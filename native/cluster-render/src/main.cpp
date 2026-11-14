/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
/* cluster-render: the one process that draws on the instrument cluster and
 * the HUD for every app (README.md). It is the RAMSES participant and the
 * display client (Dcsm2 on iDrive 7, RAMSES 27's DCSM on iDrive 8); apps and
 * native producers are its clients over a socket. Built three times
 * (unit.h): cluster-render starts the service for the head unit's
 * generation, which takes the same arguments.
 *
 *   cluster-render [-c FILE] [-s key=value]...          serve
 *   cluster-render [-c FILE] [-s key=value]... status   print the service's status
 *   cluster-render [-c FILE] [-s key=value]... guard-reset
 *                     as root: remove the mapping guard's file (guard.h) and
 *                     restart the service if it runs */
#include <cerrno>
#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

#include <fstream>

#include "cluster_render/protocol.h"
#include "config.h"
#include "head_unit.h"
#include "log.h"
#include "refused.h"
#include "settings.h"
#include "unit.h"

using namespace crs;

/* component.json's version, given by the target build. */
#ifndef CR_VERSION
#define CR_VERSION ""
#endif

bool crs::service_config(const cld::Config &cfg, int generation, ServiceConfig *out, std::string *err)
{
    if (cfg.has("log_file"))
        cld::log_to_file(cfg.str("log_file"), cld::log_file_cap(cfg.num("log_file_kb")), "cluster-render", CR_VERSION);
    ServiceConfig &sc = *out;
    if (!load_targets(cfg, generation, &sc.targets, err))
        return false;
    const long max_kb = cfg.num("upload_kb_per_s"), step_kb = cfg.num("upload_step_kb_per_s");
    long floor_kb = cfg.num("upload_floor_kb_per_s");
    if (max_kb < 0 || max_kb > 1048576 || floor_kb < 0 || step_kb < 1 || cfg.num("upload_burst_ms") < 1 ||
        cfg.num("upload_burst_ms") > 1000 || cfg.num("fps") < 1 || cfg.num("fps") > 60 ||
        cfg.num("slow_flush_ms") < 10 || cfg.num("slow_flush_ms") > 10000 || cfg.num("fade_ms") < 0 ||
        cfg.num("fade_ms") > 5000) {
        *err = "upload_kb_per_s (0-1048576), upload_floor_kb_per_s (0 and up), upload_step_kb_per_s (1 and up), "
               "upload_burst_ms (1-1000), slow_flush_ms (10-10000), fps (1-60) or fade_ms (0-5000) out of range";
        return false;
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
    sc.backend = generation == 8 ? "id8" : "id7";
    sc.guard_path = cfg.str("guard_path");
    sc.version = CR_VERSION;
    std::ifstream boot("/proc/sys/kernel/random/boot_id");
    std::getline(boot, sc.boot_id);
    return true;
}

namespace {

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

/* Root only: removes the mapping guard's file, then restarts the service
 * if it runs, so it starts with no strike. */
int guard_reset(const cld::Config &cfg)
{
    if (geteuid() != 0) {
        std::fprintf(stderr, "cluster-render: guard-reset runs as root\n");
        return 1;
    }
    const std::string path = cfg.str("guard_path");
    if (unlink(path.c_str()) != 0 && errno != ENOENT) {
        std::fprintf(stderr, "cluster-render: %s: %s\n", path.c_str(), strerror(errno));
        return 1;
    }
    std::printf("cluster-render: %s removed\n", path.c_str());
    return std::system("systemctl try-restart cluster-render.service") == 0 ? 0 : 1;
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
    if (i == argc) {
        /* Before anything that reaches the cluster: the generation's
         * service, Dcsm2, vsomeip, RAMSES. */
        const std::string why = cld::head_unit_refused();
        return why.empty() ? start(cfg, argv) : serve_refused(cfg, why);
    }
    if (i + 1 == argc && !std::strcmp(argv[i], "status"))
        return status(cfg);
    if (i + 1 == argc && !std::strcmp(argv[i], "guard-reset"))
        return guard_reset(cfg);
    std::fprintf(stderr, "usage: cluster-render [-c FILE] [-s key=value]... [status | guard-reset]\n");
    return 2;
}
