// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* Host test of the map feed (map_feed.h) against the shared cluster renderer
 * (cluster-render, the CR tree) on fake display backends, over its socket:
 * - the map is a contending content layer on the map target, covering the
 *   1088x480 slot; before a frame the app sees idle, with the first frames
 *   the slot is asked for (starting) and the map shown with the frames as
 *   they were decoded;
 * - the stock map taking the slot shows as starting with that reason; the
 *   contending map asks again, parks behind it, takes it over and is shown,
 *   the stock map parked behind it;
 * - a control start moves it to the whole panel, centred at 416,120, and an
 *   unknown target is refused;
 * - frames stopping: idle after stall_ms, the slot released;
 * - the renderer restarting: starting while it is gone, an error once it
 *   stays gone 15 s, then the map again with the next frames;
 * - a lowered shared upload cap shows on the status line, with its reason in
 *   the status, and leaves the line once it is back at the ceiling;
 * - frames offered faster than they can be written are newest-wins;
 * - the stream not live: the layer hidden, idle, the slot released and the
 *   stock map back; live again: shown with the frames; frozen: hidden, the
 *   status says so; no longer frozen: shown again;
 * - before the stream is live the layer is made hidden;
 * - the status is logged when its state, reason or target changes, not for
 *   the frame rate, the page or the upload cap. */
#include <poll.h>
#include <signal.h>
#include <unistd.h>

#include <cstdio>
#include <memory>
#include <string>
#include <vector>

/* cluster-render's service and fakes, from its tree (-I$(CR)) */
#include "src/service.h"
#include "test/fake_graph.h"
#include "test/fake_port.h"
#include "../src/map_feed.h"

using namespace woc;

static int failures;

static void ok(const char *name, bool cond)
{
    std::printf("%-4s %s\n", cond ? "ok" : "FAIL", name);
    if (!cond) failures++;
}

static int rigs;

struct Rig {
    std::string path = "/tmp/woc-feed-test-" + std::to_string(getpid()) + "-" + std::to_string(++rigs) + ".sock";
    crs::FakeGpu gpu;
    crs::FakePort port;
    crs::ServiceConfig sc;
    std::unique_ptr<crs::Service> svc;
    std::unique_ptr<MapFeed> feed;
    int64_t now = 200000;
    std::vector<uint8_t> spare;   /* the buffer handed to the feed, as the producer's */

    Rig()
    {
        crs::TargetSpec m, p;
        m.name = "map"; m.slot = 0x100; m.scene_id = 0x010004f0; m.width = 1088; m.height = 480; m.linger_ms = 1500;
        m.take_over_stock = true;   /* as cluster-render.conf ships it */
        p.name = "panel"; p.slot = 0x203; p.scene_id = 0x01000400; p.width = 1920; p.height = 720; p.linger_ms = 3000;
        sc.targets = {m, p};
        sc.socket_path = path;
        sc.backend = "fake";
        start();
        FeedConfig fc;
        fc.socket = path;
        fc.video.level_bits = 0;
        feed.reset(new MapFeed(fc));
        feed->set_stream(true, false);
    }
    void start()
    {
        svc.reset(new crs::Service(&gpu, &port, sc));
        port.m = &svc->slots();
        port.pending.clear();
        std::string err;
        if (!svc->start(&err))
            std::printf("start: %s\n", err.c_str());
    }
    /* Simulated time; each step runs the socket exchange until idle. */
    void pump(int64_t ms, const std::vector<uint8_t> *frame = nullptr, int64_t frame_every = 65)
    {
        for (int64_t t = 0; t < ms; t += 5) {
            now += 5;
            if (frame && t % frame_every == 0) {
                spare.assign(frame->begin(), frame->end());
                feed->offer(&spare, (uint64_t)now, now);
            }
            for (int round = 0; round < 400; round++) {
                std::vector<pollfd> fds;
                size_t first = 0;
                if (svc)
                    first = svc->poll_fds(&fds);
                const int n = ::poll(fds.data(), fds.size(), 0);
                if (svc) {
                    port.tick(now);
                    svc->after_poll(fds, first, now);
                }
                const bool pending = feed->wants_write();
                feed->poll(now);
                if (round > 0 && n <= 0 && !pending)
                    break;
            }
        }
    }
    FeedStatus st() { return feed->status("decode"); }
    const crs::Layer *map_layer()
    {
        for (const crs::Layer *l : svc->compositor().layers())
            return l;
        return nullptr;
    }
};

static std::vector<uint8_t> atlas(int seed)
{
    std::vector<uint8_t> f(1088 * 720);
    for (size_t i = 0; i < f.size(); i++)
        f[i] = (uint8_t)(i < 1088 * 480 ? (i / 5 + seed * 17) & 0xff : 128);
    return f;
}

int main()
{
    signal(SIGPIPE, SIG_IGN);
    setvbuf(stdout, nullptr, _IONBF, 0);
    Rig r;
    r.pump(100);
    const crs::Layer *l = r.map_layer();
    ok("connected: one contending content layer on the map target, covering the 1088x480 slot",
       l && l->target() == 0 && l->params.contend && l->params.klass == crs::Klass::Content && l->params.rect.x == 0 &&
           l->params.rect.y == 0 && l->params.rect.w == 1088 && l->params.rect.h == 480);
    ok("no frame yet: idle, and the slot is not asked for", r.st().state == "idle" && r.port.requests == 0);

    const std::vector<uint8_t> f1 = atlas(1);
    r.pump(20, &f1);
    ok("the first frame asks for the slot: starting", r.st().state == "starting" && r.port.requests == 1);
    r.pump(1100, &f1);
    crs::FakeGraph *g = r.gpu.graph("map");
    bool drawn = false;
    if (g)
        for (const auto &kv : g->shown.buffers)
            drawn = drawn || (kv.second.f == crs::TexFormat::R8 && kv.second.px == f1);
    ok("granted: showing, with the decoded frame in the slot's scene",
       r.st().state == "showing" && drawn && r.st().page.find("Waze map — ") == 0);
    ok("the status line counts the frames handed over", r.st().page.find("15 frames/s") != std::string::npos);
    const std::string lost = "Stream lost — restarting CarPlay";   /* until the layer stalls */
    ok("showing carries the stream's reason", r.feed->status("decode", lost).state == "showing" &&
                                                  r.feed->status("decode", lost).reason == lost &&
                                                  r.feed->status("decode", lost).stream_reason);

    r.port.steal(r.sc.targets[0]);
    r.pump(20, &f1);
    ok("the stock map takes the slot: starting, with that reason",
       r.st().state == "starting" && r.st().reason == "the stock map holds the slot");
    r.pump(2200, &f1);
    const crs::SlotInfo *ours = r.port.row(0x100, 0x010004f0), *stock = r.port.row(0x100, 0x01000101);
    ok("the map contends: it takes the stock map over and is shown, the stock map parked behind it",
       r.st().state == "showing" && r.port.requests == 2 && r.port.taken_over.size() == 1 &&
           r.port.taken_over[0] == 0x01000101 && ours && ours->map_status == 1 && stock && stock->map_status == 3);

    /* Many frames between two writes: only the newest is drawn. */
    const std::vector<uint8_t> f2 = atlas(2), f3 = atlas(3);
    std::vector<uint8_t> b2 = f2, b3 = f3;
    r.feed->offer(&b2, 2, r.now);
    r.feed->offer(&b3, 3, r.now);
    ok("a frame is taken without a copy: a same-size buffer comes back for each",
       b2.size() == f2.size() && b3.size() == f3.size() && b3 == f2);
    r.pump(200);
    g = r.gpu.graph("map");
    bool newest = false, stale = false;
    for (const auto &kv : g->shown.buffers)
        if (kv.second.f == crs::TexFormat::R8) {
            newest = newest || kv.second.px == f3;
            stale = stale || kv.second.px == f2;
        }
    ok("frames faster than the writes: the newest is drawn", newest && !stale);

    ok("an unknown target is refused", !r.feed->set_target("cockpit"));
    ok("a control start moves the map to the whole panel", r.feed->set_target("panel"));
    r.pump(1200, &f3);
    l = r.map_layer();
    ok("centred in the 1920x720 panel at 416,120, showing",
       l && l->target() == 1 && l->params.rect.x == 416 && l->params.rect.y == 120 && l->params.rect.w == 1088 &&
           r.st().state == "showing" && r.st().target == "panel");
    r.pump(1600);
    ok("the map target, no longer wanted, is released after its linger",
       r.port.releases >= 1 && !r.port.row(0x100, 0x010004f0));
    r.feed->set_target("sail");
    r.pump(1200, &f3);
    ok("sail is the map slot", r.map_layer() && r.map_layer()->target() == 0 && r.st().state == "showing");

    const int releases = r.port.releases;
    r.pump(6100);
    ok("frames stop: idle after stall_ms", r.st().state == "idle");
    const std::string waiting = "Stream lost — reconnect CarPlay";
    ok("idle while the stream is live carries the stream's reason", r.feed->status("decode", waiting).reason == waiting);
    r.pump(2000);   /* the fade out, then the linger */
    ok("and the slot is released after the linger",
       r.port.releases > releases && !r.port.row(0x100, 0x010004f0));

    r.svc.reset();
    r.pump(100);
    ok("the renderer gone: starting while it may be starting", r.st().state == "starting" &&
                                                               r.st().reason == "waiting for the cluster renderer");
    r.pump(15000);
    ok("still gone 15 s on: an error the app shows", r.st().state == "error" &&
                                                     r.st().reason == "cluster renderer not reachable");
    r.start();
    r.pump(3000, &f1);
    ok("it comes back: the map layer made again, showing with the next frames",
       r.map_layer() && r.st().state == "showing");

    /* the governor counts evidence seen while writes go */
    r.svc->compositor().governor().activity(r.now);
    r.svc->compositor().governor().evidence(crs::Evidence::Removal, r.now);
    r.pump(100, &f1);
    ok("a lowered shared upload cap shows on the status line",
       r.st().page.find("upload cap 5000 KB/s") != std::string::npos);
    ok("the status carries the cap and why",
       r.st().upload_cap_kb == 5000 && r.st().upload_reason.find("lowered from 5500 KB/s") == 0 &&
           r.st().upload_reason.find("scene removed") != std::string::npos);
    /* A minute of healthy upload raises it back to the ceiling, which the
     * status line leaves out. */
    for (int s = 0; s < 62; s++) {
        r.svc->compositor().governor().activity(r.now);
        r.pump(1000, &f1);
    }
    ok("back at the ceiling after healthy upload: the cap leaves the status line, its reason stays",
       r.st().upload_cap_kb == 5500 && r.st().page.find("upload cap") == std::string::npos &&
           r.st().upload_reason.find("raised from 5000 KB/s") == 0);
    /* the stream's liveness drives the layer, whatever the frames do */
    const int before = r.port.releases;
    r.feed->set_stream(false, false);
    r.pump(2000, &f1);   /* the fade out, then the linger */
    stock = r.port.row(0x100, 0x01000101);
    ok("the stream not live: the layer hidden, idle, and the slot released, the parked stock map shown",
       r.map_layer() && !r.map_layer()->params.visible && r.st().state == "idle" && r.port.releases > before &&
           !r.port.row(0x100, 0x010004f0) && stock && stock->map_status == 1);
    ok("and no stream reason", r.feed->status("decode", waiting).reason.empty());
    r.feed->set_stream(true, false);
    r.pump(1200, &f1);
    ok("live again: visible and showing with the frames", r.map_layer()->params.visible && r.st().state == "showing");
    r.feed->set_stream(true, true);
    r.pump(100, &f1);
    ok("frozen: hidden, and the status says why",
       !r.map_layer()->params.visible && r.st().state == "frozen" && r.st().reason == "the phone's cluster stream froze");
    r.feed->set_stream(true, false);
    r.pump(1200, &f1);
    ok("no longer frozen: shown again", r.map_layer()->params.visible && r.st().state == "showing");

    Rig h;
    h.feed->set_stream(false, false);
    h.svc.reset();
    h.start();
    h.pump(3000, &f1);
    ok("a layer made while the stream is not live is hidden: idle, the slot not asked for",
       h.map_layer() && !h.map_layer()->params.visible && h.st().state == "idle" && h.port.requests == 0);

    StatusLog sl;
    FeedStatus a;
    a.state = "showing";
    a.target = "map";
    a.page = "Waze map — 15 frames/s";
    int64_t t = 1000000;
    ok("status log: the first status", sl.due(a, t));
    a.page = "Waze map — 14 frames/s";
    a.upload_cap_kb = 5500;
    a.upload_reason = "slow flushes";
    ok("status log: not for the page or the upload cap", !sl.due(a, t));
    a.reason = "Stream lost — reconnect CarPlay";
    a.stream_reason = true;
    ok("status log: the stream's reason", sl.due(a, t));
    a.reason.clear();
    a.stream_reason = false;
    ok("status log: the stream whole again within 10 s waits", !sl.due(a, t + 2000));
    a.reason = "Stream lost — reconnect CarPlay";
    a.stream_reason = true;
    ok("status log: so does its next loss; the logged reason is the same, nothing to log",
       !sl.due(a, t + 4000) && !sl.due(a, t + 10000));
    a.reason.clear();
    a.stream_reason = false;
    ok("status log: a change still standing 10 s after the last such line is logged",
       !sl.due(a, t + 9000) && sl.due(a, t + 10500));
    a.state = "idle";
    a.reason = "Stream lost — reconnect CarPlay";
    a.stream_reason = true;
    ok("status log: a state change is logged at once, with its reason", sl.due(a, t + 11000));
    a.state = "starting";
    a.reason = "the stock map holds the slot";
    a.stream_reason = false;
    ok("status log: a state and reason", sl.due(a, t + 11100));
    ok("status log: the same again is not", !sl.due(a, t + 11200));
    a.reason = "another app holds the slot";
    ok("status log: a reason of the feed's own alone, at once", sl.due(a, t + 11300));
    a.target = "panel";
    ok("status log: a target alone", sl.due(a, t + 11400));

    std::printf(failures ? "%d FAILED\n" : "all ok\n", failures);
    return failures ? 1 : 0;
}
