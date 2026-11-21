// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* Host test of the opt-in settings (opt_in.h): features_file's valid
 * opt-in values over the configuration's (the frame rates' too), any other
 * line left out, a missing file none; the shipped waze-on-cluster.conf
 * loads, names the file patchd writes, has the opt-in keys at their
 * defaults and sets neither local_conf nor target. */
#include <unistd.h>

#include <cstdio>
#include <fstream>
#include <sstream>
#include <string>

#include "config.h"
#include "opt_in.h"

using namespace woc;

static int failures;

static void ok(const char *name, bool cond)
{
    std::printf("%-4s %s\n", cond ? "ok" : "FAIL", name);
    if (!cond) failures++;
}

static cld::Config conf()
{
    cld::Config c;
    c.define("target_fps", "30");
    c.define("picture_fps", "0");
    c.define("pan_blocks", "1");
    c.define("hosted_vpp_scale", "0");
    c.define("always_packed", "0");
    return c;
}

/* A key some line of the file sets, as Config::load reads it. */
static bool sets(const std::string &path, const std::string &key)
{
    std::ifstream f(path);
    std::string line;
    while (std::getline(f, line)) {
        line = line.substr(0, line.find('#'));
        std::istringstream words(line);
        std::string first;
        if (words >> first && (first == key || first.rfind(key + "=", 0) == 0 || first.rfind(key + "+=", 0) == 0))
            return true;
    }
    return false;
}

int main()
{
    const std::string feat = "/tmp/woc-opt-in-test-" + std::to_string(getpid()) + ".conf";
    unlink(feat.c_str());

    cld::Config c = conf();
    load_features(&c, feat);
    ok("no features file: the opt-in keys off", c.str("hosted_vpp_scale") == "0" && c.str("always_packed") == "0");
    std::ofstream(feat) << "hosted_vpp_scale = 1\nalways_packed += 1 # on\n";
    c = conf();
    load_features(&c, feat);
    ok("the features file's values (= and +=), over the configuration's", c.str("hosted_vpp_scale") == "1" && c.str("always_packed") == "1");
    std::ofstream(feat) << "hosted_vpp_scale = 2\nalways_packed = yes\npan_blocks = 0\ngarbage\nalways_packed=1\n";
    c = conf();
    load_features(&c, feat);
    ok("out of range, another key or a line that does not read: left out, the rest taken",
       c.str("hosted_vpp_scale") == "0" && c.str("always_packed") == "1" && c.str("pan_blocks") == "1");
    std::ofstream(feat) << "target_fps = 20\npicture_fps += 20 # CPU\n";
    c = conf();
    load_features(&c, feat);
    ok("the frame rates from the features file", c.str("target_fps") == "20" && c.str("picture_fps") == "20");
    std::ofstream(feat) << "target_fps = 60\npicture_fps = 0\n";
    c = conf();
    load_features(&c, feat);
    ok("the frame rates at the ends of their range", c.str("target_fps") == "60" && c.str("picture_fps") == "0");
    for (const char *bad : {"target_fps = 61", "target_fps = -1", "target_fps = +20", "target_fps = 020",
                            "target_fps = 20.5", "target_fps = 0x14", "target_fps =", "picture_fps = 61",
                            "picture_fps = 99999999999999999999"}) {
        std::ofstream(feat) << bad << "\n";
        c = conf();
        load_features(&c, feat);
        ok((std::string("a frame rate out of range or not a plain number left out: ") + bad).c_str(),
           c.str("target_fps") == "30" && c.str("picture_fps") == "0");
    }
    unlink(feat.c_str());

    /* The shipped conf: the only configuration file main() loads. */
    cld::Config shipped;
    shipped.define("hosted_vpp_scale", "");
    shipped.define("always_packed", "");
    shipped.define("target_fps", "");
    shipped.define("picture_fps", "");
    shipped.define("features_file", "");
    shipped.extra_keys = [](const std::string &) { return true; };
    std::string err;
    ok("shipped: waze-on-cluster.conf reads", shipped.load("waze-on-cluster.conf", &err));
    ok("shipped: features_file is the file patchd writes", shipped.str("features_file") == "/var/opt/waze-on-cluster/features.conf");
    ok("shipped: the opt-in keys off", shipped.str("hosted_vpp_scale") == "0" && shipped.str("always_packed") == "0");
    ok("shipped: target_fps 30, picture_fps 0", shipped.str("target_fps") == "30" && shipped.str("picture_fps") == "0");
    ok("shipped: no local_conf, no target", !sets("waze-on-cluster.conf", "local_conf") && !sets("waze-on-cluster.conf", "target"));
    std::printf(failures ? "%d FAILED\n" : "all ok\n", failures);
    return failures ? 1 : 0;
}
