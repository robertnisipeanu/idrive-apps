// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
#include "opt_in.h"

#include <unistd.h>

#include <algorithm>
#include <fstream>
#include <iterator>

#include "log.h"

namespace woc {

const FeatureKey kFeatureKeys[4] = {{"hosted_vpp_scale", 1}, {"always_packed", 1}, {"target_fps", 60}, {"picture_fps", 60}};

namespace {

std::string trim(const std::string &s)
{
    const size_t a = s.find_first_not_of(" \t\r"), b = s.find_last_not_of(" \t\r");
    return a == std::string::npos ? "" : s.substr(a, b - a + 1);
}

/* An opt-in key's value: a whole number from 0 to its hi, written without
 * a sign or a leading 0 (Config::num reads one as octal). */
bool feature_value(const std::string &key, const std::string &value)
{
    const FeatureKey *k = std::find_if(std::begin(kFeatureKeys), std::end(kFeatureKeys),
                                       [&](const FeatureKey &f) { return key == f.key; });
    return k != std::end(kFeatureKeys) && !value.empty() && value.size() <= 9 &&
           value.find_first_not_of("0123456789") == std::string::npos && (value == "0" || value[0] != '0') &&
           std::stol(value) <= k->hi;
}

/* The key of a key = value or key += value line. */
std::string key_of(const std::string &line)
{
    std::string key = trim(line.substr(0, line.find('=')));
    if (!key.empty() && key.back() == '+')
        key = trim(key.substr(0, key.size() - 1));
    return key;
}

}  // namespace

void load_features(cld::Config *cfg, const std::string &path)
{
    if (path.empty() || access(path.c_str(), F_OK) != 0)
        return;
    std::ifstream f(path);
    if (!f) {
        log_warn("%s: cannot read it: the opt-in settings off", path.c_str());
        return;
    }
    std::string line, applied, err;
    while (std::getline(f, line)) {
        const size_t hash = line.find('#');
        if (hash != std::string::npos)
            line.erase(hash);
        if (trim(line).empty())
            continue;
        const size_t eq = line.find('=');
        const std::string key = key_of(line), value = eq == std::string::npos ? "" : trim(line.substr(eq + 1));
        if (!feature_value(key, value) || !cfg->set_pair(key + "=" + value, &err)) {
            log_warn("%s: \"%s\" left out", path.c_str(), trim(line).c_str());
            continue;
        }
        applied += (applied.empty() ? "" : ", ") + key + " " + value;
    }
    if (!applied.empty())
        log_info("opt-in settings from %s: %s", path.c_str(), applied.c_str());
}

}  // namespace woc
