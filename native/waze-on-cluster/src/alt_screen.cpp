// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
#include "alt_screen.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>

namespace woc {

namespace {

/* sl local_address rem_address st tx:rx tr:when retrnsmt uid ... */
bool alt_screen_line(const char *line, uint16_t port, uint32_t uid)
{
    char local[64], st[8];
    unsigned long owner = 0;
    if (std::sscanf(line, " %*s %63s %*s %7s %*s %*s %*s %lu", local, st, &owner) != 3)
        return false;
    if (st[0] != '0' || st[1] != '1' || st[2] != '\0' || owner != uid)
        return false;
    const char *colon = std::strrchr(local, ':');
    return colon && std::strtoul(colon + 1, nullptr, 16) == port;
}

}  // namespace

bool alt_screen_in(const std::string &table, uint16_t port, uint32_t uid)
{
    const char *p = table.c_str();
    const char *nl = std::strchr(p, '\n');
    if (!nl)
        return false;
    p = nl + 1;
    char buf[256];
    while (*p) {
        const char *end = std::strchr(p, '\n');
        const size_t n = end ? (size_t)(end - p) : std::strlen(p);
        const size_t copy = n < sizeof buf - 1 ? n : sizeof buf - 1;
        std::memcpy(buf, p, copy);
        buf[copy] = '\0';
        if (alt_screen_line(buf, port, uid))
            return true;
        if (!end)
            break;
        p = end + 1;
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
    char buf[256];
    for (const std::string &path : tables_) {
        FILE *f = std::fopen(path.c_str(), "r");
        if (!f)
            continue;
        readable = true;
        bool header = true, found = false;
        while (std::fgets(buf, sizeof buf, f)) {
            if (!std::strchr(buf, '\n')) {
                int c;
                while ((c = std::fgetc(f)) != EOF && c != '\n') {
                }
            }
            if (header) {
                header = false;
                continue;
            }
            if (alt_screen_line(buf, port_, uid_)) {
                found = true;
                break;
            }
        }
        std::fclose(f);
        if (found)
            return Connected;
    }
    return readable ? Absent : Unknown;
}

}  // namespace woc
