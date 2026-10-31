/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
/* Host test for the iDrive 7 port (dcsm2_port.h) under the slot manager:
 * fetch, then map once FETCHED, shown at MAPPED_FOREGROUND or BACKGROUND;
 * release unmaps only what a map went out for; replies are matched to the
 * oldest unanswered request of their kind across targets; refusals are
 * classified (busy, configuration, transient); a removed fetch of a shown
 * scene is lost, and evidence for the upload governor unless the stock HMI
 * holds the slot; Dcsm2 going away forgets everything and later events for
 * it are ignored. MAPPED_INVISIBLE is parked, with no timeout, and shown
 * when the KOMBI promotes it; a parked scene unmapped is lost; a take-over
 * is an unmap of the stock HMI's content with the HMI's handle, whose reply
 * matches no request of ours: fetch and map replies still go to the oldest
 * fetch and map. */
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
    void unmap_as(uint64_t h, uint64_t s) override { calls.push_back("unmap " + hex(s) + " as " + hex(h)); }
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
        a.take_over_stock = true;
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
    /* The map requested, fetched and mapped; its map status still to come. */
    void map_asked(bool contend)
    {
        m.want(0, true, contend);
        tick();
        port.on_reply(dcsm::kReqFetchContent, true, dcsm::E_DCSM_OK, "E_DCSM_OK", now);
        port.on_fetch_status(kMap, dcsm::E_FETCH_STATUS_FETCHED, now);
        port.on_reply(dcsm::kReqMapContent, true, dcsm::E_DCSM_OK, "E_DCSM_OK", now);
        calls.clear();
    }
    /* Slot 0x100 as the car reports it: the stock map and ours. */
    void table(uint32_t stock_map, uint32_t ours)
    {
        SlotInfo h, o;
        h.slot = o.slot = 0x100;
        h.status = o.status = stock_map == 1 || ours == 1 ? 2 : 1;
        h.content = 0x01000300;
        o.content = kMap;
        h.map_status = stock_map;
        o.map_status = ours;
        port.on_slots({h, o}, now);
    }
};

static void parked()
{
    Rig r;
    r.map_asked(false);
    r.table(1, 3);
    r.port.on_map_status(kMap, 0, dcsm::E_MAP_STATUS_MAPPED_INVISIBLE, r.now);
    ok("MAPPED_INVISIBLE: parked behind the stock map", r.m.status(0).state == TargetState::Parked &&
                                                          r.m.status(0).holder == Holder::Stock);
    calls.clear();
    for (int k = 0; k < 1000; k++)
        r.tick();
    ok("10 s parked: no timeout, nothing released", r.m.status(0).state == TargetState::Parked &&
                                                      calls_are("slots?; slots?"));
    r.table(0, 1);
    r.port.on_map_status(kMap, 3, dcsm::E_MAP_STATUS_MAPPED_FOREGROUND, r.now);
    ok("promoted (3 -> 1): shown", r.m.status(0).state == TargetState::Shown);
    r.port.on_map_status(kMap, 1, dcsm::E_MAP_STATUS_MAPPED_INVISIBLE, r.now);
    ok("1 -> 3: parked, not lost", r.m.status(0).state == TargetState::Parked && calls_are("slots?"));
    r.m.want(0, false, false);
    r.tick();
    ok("released while parked: unmapped, then unfetched", calls_are("unmap 0x10004f0; unfetch 0x10004f0") &&
                                                            r.m.status(0).state == TargetState::Idle);

    Rig l;
    l.map_asked(false);
    l.port.on_map_status(kMap, 0, dcsm::E_MAP_STATUS_MAPPED_INVISIBLE, l.now);
    calls.clear();
    l.table(0, 0);
    l.port.on_map_status(kMap, 3, dcsm::E_MAP_STATUS_UNMAPPED, l.now);
    ok("parked, then unmapped (a lock): lost, unfetched with no unmap", calls_are("unfetch 0x10004f0") &&
                                                                         l.m.status(0).state == TargetState::Waiting);

    Rig f;
    f.map_asked(false);
    f.port.on_map_status(kMap, 0, dcsm::E_MAP_STATUS_MAPPED_INVISIBLE, f.now);
    calls.clear();
    f.port.on_fetch_status(kMap, dcsm::E_FETCH_STATUS_REMOVED, f.now);
    ok("parked, then its fetch removed: lost, no evidence", calls_are("unfetch 0x10004f0") &&
                                                              f.m.status(0).state == TargetState::Waiting &&
                                                              f.evidence.empty());
}

static void take_over()
{
    Rig r;
    r.port.set_hmi_client_handle(1);
    r.map_asked(true);
    r.table(1, 3);
    r.port.on_map_status(kMap, 0, dcsm::E_MAP_STATUS_MAPPED_INVISIBLE, r.now);
    calls.clear();
    r.tick();
    ok("contending and parked behind the stock map: an unmap of it as client 1",
       calls_are("unmap 0x1000300 as 0x1; slots?"));
    /* The panel's fetch is out when the take-over's reply comes. */
    r.m.want(1, true, false);
    r.tick();
    calls.clear();
    r.port.on_reply(dcsm::kReqUnmapContent, true, dcsm::E_DCSM_HANDLE_UNKNOWN, "E_DCSM_HANDLE_UNKNOWN", r.now);
    ok("the take-over's reply, even a refusal, refuses nothing of ours",
       r.m.status(1).state == TargetState::Acquiring && r.m.status(0).state == TargetState::Parked);
    r.port.on_reply(dcsm::kReqFetchContent, true, dcsm::E_DCSM_CONTENTID_UNKNOWN, "E_DCSM_CONTENTID_UNKNOWN", r.now);
    ok("the next fetch reply is still the panel's", r.m.status(1).state == TargetState::Waiting &&
                                                     r.m.status(1).reason.find("CONTENTID") != std::string::npos);
    r.table(3, 1);
    r.port.on_map_status(kMap, 3, dcsm::E_MAP_STATUS_MAPPED_FOREGROUND, r.now);
    ok("the KOMBI shows ours: shown", r.m.status(0).state == TargetState::Shown);

    Rig h;
    h.port.set_hmi_client_handle(7);
    h.map_asked(true);
    h.table(1, 3);
    h.port.on_map_status(kMap, 0, dcsm::E_MAP_STATUS_MAPPED_INVISIBLE, h.now);
    calls.clear();
    h.tick();
    ok("the HMI's handle is configurable", calls_are("unmap 0x1000300 as 0x7; slots?"));
    /* More unmap replies than unmaps sent. */
    h.m.want(0, false, false);
    h.tick();
    calls.clear();
    h.port.on_reply(dcsm::kReqUnmapContent, true, dcsm::E_DCSM_OK, "E_DCSM_OK", h.now);
    h.port.on_reply(dcsm::kReqUnmapContent, true, dcsm::E_DCSM_OK, "E_DCSM_OK", h.now);
    h.port.on_reply(dcsm::kReqUnmapContent, true, dcsm::E_DCSM_OK, "E_DCSM_OK", h.now);
    ok("unmap replies, more than were sent: nothing breaks", h.m.status(0).state == TargetState::Idle);
}

static void basics()
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
    s.map_status = 1;   /* shown */
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
}

int main()
{
    basics();
    parked();
    take_over();
    std::printf(failures ? "%d FAILED\n" : "all ok\n", failures);
    return failures ? 1 : 0;
}
