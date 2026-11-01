/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 IterioDev */
#include "generation.h"

#include <dirent.h>
#include <sys/stat.h>

#include <fstream>

namespace crs {

namespace {

bool is_dir(const std::string &path)
{
    struct stat st;
    return stat(path.c_str(), &st) == 0 && S_ISDIR(st.st_mode);
}

/* The generation of the HMI running; 0: none. */
int running_hmi(const std::string &root)
{
    DIR *d = opendir((root + "/proc").c_str());
    if (!d)
        return 0;
    int g = 0;
    while (struct dirent *e = readdir(d)) {
        if (e->d_name[0] < '0' || e->d_name[0] > '9')
            continue;
        std::ifstream f(root + "/proc/" + e->d_name + "/comm");
        std::string comm;
        std::getline(f, comm);
        if (comm == "HmiMain3D")
            g = 7;
        else if (comm == "Hmi8")
            g = 8;
        if (g)
            break;
    }
    closedir(d);
    return g;
}

}  // namespace

int unit_generation(const std::string &root)
{
    const bool id7 = is_dir(root + "/usr/lib/oap-mainapp"), id8 = is_dir(root + "/usr/lib/oap-mainapp21");
    if (id7 != id8)
        return id8 ? 8 : 7;
    return running_hmi(root);
}

}  // namespace crs
