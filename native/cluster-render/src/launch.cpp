/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 IterioDev */
/* cluster-render: starts the service for the head unit's generation
 * (unit.h), cluster-render-idrive7 or cluster-render-idrive8 from its own
 * folder, with its own arguments, in its own process (exec): systemd's
 * unit and the socket stay the same on both. `generation` (auto, 7 or 8)
 * settles it; auto asks the unit (generation.h). Not known yet (at boot,
 * before the HMI runs), it asks again every 5 s rather than exiting: what
 * iDrive 8 does when a service exits is CAR-ONLY. */
#include <cerrno>
#include <climits>
#include <cstring>
#include <unistd.h>

#include "generation.h"
#include "log.h"
#include "unit.h"

namespace crs {

int start(const cld::Config &cfg, char **argv)
{
    const std::string g = cfg.str("generation");
    int gen = g == "7" ? 7 : g == "8" ? 8 : g == "auto" ? unit_generation() : -1;
    if (gen < 0) {
        log_error("generation must be auto, 7 or 8");
        return 1;
    }
    if (!gen)
        log_info("the head unit's generation is not known yet (both or neither MainApp folder, and neither "
                 "HmiMain3D nor Hmi8 runs); asking again every 5 s, or set generation to 7 or 8 to settle it");
    while (!gen) {
        sleep(5);
        gen = unit_generation();
    }
    char self[PATH_MAX];
    const ssize_t n = readlink("/proc/self/exe", self, sizeof self - 1);
    if (n <= 0) {
        log_error("/proc/self/exe: %s", strerror(errno));
        return 1;
    }
    self[n] = 0;
    std::string path(self);
    path = path.substr(0, path.rfind('/') + 1) + (gen == 8 ? "cluster-render-idrive8" : "cluster-render-idrive7");
    log_info("iDrive %d%s: %s", gen, g == "auto" ? "" : " (generation set)", path.c_str());
    argv[0] = &path[0];
    execv(path.c_str(), argv);
    log_error("%s: %s", path.c_str(), strerror(errno));
    return 1;
}

}  // namespace crs
