// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
#include "alt_screen.h"

#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <sstream>

namespace woc {

bool alt_screen_in(const std::string &table, uint16_t port, uint32_t uid)
{
    /* sl local_address rem_address st tx:rx tr:when retrnsmt uid ... */
    std::istringstream lines(table);
    std::string line;
    std::getline(lines, line);   /* the header */
    while (std::getline(lines, line)) {
        std::istringstream f(line);
        std::string sl, local, remote, st, queues, timer, retr;
        unsigned long owner;
        if (!(f >> sl >> local >> remote >> st >> queues >> timer >> retr >> owner))
            continue;
        const size_t colon = local.rfind(':');
        if (colon == std::string::npos || st != "01" || owner != uid)
            continue;
        if (std::strtoul(local.c_str() + colon + 1, nullptr, 16) == port)
            return true;
    }
    return false;
}

AltScreen::AltScreen(uint16_t port, uint32_t uid, std::vector<std::string> tables)
    : port_(port), uid_(uid), tables_(std::move(tables))
{
}

bool StreamLiveness::live(AltScreen::State alt, int64_t last_frame_ms, int64_t now_ms)
{
    if (connected_ && alt != AltScreen::Connected)
        ended_ms_ = now_ms;
    connected_ = alt == AltScreen::Connected;
    if (connected_)
        return true;
    return last_frame_ms >= 0 && now_ms - last_frame_ms <= stall_ms_ &&
           (ended_ms_ < 0 || last_frame_ms > ended_ms_ + 1000);
}

AltScreen::State AltScreen::read() const
{
    bool readable = false;
    for (const std::string &path : tables_) {
        std::ifstream in(path);
        if (!in)
            continue;
        readable = true;
        std::stringstream text;
        text << in.rdbuf();
        if (alt_screen_in(text.str(), port_, uid_))
            return Connected;
    }
    return readable ? Absent : Unknown;
}

}  // namespace woc
