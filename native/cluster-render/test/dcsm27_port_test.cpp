/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 IterioDev */
/* Host test for the iDrive 8 port (dcsm27_port.h) under the slot manager:
 * a request is an offer, parked once accepted, with no timeout, until the
 * cluster shows it; the cluster's ready request is answered; hide and
 * release park it again and keep the offer; release is a stop of the offer,
 * the scene going only once the cluster accepts it, and a request before
 * then waiting on the ladder (no new scene meanwhile); a refused offer
 * waits on the ladder and is offered again; events
 * for content not offered, or stopping, are ignored; two targets go their
 * own ways; the framework going away forgets everything. */
#include <cstdio>
#include <set>
#include <string>
#include <vector>

#include "../src/dcsm27_port.h"
#include "log.h"

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

struct Wire : Dcsm27Wire {
    bool refuse = false;
    bool offer(const TargetSpec &t, std::string *why) override
    {
        calls.push_back("offer " + std::to_string(t.content) + " in " + std::to_string(t.slot));
        if (refuse)
            *why = "failure to send sendOfferContent message";
        return !refuse;
    }
    bool stop_offer(uint64_t c, std::string *) override
    {
        calls.push_back("stop " + std::to_string(c));
        return true;
    }
    bool ready(uint64_t c, std::string *) override
    {
        calls.push_back("ready " + std::to_string(c));
        return true;
    }
};

/* As Ramses27Gpu: a scene taken down while its content is offered or
 * stopping is retired until its offer is gone (on_stopped), and no new scene
 * with its id is built meanwhile. */
struct Scenes27 : Scenes {
    std::set<uint64_t> retired;
    std::function<bool(uint64_t)> offered;
    int published = 0;
    bool publish(const TargetSpec &t, std::string *err) override
    {
        if (retired.count(t.scene_id)) {
            *err = "its last offer is still stopping";
            return false;
        }
        published++;
        return true;
    }
    void unpublish(const TargetSpec &t) override
    {
        if (offered(t.scene_id))
            retired.insert(t.scene_id);
    }
};

static const uint64_t kCentre = 43204041, kWidget = 43204001;

struct Rig {
    Wire wire;
    Scenes27 scenes;
    Dcsm27Port port{&wire};
    SlotManager m{&port, &scenes};
    std::vector<std::string> evidence;
    std::vector<uint64_t> stopped;   /* scenes whose offer is gone */
    int64_t now = 10000;
    Rig()
    {
        port.on_stopped = [this](uint64_t scene) {
            stopped.push_back(scene);
            scenes.retired.erase(scene);
        };
        scenes.offered = [this](uint64_t scene) { return port.holds(scene); };
        TargetSpec a;
        a.name = "map"; a.slot = 43100201; a.content = kCentre; a.scene_id = 0x4d4755000108;
        a.width = 874; a.height = 749; a.linger_ms = 0;
        TargetSpec b;
        b.name = "widget"; b.slot = 43100301; b.content = kWidget; b.scene_id = 0x4d4755000001;
        b.width = 2240; b.height = 896; b.linger_ms = 3000;
        m.add(a);
        m.add(b);
        port.set_manager(&m);
        m.on_evidence = [this](Evidence e, const std::string &d, int64_t) {
            evidence.push_back(std::string(evidence_name(e)) + " " + d);
        };
        port.on_availability(true, now);
        now += 1500;
    }
    /* One pass of the unit's loop: the slot manager, then the answers. */
    void tick()
    {
        m.tick(now += 10);
        port.dispatch(now);
    }
    /* The map offered and parked. */
    void offered(int t = 0)
    {
        m.want(t, true, false);
        tick();
        calls.clear();
    }
};

static void basics()
{
    Rig r;
    r.m.want(0, true, true);
    r.m.tick(r.now += 10);
    ok("a request is an offer of the target's content in its category", calls_are("offer 43204041 in 43100201"));
    ok("answered in the next dispatch: acquiring until then", r.m.status(0).state == TargetState::Acquiring);
    r.port.dispatch(r.now);
    ok("an accepted offer is parked", r.m.status(0).state == TargetState::Parked &&
                                          r.m.status(0).holder == Holder::None);
    for (int k = 0; k < 1000; k++)
        r.tick();
    ok("10 s parked: no timeout, nothing sent", r.m.status(0).state == TargetState::Parked && calls_are(""));

    ContentArea a;
    a.has_render = a.has_rect = true;
    a.render_w = 874; a.render_h = 749;
    a.rect.w = 874; a.rect.h = 749;
    r.port.on_size(kCentre, a, r.now);
    r.port.on_ready_requested(kCentre, r.now);
    ok("the cluster's size taken, its ready request answered", calls_are("ready 43204041") &&
                                                                   r.m.status(0).state == TargetState::Parked);
    r.port.on_show(kCentre, r.now);
    ok("contentShow: shown", r.m.status(0).state == TargetState::Shown);
    r.port.on_hide(kCentre, r.now);
    ok("contentHide: parked, still offered", r.m.status(0).state == TargetState::Parked && calls_are(""));
    r.port.on_show(kCentre, r.now);
    r.port.on_release(kCentre, r.now);
    ok("contentRelease (a layout change): parked, still offered, no evidence",
       r.m.status(0).state == TargetState::Parked && calls_are("") && r.evidence.empty());
    r.port.on_ready_requested(kCentre, r.now);
    r.port.on_show(kCentre, r.now);
    ok("asked again and shown again", calls_are("ready 43204041") && r.m.status(0).state == TargetState::Shown);

    r.m.want(0, false, false);
    r.tick();
    r.tick();
    ok("not wanted (linger 0): the offer stops", calls_are("stop 43204041") &&
                                                    r.m.status(0).state == TargetState::Idle);
    r.port.on_show(kCentre, r.now);
    r.port.on_ready_requested(kCentre, r.now);
    ok("stopping: a late show is ignored, ready is not answered", calls_are("") &&
                                                                     r.m.status(0).state == TargetState::Idle);
    r.tick();
    ok("the scene stays until the cluster accepts the stop", r.stopped.empty());
    r.port.on_stop_accepted(kCentre, r.now);
    r.tick();
    ok("the stop accepted: nothing more sent, the scene may go", calls_are("") &&
                                                                    r.m.status(0).state == TargetState::Idle &&
                                                                    r.stopped.size() == 1 &&
                                                                    r.stopped[0] == 0x4d4755000108);
    r.port.on_show(kCentre, r.now);
    ok("events for content not offered are ignored", r.m.status(0).state == TargetState::Idle);
}

static void restop()
{
    Rig r;
    r.offered();
    r.port.on_show(kCentre, r.now);
    r.m.want(0, false, false);
    r.tick();
    r.tick();
    ok("released: the offer stopping", calls_are("stop 43204041"));
    TargetSpec centre;
    centre.content = kCentre;
    ok("its scene stays published, warm, the release not confirmed",
       r.m.published(0) && r.scenes.retired.empty() && !r.port.confirmed(centre));
    r.m.want(0, true, false);
    for (int k = 0; k < 50; k++)
        r.tick();
    ok("wanted again before the stop is accepted: no offer (the library would refuse it), waiting for it",
       calls_are("") && r.m.status(0).state == TargetState::Idle && r.evidence.empty());
    r.port.on_stop_accepted(kCentre, r.now);
    ok("the stop accepted: confirmed", r.port.confirmed(centre));
    for (int k = 0; k < 60; k++)
        r.tick();
    ok("offered again after the request gap in the same scene, and parked",
       calls_are("offer 43204041 in 43100201") && r.m.status(0).state == TargetState::Parked &&
           r.stopped.size() == 1 && r.scenes.published == 1);

    Rig s;
    s.offered();
    s.m.want(0, false, false);
    s.tick();
    s.tick();
    calls.clear();
    s.m.want(0, true, false);
    for (int k = 0; k < 110; k++)
        s.tick();
    ok("no acceptance within kConfirmMs: asked anyway, refused without an offer, the ladder",
       calls_are("") && s.m.status(0).state == TargetState::Waiting && s.m.status(0).retry_ms > 0 &&
           s.m.status(0).reason.find("not accepted yet") != std::string::npos && s.evidence.empty());
    s.port.on_stop_accepted(kCentre, s.now);
    for (int k = 0; k < 250; k++)
        s.tick();
    ok("offered again at the ladder's first step, and parked",
       calls_are("offer 43204041 in 43100201") && s.m.status(0).state == TargetState::Parked);

    Rig c;
    c.offered();
    c.m.want(0, false, false);
    c.tick();
    c.now += 1000;
    c.m.want(0, true, false);
    c.tick();
    c.m.want(0, false, false);
    for (int k = 0; k < 1000; k++)
        c.tick();
    calls.clear();
    c.port.on_stop_accepted(kCentre, c.now);
    ok("wanted again, then not, before the stop is accepted: not offered", calls_are("") &&
                                                                             c.m.status(0).state == TargetState::Idle);
}

static void refused()
{
    Rig r;
    r.wire.refuse = true;
    r.m.want(0, true, true);
    r.tick();
    ok("a refused offer waits on the ladder, no evidence",
       calls_are("offer 43204041 in 43100201") && r.m.status(0).state == TargetState::Waiting &&
           r.m.status(0).retry_ms > 0 && r.m.status(0).reason.find("sendOfferContent") != std::string::npos &&
           r.evidence.empty());
    r.tick();
    ok("its scene may go at once: nothing to stop", r.stopped.size() == 1 && r.stopped[0] == 0x4d4755000108);
    r.wire.refuse = false;
    for (int k = 0; k < 250; k++)
        r.tick();
    ok("offered again at the ladder's first step", calls_are("offer 43204041 in 43100201") &&
                                                      r.m.status(0).state == TargetState::Parked);
}

static void two_targets()
{
    Rig r;
    r.m.want(0, true, false);
    r.m.want(1, true, false);
    r.tick();
    ok("map and widget offered at once", calls_are("offer 43204041 in 43100201; offer 43204001 in 43100301") &&
                                             r.m.status(0).state == TargetState::Parked &&
                                             r.m.status(1).state == TargetState::Parked);
    r.port.on_show(kWidget, r.now);
    ok("the widget picked: only it shown", r.m.status(1).state == TargetState::Shown &&
                                               r.m.status(0).state == TargetState::Parked);
    r.m.want(1, false, false);
    r.tick();
    ok("not wanted: the widget lingers", r.m.status(1).state == TargetState::Lingering && calls_are(""));
    r.port.on_hide(kWidget, r.now);
    ok("hidden while lingering: released at once", calls_are("stop 43204001") &&
                                                       r.m.status(1).state == TargetState::Idle &&
                                                       r.m.status(0).state == TargetState::Parked);
}

static void gone()
{
    Rig r;
    r.offered();
    r.port.on_show(kCentre, r.now);
    const int errors = cld::log_errors;
    ContentArea a;
    a.has_render = true;
    a.render_w = 1000; a.render_h = 500;
    r.port.on_size(kCentre, a, r.now);
    ok("a canvas other than the target's is a warning, not an error", cld::log_errors == errors);
    r.port.on_availability(false, r.now);
    ok("the framework gone: unavailable, nothing sent", r.m.status(0).state == TargetState::Unavailable &&
                                                            calls_are(""));
    r.port.on_show(kCentre, r.now);
    r.port.on_stop_accepted(kCentre, r.now);
    ok("later events are ignored", r.m.status(0).state == TargetState::Unavailable && calls_are(""));
}

int main()
{
    basics();
    restop();
    refused();
    two_targets();
    gone();
    std::printf(failures ? "%d FAILED\n" : "all ok\n", failures);
    return failures ? 1 : 0;
}
