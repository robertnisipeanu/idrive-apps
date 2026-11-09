// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 JustAnotherPU
/* The centre screen's luma, for the CarPlay manoeuvre card (hud_maparrow.h).
 * The unit's own winston-grabber (Wayland screencopy, as the screencast tool
 * uses) writes raw BGRA frames (`--pipeline=rgb,file`) to our FIFO at `fps`;
 * a thread turns each into luma and keeps the latest. The grabber runs only
 * while wanted (the HUD arrows are on) and is started again 3 s after it
 * exits. Measured on the unit: 1920x720 at 2 fps costs about 2% of a core
 * (we take 4: the HUD half a second behind the card, not 1.5 s)
 * and coexists with the screencast. */
#ifndef WOC_SCREEN_GRAB_H
#define WOC_SCREEN_GRAB_H

#include <stdint.h>
#include <sys/types.h>

#include <atomic>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace woc {

struct ScreenGrabConfig {
    std::string grabber = "/usr/bin/winston-grabber";
    std::string screen = "center";
    std::string wayland_dir = "/run/wayland";
    std::string fifo = "/run/waze-on-cluster/screen.fifo";
    unsigned w = 1920, h = 720, fps = 4;
};

class ScreenGrab {
public:
    explicit ScreenGrab(const ScreenGrabConfig &c);
    ~ScreenGrab();
    void want(bool on) { want_ = on; }
    /* The latest frame's luma when it is at most max_age_ms old. */
    bool latest(std::vector<uint8_t> *y, int64_t now_ms, int64_t max_age_ms) const;
    std::string state() const;

private:
    void run();
    bool spawn(int *fd);
    void reap(bool kill_it);

    ScreenGrabConfig c_;
    std::atomic<bool> want_{false}, stop_{false};
    std::thread th_;
    pid_t pid_ = -1;
    mutable std::mutex mu_;
    std::vector<uint8_t> y_;
    int64_t at_ms_ = 0;
    unsigned frames_ = 0, starts_ = 0;
};

}  // namespace woc

#endif
