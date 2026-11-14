/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
/* The service's settings beyond the shared Config's own (cluster-render.conf
 * documents each), and the targets they declare. */
#ifndef CRS_SETTINGS_H
#define CRS_SETTINGS_H

#include <string>
#include <vector>

#include "config.h"
#include "slots.h"

namespace crs {

/* Every key this service reads beyond the shared Config's, with its
 * built-in default. */
void define_keys(cld::Config *cfg);

/* Generation 7's targets, or 8's from the id8_ keys: a category in place
 * of the slot, a content, no content class and no take-over. False, with
 * err, when one is missing or out of range. */
bool load_targets(const cld::Config &cfg, int generation, std::vector<TargetSpec> *out, std::string *err);

}  // namespace crs

#endif
