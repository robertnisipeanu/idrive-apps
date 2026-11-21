// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* The opt-in settings over the shipped configuration.
 *
 * features_file (features.conf) holds only the opt-in keys (kFeatureKeys),
 * each a whole number in its key's range (hosted_vpp_scale and
 * always_packed 0 or 1; target_fps and picture_fps 0-60, the shipped
 * configuration's ranges); a valid value replaces the configuration's;
 * another key, a value out of range or a line that does not read is left
 * out with a warning, as is a file that cannot be read. Every release up to
 * 0.10.7 refuses to start with hosted_vpp_scale or always_packed in its
 * local conf, and up to 0.9.12 with picture_fps, so they never go there
 * (patchd moves any of the keys it finds there to features_file). */
#ifndef WOC_OPT_IN_H
#define WOC_OPT_IN_H

#include <string>

#include "config.h"

namespace woc {

/* The keys features_file holds, each from 0 to its hi. */
struct FeatureKey {
    const char *key;
    long hi;
};
extern const FeatureKey kFeatureKeys[4];

void load_features(cld::Config *cfg, const std::string &path);

}  // namespace woc

#endif
