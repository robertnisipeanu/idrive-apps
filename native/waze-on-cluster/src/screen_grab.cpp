// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 JustAnotherPU
#include "screen_grab.h"

#include <fcntl.h>
#include <poll.h>
#include <spawn.h>
#include <sys/stat.h>
#include <signal.h>
#include <sys/wait.h>
#include <unistd.h>

#include <algorithm>
#include <cerrno>
#include <cstdio>
#include <cstring>

#include "log.h"

extern char **environ;

using cld::now_ms;

namespace woc {

ScreenGrab::ScreenGrab(const ScreenGrabConfig &c) : c_(c)
{
    th_ = std::thread(&ScreenGrab::run, this);
}

ScreenGrab::~ScreenGrab()
{
    stop_ = true;
    if (th_.joinable())
        th_.join();
}

bool ScreenGrab::latest(std::vector<uint8_t> *y, int64_t now, int64_t max_age_ms) const
{
    std::lock_guard<std::mutex> l(mu_);
    if (y_.empty() || now - at_ms_ > max_age_ms)
        return false;
    *y = y_;
    return true;
}

std::string ScreenGrab::state() const
{
    std::lock_guard<std::mutex> l(mu_);
    char buf[160];
    std::snprintf(buf, sizeof buf, "centre screen: %s, %u frames, %u starts, the last %lld ms ago",
                  pid_ > 0 ? "grabbing" : "idle", frames_, starts_,
                  at_ms_ ? (long long)(now_ms() - at_ms_) : -1LL);
    return buf;
}

/* The grabber writes to a FIFO (its file plugin writes nothing to a pipe
 * given as /dev/stdout, tried on the unit). We hold it open read-write, so
 * the open never blocks and a dead grabber is found by waitpid, not EOF. */
bool ScreenGrab::spawn(int *fd)
{
    unlink(c_.fifo.c_str());
    if (mkfifo(c_.fifo.c_str(), 0600) != 0)
        return false;
    const int rfd = open(c_.fifo.c_str(), O_RDWR | O_CLOEXEC);
    if (rfd < 0)
        return false;
    char geo[32], fps[16], scr[64];
    std::snprintf(geo, sizeof geo, "--geometry=%ux%u", c_.w, c_.h);
    std::snprintf(fps, sizeof fps, "--fps=%u", c_.fps);
    std::snprintf(scr, sizeof scr, "--screen=%s", c_.screen.c_str());
    const std::string xdg = "XDG_RUNTIME_DIR=" + c_.wayland_dir;
    std::vector<char *> envp;
    for (char **e = environ; *e; e++)
        if (std::strncmp(*e, "XDG_RUNTIME_DIR=", 16) != 0) envp.push_back(*e);
    envp.push_back(const_cast<char *>(xdg.c_str()));
    envp.push_back(nullptr);
    char *argv[] = {const_cast<char *>(c_.grabber.c_str()), scr, geo, fps, const_cast<char *>("--num-frames=0"),
                    const_cast<char *>("--pipeline=rgb,file"), const_cast<char *>(c_.fifo.c_str()), nullptr};
    /* posix_spawn, not fork: nothing unsafe runs between the fork and the
     * exec in a threaded process; and the child gets an empty signal mask
     * (main blocks SIGTERM, which would make the grabber unkillable). */
    posix_spawn_file_actions_t fa;
    posix_spawnattr_t at;
    posix_spawn_file_actions_init(&fa);
    posix_spawnattr_init(&at);
    for (int i = 0; i < 3; i++)   /* it prints a libdrm line a frame */
        posix_spawn_file_actions_addopen(&fa, i, "/dev/null", O_RDWR, 0);
    sigset_t none;
    sigemptyset(&none);
    posix_spawnattr_setsigmask(&at, &none);
    posix_spawnattr_setflags(&at, POSIX_SPAWN_SETSIGMASK);
    pid_t pid = -1;
    const int err = posix_spawn(&pid, c_.grabber.c_str(), &fa, &at, argv, envp.data());
    posix_spawn_file_actions_destroy(&fa);
    posix_spawnattr_destroy(&at);
    if (err) {
        close(rfd);
        errno = err;
        return false;
    }
    *fd = rfd;
    std::lock_guard<std::mutex> l(mu_);
    pid_ = pid;
    starts_++;
    return true;
}

void ScreenGrab::reap(bool kill_it)
{
    pid_t pid;
    {
        std::lock_guard<std::mutex> l(mu_);
        pid = pid_;
        pid_ = -1;
    }
    if (pid <= 0)
        return;
    if (kill_it)
        kill(pid, SIGTERM);
    int st = 0;
    for (int i = 0; i < 20; i++) {   /* at most 1 s, then SIGKILL */
        if (waitpid(pid, &st, WNOHANG) == pid)
            return;
        usleep(50 * 1000);
    }
    kill(pid, SIGKILL);
    waitpid(pid, &st, 0);
}

void ScreenGrab::run()
{
    const size_t frame = (size_t)c_.w * c_.h * 4;
    std::vector<uint8_t> buf(frame), y((size_t)c_.w * c_.h);
    int fd = -1;
    size_t got = 0;
    int64_t retry_ms = 0;
    bool told = false;
    int backoff_s = 3;
    while (!stop_) {
        if (fd < 0) {
            if (!want_ || now_ms() < retry_ms) {
                usleep(200 * 1000);
                continue;
            }
            if (!spawn(&fd)) {
                log_warn("hud: cannot start %s: %s", c_.grabber.c_str(), strerror(errno));
                retry_ms = now_ms() + 3000;
                continue;
            }
            got = 0;
            if (!told)
                log_info("hud: reading the centre screen (%s, %ux%u at %u fps)", c_.grabber.c_str(), c_.w, c_.h, c_.fps);
            told = true;
        }
        if (!want_) {
            close(fd);
            fd = -1;
            reap(true);
            continue;
        }
        struct pollfd pfd = {fd, POLLIN, 0};
        if (poll(&pfd, 1, 500) <= 0) {
            pid_t pid;
            {
                std::lock_guard<std::mutex> l(mu_);
                pid = pid_;
            }
            int st;
            if (pid > 0 && waitpid(pid, &st, WNOHANG) == pid) {
                {
                    std::lock_guard<std::mutex> l(mu_);
                    pid_ = -1;
                }
                close(fd);
                fd = -1;
                log_warn("hud: the centre screen grabber exited (%s %d); again in %d s",
                         WIFSIGNALED(st) ? "signal" : "status", WIFSIGNALED(st) ? WTERMSIG(st) : WEXITSTATUS(st),
                         backoff_s);
                retry_ms = now_ms() + backoff_s * 1000;
                backoff_s = std::min(backoff_s * 2, 60);
            }
            continue;
        }
        const ssize_t n = read(fd, buf.data() + got, frame - got);
        if (n <= 0) {
            close(fd);
            fd = -1;
            reap(true);
            log_warn("hud: reading the centre screen grabber failed; again in 3 s");
            retry_ms = now_ms() + 3000;
            continue;
        }
        got += (size_t)n;
        backoff_s = 3;
        if (got < frame)
            continue;
        got = 0;
        /* BGRA (checked on the unit) to luma, BT.601 */
        for (size_t i = 0, j = 0; j < y.size(); i += 4, j++)
            y[j] = (uint8_t)((buf[i + 2] * 77 + buf[i + 1] * 150 + buf[i] * 29) >> 8);
        std::lock_guard<std::mutex> l(mu_);
        y_.swap(y);
        if (y.size() != y_.size())
            y.resize(y_.size());
        at_ms_ = now_ms();
        frames_++;
    }
    if (fd >= 0)
        close(fd);
    reap(true);
}

}  // namespace woc
