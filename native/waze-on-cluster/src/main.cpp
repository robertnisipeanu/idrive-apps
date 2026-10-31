// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* waze-on-cluster: decode the captured CarPlay 2nd-screen H.264 (the Waze/Maps
 * cluster map) and hand it to the shared cluster renderer (cluster-render),
 * which draws it in a cluster slot. The service runs from boot, so it decodes
 * from the stream's first keyframe; the map goes up with the first decoded
 * frame and comes down after the frames stop (map_feed.h). The control socket
 * reports its status and log to the Waze app.
 *
 *   waze-on-cluster [-c FILE] [-s key=value]...     serve the control socket
 *   waze-on-cluster [-c FILE] run sail|map|panel|hud
 *                                                   map that target from now on,
 *                                                   and follow the status from a shell
 *                                                   (sail = map, the native central-map slot)
 *   waze-on-cluster [-c FILE] bench-pack I420_FILE  time the packed-motion packing
 *
 * The H.264 reaches this tool through the sink the carplay patch points at
 * (patch/carplay_patch.js --sink/--capture), after the patch advertises the 2nd
 * display and makes CarPlay self-start the stream (PATCH.md Edits 1 and 3). It
 * receives on the media bus (avb_stream, the AVB capture mode), a local UDP
 * socket (udp_port) and the FIFO. README.md. */
#include <algorithm>
#include <cerrno>
#include <chrono>
#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fcntl.h>
#include <poll.h>
#include <pthread.h>
#include <sys/signalfd.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>
#include <vector>

#include "config.h"
#include "control.h"
#include "log.h"
#include "block_pack.h"
#include "map_feed.h"
#include "map_geometry.h"
#include "video_producer.h"
#include "yuv_atlas.h"

using namespace cld;
using namespace woc;
using crk::atlas_height;
using crk::block_bytes;
using crk::pack_blocks;
using crk::texture_size_error;

namespace {

/* Accepted and ignored, so a local_conf that sets them still starts the
 * service: the map is drawn by the shared renderer, whose own configuration
 * owns the slots, scene ids and the upload budget. */
const char *const kIgnoredKeys[] = {"tex_format",         "upload",          "dirty_tiles",
                                    "max_frame_textures", "resource_linger_ms", "resource_fetch_log",
                                    "texture_replay",     "texture_replay_frames", "mutable_r8",
                                    "upload_kb_per_s",    "upload_burst_ms"};

volatile sig_atomic_t g_stop;
void on_signal(int) { g_stop = 1; }

std::string status_line(const FeedStatus &s)
{
    return "{\"ev\":\"status\",\"state\":" + json_escape(s.state) + ",\"target\":" + json_escape(s.target) +
           ",\"page\":" + json_escape(s.page) + ",\"reason\":" + json_escape(s.reason) +
           ",\"upload_cap_kb_per_s\":" + std::to_string(s.upload_cap_kb) +
           ",\"upload_reason\":" + json_escape(s.upload_reason) + "}";
}

class Server : public Control::Handler {
public:
    explicit Server(MapFeed *feed) : feed_(feed) {}
    void set_control(Control *c) { control_ = c; }

    /* start picks the target the map goes to (`run`); the map itself comes
     * and goes with the stream. */
    void on_command(const std::map<std::string, std::string> &msg) override
    {
        const std::string &cmd = msg.at("cmd");
        auto it = msg.find("target");
        if (cmd == "start" && it != msg.end()) {
            log_info("start %s", it->second.c_str());
            if (!feed_->set_target(it->second))
                log_warn("start: the cluster renderer has no target %s", it->second.c_str());
        } else {
            log_warn("control: unknown command %s", cmd.c_str());
        }
    }
    void on_owner_connected() override
    {
        log_seq_ = 0;
        last_.clear();
    }
    /* The map does not depend on the app: it stays while CarPlay is on the
     * CID and the app's page is hidden. */
    void on_owner_gone() override {}

    void report(const std::string &status)
    {
        if (control_->owner_fd() < 0)
            return;
        if (status != last_) {
            last_ = status;
            control_->send(status);
        }
        std::vector<std::string> lines;
        log_lines_since(&log_seq_, &lines);
        for (const std::string &l : lines)
            control_->send("{\"ev\":\"log\",\"line\":" + json_escape(l) + "}");
    }

private:
    MapFeed *feed_;
    Control *control_ = nullptr;
    uint64_t log_seq_ = 0;
    std::string last_;
};

/* Files next to the FIFO, in the render's own RuntimeDirectory, which it can
 * write: status.json, probe.txt and stream.json, for the remote diagnostics
 * and patchd, read without taking the control socket's owner slot. 0644,
 * world-readable. */
void write_sibling_file(const std::string &fifo_path, const char *name, const std::string &content)
{
    std::string::size_type slash = fifo_path.find_last_of('/');
    if (slash == std::string::npos)
        return;
    std::string path = fifo_path.substr(0, slash) + "/" + name;
    std::string tmp = path + ".tmp";
    int fd = open(tmp.c_str(), O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (fd < 0)
        return;
    std::string line = content + "\n";
    ssize_t n = write(fd, line.data(), line.size());
    close(fd);
    if (n == (ssize_t)line.size())
        rename(tmp.c_str(), path.c_str());
    else
        unlink(tmp.c_str());
}

int serve(const Config &cfg)
{
    VideoConfig vc;
    vc.fifo_path = cfg.str("fifo_path");
    vc.carplay_group = cfg.str("carplay_group");
    vc.udp_port = (uint16_t)cfg.num("udp_port");
    vc.avb_stream = cfg.str("avb_stream");
    vc.drm_device = cfg.str("drm_device");
    if (!cfg.size("tex_size", &vc.tex_width, &vc.tex_height)) {
        log_error("tex_size must be WxH");
        return 1;
    }
    if (const char *e = texture_size_error(vc.tex_width, vc.tex_height)) {
        log_error("tex_size %ux%u: %s", vc.tex_width, vc.tex_height, e);
        return 1;
    }
    for (const char *key : kIgnoredKeys)
        if (cfg.has(key))
            log_warn("%s = %s is ignored: the upload budget is the cluster renderer's "
                     "(upload_kb_per_s in /var/opt/cluster-render/cluster-render.local.conf)", key, cfg.str(key).c_str());
    struct Range { const char *key; long lo, hi; } ranges[] = {
        {"dirty_threshold", 0, 64}, {"dirty_settle_ms", 0, 3600000}, {"tex_level_bits", 0, 3},
        {"target_fps", 0, 60},      {"pan_blocks", 0, 1},            {"stall_ms", 1000, 600000}};
    for (const Range &r : ranges)
        if (cfg.num(r.key) < r.lo || cfg.num(r.key) > r.hi) {
            log_error("%s must be from %ld to %ld", r.key, r.lo, r.hi);
            return 1;
        }
    vc.tex_level_bits = (uint32_t)cfg.num("tex_level_bits");
    vc.stall_ms = (int)cfg.num("stall_ms");

    FeedConfig fc;
    fc.socket = cfg.str("render_socket");
    fc.target = cfg.str("target");
    fc.video.w = vc.tex_width;
    fc.video.h = vc.tex_height;
    fc.video.fps = (unsigned)cfg.num("target_fps");
    fc.video.level_bits = 0;   /* rounded on the decoder thread (video_producer.h) */
    fc.video.dirty_threshold = (unsigned)cfg.num("dirty_threshold");
    fc.video.settle_ms = (unsigned)cfg.num("dirty_settle_ms");
    fc.video.pan_blocks = cfg.num("pan_blocks") == 1 && vc.tex_height % 4 == 0;
    fc.video.stall_ms = (unsigned)vc.stall_ms;

    sigset_t sigs;
    sigemptyset(&sigs);
    sigaddset(&sigs, SIGINT);
    sigaddset(&sigs, SIGTERM);
    pthread_sigmask(SIG_BLOCK, &sigs, nullptr);
    int sig_fd = signalfd(-1, &sigs, SFD_CLOEXEC);
    if (sig_fd < 0) { log_error("signalfd: %s", strerror(errno)); return 1; }

    std::string err;
    VideoProducer producer(vc);
    MapFeed feed(fc);
    Server server(&feed);
    Control control(&server);
    server.set_control(&control);
    if (!control.listen(cfg.str("socket_path"), (unsigned)std::strtoul(cfg.str("socket_mode").c_str(), nullptr, 8),
                        cfg.str("socket_group"), &err)) {
        log_error("%s", err.c_str());
        return 1;
    }

    std::vector<uint8_t> frame;
    int64_t last_status_write = 0;
    for (;;) {
        struct pollfd p[5] = {{sig_fd, POLLIN, 0}, {control.listen_fd(), POLLIN, 0}, {control.owner_fd(), POLLIN, 0},
                              {feed.fd(), (short)(POLLIN | (feed.wants_write() ? POLLOUT : 0)), 0},
                              {producer.ready_fd(), POLLIN, 0}};
        /* A decoded frame wakes it (the producer's ready fd), and so does the
         * renderer's socket; four times a second otherwise, so the client
         * retries its connection, a source that is down is retried and the
         * status files stay current. */
        int n = poll(p, 5, 250);
        if (n < 0 && errno != EINTR)
            break;
        if (p[0].revents & POLLIN)
            break;
        if (control.owner_fd() >= 0 && (p[2].revents & (POLLIN | POLLHUP | POLLERR)))
            control.on_owner_readable();
        if (p[1].revents & POLLIN)
            control.on_listen_readable();
        const int64_t now = now_ms();
        uint64_t id = 0;
        if (producer.take(&frame, &id))
            feed.offer(&frame, id, now);
        feed.poll(now);
        producer.retry_sources(now);
        const std::string status = status_line(feed.status(producer.decode_status()));
        if (feed.take_changed())
            log_info("status %s", status.c_str());
        server.report(status);
        if (now - last_status_write > 1000) {
            write_sibling_file(cfg.str("fifo_path"), "status.json", status);
            /* The framing probe and the renderer's own status (targets, the
             * map layer's writes, the upload cap), for the diagnostics. */
            producer.track_keyframe_wait(now);
            write_sibling_file(cfg.str("fifo_path"), "probe.txt", producer.probe_report() + feed.report());
            feed.request_report();
            /* For patchd's stream resync (PATCH.md "Stream resync"). */
            write_sibling_file(cfg.str("fifo_path"), "stream.json",
                               "{\"keyframe_wait_ms\":" + std::to_string(producer.keyframe_wait_ms(now)) + "}");
            last_status_write = now;
        }
    }
    log_info("stopped");
    return 0;
}

int run(const Config &cfg, const char *target)
{
    struct sigaction sa;
    std::memset(&sa, 0, sizeof sa);
    sa.sa_handler = on_signal;
    sigaction(SIGINT, &sa, nullptr);
    sigaction(SIGTERM, &sa, nullptr);

    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    struct sockaddr_un addr;
    std::memset(&addr, 0, sizeof addr);
    addr.sun_family = AF_UNIX;
    std::snprintf(addr.sun_path, sizeof addr.sun_path, "%s", cfg.str("socket_path").c_str());
    if (fd < 0 || connect(fd, (struct sockaddr *)&addr, sizeof addr) < 0) {
        std::fprintf(stderr, "waze-on-cluster: %s: %s\n", addr.sun_path, strerror(errno));
        return 1;
    }
    std::string start = "{\"cmd\":\"start\",\"target\":" + json_escape(target) + "}\n";
    if (write(fd, start.data(), start.size()) != (ssize_t)start.size())
        return 1;
    char buf[1024];
    while (!g_stop) {
        ssize_t n = read(fd, buf, sizeof buf);
        if (n <= 0)
            break;
        fwrite(buf, 1, (size_t)n, stdout);
        fflush(stdout);
    }
    close(fd);
    return 0;
}

bool load_local(Config *cfg, std::string *err)
{
    std::string path = cfg->str("local_conf");
    return path.empty() || access(path.c_str(), F_OK) != 0 || cfg->load(path, err);
}

void usage()
{
    std::fprintf(stderr,
                 "usage: waze-on-cluster [-c FILE] [-s key=value]... [run sail|map|panel|hud | bench-pack I420_FILE]\n");
}

/* Times pan_blocks' packing (4:2:0 to RGB and the block fit) of each
 * tex_size I420 frame in the file on 1 to 4 threads, ten rounds each. */
int bench_pack(const Config &cfg, const char *path)
{
    uint32_t w = 0, h = 0;
    if (!cfg.size("tex_size", &w, &h) || texture_size_error(w, h) || h % 4) {
        std::fprintf(stderr, "bench-pack: tex_size must be a valid map size with a height that is a multiple of 4\n");
        return 2;
    }
    FILE *f = std::fopen(path, "rb");
    if (!f) { std::fprintf(stderr, "bench-pack: %s: %s\n", path, strerror(errno)); return 2; }
    const size_t frame = (size_t)w * h * 3 / 2;
    std::vector<uint8_t> i420(frame);
    std::vector<std::vector<uint8_t>> atlases;
    while (atlases.size() < 64 && std::fread(i420.data(), 1, frame, f) == frame) {
        std::vector<uint8_t> a((size_t)w * atlas_height(h));
        std::memcpy(a.data(), i420.data(), (size_t)w * h);
        const uint8_t *u = i420.data() + (size_t)w * h, *v = u + (size_t)w / 2 * (h / 2);
        for (uint32_t y = 0; y < h / 2; y++) {
            std::memcpy(&a[(size_t)(h + y) * w], u + (size_t)y * (w / 2), w / 2);
            std::memcpy(&a[(size_t)(h + y) * w + w / 2], v + (size_t)y * (w / 2), w / 2);
        }
        atlases.push_back(std::move(a));
    }
    std::fclose(f);
    if (atlases.empty()) { std::fprintf(stderr, "bench-pack: no whole %ux%u frame in %s\n", w, h, path); return 2; }
    std::vector<uint8_t> out(block_bytes(w, h));
    std::printf("bench-pack: %zu frames of %ux%u, %zu B packed each\n", atlases.size(), w, h, out.size());
    for (unsigned threads = 1; threads <= 4; threads++) {
        double sum = 0, worst = 0;
        int n = 0;
        for (int round = 0; round < 10; round++)
            for (const std::vector<uint8_t> &a : atlases) {
                const auto t0 = std::chrono::steady_clock::now();
                pack_blocks(a.data(), w, h, out.data(), threads);
                const double ms =
                    std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
                sum += ms;
                worst = std::max(worst, ms);
                n++;
            }
        std::printf("bench-pack: %u thread%s: %.2f ms mean, %.2f ms max\n", threads, threads > 1 ? "s" : "",
                    sum / n, worst);
    }
    return 0;
}

}  // namespace

/* The keys beyond the shared Config's own that this tool reads. Registered
 * before any conf is loaded, so Config accepts them. */
void define_keys(Config *cfg)
{
    cfg->define("fifo_path", "/run/waze-on-cluster/alt.h264");
    cfg->define("carplay_group", "video");
    cfg->define("udp_port", "20557");
    cfg->define("avb_stream", "media_transport.avb_streaming.15");
    cfg->define("drm_device", "/dev/dri/renderD128");
    cfg->define("tex_size", "1088x480");
    cfg->define("dirty_threshold", "8");
    cfg->define("dirty_settle_ms", "1000");
    cfg->define("stall_ms", "6000");
    cfg->define("target_fps", "30");
    cfg->define("pan_blocks", "1");
    cfg->define("tex_level_bits", "2");
    cfg->define("target", "map");
    cfg->define("render_socket", "/dev/shm/cluster-render/render.sock");
    for (const char *key : kIgnoredKeys)
        cfg->define(key, "");
}

int main(int argc, char **argv)
{
    Config cfg;
    define_keys(&cfg);
    std::string err;
    int i = 1;
    for (; i < argc && argv[i][0] == '-'; i++) {
        bool has_arg = i + 1 < argc;
        if (!std::strcmp(argv[i], "-c") && has_arg) {
            if (!cfg.load(argv[++i], &err) || !load_local(&cfg, &err)) { std::fprintf(stderr, "waze-on-cluster: %s\n", err.c_str()); return 2; }
        } else if (!std::strcmp(argv[i], "-s") && has_arg) {
            if (!cfg.set_pair(argv[++i], &err)) { std::fprintf(stderr, "waze-on-cluster: %s\n", err.c_str()); return 2; }
        } else {
            usage();
            return 2;
        }
    }
    log_verbose = (int)cfg.num("verbose");
    signal(SIGPIPE, SIG_IGN);

    if (i == argc)
        return serve(cfg);
    if (i + 2 == argc && !std::strcmp(argv[i], "run"))
        return run(cfg, argv[i + 1]);
    if (i + 2 == argc && !std::strcmp(argv[i], "bench-pack"))
        return bench_pack(cfg, argv[i + 1]);
    usage();
    return 2;
}
