/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
#include "log.h"

#include <fcntl.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#include <algorithm>
#include <cerrno>
#include <cstdarg>
#include <cstdio>
#include <cstring>
#include <deque>
#include <mutex>

namespace cld {

int log_verbose;
int log_errors;
const char *log_name = "cluster-demo";

namespace {
const size_t BACKLOG = 60;
std::mutex lines_mutex;
std::deque<std::string> lines;   /* the newest BACKLOG lines */
uint64_t lines_total;            /* sequence number of the newest line */

/* The log file (log_to_file), under file_mutex. */
std::mutex file_mutex;
int file_fd = -1;
std::string file_path;
size_t file_max, file_size;

/* Opens file_path for appending and takes its size; under file_mutex. */
bool file_open()
{
    file_fd = open(file_path.c_str(), O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC, 0644);
    if (file_fd < 0)
        return false;
    struct stat st;
    file_size = fstat(file_fd, &st) == 0 ? (size_t)st.st_size : 0;
    return true;
}

/* The one warning, straight to stderr (log() would come back here), and
 * file logging off; under file_mutex. */
void file_fail(const char *what, int err)
{
    std::fprintf(stderr, "W %s: log file %s: %s: %s; logging to the journal only\n", log_name, file_path.c_str(),
                 what, strerror(err));
    if (file_fd >= 0)
        close(file_fd);
    file_fd = -1;
}

/* Under file_mutex. */
void file_write(char level, const char *text)
{
    if (file_fd < 0)
        return;
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    std::string line = utc_time((int64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000);
    line += ' ';
    line += level;
    line += ' ';
    line += text;
    line += '\n';
    if (file_size > 0 && file_size + line.size() > file_max) {
        close(file_fd);
        file_fd = -1;
        if (rename(file_path.c_str(), (file_path + ".1").c_str()) != 0) {
            file_fail("rename", errno);
            return;
        }
        if (!file_open()) {
            file_fail("open", errno);
            return;
        }
    }
    if (write(file_fd, line.data(), line.size()) != (ssize_t)line.size()) {
        file_fail("write", errno);
        return;
    }
    file_size += line.size();
}
}  // namespace

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
    {
        std::lock_guard<std::mutex> lock(lines_mutex);
        lines.push_back(line);
        if (lines.size() > BACKLOG)
            lines.pop_front();
        lines_total++;
    }
    std::lock_guard<std::mutex> lock(file_mutex);
    file_write(level, line);
}

size_t log_file_cap(long kb)
{
    if (kb < 16 || kb > 16384) {
        log('W', "log_file_kb %ld is not from 16 to 16384; 512 it is", kb);
        kb = 512;
    }
    return (size_t)kb * 1024;
}

bool log_to_file(const std::string &path, size_t max_bytes, const char *name, const char *version)
{
    std::lock_guard<std::mutex> lock(file_mutex);
    if (file_fd >= 0)
        close(file_fd);
    file_fd = -1;
    file_path = path;
    file_max = max_bytes;
    if (path.empty())
        return false;
    if (!file_open()) {
        file_fail("open", errno);
        return false;
    }
    char line[256];
    std::snprintf(line, sizeof line, "start: %s%s%s, pid %d", name, version && *version ? " " : "",
                  version ? version : "", (int)getpid());
    file_write('I', line);
    return file_fd >= 0;
}

std::string utc_time(int64_t unix_ms)
{
    const time_t secs = (time_t)(unix_ms / 1000);
    struct tm tm;
    gmtime_r(&secs, &tm);
    char out[80];   /* the widest ints the format can take */
    std::snprintf(out, sizeof out, "%04d-%02d-%02d %02d:%02d:%02d.%03d", tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday,
                  tm.tm_hour, tm.tm_min, tm.tm_sec, (int)(unix_ms % 1000));
    return out;
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
