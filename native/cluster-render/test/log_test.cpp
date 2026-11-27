/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
/* Host test for the log file (log.h log_to_file): the UTC timestamp's
 * format; the start line; every line with its time and level; a line that
 * would pass the cap renames the file to .1 and starts a new one, a second
 * rotation replaces .1, and the two together stay within twice the cap; the
 * file is appended to across opens; no descriptor stays open between lines,
 * rotation included; a file system that is read-only (open, rename) or full
 * (write, a short write) drops the line without a word and the next line
 * writes again; a path that cannot be opened is one warning and logging goes
 * on without the file. */
#include <dirent.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

#include <cerrno>
#include <climits>

#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#include "../src/log.h"

static int failures;

static void ok(const char *name, bool cond)
{
    std::printf("%-4s %s\n", cond ? "ok" : "FAIL", name);
    if (!cond) failures++;
}

static std::vector<std::string> read_lines(const std::string &path)
{
    std::vector<std::string> out;
    std::ifstream f(path);
    std::string l;
    while (std::getline(f, l))
        out.push_back(l);
    return out;
}

static long file_size(const std::string &path)
{
    struct stat st;
    return stat(path.c_str(), &st) == 0 ? (long)st.st_size : -1;
}

/* The descriptors open in this process. */
static int open_fds()
{
    int n = 0;
    for (int fd = 0; fd < 1024; fd++)
        if (fcntl(fd, F_GETFD) != -1)
            n++;
    return n;
}

/* Whether a descriptor of this process names path (Linux: /proc/self/fd;
 * elsewhere false, open_fds covers it). */
static bool fd_on(const std::string &path)
{
    char real[PATH_MAX];
    if (!realpath(path.c_str(), real))
        return false;
    DIR *d = opendir("/proc/self/fd");
    if (!d)
        return false;
    bool found = false;
    while (struct dirent *e = readdir(d)) {
        char link[PATH_MAX];
        const ssize_t n = readlink(("/proc/self/fd/" + std::string(e->d_name)).c_str(), link, sizeof link - 1);
        if (n > 0 && std::string(link, (size_t)n) == real)
            found = true;
    }
    closedir(d);
    return found;
}

/* Failing calls for the log file: the errno each next call fails with (0:
 * the real call). */
static int fail_open, fail_write, fail_rename;
static bool short_write;
static const cld::LogFileCalls real_calls = cld::log_file_calls;
static int test_open(const char *path, int flags, mode_t mode)
{
    if (fail_open) {
        errno = fail_open;
        return -1;
    }
    return real_calls.open_file(path, flags, mode);
}
static ssize_t test_write(int fd, const void *buf, size_t n)
{
    if (fail_write) {
        errno = fail_write;
        return -1;
    }
    return real_calls.write_file(fd, buf, short_write && n > 1 ? n / 2 : n);
}
static int test_rename(const char *from, const char *to)
{
    if (fail_rename) {
        errno = fail_rename;
        return -1;
    }
    return real_calls.rename_file(from, to);
}

/* stderr into a file while the test logs, to see what the log file's
 * failures write there. */
static int saved_stderr = -1;
static void stderr_to(const std::string &path)
{
    std::fflush(stderr);
    saved_stderr = dup(2);
    const int fd = open(path.c_str(), O_WRONLY | O_CREAT | O_TRUNC, 0644);
    dup2(fd, 2);
    close(fd);
}
static void stderr_back()
{
    std::fflush(stderr);
    dup2(saved_stderr, 2);
    close(saved_stderr);
}

/* "YYYY-MM-DD HH:MM:SS.mmm L " */
static bool stamped(const std::string &l, char level)
{
    if (l.size() < 26)
        return false;
    const char *shape = "dddd-dd-dd dd:dd:dd.ddd";
    for (size_t i = 0; shape[i]; i++)
        if (shape[i] == 'd' ? (l[i] < '0' || l[i] > '9') : l[i] != shape[i])
            return false;
    return l[23] == ' ' && l[24] == level && l[25] == ' ';
}

int main()
{
    ok("epoch", cld::utc_time(0) == "1970-01-01 00:00:00.000");
    ok("a time with milliseconds", cld::utc_time(1730376896789LL) == "2024-10-31 12:14:56.789");
    ok("milliseconds padded", cld::utc_time(951782400007LL) == "2000-02-29 00:00:00.007");

    char dir[] = "/tmp/cr_log_test.XXXXXX";
    if (!mkdtemp(dir)) {
        std::perror("mkdtemp");
        return 1;
    }
    const std::string path = std::string(dir) + "/x.log", old = path + ".1";
    cld::log_name = "log_test";

    const int fds = open_fds();
    ok("opens", cld::log_to_file(path, 1000, "log_test", "1.2.3"));
    std::vector<std::string> l = read_lines(path);
    ok("start line with name, version and pid",
       l.size() == 1 && stamped(l[0], 'I') &&
           l[0].substr(26) == "start: log_test 1.2.3, pid " + std::to_string((int)getpid()));
    log_info("hello %d", 1);
    log_warn("careful");
    log_error("broken");
    cld::log_flush_file();
    l = read_lines(path);
    ok("each line with its time and level", l.size() == 4 && stamped(l[1], 'I') && l[1].substr(26) == "hello 1" &&
                                                 stamped(l[2], 'W') && l[2].substr(26) == "careful" &&
                                                 stamped(l[3], 'E') && l[3].substr(26) == "broken");
    ok("no .1 yet", file_size(old) < 0);
    ok("no descriptor stays open between lines", open_fds() == fds && !fd_on(path));

    /* 26 + 40 + 1 = 67 bytes a line */
    const std::string pad(40, 'a');
    long before = file_size(path);
    int n = 0;
    while (file_size(old) < 0 && n < 100) {
        log_info("%s", pad.c_str());
        cld::log_flush_file();
        n++;
    }
    ok("rotated once past the cap", file_size(old) == before + 67 * (n - 1) && file_size(old) <= 1000 &&
                                        file_size(path) == 67);
    l = read_lines(old);
    ok("none after a rotation either", open_fds() == fds && !fd_on(path) && !fd_on(old));
    ok(".1 holds the start line", !l.empty() && l[0].find("start: log_test") != std::string::npos);

    for (int i = 0; i < 20; i++)
        log_info("%s %02d", pad.substr(3).c_str(), i);   /* 67 bytes too */
    cld::log_flush_file();
    l = read_lines(old);
    ok("a second rotation replaces .1", !l.empty() && l[0].find("start:") == std::string::npos);
    ok("the two together within twice the cap", file_size(path) <= 1000 && file_size(old) <= 1000);
    l = read_lines(path);
    ok("the newest line last", !l.empty() && l.back().substr(26) == pad.substr(3) + " 19");

    const long now = file_size(path);
    ok("opened again", cld::log_to_file(path, 1000, "log_test", ""));
    l = read_lines(path);
    ok("appends, the start line without a version",
       file_size(path) > now && l.back().substr(26) == "start: log_test, pid " + std::to_string((int)getpid()));

    /* a read-only or full file system */
    const std::string err_path = std::string(dir) + "/stderr";
    cld::log_file_calls = {test_open, test_write, test_rename};
    stderr_to(err_path);
    long size = file_size(path);
    fail_open = EROFS;
    log_info("read-only");
    cld::log_flush_file();
    ok("read-only: the line is dropped", file_size(path) == size);
    fail_open = 0;
    log_info("writable again");
    cld::log_flush_file();
    l = read_lines(path);
    ok("the next line writes again", l.back().substr(26) == "writable again");
    size = file_size(path);
    fail_write = ENOSPC;
    log_info("full");
    cld::log_flush_file();
    fail_write = EDQUOT;
    log_info("over quota");
    cld::log_flush_file();
    ok("full, over quota: dropped", file_size(path) == size);
    fail_write = 0;
    short_write = true;
    log_info("half");
    cld::log_flush_file();
    short_write = false;
    log_info("room again");
    cld::log_flush_file();
    l = read_lines(path);
    ok("a short write is taken back, the next line written whole",
       file_size(path) == size + 26 + 11 && l.back().substr(26) == "room again");
    /* fds + 1: the saved stderr */
    ok("no descriptor left by the failures", open_fds() == fds + 1 && !fd_on(path));
    fail_rename = EROFS;
    const long at_cap = file_size(path), old_size = file_size(old);
    for (int i = 0; i < 20; i++)
        log_info("%s", pad.c_str());
    cld::log_flush_file();
    ok("a rename refused read-only drops the line, nothing rotated",
       file_size(old) == old_size && file_size(path) <= 1000 && file_size(path) >= at_cap);
    fail_rename = 0;
    log_info("%s", pad.c_str());
    cld::log_flush_file();
    l = read_lines(old);
    bool moved = false;
    for (const std::string &x : l)
        moved = moved || (x.size() > 26 && x.substr(26) == "room again");
    ok("the next line rotates", file_size(path) == 67 && file_size(old) <= 1000 && moved);
    fail_open = EROFS;
    ok("a start on a read-only file system", !cld::log_to_file(path, 1000, "log_test", ""));
    fail_open = 0;
    log_info("after a read-only start");
    cld::log_flush_file();
    l = read_lines(path);
    ok("writes once it is writable", l.back().substr(26) == "after a read-only start");
    stderr_back();
    bool warned = false;
    for (const std::string &x : read_lines(err_path))
        warned = warned || x.find("log file") != std::string::npos;
    ok("not a word on stderr about any of it", !warned);
    cld::log_file_calls = real_calls;
    unlink(err_path.c_str());

    ok("a path that cannot be opened", !cld::log_to_file(std::string(dir) + "/no/such/dir/x.log", 1000, "t", ""));
    const long kept = file_size(path);
    log_info("journal only");
    cld::log_flush_file();
    ok("logging goes on without the file", file_size(path) == kept);
    uint64_t seq = 0;
    std::vector<std::string> backlog;
    cld::log_lines_since(&seq, &backlog);
    ok("and the backlog keeps it", !backlog.empty() && backlog.back() == "journal only");

    /* Async burst from another thread flushes cleanly with no open descriptor left. */
    const std::string burst_path = std::string(dir) + "/burst.log";
    ok("burst log opens", cld::log_to_file(burst_path, 65536, "log_test", "1.0"));
    std::thread producer([&] {
        for (int i = 0; i < 40; i++)
            log_info("burst %d", i);
    });
    producer.join();
    cld::log_flush_file();
    l = read_lines(burst_path);
    ok("async burst writes every line in order and leaves no fd open",
       l.size() == 41 && l[1].substr(26) == "burst 0" && l[40].substr(26) == "burst 39" &&
           open_fds() == fds && !fd_on(burst_path));
    cld::log_to_file("", 0, "", "");
    unlink(burst_path.c_str());

    unlink(path.c_str());
    unlink(old.c_str());
    rmdir(dir);
    std::printf("%s\n", failures ? "FAILED" : "all passed");
    return failures ? 1 : 0;
}
