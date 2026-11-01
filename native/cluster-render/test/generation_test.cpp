/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 IterioDev */
/* Host test for the head unit's generation (generation.h) on root
 * filesystems made in a temporary folder: MainApp's folder decides; with
 * both (as on the iDrive 8 unit) or neither, the running HMI; with no HMI,
 * not known. */
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <string>

#include "../src/generation.h"

using namespace crs;

static int failures;

static void ok(const char *name, bool cond)
{
    std::printf("%-4s %s\n", cond ? "ok" : "FAIL", name);
    if (!cond) failures++;
}

static std::string root;

static void sh(const std::string &cmd)
{
    if (std::system(cmd.c_str()) != 0)
        std::printf("     failed: %s\n", cmd.c_str());
}

static void make(const std::string &dir) { sh("mkdir -p '" + root + dir + "'"); }

static void hmi(const char *pid, const char *comm)
{
    make(std::string("/proc/") + pid);
    std::ofstream(root + "/proc/" + pid + "/comm") << comm << "\n";
}

int main()
{
    char tmpl[] = "/tmp/crs-generation-XXXXXX";
    if (!mkdtemp(tmpl))
        return 1;
    root = tmpl;
    ok("nothing: not known", unit_generation(root) == 0);
    make("/usr/lib/oap-mainapp");
    ok("oap-mainapp alone: iDrive 7", unit_generation(root) == 7);
    make("/usr/lib/oap-mainapp21");
    hmi("1", "systemd");
    hmi("self", "Hmi8");   /* not a pid: not read */
    ok("both folders, no HMI running: not known", unit_generation(root) == 0);
    hmi("812", "Hmi8");
    ok("both folders and Hmi8 running: iDrive 8", unit_generation(root) == 8);
    sh("rm -rf '" + root + "/usr/lib/oap-mainapp' '" + root + "/proc'");
    ok("oap-mainapp21 alone: iDrive 8", unit_generation(root) == 8);
    sh("rm -rf '" + root + "/usr'");
    hmi("640", "HmiMain3D");
    ok("neither folder, HmiMain3D running: iDrive 7", unit_generation(root) == 7);
    sh("rm -rf '" + root + "'");
    std::printf(failures ? "%d FAILED\n" : "all ok\n", failures);
    return failures ? 1 : 0;
}
