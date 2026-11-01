/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 IterioDev */
/* The three programs built from main.cpp (README.md "iDrive 8"): the
 * service for each generation, cluster-render-idrive7 (unit_idrive7.cpp:
 * RAMSES 19 and Dcsm2) and cluster-render-idrive8 (unit_idrive8.cpp:
 * RAMSES 27 and its DCSM provider), and cluster-render (launch.cpp), which
 * starts the one the head unit needs. The two libramses cannot share a
 * process (they export the same symbols), and an iDrive 7 unit has no
 * RAMSES 27. */
#ifndef CRS_UNIT_H
#define CRS_UNIT_H

#include <string>

#include "config.h"
#include "service.h"

namespace crs {

/* The program's own part once the settings are read: serve, or start the
 * service for the head unit's generation. argv as main() got it. */
int start(const cld::Config &cfg, char **argv);

/* The settings of generation 7 or 8 as the service takes them: the
 * targets (on iDrive 8 the id8_ keys), the budget, the socket and the
 * status (main.cpp). False, with err, when one is missing or out of range. */
bool service_config(const cld::Config &cfg, int generation, ServiceConfig *sc, std::string *err);

}  // namespace crs

#endif
