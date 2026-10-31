/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
/* Slot arbitration: when each display target's scene is published and shown
 * in its slot, for every client of the service at once (README.md
 * "Arbitration").
 *
 * A target (the cluster panel, the map area, the HUD) is one slot with one
 * scene; all of its clients' layers are drawn in that scene (stack.h). The
 * slot manager is told each tick whether any layer on the target wants it
 * shown, and keeps it so:
 *
 *   Idle --wanted--> Acquiring --shown--> Shown --not wanted--> Lingering
 *                        |                  ^ |                   |    |
 *                        |                  | +--lost--+   wanted |    | linger_ms
 *                        |                  +----------|----------+    v
 *                        +--refused/timeout--> Waiting <+            release --> Idle
 *
 * - The slot is requested when at least one layer wants it and released only
 *   when none has for linger_ms, so clients coming and going, or one
 *   replacing another, never unmaps it: their layers change in the scene.
 * - Waiting is a slot someone else holds, a refusal, no answer, or a loss
 *   whose cause waits for the next table report (kVerdictMs). Who holds
 *   it comes from the display's slot table: content of the stock HMI (scene
 *   ids 0x0100xxxx that are not ours), or of anything else (an app that does
 *   not use this service). Content of anything else is always yielded to:
 *   the slot is asked for again only once it is reported free. The stock
 *   HMI's is yielded to the same way unless a wanting layer contends; a
 *   contending target retries after 2, 5, 10, 20, then every 30 s, and the
 *   ladder starts over after 30 s shown. Any other refusal or no answer
 *   retries on the same ladder. A target waiting on the ladder whose slot
 *   the table reports disabled or held and then free again (a door-open
 *   warning come and gone) is asked for at once.
 * - Requests to a slot are spaced by at least kMinRequestGapMs, and one
 *   request is outstanding per slot.
 * - The display service going away takes every target down; when it comes
 *   back, the targets still wanted are requested again after kSettleMs.
 * - Two targets with one scene id cannot both be up: the second waits until
 *   the first is idle.
 *
 * Everything here is host-testable: the display's placement service (Port)
 * and the scenes (Scenes) are interfaces. */
#ifndef CRS_SLOTS_H
#define CRS_SLOTS_H

#include <stdint.h>
#include <functional>
#include <map>
#include <string>
#include <vector>

#include "governor.h"

namespace crs {

/* Where a target's scene goes: its slot, content class and scene. */
struct TargetSpec {
    std::string name;
    uint64_t slot = 0;
    uint32_t content_class = 0;
    uint64_t scene_id = 0;
    uint32_t width = 0, height = 0;   /* scene size in pixels */
    int linger_ms = 2000;             /* kept mapped this long after the last layer stops wanting it */
};

/* Who the display reports in a slot. */
enum class Holder { None, Us, Stock, Foreign };
const char *holder_name(Holder h);

/* One entry of the display's slot table. A slot can have several entries,
 * one per content the display knows for it. */
struct SlotInfo {
    uint64_t slot = 0;
    uint32_t status = 0;      /* 0 disabled, 1 available, 2 occupied */
    uint64_t content = 0;     /* the entry's scene id; 0: none */
    uint32_t klass = 0;       /* its content class */
    uint32_t map_status = 0;  /* 0 unmapped, 1 foreground, 2 background, 3 invisible */
};

/* Why a request was not granted. */
enum class Refusal {
    Busy,       /* the slot is held: E_DCSM_PRIOTOOLOW, E_DCSM_CONTENT_ALREADYMAPPED */
    Config,     /* the slot, scene or client is unknown to the display */
    Transient,  /* fetch failed, no valid reply */
};

/* The display's placement service (iDrive 7: Dcsm2 fetch and map). */
class Port {
public:
    virtual ~Port() {}
    virtual bool available() const = 0;
    /* Show the target's published scene in its slot. Answered by
     * SlotManager::on_shown or on_refused. */
    virtual void request(const TargetSpec &t) = 0;
    /* Take it out of its slot. No answer is awaited. */
    virtual void release(const TargetSpec &t) = 0;
    /* Ask for the slot table (SlotManager::on_slots). */
    virtual void refresh_slots() = 0;
};

/* Builds, publishes and takes down each target's scene (the compositor). */
class Scenes {
public:
    virtual ~Scenes() {}
    virtual bool publish(const TargetSpec &t, std::string *err) = 0;
    virtual void unpublish(const TargetSpec &t) = 0;
};

enum class TargetState { Idle, Acquiring, Shown, Lingering, Waiting, Unavailable };
const char *target_state_name(TargetState s);

/* A target's state as clients see it. */
struct TargetStatus {
    TargetState state = TargetState::Idle;
    Holder holder = Holder::None;   /* who holds the slot while Waiting */
    std::string reason;
    int64_t retry_ms = -1;          /* Waiting on a timer: when it asks again (or decides a loss); -1: when
                                       the slot is free */
};

class SlotManager {
public:
    static const int64_t kStartTimeoutMs = 5000;
    static const int64_t kMinRequestGapMs = 1000;
    static const int64_t kSettleMs = 1000;
    static const int64_t kSlotPollMs = 5000;
    static const int64_t kLadderResetMs = 30000;
    static const int64_t kVerdictMs = 1000;

    SlotManager(Port *port, Scenes *scenes);
    /* The scenes, when they are made after the slot manager (they read its
     * targets). Before the first tick. */
    void set_scenes(Scenes *scenes) { scenes_ = scenes; }

    /* Targets are fixed at start (the configuration). */
    void add(const TargetSpec &t);
    const std::vector<TargetSpec> &targets() const { return specs_; }
    int index(const std::string &name) const;   /* -1 if unknown */

    /* What the target's layers want, recomputed by the compositor each tick:
     * shown at all, and whether a wanting layer contends with the stock HMI. */
    void want(int target, bool wanted, bool contend);

    /* The display's answers and reports. */
    void on_availability(bool up, int64_t now_ms);
    void on_shown(uint64_t scene_id, int64_t now_ms);
    void on_refused(uint64_t scene_id, Refusal r, const std::string &why, int64_t now_ms);
    void on_lost(uint64_t scene_id, const std::string &why, int64_t now_ms);
    void on_slots(const std::vector<SlotInfo> &slots, int64_t now_ms);

    void tick(int64_t now_ms);

    const TargetStatus &status(int target) const { return t_[target].status; }
    /* True when the target's scene is published (Acquiring, Shown,
     * Lingering): its layers are drawn and flushed. */
    bool published(int target) const { return t_[target].published; }
    /* Milliseconds until the next timer of any target; -1: none. */
    int64_t wake_in_ms(int64_t now_ms) const;

    Holder holder_of(uint64_t content) const;

    /* Evidence of the link or the display's renderer falling behind, for the
     * upload governor: a shown scene removed with no other content in its
     * slot. A slot the stock HMI or another app takes, a refusal or no
     * answer is arbitration, not evidence. */
    std::function<void(Evidence, const std::string &detail, int64_t now_ms)> on_evidence;

private:
    struct Target {
        TargetStatus status;
        bool wanted = false, contend = false;
        bool published = false;
        int64_t since_ms = 0;        /* entered the current state */
        int64_t last_request_ms = -1000000;
        int ladder = 0;
        /* Lost while the table named our own scene id: who holds the slot
         * is decided at the next table report (or kVerdictMs). */
        bool verdict = false, verdict_removal = false;
        uint64_t verdict_seq = 0;
        int64_t lost_ms = 0;
        /* Waiting on the ladder: the table has since reported the slot
         * disabled or held by other content. */
        bool slot_away = false;
    };

    void set(int i, TargetState s, Holder h, const std::string &reason, int64_t now_ms, int64_t retry_ms = -1);
    void acquire(int i, int64_t now_ms);
    void take_down(int i);
    /* Waiting; on the ladder, the retry counts from from_ms (-1: now_ms). */
    void wait(int i, Holder h, bool use_ladder, const std::string &reason, int64_t now_ms, int64_t from_ms = -1);
    Holder other_holder(int i) const;
    void settle_loss(int i, Holder h, bool removal, const std::string &reason, int64_t now_ms, int64_t lost_ms);
    bool yields(int i, int64_t now_ms);
    int by_scene(uint64_t scene_id) const;
    bool scene_busy(int i) const;
    const SlotInfo *slot(uint64_t id) const;

    Port *port_;
    Scenes *scenes_;
    std::vector<TargetSpec> specs_;
    std::vector<Target> t_;
    std::map<uint64_t, SlotInfo> slots_;
    /* Per slot, from its latest report: disabled, or held by content not
     * ours. */
    std::map<uint64_t, bool> away_;
    uint64_t slots_seq_ = 0;   /* table reports so far */
    int64_t available_since_ms_ = -1;
    int64_t slot_poll_ms_ = 0;
};

}  // namespace crs

#endif
