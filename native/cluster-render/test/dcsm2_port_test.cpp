/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
/* Host test for the iDrive 7 port (dcsm2_port.h) under the slot manager:
 * fetch, then map once FETCHED, shown at MAPPED_FOREGROUND or BACKGROUND;
 * release unmaps only what a map went out for; replies are matched to the
 * oldest unanswered request of their kind across targets; refusals are
 * classified (busy, configuration, transient); a removed fetch of a shown
 * scene is lost, and evidence for the upload governor unless the stock HMI
 * holds the slot; Dcsm2 going away forgets everything and later events for
 * it are ignored. */
#include <cstdio>
#include <string>
#include <vector>

#include "../src/dcsm2_port.h"
#include "dcsm/dcsm_client.h"

using namespace crs;

static int failures;
static std::vector<std::string> calls;

static void ok(const char *name, bool cond)
{
    std::printf("%-4s %s\n", cond ? "ok" : "FAIL", name);
    if (!cond) failures++;
}

static bool calls_are(const std::string &want)
{
    std::string got;
    for (auto &c : calls) got += (got.empty() ? "" : "; ") + c;
    calls.clear();
    if (got == want)
        return true;
    std::printf("     got  \"%s\"\n     want \"%s\"\n", got.c_str(), want.c_str());
    return false;
}

static std::string hex(uint64_t v)
{
    char b[24];
    std::snprintf(b, sizeof b, "0x%llx", (unsigned long long)v);
    return b;
}

struct Wire : Dcsm2Wire {
    void fetch(uint64_t s) override { calls.push_back("fetch " + hex(s)); }
    void map(uint64_t s, uint32_t c, uint64_t slot) override
    {
        calls.push_back("map " + hex(s) + " class " + std::to_string(c) + " slot " + hex(slot));
    }
    void unmap(uint64_t s) override { calls.push_back("unmap " + hex(s)); }
    void unfetch(uint64_t s) override { calls.push_back("unfetch " + hex(s)); }
    void slots() override { calls.push_back("slots?"); }
};

struct Scenes0 : Scenes {
    bool publish(const TargetSpec &, std::string *) override { return true; }
    void unpublish(const TargetSpec &) override {}
};

static const uint64_t kMap = 0x010004f0, kPanel = 0x01000400;

struct Rig {
    Wire wire;
    Scenes0 scenes;
    Dcsm2Port port{&wire};
    SlotManager m{&port, &scenes};
    std::vector<std::string> evidence;
    int64_t now = 10000;
    Rig()
    {
        TargetSpec a;
        a.name = "map"; a.slot = 0x100; a.scene_id = kMap; a.width = 1088; a.height = 480;
        TargetSpec b;
        b.name = "panel"; b.slot = 0x203; b.scene_id = kPanel; b.width = 1920; b.height = 720; b.content_class = 3;
        m.add(a);
        m.add(b);
        port.set_manager(&m);
        m.on_evidence = [this](Evidence e, const std::string &d, int64_t) {
            evidence.push_back(std::string(evidence_name(e)) + " " + d);
        };
        port.on_availability(true, now);
        now += 1500;
    }
    void tick() { m.tick(now += 10); }
};

int main()
{
    Rig r;
    r.m.want(0, true, true);
    r.tick();
    ok("a request is a fetch", calls_are("fetch 0x10004f0"));
    r.port.on_reply(dcsm::kReqFetchContent, true, dcsm::E_DCSM_OK, "E_DCSM_OK", r.now);
    r.port.on_fetch_status(kMap, dcsm::E_FETCH_STATUS_FETCHED, r.now);
    ok("FETCHED: the map into its slot with its class", calls_are("map 0x10004f0 class 0 slot 0x100"));
    r.port.on_map_status(kMap, 0, dcsm::E_MAP_STATUS_MAPPED_BACKGROUND, r.now);
    ok("MAPPED_BACKGROUND is shown", r.m.status(0).state == TargetState::Shown);

    /* Two requests out at once: replies match the oldest of their kind. */
    r.m.want(1, true, false);
    r.tick();
    calls.clear();
    r.port.on_reply(dcsm::kReqMapContent, true, dcsm::E_DCSM_OK, "E_DCSM_OK", r.now);
    r.port.on_reply(dcsm::kReqFetchContent, true, dcsm::E_DCSM_OK, "E_DCSM_OK", r.now);
    r.port.on_fetch_status(kPanel, dcsm::E_FETCH_STATUS_FETCHED, r.now);
    ok("the panel is mapped with its own class and slot", calls_are("map 0x1000400 class 3 slot 0x203"));
    r.port.on_reply(dcsm::kReqMapContent, true, dcsm::E_DCSM_PRIOTOOLOW, "E_DCSM_PRIOTOOLOW", r.now);
    ok("a busy map refusal: the panel waits for the slot, unfetched without an unmap",
       r.m.status(1).state == TargetState::Waiting && r.m.status(1).holder == Holder::Stock &&
           calls_are("unfetch 0x1000400") && r.evidence.empty());
    r.port.on_map_status(kPanel, 0, dcsm::E_MAP_STATUS_MAPPED_FOREGROUND, r.now);
    ok("a late map answer for the released panel is ignored", r.m.status(1).state == TargetState::Waiting);

    /* The display removes the shown map with nothing else in its slot. */
    r.port.on_fetch_status(kMap, dcsm::E_FETCH_STATUS_REMOVED, r.now);
    ok("a removed fetch of a shown scene: lost and unfetched (nothing left to unmap)",
       r.m.status(0).state == TargetState::Waiting && calls_are("unfetch 0x10004f0"));
    ok("and it is evidence for the governor", r.evidence.size() == 1 &&
                                                  r.evidence[0].find("scene removed map") == 0);
    calls.clear();

    /* Now the stock map takes it: arbitration, not evidence. */
    r.now += 3000;
    r.tick();
    r.port.on_reply(dcsm::kReqFetchContent, true, dcsm::E_DCSM_OK, "E_DCSM_OK", r.now);
    r.port.on_fetch_status(kMap, dcsm::E_FETCH_STATUS_FETCHED, r.now);
    r.port.on_map_status(kMap, 0, dcsm::E_MAP_STATUS_MAPPED_FOREGROUND, r.now);
    SlotInfo s;
    s.slot = 0x100;
    s.status = 2;
    s.content = 0x01000101;
    r.port.on_slots({s}, r.now);
    r.port.on_map_status(kMap, 1, dcsm::E_MAP_STATUS_UNMAPPED, r.now);
    ok("unmapped by the stock map: lost, no evidence",
       r.m.status(0).state == TargetState::Waiting && r.m.status(0).holder == Holder::Stock && r.evidence.size() == 1);

    /* Refusal kinds. */
    Rig q;
    q.m.want(0, true, false);
    q.tick();
    q.port.on_reply(dcsm::kReqFetchContent, true, dcsm::E_DCSM_SLOTID_UNKNOWN, "E_DCSM_SLOTID_UNKNOWN", q.now);
    ok("an unknown slot is configuration: the ladder, no evidence",
       q.m.status(0).retry_ms > 0 && q.m.status(0).reason.find("SLOTID") != std::string::npos && q.evidence.empty());
    Rig t;
    t.m.want(0, true, false);
    t.tick();
    t.port.on_reply(dcsm::kReqFetchContent, false, 0, "", t.now);
    ok("no valid reply is transient: the ladder, no evidence", t.m.status(0).retry_ms > 0 && t.evidence.empty());

    /* Panel and HUD share a scene id: the HUD asks for it right after the
     * panel let it go, and the REMOVED answering the panel's unfetch
     * arrives while the HUD's fetch is under way. */
    Rig h;
    TargetSpec hud;
    hud.name = "hud"; hud.slot = 0x323; hud.scene_id = kPanel; hud.width = 800; hud.height = 480;
    h.m.add(hud);
    h.m.want(1, true, false);
    h.tick();
    h.port.on_reply(dcsm::kReqFetchContent, true, dcsm::E_DCSM_OK, "E_DCSM_OK", h.now);
    h.port.on_fetch_status(kPanel, dcsm::E_FETCH_STATUS_FETCHED, h.now);
    h.port.on_map_status(kPanel, 0, dcsm::E_MAP_STATUS_MAPPED_FOREGROUND, h.now);
    h.m.want(1, false, false);
    h.m.want(2, true, false);
    for (int k = 0; k < 400; k++)
        h.tick();
    calls.clear();
    h.port.on_fetch_status(kPanel, dcsm::E_FETCH_STATUS_REMOVED, h.now);
    ok("the REMOVED answering our own unfetch does not refuse the HUD's new fetch",
       h.m.status(2).state == TargetState::Acquiring && h.evidence.empty() && calls_are(""));
    h.port.on_fetch_status(kPanel, dcsm::E_FETCH_STATUS_FETCHED, h.now);
    h.port.on_map_status(kPanel, 0, dcsm::E_MAP_STATUS_MAPPED_FOREGROUND, h.now);
    h.port.on_fetch_status(kPanel, dcsm::E_FETCH_STATUS_REMOVED, h.now);
    ok("after the HUD's FETCHED a REMOVED is a loss again", h.m.status(2).state == TargetState::Waiting &&
                                                             h.evidence.size() == 1);

    /* Dcsm2 goes away and comes back. */
    Rig u;
    u.m.want(0, true, false);
    u.tick();
    calls.clear();
    u.port.on_availability(false, u.now);
    u.port.on_fetch_status(kMap, dcsm::E_FETCH_STATUS_FETCHED, u.now);
    ok("gone: nothing is sent, later events are ignored", calls_are("") &&
                                                             u.m.status(0).state == TargetState::Unavailable);
    std::printf(failures ? "%d FAILED\n" : "all ok\n", failures);
    return failures ? 1 : 0;
}
