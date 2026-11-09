// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 JustAnotherPU
/* Waze's turn arrows on BMW's own HUD (README.md "HUD arrows", an
 * experimental option, off unless the app turns it on). Waze sends CarPlay
 * no route guidance, so BMW's HUD shows no arrows for it, while it does for
 * Apple Maps and Google Maps. While the option is on, HudArrows reads the
 * card iOS draws for Waze's next turn at the top left of the CarPlay screen
 * (the centre screen, grabbed by the unit's winston-grabber, screen_grab.h),
 * at most every sample_ms, and writes each settled reading to a file for
 * the waze-on-cluster-hudguide service (patch/hudguide.js), which sends it
 * to the navigation's ProjectedModeGuiding as carplay sends Apple's and
 * Google's. The cluster map is unaffected.
 *
 * Off (the default) it does nothing: no grabber, no thread, no file. */
#ifndef WOC_HUD_ARROWS_H
#define WOC_HUD_ARROWS_H

#include <stdint.h>
#include <memory>
#include <string>
#include <vector>

#include "hud_banner.h"
#include "hud_maparrow.h"
#include "screen_grab.h"

namespace woc {

/* The reading as JSON (maneuver, distance, at) in `path`, rewritten on
 * change and every second (hudguide clears a reading 3 s stale); clear()
 * removes the file. */
class NativeGuidanceHud {
public:
    explicit NativeGuidanceHud(const std::string &path) : path_(path) {}
    void show(const Reading &r, int64_t now_ms);
    void poll(int64_t now_ms);
    void clear();
    std::string state() const;

private:
    void write(int64_t now_ms);

    std::string path_;
    Reading want_;
    int64_t written_ms_ = -1000000;
    unsigned writes_ = 0;
    bool failed_ = false;
};

struct HudConfig {
    CardConfig card;   /* in centre-screen pixels */
    ScreenGrabConfig grab;
    std::string templates_dir = "/var/opt/waze-on-cluster/hud-templates";   /* the card's distance glyphs */
    unsigned sample_ms = 250;
    unsigned stable = 2;
    std::string guidance_path = "/run/waze-on-cluster/hud.json";
};

class HudArrows {
public:
    explicit HudArrows(const HudConfig &cfg) : cfg_(cfg), debounce_(cfg.stable), out_(cfg.guidance_path) {}
    /* Whether arrows may show now (the option on, the stream live); off
     * stops the grabber and removes the reading. */
    void set_active(bool on, int64_t now_ms);
    /* While active: reads the card when a sample is due, and the heartbeat. */
    void poll(int64_t now_ms);
    bool active() const { return active_; }
    std::string report() const;

private:
    void load_templates();

    HudConfig cfg_;
    Templates tpl_;
    std::unique_ptr<CardReader> card_;
    std::unique_ptr<ScreenGrab> grab_;   /* made the first time the arrows go on */
    std::vector<uint8_t> scr_;
    int64_t tpl_checked_ms_ = -1000000;
    long tpl_mtime_ = 0;
    Debounce debounce_;
    CardHold hold_;
    NativeGuidanceHud out_;
    bool active_ = false;
    int64_t last_sample_ms_ = -1000000;
    Reading last_read_;
};

}  // namespace woc

#endif
