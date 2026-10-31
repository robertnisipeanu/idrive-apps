/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
/* cluster-render: the one process that draws on the instrument cluster and
 * the HUD for every app (README.md). It is the RAMSES participant and the
 * Dcsm2 client; apps and native producers are its clients over a socket.
 *
 *   cluster-render [-c FILE] [-s key=value]...          serve
 *   cluster-render [-c FILE] [-s key=value]... status   print the service's status */
#include <cerrno>
#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <pthread.h>
#include <sys/signalfd.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

#include <algorithm>
#include <sstream>

#include "cluster_render/protocol.h"
#include "config.h"
#include "dcsm2_link.h"
#include "dcsm2_port.h"
#include "graph_ramses19.h"
#include "log.h"
#include "ramses19/ramses.h"
#include "service.h"

using namespace crs;

/* component.json's version, given by the target build. */
#ifndef CR_VERSION
#define CR_VERSION ""
#endif

namespace {

/* The keys this service reads beyond the shared Config's own
 * (cluster-render.conf documents each). */
void define_keys(cld::Config *cfg)
{
    cfg->define("vsomeip_app", "cluster-demo");
    cfg->define("targets", "map,panel,hud");
    cfg->define("scene_ids_allowed", "0x010004f0,0x01000400");
    cfg->define("map_slot", "0x100");
    cfg->define("map_content_class", "0");
    cfg->define("map_scene_id", "0x010004f0");
    cfg->define("map_size", "1088x480");
    cfg->define("map_linger_ms", "0");
    cfg->define("map_take_over_stock", "1");
    cfg->define("panel_slot", "0x203");
    cfg->define("panel_content_class", "0");
    cfg->define("panel_scene_id", "0x01000400");
    cfg->define("panel_size", "1920x720");
    cfg->define("panel_linger_ms", "3000");
    cfg->define("panel_take_over_stock", "0");
    cfg->define("hud_linger_ms", "3000");
    cfg->define("hud_take_over_stock", "0");
    cfg->define("dcsm_hmi_client_handle", "1");
    cfg->define("fade_ms", "250");
    cfg->define("upload_kb_per_s", "6000");
    cfg->define("upload_floor_kb_per_s", "2000");
    cfg->define("upload_step_kb_per_s", "500");
    cfg->define("upload_burst_ms", "250");
    cfg->define("slow_flush_ms", "150");
    cfg->define("status_path", "/run/cluster-render/status.txt");
    cfg->define("log_file", "/var/opt/cluster-render/log/cluster-render.log");
    cfg->define("log_file_kb", "512");
    /* The shared Config's defaults are cluster-demo's (src/config.cpp). */
    std::string err;
    cfg->set_pair("socket_path=/dev/shm/cluster-render/render.sock", &err);
    cfg->set_pair("local_conf=/var/opt/cluster-render/cluster-render.local.conf", &err);
}

bool load_targets(const cld::Config &cfg, std::vector<TargetSpec> *out, std::string *err)
{
    std::vector<uint64_t> allowed;
    {
        std::stringstream ss(cfg.str("scene_ids_allowed"));
        std::string id;
        while (std::getline(ss, id, ','))
            allowed.push_back(std::strtoull(id.c_str(), nullptr, 0));
    }
    std::stringstream ss(cfg.str("targets"));
    std::string name;
    while (std::getline(ss, name, ',')) {
        if (name.empty())
            continue;
        const std::string p = name + "_";
        TargetSpec t;
        t.name = name;
        if (!cfg.has((p + "slot").c_str()) || !cfg.has((p + "scene_id").c_str())) {
            *err = "target " + name + ": " + p + "slot and " + p + "scene_id must be set";
            return false;
        }
        t.slot = std::strtoull(cfg.str((p + "slot").c_str()).c_str(), nullptr, 0);
        t.content_class = (uint32_t)cfg.num((p + "content_class").c_str());
        t.scene_id = std::strtoull(cfg.str((p + "scene_id").c_str()).c_str(), nullptr, 0);
        t.linger_ms = (int)cfg.num((p + "linger_ms").c_str());
        t.take_over_stock = cfg.num((p + "take_over_stock").c_str()) != 0;
        if (!cfg.size((p + "size").c_str(), &t.width, &t.height) || t.width < 16 || t.height < 16 ||
            t.width > 4096 || t.height > 4096) {
            *err = "target " + name + ": " + p + "size must be WxH";
            return false;
        }
        if (t.linger_ms < 0 || t.linger_ms > 600000) {
            *err = "target " + name + ": " + p + "linger_ms must be from 0 to 600000";
            return false;
        }
        /* Only scene ids the KOMBI is known to take: others (7702, 7703)
         * made it restart the cluster and the HUD. */
        if (std::find(allowed.begin(), allowed.end(), t.scene_id) == allowed.end()) {
            *err = "target " + name + ": scene id " + cfg.str((p + "scene_id").c_str()) + " is not in scene_ids_allowed";
            return false;
        }
        out->push_back(t);
    }
    if (out->empty()) {
        *err = "no targets";
        return false;
    }
    return true;
}

int serve(const cld::Config &cfg)
{
    if (cfg.has("log_file"))
        cld::log_to_file(cfg.str("log_file"), cld::log_file_cap(cfg.num("log_file_kb")), "cluster-render", CR_VERSION);
    ServiceConfig sc;
    std::string err;
    if (!load_targets(cfg, &sc.targets, &err)) {
        log_error("%s", err.c_str());
        return 1;
    }
    const long max_kb = cfg.num("upload_kb_per_s"), step_kb = cfg.num("upload_step_kb_per_s");
    long floor_kb = cfg.num("upload_floor_kb_per_s");
    if (max_kb < 0 || max_kb > 1048576 || floor_kb < 0 || step_kb < 1 || cfg.num("upload_burst_ms") < 1 ||
        cfg.num("upload_burst_ms") > 1000 || cfg.num("fps") < 1 || cfg.num("fps") > 60 ||
        cfg.num("slow_flush_ms") < 10 || cfg.num("slow_flush_ms") > 10000 || cfg.num("fade_ms") < 0 ||
        cfg.num("fade_ms") > 5000) {
        log_error("upload_kb_per_s (0-1048576), upload_floor_kb_per_s (0 and up), upload_step_kb_per_s (1 and up), "
                  "upload_burst_ms (1-1000), slow_flush_ms (10-10000), fps (1-60) or fade_ms (0-5000) out of range");
        return 1;
    }
    /* A ceiling set below the floor is the cap: the governor then has no
     * room to lower it. 0 is no limit. */
    if (floor_kb > max_kb)
        floor_kb = max_kb;
    sc.budget.max_bps = (uint64_t)max_kb * 1024;
    sc.budget.floor_bps = (uint64_t)floor_kb * 1024;
    sc.budget.step_bps = (uint64_t)step_kb * 1024;
    sc.slow_flush_ms = (int)cfg.num("slow_flush_ms");
    sc.upload_burst_ms = (int)cfg.num("upload_burst_ms");
    sc.fps = (int)cfg.num("fps");
    sc.fade_ms = (int)cfg.num("fade_ms");
    sc.socket_path = cfg.str("socket_path");
    sc.socket_mode = (unsigned)std::strtoul(cfg.str("socket_mode").c_str(), nullptr, 8);
    sc.socket_group = cfg.str("socket_group");
    sc.status_path = cfg.str("status_path");

    sigset_t sigs;
    sigemptyset(&sigs);
    sigaddset(&sigs, SIGINT);
    sigaddset(&sigs, SIGTERM);
    pthread_sigmask(SIG_BLOCK, &sigs, nullptr);
    const int sig_fd = signalfd(-1, &sigs, SFD_CLOEXEC);
    if (sig_fd < 0) {
        log_error("signalfd: %s", strerror(errno));
        return 1;
    }

    const char *args[] = {"cluster-render"};
    ramses::RamsesFrameworkConfig fwc(1, args);
    fwc.setDLTApplicationID("CLRD");
    fwc.setDLTApplicationDescription("cluster-render");
    const uint32_t user = (uint32_t)cfg.num("ramses_user");
    if (fwc.enableSomeIPCommunication(user) != ramses::StatusOK) {
        log_error("ramses: SOME/IP participant %u refused", user);
        return 1;
    }
    ramses::RamsesFramework framework(fwc);
    ramses::RamsesClient client("cluster-render", framework);
    if (framework.connect() != ramses::StatusOK) {
        log_error("ramses: connect failed (participant %u)", user);
        return 1;
    }
    log_info("ramses: connected as participant %u", user);
    Ramses19Gpu gpu(client);
    if (!gpu.init(&err)) {
        log_error("ramses: %s", err.c_str());
        framework.disconnect();
        return 1;
    }

    Dcsm2Link link;
    Dcsm2Port port(&link);
    Service service(&gpu, &port, sc);
    port.set_manager(&service.slots());
    port.set_hmi_client_handle(std::strtoull(cfg.str("dcsm_hmi_client_handle").c_str(), nullptr, 0));
    Governor *gov = &service.compositor().governor();
    port.on_link = [gov](bool silent, int64_t now_ms) {
        if (silent)
            gov->evidence(Evidence::LinkStall, now_ms);
    };
    Dcsm2Link::Options lo;
    lo.app_name = cfg.str("vsomeip_app");
    lo.client_handle = cfg.has("dcsm_client_handle")
                           ? std::strtoull(cfg.str("dcsm_client_handle").c_str(), nullptr, 0)
                           : 0;
    lo.heartbeat_replies = cfg.num("dcsm_heartbeat_replies") != 0;
    if (!service.start(&err) || !link.start(lo, &err)) {
        log_error("%s", err.c_str());
        framework.disconnect();
        return 1;
    }
    for (const TargetSpec &t : sc.targets)
        log_info("target %s: slot 0x%llx class %u scene 0x%llx %ux%u, linger %d ms%s", t.name.c_str(),
                 (unsigned long long)t.slot, t.content_class, (unsigned long long)t.scene_id, t.width, t.height,
                 t.linger_ms, t.take_over_stock ? ", takes over from the stock HMI" : "");

    std::vector<pollfd> fds;
    for (;;) {
        fds.clear();
        fds.push_back(pollfd{sig_fd, POLLIN, 0});
        fds.push_back(pollfd{link.fd(), POLLIN, 0});
        const size_t first = service.poll_fds(&fds);
        const int n = poll(fds.data(), fds.size(), service.timeout_ms(cld::now_ms()));
        if (n < 0 && errno != EINTR)
            break;
        if (fds[0].revents & POLLIN)
            break;
        const int64_t now = cld::now_ms();
        if (fds[1].revents & POLLIN)
            link.drain(&port, now);
        service.after_poll(fds, first, now);
    }
    service.shutdown(cld::now_ms());
    usleep(300 * 1000);   /* the unmap and unfetch on their way */
    link.stop();
    framework.disconnect();
    log_info("stopped");
    return 0;
}

/* Prints the service's status: its targets and every client's layers. */
int status(const cld::Config &cfg)
{
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    struct sockaddr_un addr;
    std::memset(&addr, 0, sizeof addr);
    addr.sun_family = AF_UNIX;
    std::snprintf(addr.sun_path, sizeof addr.sun_path, "%s", cfg.str("socket_path").c_str());
    if (fd < 0 || connect(fd, (struct sockaddr *)&addr, sizeof addr) < 0) {
        std::fprintf(stderr, "cluster-render: %s: %s\n", addr.sun_path, strerror(errno));
        return 1;
    }
    const std::string m = cr::encode(cr::kJson, "{\"op\":\"status\"}");
    if (write(fd, m.data(), m.size()) != (ssize_t)m.size())
        return 1;
    std::string in;
    char buf[4096];
    for (;;) {
        ssize_t r = read(fd, buf, sizeof buf);
        if (r <= 0)
            return 1;
        in.append(buf, (size_t)r);
        size_t used = 0, len = 0;
        uint8_t type = 0;
        const char *body = nullptr;
        bool bad = false;
        while (cr::next_message(in.data(), in.size(), &used, &type, &body, &len, &bad)) {
            cr::Json j;
            if (type == cr::kJson && cr::parse_json(std::string(body, len), &j) && j["ev"] == "status") {
                std::fputs(j["text"].c_str(), stdout);
                return 0;
            }
            in.erase(0, used);
        }
        if (bad)
            return 1;
    }
}

bool load_local(cld::Config *cfg, std::string *err)
{
    const std::string path = cfg->str("local_conf");
    return path.empty() || access(path.c_str(), F_OK) != 0 || cfg->load(path, err);
}

}  // namespace

int main(int argc, char **argv)
{
    cld::log_name = "cluster-render";
    cld::Config cfg;
    define_keys(&cfg);
    std::string err;
    int i = 1;
    for (; i < argc && argv[i][0] == '-'; i++) {
        const bool has_arg = i + 1 < argc;
        if (!std::strcmp(argv[i], "-c") && has_arg) {
            if (!cfg.load(argv[++i], &err) || !load_local(&cfg, &err)) {
                std::fprintf(stderr, "cluster-render: %s\n", err.c_str());
                return 2;
            }
        } else if (!std::strcmp(argv[i], "-s") && has_arg) {
            if (!cfg.set_pair(argv[++i], &err)) {
                std::fprintf(stderr, "cluster-render: %s\n", err.c_str());
                return 2;
            }
        } else {
            break;
        }
    }
    cld::log_verbose = (int)cfg.num("verbose");
    signal(SIGPIPE, SIG_IGN);
    if (i == argc)
        return serve(cfg);
    if (i + 1 == argc && !std::strcmp(argv[i], "status"))
        return status(cfg);
    std::fprintf(stderr, "usage: cluster-render [-c FILE] [-s key=value]... [status]\n");
    return 2;
}
