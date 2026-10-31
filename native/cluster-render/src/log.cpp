/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
#include "log.h"

#include <algorithm>
#include <cstdarg>
#include <cstdio>
#include <deque>
#include <mutex>
#include <time.h>

namespace cld {

int log_verbose;
int log_errors;
const char *log_name = "cluster-demo";

namespace {
const size_t BACKLOG = 60;
std::mutex lines_mutex;
std::deque<std::string> lines;   /* the newest BACKLOG lines */
uint64_t lines_total;            /* sequence number of the newest line */
}

int64_t now_ms()
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (int64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

void log(char level, const char *fmt, ...)
{
    if (level == 'E')
        log_errors++;
    char line[1024];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(line, sizeof line, fmt, ap);
    va_end(ap);
    std::fprintf(stderr, "%c %s: %s\n", level, log_name, line);
    std::lock_guard<std::mutex> lock(lines_mutex);
    lines.push_back(line);
    if (lines.size() > BACKLOG)
        lines.pop_front();
    lines_total++;
}

void log_lines_since(uint64_t *seq, std::vector<std::string> *out)
{
    std::lock_guard<std::mutex> lock(lines_mutex);
    uint64_t first = lines_total - lines.size();   /* sequence number before the oldest kept line */
    for (uint64_t n = std::max(*seq, first); n < lines_total; n++)
        out->push_back(lines[n - first]);
    *seq = lines_total;
}

}  // namespace cld
