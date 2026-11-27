/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
#include "log.h"

#include <fcntl.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#include <algorithm>
#include <cerrno>
#include <condition_variable>
#include <cstdarg>
#include <cstdio>
#include <cstring>
#include <deque>
#include <mutex>
#include <thread>
#include <vector>

namespace cld {

int log_verbose;
int log_errors;
const char *log_name = "cluster-demo";

static int open_file(const char *path, int flags, mode_t mode) { return open(path, flags, mode); }
LogFileCalls log_file_calls = {open_file, ::write, ::rename};

namespace {
const size_t BACKLOG = 60;
const size_t FILE_QUEUE_MAX = 256;
std::mutex lines_mutex;
std::deque<std::string> lines;   /* the newest BACKLOG lines */
uint64_t lines_total;            /* sequence number of the newest line */

/* A file system that is read-only, full or over quota. */
bool dropped(int err) { return err == EROFS || err == ENOSPC || err == EDQUOT; }

std::string format_file_line(char level, const char *text)
{
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    std::string line = utc_time((int64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000);
    line += ' ';
    line += level;
    line += ' ';
    line += text;
    line += '\n';
    return line;
}

void warn_file_fail(const std::string &path, const char *what, int err)
{
    std::fprintf(stderr, "W %s: log file %s: %s: %s; logging to the journal only\n", log_name, path.c_str(), what,
                 strerror(err));
}

/* Writes lines to path, rotating to path.1 before any line that would pass
 * max_bytes. Opens and closes the file per flush batch so no descriptor stays
 * open across shutdown read-only remounts. Sets *disable on non-droppable
 * errors; returns whether at least the last line was written. */
bool write_batch(const std::string &path, size_t max_bytes, const std::vector<std::string> &batch, bool *disable)
{
    *disable = false;
    struct stat st;
    size_t size = stat(path.c_str(), &st) == 0 ? (size_t)st.st_size : 0;
    bool wrote = false;
    std::string joined;
    for (size_t i = 0; i < batch.size();) {
        if (size > 0 && size + batch[i].size() > max_bytes) {
            if (log_file_calls.rename_file(path.c_str(), (path + ".1").c_str()) != 0) {
                const int err = errno;
                if (!dropped(err)) {
                    warn_file_fail(path, "rename", err);
                    *disable = true;
                    return false;
                }
                i++;
                continue;
            }
            size = 0;
        }
        size_t j = i + 1;
        size_t len = batch[i].size();
        while (j < batch.size() && size + len + batch[j].size() <= max_bytes) {
            len += batch[j].size();
            j++;
        }
        const char *data = batch[i].data();
        if (j - i > 1) {
            joined.clear();
            joined.reserve(len);
            for (size_t k = i; k < j; k++)
                joined += batch[k];
            data = joined.data();
        }
        const int fd = log_file_calls.open_file(path.c_str(), O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC, 0644);
        if (fd < 0) {
            const int err = errno;
            if (!dropped(err)) {
                warn_file_fail(path, "open", err);
                *disable = true;
                return false;
            }
            i = j;
            continue;
        }
        const ssize_t n = log_file_calls.write_file(fd, data, len);
        const int err = n < 0 ? errno : ENOSPC;   /* a short write: the file system is full */
        /* a short write's part taken back, so the next line starts on its own;
         * should that fail too, the part stays (the if only checks the result) */
        if (n > 0 && n != (ssize_t)len && ftruncate(fd, (off_t)size) != 0) {
        }
        close(fd);
        if (n != (ssize_t)len) {
            if (!dropped(err)) {
                warn_file_fail(path, "write", err);
                *disable = true;
                return false;
            }
            i = j;
            continue;
        }
        size += (size_t)n;
        wrote = true;
        i = j;
    }
    return wrote;
}

/* Async writer for the log file (log_to_file): decouples flash I/O from
 * callers (including I/O threads) while keeping bounded memory and draining
 * cleanly before process exit. */
struct FileWriter {
    std::mutex mu;
    std::condition_variable cv;
    std::condition_variable idle_cv;
    bool on = false;
    bool stopping = false;
    bool busy = false;
    std::string path;
    size_t max_bytes = 0;
    std::deque<std::string> queue;
    std::thread thread;

    ~FileWriter()
    {
        {
            std::lock_guard<std::mutex> lock(mu);
            stopping = true;
        }
        cv.notify_all();
        if (thread.joinable())
            thread.join();
    }

    void flush()
    {
        std::unique_lock<std::mutex> lock(mu);
        idle_cv.wait(lock, [this] { return queue.empty() && !busy; });
    }

    void enqueue(char level, const char *text)
    {
        {
            std::lock_guard<std::mutex> lock(mu);
            if (!on || stopping)
                return;
        }
        std::string line = format_file_line(level, text);
        {
            std::lock_guard<std::mutex> lock(mu);
            if (!on || stopping)
                return;
            if (queue.size() < FILE_QUEUE_MAX)
                queue.push_back(std::move(line));
        }
        cv.notify_one();
    }

    bool configure(const std::string &new_path, size_t new_max, const char *name, const char *version)
    {
        flush();
        std::string cur_path;
        size_t cur_max = 0;
        {
            std::lock_guard<std::mutex> lock(mu);
            path = new_path;
            max_bytes = new_max;
            on = !new_path.empty() && !stopping;
            queue.clear();
            if (!on)
                return false;
            cur_path = path;
            cur_max = max_bytes;
        }
        char start_text[256];
        std::snprintf(start_text, sizeof start_text, "start: %s%s%s, pid %d", name, version && *version ? " " : "",
                      version ? version : "", (int)getpid());
        std::vector<std::string> first(1, format_file_line('I', start_text));
        bool disable = false;
        const bool ok = write_batch(cur_path, cur_max, first, &disable);
        std::lock_guard<std::mutex> lock(mu);
        if (disable) {
            on = false;
            return false;
        }
        if (on && !stopping && !thread.joinable())
            thread = std::thread([this] { run(); });
        return ok;
    }

    void run()
    {
        std::vector<std::string> batch;
        for (;;) {
            std::string cur_path;
            size_t cur_max = 0;
            {
                std::unique_lock<std::mutex> lock(mu);
                cv.wait(lock, [this] { return stopping || !queue.empty(); });
                if (queue.empty()) {
                    if (stopping)
                        break;
                    continue;
                }
                if (!on) {
                    queue.clear();
                    idle_cv.notify_all();
                    continue;
                }
                busy = true;
                cur_path = path;
                cur_max = max_bytes;
                batch.clear();
                while (!queue.empty()) {
                    batch.push_back(std::move(queue.front()));
                    queue.pop_front();
                }
            }
            bool disable = false;
            write_batch(cur_path, cur_max, batch, &disable);
            {
                std::lock_guard<std::mutex> lock(mu);
                if (disable) {
                    on = false;
                    queue.clear();
                }
                busy = false;
                if (queue.empty())
                    idle_cv.notify_all();
            }
        }
    }
};

FileWriter &file_writer()
{
    static FileWriter w;
    return w;
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
    file_writer().enqueue(level, line);
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
    return file_writer().configure(path, max_bytes, name, version);
}

void log_flush_file()
{
    file_writer().flush();
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
