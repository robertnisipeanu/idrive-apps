/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
/* Host test for slot arbitration (slots.h): a slot is requested once while
 * any layer wants it and released only after none has for linger_ms, so
 * clients coming and going cause no display traffic; content of the stock
 * HMI is yielded to unless a layer contends, which retries on the 2/5/10/20/30
 * s ladder, reset after 30 s shown; content of anything else is always
 * yielded to; a slot the table names as held is not asked for; refusals and
 * no answer retry on the ladder; requests are spaced; the display service
 * going away takes every target down and its return maps the wanted ones
 * again after the settle time; two targets sharing a scene id are never up
 * together. */
#include <cstdio>
#include <string>
#include <vector>

#include "../src/slots.h"

using namespace crs;

static int failures;
static std::vector<std::string> calls;

static void ok(const char *name, bool cond)
{
    std::printf("%-4s %s\n", cond ? "ok" : "FAIL", name);
    if (!cond) failures++;
}

static std::string joined()
{
    std::string s;
    for (auto &c : calls) s += (s.empty() ? "" : "; ") + c;
    calls.clear();
    return s;
}

static bool calls_are(const std::string &want)
{
    const std::string got = joined();
    if (got == want)
        return true;
    std::printf("     got  \"%s\"\n     want \"%s\"\n", got.c_str(), want.c_str());
    return false;
}

struct FakePort : Port {
    bool up = true;
    bool available() const override { return up; }
    void request(const TargetSpec &t) override { calls.push_back("request " + t.name); }
    void release(const TargetSpec &t) override { calls.push_back("release " + t.name); }
    void refresh_slots() override { calls.push_back("slots?"); }
};

struct FakeScenes : Scenes {
    bool fail = false;
    bool publish(const TargetSpec &t, std::string *err) override
    {
        calls.push_back("publish " + t.name);
        if (fail) *err = "refused";
        return !fail;
    }
    void unpublish(const TargetSpec &t) override { calls.push_back("unpublish " + t.name); }
};

static const uint64_t kMapScene = 0x010004f0, kPanelScene = 0x01000400;
static const uint64_t kMapSlot = 0x100, kPanelSlot = 0x203, kHudSlot = 0x323;
static const uint64_t kStockMap = 0x01000101;   /* an HmiMain3D scene */

struct Rig {
    FakePort port;
    FakeScenes scenes;
    SlotManager m{&port, &scenes};
    int64_t now = 100000;
    Rig()
    {
        TargetSpec map;
        map.name = "map"; map.slot = kMapSlot; map.scene_id = kMapScene; map.width = 1088; map.height = 480;
        map.linger_ms = 2000;
        TargetSpec panel;
        panel.name = "panel"; panel.slot = kPanelSlot; panel.scene_id = kPanelScene; panel.width = 1920;
        panel.height = 720; panel.linger_ms = 3000;
        TargetSpec hud;
        hud.name = "hud"; hud.slot = kHudSlot; hud.scene_id = kPanelScene; hud.width = 800; hud.height = 480;
        m.add(map);
        m.add(panel);
        m.add(hud);
    }
    void run(int64_t ms, int64_t step = 10)
    {
        for (int64_t t = 0; t < ms; t += step) {
            now += step;
            m.tick(now);
        }
    }
    void slot(uint64_t id, uint32_t status, uint64_t content)
    {
        SlotInfo s;
        s.slot = id; s.status = status; s.content = content;
        m.on_slots({s}, now);
    }
    TargetState state(int i) const { return m.status(i).state; }
};

static void refcount_and_linger()
{
    Rig r;
    r.m.want(0, true, false);
    r.m.tick(r.now);
    ok("a wanted target is published and requested", calls_are("publish map; request map") &&
                                                         r.state(0) == TargetState::Acquiring);
    r.m.on_shown(kMapScene, r.now);
    ok("and shown once the display says so", r.state(0) == TargetState::Shown && r.m.published(0));
    /* A second client, then the first leaving: still wanted (the compositor
     * ORs its layers), so nothing reaches the display. */
    r.m.want(0, true, false);
    r.run(5000);
    ok("layers coming and going while one wants it: no display traffic", calls_are(""));
    r.m.want(0, false, false);
    r.run(1000);
    ok("the last layer gone: lingering, still mapped", r.state(0) == TargetState::Lingering && calls_are(""));
    r.m.want(0, true, false);
    r.m.tick(r.now);
    ok("wanted again within the linger: shown at once, no request",
       r.state(0) == TargetState::Shown && calls_are(""));
    r.m.want(0, false, false);
    r.run(1990);
    ok("not released before linger_ms", r.state(0) == TargetState::Lingering && calls_are(""));
    r.run(20);
    ok("released after linger_ms: release, unpublish", calls_are("release map; unpublish map") &&
                                                          r.state(0) == TargetState::Idle && !r.m.published(0));
}

static void timeout_and_ladder()
{
    Rig r;
    r.m.want(0, true, false);
    r.m.tick(r.now);
    joined();
    r.run(4990);
    ok("no answer: still acquiring before 5 s", r.state(0) == TargetState::Acquiring);
    r.run(20);
    ok("no answer for 5 s: taken down, waiting 2 s",
       calls_are("release map; unpublish map") && r.state(0) == TargetState::Waiting &&
           r.m.status(0).retry_ms == r.now + 2000 - 10);
    r.run(1980);
    ok("nothing before the 2 s retry", calls_are(""));
    r.run(20);
    ok("requested again after 2 s", calls_are("publish map; request map"));
    r.m.on_refused(kMapScene, Refusal::Config, "E_DCSM_SLOTID_UNKNOWN", r.now);
    ok("a configuration refusal retries on the ladder (5 s)",
       calls_are("release map; unpublish map") && r.m.status(0).retry_ms == r.now + 5000 &&
           r.m.status(0).holder == Holder::None);
    const int64_t at = r.now;
    r.run(4000);
    r.m.on_shown(kMapScene, r.now);
    ok("a late answer to a request taken down is ignored", r.state(0) == TargetState::Waiting);
    r.run(1000);
    ok("next request at the 5 s step", calls_are("publish map; request map") && r.now - at == 5000);
}

static void stock_yield()
{
    Rig r;
    r.m.want(1, true, false);   /* an overlay: yields */
    r.m.tick(r.now);
    r.m.on_shown(kPanelScene, r.now);
    joined();
    /* The stock HMI maps its speech dialog over ours. */
    r.slot(kPanelSlot, 2, 0x01000400 + 1);
    r.m.on_lost(kPanelScene, "fetch removed", r.now);
    ok("taken by the stock HMI: down, waiting for the slot to be free",
       calls_are("release panel; unpublish panel") && r.state(1) == TargetState::Waiting &&
           r.m.status(1).holder == Holder::Stock && r.m.status(1).retry_ms == -1);
    r.run(60000);
    const std::string polled = joined();
    ok("no request while the stock HMI holds it, the table polled every 5 s",
       polled.find("request") == std::string::npos && polled.find("slots?") != std::string::npos &&
           polled.size() <= std::string("slots?; ").size() * 12);
    r.slot(kPanelSlot, 1, 0);
    r.m.tick(r.now);
    ok("requested again once the slot is free", calls_are("publish panel; request panel"));
}

static void stock_contend()
{
    Rig r;
    r.m.want(0, true, true);   /* the Waze map contends */
    r.m.tick(r.now);
    r.m.on_shown(kMapScene, r.now);
    joined();
    const int64_t steps[] = {2000, 5000, 10000, 20000, 30000, 30000};
    bool ladder = true;
    for (int64_t step : steps) {
        r.slot(kMapSlot, 2, kStockMap);
        r.m.on_lost(kMapScene, "fetch removed", r.now);
        joined();
        const int64_t at = r.now;
        r.run(step - 10);
        ladder = ladder && calls_are("");
        r.run(10);
        ladder = ladder && calls_are("publish map; request map") && r.now - at == step;
        r.m.on_shown(kMapScene, r.now);
        r.run(1000);
    }
    ok("contending with the stock map: retries after 2, 5, 10, 20, 30, 30 s", ladder);
    r.run(30000);
    r.slot(kMapSlot, 2, kStockMap);
    r.m.on_lost(kMapScene, "fetch removed", r.now);
    joined();
    ok("30 s shown resets the ladder to 2 s", r.m.status(0).retry_ms == r.now + 2000);
}

static void foreign_always_yields()
{
    Rig r;
    r.slot(kMapSlot, 2, 0x00007777);   /* content of an app outside the service */
    r.m.want(0, true, true);
    r.m.tick(r.now);
    ok("a slot held by a foreign app is not asked for, even contending",
       calls_are("slots?") && r.state(0) == TargetState::Waiting && r.m.status(0).holder == Holder::Foreign);
    r.run(20000);
    ok("still not asked for while it holds it", joined().find("request") == std::string::npos);
    r.slot(kMapSlot, 1, 0);
    r.m.tick(r.now);
    ok("asked for once it is free", calls_are("publish map; request map"));
}

static void idle_precheck()
{
    Rig r;
    r.slot(kPanelSlot, 2, 0x01000400);   /* our panel scene id, but not ours: the speech dialog */
    r.m.want(1, true, false);
    r.m.tick(r.now);
    ok("our scene id in the slot while we publish nothing is the stock HMI's: yield",
       r.state(1) == TargetState::Waiting && r.m.status(1).holder == Holder::Stock &&
           joined().find("request") == std::string::npos);
    r.m.want(1, true, true);
    r.m.tick(r.now);
    ok("a contending layer arriving while yielding retries on the ladder",
       r.m.status(1).retry_ms == r.now + 2000);
    r.m.want(1, false, false);
    r.run(2000);
    ok("nobody wants it when the timer passes: idle", r.state(1) == TargetState::Idle && calls_are(""));
}

static void busy_refusal_unknown_holder()
{
    Rig r;
    r.m.want(1, true, false);
    r.m.tick(r.now);
    joined();
    r.m.on_refused(kPanelScene, Refusal::Busy, "E_DCSM_PRIOTOOLOW", r.now);
    ok("a busy refusal with no table: held by the stock HMI, yield",
       calls_are("release panel; unpublish panel") && r.m.status(1).holder == Holder::Stock &&
           r.m.status(1).retry_ms == -1);
    r.run(100);
    ok("the slot table is asked for", calls_are("slots?"));
}

static void availability()
{
    Rig r;
    r.m.want(0, true, true);
    r.m.tick(r.now);
    r.m.on_shown(kMapScene, r.now);
    joined();
    r.port.up = false;
    r.m.on_availability(false, r.now);
    r.m.tick(r.now);
    ok("display service gone: unpublished, nothing sent, unavailable",
       calls_are("unpublish map") && r.state(0) == TargetState::Unavailable);
    r.run(10000);
    ok("nothing while it is gone", calls_are(""));
    r.port.up = true;
    r.m.on_availability(true, r.now);
    const int64_t at = r.now;
    r.run(990);
    ok("back: nothing during the settle time", calls_are("") && r.state(0) == TargetState::Idle);
    r.run(20);
    ok("requested again after it", calls_are("publish map; request map") && r.now - at >= 1000);
    r.m.want(1, false, false);
    ok("an unwanted target stays idle throughout", r.state(1) == TargetState::Idle);
}

static void shared_scene_id()
{
    Rig r;
    r.m.want(1, true, false);
    r.m.tick(r.now);
    r.m.on_shown(kPanelScene, r.now);
    joined();
    r.m.want(2, true, false);   /* the HUD has the panel's scene id */
    r.run(5000);
    ok("a second target with a published scene id waits",
       r.state(2) == TargetState::Waiting && joined().find("hud") == std::string::npos);
    r.m.want(1, false, false);
    r.run(3100);
    const std::string c = joined();
    ok("and is requested once the first is idle",
       c.find("release panel; unpublish panel") != std::string::npos &&
           c.find("publish hud; request hud") != std::string::npos);
}

static void request_gap()
{
    Rig r;
    r.m.want(0, true, false);
    r.m.tick(r.now);
    r.m.on_refused(kMapScene, Refusal::Transient, "E_FETCH_STATUS_FAILED", r.now);
    joined();
    r.m.want(0, false, false);
    r.run(2000);
    r.m.want(0, true, false);
    r.m.tick(r.now);
    ok("after a refusal the ladder is not bypassed by the demand flapping",
       calls_are("publish map; request map") && r.now >= 100000 + 2000);
    r.m.on_refused(kMapScene, Refusal::Transient, "E_FETCH_STATUS_FAILED", r.now);
    joined();
    r.m.want(0, false, false);
    r.run(4000);
    r.m.want(0, true, false);
    r.run(500);
    ok("the next step is still 5 s", calls_are(""));
}

static void lost_while_lingering()
{
    Rig r;
    r.m.want(0, true, false);
    r.m.tick(r.now);
    r.m.on_shown(kMapScene, r.now);
    r.m.want(0, false, false);
    r.m.tick(r.now);
    joined();
    r.m.on_lost(kMapScene, "fetch removed", r.now);
    ok("lost while lingering: down and idle, no retry", calls_are("release map; unpublish map") &&
                                                           r.state(0) == TargetState::Idle);
}

static void scene_failure()
{
    Rig r;
    r.scenes.fail = true;
    r.m.want(0, true, false);
    r.m.tick(r.now);
    ok("a scene that cannot be published is not requested, and retried on the ladder",
       calls_are("publish map") && r.state(0) == TargetState::Waiting && r.m.status(0).retry_ms == r.now + 2000);
}

static void ladder_rechecks_the_table()
{
    Rig r;
    r.m.want(0, true, true);
    r.m.tick(r.now);
    r.m.on_shown(kMapScene, r.now);
    r.slot(kMapSlot, 2, kStockMap);
    r.m.on_lost(kMapScene, "fetch removed", r.now);
    joined();
    r.m.want(0, true, false);   /* the contending layer goes; a yielding one stays */
    r.run(3000);
    ok("on the ladder, the contending layer gone: the stock map's slot is not asked for",
       joined().find("request") == std::string::npos && r.m.status(0).holder == Holder::Stock &&
           r.m.status(0).retry_ms == -1);
}

static void lost_to_our_own_id()
{
    std::vector<std::string> evidence;
    auto shown_panel = [&](Rig &r) {
        r.m.on_evidence = [&](Evidence e, const std::string &, int64_t) { evidence.push_back(evidence_name(e)); };
        r.m.want(1, true, false);
        r.m.tick(r.now);
        r.m.on_shown(kPanelScene, r.now);
        r.slot(kPanelSlot, 2, kPanelScene);   /* the table names our mapping */
        joined();
    };
    Rig a;
    shown_panel(a);
    a.m.on_lost(kPanelScene, "fetch removed", a.now);
    ok("lost while the table names our id: undecided, the table asked for, no evidence yet",
       a.m.status(1).state == TargetState::Waiting && evidence.empty() &&
           joined() == "release panel; unpublish panel; slots?");
    a.slot(kPanelSlot, 2, kPanelScene);   /* after our unfetch it still names that id */
    a.m.tick(a.now);
    ok("the next report still names it: the stock HMI's (the speech dialog), yielded to, no evidence",
       a.m.status(1).holder == Holder::Stock && a.m.status(1).retry_ms == -1 && evidence.empty());

    Rig b;
    shown_panel(b);
    b.m.on_lost(kPanelScene, "fetch removed", b.now);
    b.slot(kPanelSlot, 1, 0);
    b.m.tick(b.now);
    ok("the next report shows it free: the loss was ours, evidence, and the ladder",
       evidence.size() == 1 && evidence[0] == std::string("scene removed") && b.m.status(1).retry_ms == b.now + 2000);

    Rig c;
    evidence.clear();
    shown_panel(c);
    c.m.on_lost(kPanelScene, "fetch removed", c.now);
    c.run(990);
    const bool waited = evidence.empty();
    c.run(20);
    ok("no report within 1 s: the loss was ours", waited && evidence.size() == 1);
    ok("and the ladder counts from the loss", c.m.status(1).retry_ms == c.now - 1010 + 2000);

    Rig d;
    std::vector<std::string> ev2;
    d.m.on_evidence = [&](Evidence e, const std::string &, int64_t) { ev2.push_back(evidence_name(e)); };
    d.m.want(0, true, false);
    d.m.tick(d.now);
    d.m.on_shown(kMapScene, d.now);
    d.slot(kMapSlot, 1, kMapScene);   /* a removal: the slot available, our content still named */
    d.m.on_lost(kMapScene, "fetch removed", d.now);
    ok("removed with the slot shown available: evidence at once, and the ladder",
       ev2.size() == 1 && d.m.status(0).retry_ms == d.now + 2000);
}

static void wake()
{
    Rig r;
    ok("no timer when idle", r.m.wake_in_ms(r.now) == -1);
    r.m.want(0, true, false);
    r.m.tick(r.now);
    ok("acquiring wakes at the start timeout", r.m.wake_in_ms(r.now) == 5000);
    r.m.on_shown(kMapScene, r.now);
    r.m.want(0, false, false);
    r.m.tick(r.now);
    ok("lingering wakes at its end", r.m.wake_in_ms(r.now) == 2000);
}

int main()
{
    refcount_and_linger();
    timeout_and_ladder();
    stock_yield();
    stock_contend();
    foreign_always_yields();
    idle_precheck();
    busy_refusal_unknown_holder();
    availability();
    shared_scene_id();
    request_gap();
    lost_while_lingering();
    scene_failure();
    ladder_rechecks_the_table();
    lost_to_our_own_id();
    wake();
    std::printf(failures ? "%d FAILED\n" : "all ok\n", failures);
    return failures ? 1 : 0;
}
