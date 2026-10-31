// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* MapFeed: the decoded map as a video layer of the shared cluster renderer
 * (cluster-render, its PROTOCOL.md), and what the Waze app is told about it.
 *
 * One video layer, class content and contending with the stock map, on the
 * target the map goes to: `map` (the native central-map slot 0x100, whose
 * 1088x480 scene the map fills) unless a control start chose another; on a
 * whole-panel or HUD target it is the centred map area (map_geometry.h).
 * The renderer draws every frame the way waze-on-cluster always has (one
 * persistent R8 atlas written in changed tiles, packed fast motion, the
 * frame clock, newest frame only) within the budget all its clients share,
 * maps the slot from the first frame, and releases it after the frames stop
 * for stall_ms. Frames handed over while the renderer is not reachable are
 * dropped; the client reconnects by itself and the next frame shows.
 *
 * The app's status line follows the layer and its target: idle until the
 * first frame, starting while the slot is asked for or held by the stock
 * map and while the renderer starts, showing with the frames handed over a
 * second, error when the renderer refused the layer or stays unreachable. */
#ifndef WOC_MAP_FEED_H
#define WOC_MAP_FEED_H

#include <stdint.h>
#include <string>
#include <vector>

#include "cluster_render/client.h"

namespace woc {

struct FeedConfig {
    std::string socket = "/dev/shm/cluster-render/render.sock";
    std::string target = "map";
    cr::VideoOptions video;   /* w and h are the decoded frame's */
};

/* The status the Waze app shows (its render socket's "status" event), with
 * the shared upload cap and why it is what it is, for the diagnostics. */
struct FeedStatus {
    std::string state = "idle";   /* idle, starting, showing, error */
    std::string target;
    std::string page;
    std::string reason;
    unsigned upload_cap_kb = 0;   /* 0 until the renderer reports it */
    std::string upload_reason;
};

class MapFeed {
public:
    explicit MapFeed(const FeedConfig &cfg);

    /* Where the map goes from now on: a renderer target, or "sail" for the
     * native central-map slot. False for a name the renderer has not got
     * (known once connected). */
    bool set_target(const std::string &name);

    int fd() const { return client_.fd(); }
    bool wants_write() const { return client_.wants_write(); }
    void poll(int64_t now_ms);

    /* The newest decoded frame (the whole atlas), taken without a copy;
     * replaces one not yet sent. *atlas comes back as a buffer of the same
     * size (undefined contents), or untouched while the renderer is not
     * reachable. */
    void offer(std::vector<uint8_t> *atlas, uint64_t id, int64_t now_ms);

    /* The status for the app, with decode the capture and decode part of
     * the line; true once per change. */
    FeedStatus status(const std::string &decode) const;
    bool take_changed();
    /* The renderer's own status text (targets, layers, the upload cap),
     * asked for again once the last request is answered. */
    void request_report();
    const std::string &report() const { return report_; }

private:
    void make_layer();
    void count_second(int64_t now_ms);

    FeedConfig cfg_;
    cr::Client client_;
    uint32_t layer_ = 0;
    std::string layer_state_ = "stalled", layer_reason_;
    std::string target_state_, holder_;
    unsigned cap_kb_ = 0, max_kb_ = 0;
    std::string budget_reason_, refused_, report_;
    bool connected_ = false, changed_ = true, status_asked_ = false;
    /* Unreachable this long (it starts with the first client): an error. */
    static const int64_t kUnreachableMs = 15000;
    int64_t down_since_ms_ = -1;
    bool down_long_ = false;
    int64_t second_ms_ = 0;
    int frames_ = 0, rate_ = 0;
};

}  // namespace woc

#endif
