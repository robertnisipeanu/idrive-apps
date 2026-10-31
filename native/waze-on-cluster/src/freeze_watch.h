// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* A frozen CarPlay cluster stream: the phone keeps sending frames (15-21 a
 * second on the car) that all decode to the same picture until CarPlay
 * reconnects. A static map (a red light, parked) sends about one frame in
 * ten seconds instead, so a steady frame rate with no change tells the two
 * apart.
 *
 * ChangeSampler compares each frame's luma, sampled on a grid, with the
 * previous one; FreezeWatch calls the stream frozen once frames have kept
 * coming at least min_fps for ms with none changed, and not frozen at the
 * next changed frame. */
#ifndef WOC_FREEZE_WATCH_H
#define WOC_FREEZE_WATCH_H

#include <stddef.h>
#include <stdint.h>
#include <deque>
#include <vector>

namespace woc {

class ChangeSampler {
public:
    /* Every step-th pixel of every step-th row of a w x h luma plane; a
     * sample that moves more than threshold is a change. */
    ChangeSampler(uint32_t w, uint32_t h, uint32_t step = 4, uint32_t threshold = 8);
    /* Whether y (the w x h luma plane) differs from the last one given; the
     * first one does. */
    bool changed(const uint8_t *y);

private:
    uint32_t w_, h_, step_, threshold_;
    std::vector<uint8_t> last_;
    bool have_ = false;
};

struct FreezeConfig {
    unsigned ms = 10000;    /* 0: never frozen */
    unsigned min_fps = 3;
};

class FreezeWatch {
public:
    explicit FreezeWatch(const FreezeConfig &cfg) : cfg_(cfg) {}
    void frame(int64_t now_ms, bool changed);
    bool frozen(int64_t now_ms) const;

private:
    FreezeConfig cfg_;
    int64_t unchanged_since_ms_ = -1;   /* the last changed frame */
    std::deque<int64_t> times_;         /* unchanged frames within ms */
};

}  // namespace woc

#endif
