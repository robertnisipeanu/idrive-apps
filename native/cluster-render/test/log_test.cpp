/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
/* Host test for the log file (log.h log_to_file): the UTC timestamp's
 * format; the start line; every line with its time and level; a line that
 * would pass the cap renames the file to .1 and starts a new one, a second
 * rotation replaces .1, and the two together stay within twice the cap; the
 * file is appended to across opens; a path that cannot be opened is one
 * warning and logging goes on without the file. */
#include <sys/stat.h>
#include <unistd.h>

#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <sstream>
#include <string>
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

    ok("opens", cld::log_to_file(path, 1000, "log_test", "1.2.3"));
    std::vector<std::string> l = read_lines(path);
    ok("start line with name, version and pid",
       l.size() == 1 && stamped(l[0], 'I') &&
           l[0].substr(26) == "start: log_test 1.2.3, pid " + std::to_string((int)getpid()));
    log_info("hello %d", 1);
    log_warn("careful");
    log_error("broken");
    l = read_lines(path);
    ok("each line with its time and level", l.size() == 4 && stamped(l[1], 'I') && l[1].substr(26) == "hello 1" &&
                                                 stamped(l[2], 'W') && l[2].substr(26) == "careful" &&
                                                 stamped(l[3], 'E') && l[3].substr(26) == "broken");
    ok("no .1 yet", file_size(old) < 0);

    /* 26 + 40 + 1 = 67 bytes a line */
    const std::string pad(40, 'a');
    long before = file_size(path);
    int n = 0;
    while (file_size(old) < 0 && n < 100) {
        log_info("%s", pad.c_str());
        n++;
    }
    ok("rotated once past the cap", file_size(old) == before + 67 * (n - 1) && file_size(old) <= 1000 &&
                                        file_size(path) == 67);
    l = read_lines(old);
    ok(".1 holds the start line", !l.empty() && l[0].find("start: log_test") != std::string::npos);

    for (int i = 0; i < 20; i++)
        log_info("%s %02d", pad.substr(3).c_str(), i);   /* 67 bytes too */
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

    ok("a path that cannot be opened", !cld::log_to_file(std::string(dir) + "/no/such/dir/x.log", 1000, "t", ""));
    const long kept = file_size(path);
    log_info("journal only");
    ok("logging goes on without the file", file_size(path) == kept);
    uint64_t seq = 0;
    std::vector<std::string> backlog;
    cld::log_lines_since(&seq, &backlog);
    ok("and the backlog keeps it", !backlog.empty() && backlog.back() == "journal only");

    unlink(path.c_str());
    unlink(old.c_str());
    rmdir(dir);
    std::printf("%s\n", failures ? "FAILED" : "all passed");
    return failures ? 1 : 0;
}
