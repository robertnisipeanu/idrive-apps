// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* The first line of argv[1] as std::ifstream reads it (aapd's way to read
 * its configuration: basic_filebuf::open), for preload_test.sh. */
#include <fstream>
#include <iostream>
#include <string>

int main(int argc, char **argv) {
    std::ifstream f(argc > 1 ? argv[1] : "");
    std::string line;
    std::cout << "ifstream " << (std::getline(f, line) ? line : "-") << std::endl;
    return 0;
}
