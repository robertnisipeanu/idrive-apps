/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 IterioDev */
/* The head unit's generation, told the way mgu-store's deploy tool tells it:
 * by MainApp's folder, /usr/lib/oap-mainapp on iDrive 7 and
 * /usr/lib/oap-mainapp21 on iDrive 8; with both or neither, by the running
 * HMI (/proc/<pid>/comm: HmiMain3D on iDrive 7, Hmi8 on iDrive 8). An
 * iDrive 8 unit has both folders (VERIFIED in its root filesystem), so
 * there the HMI decides. */
#ifndef CRS_GENERATION_H
#define CRS_GENERATION_H

#include <string>

namespace crs {

/* 7 or 8; 0: not known (no HMI running yet). root: "" on the unit. */
int unit_generation(const std::string &root = "");

}  // namespace crs

#endif
