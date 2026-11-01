// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* A frozen CarPlay cluster stream: the phone keeps sending frames (15-21 a
 * second on the car) that all decode to the same empty picture until CarPlay
 * reconnects. A static map (a red light, parked) can send the same picture
 * just as steadily: one phone sends a frame about every ten seconds, another
 * keeps its full rate. So the rate does not tell the two apart; the picture
 * does: a map always draws something.
 *
 * ChangeSampler compares each frame's luma, sampled on a grid, with the
 * previous one, and says whether the picture is blank; FreezeWatch calls the
 * stream frozen once frames have kept coming at least min_fps for ms, all of
 * them blank and none changed, and not frozen at the next changed or
 * non-blank frame. Until the stream has shown a picture it takes three
 * times as long: a phone starting its stream sends the same blank picture
 * for a while (93 frames in about 2 s on the car, then a pause) before the
 * map's first, while one that starts blank and stays so (a reconnect that
 * did not take) keeps sending it. A stream starts when CarPlay's cluster
 * stream becomes live and ends when it stops being live. FrameTally sums
 * the same verdicts a minute at a time for the log. */
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
    /* Whether the last plane given is blank: all but one in a thousand of
     * its samples within one band of 2 * threshold + 1 levels. */
    bool blank() const { return blank_; }

private:
    uint32_t w_, h_, step_, threshold_;
    std::vector<uint8_t> last_;
    bool have_ = false, blank_ = false;
};

struct FreezeConfig {
    unsigned ms = 10000;    /* 0: never frozen */
    unsigned min_fps = 3;
};

class FreezeWatch {
public:
    explicit FreezeWatch(const FreezeConfig &cfg) : cfg_(cfg) {}
    void frame(int64_t now_ms, bool changed, bool blank);
    /* Whether CarPlay's cluster stream is live; each change starts a new
     * stream, with no picture shown yet. */
    void live(bool on);
    bool frozen(int64_t now_ms) const;

private:
    FreezeConfig cfg_;
    bool live_ = false;
    bool pictured_ = false;             /* the stream has shown a non-blank picture */
    int64_t unchanged_since_ms_ = -1;   /* the last changed or non-blank frame */
    std::deque<int64_t> times_;         /* unchanged blank frames within ms */
};

/* The frames of each minute while they come: how many, how many changed,
 * and whether the last one was blank. A minute starts at its first frame. */
class FrameTally {
public:
    static const int64_t kMinuteMs = 60000;
    struct Minute {
        unsigned frames = 0, changed = 0;
        bool blank = false;   /* the last frame's picture */
    };
    void frame(int64_t now_ms, bool changed, bool blank);
    /* True, with the minute's tally, once a minute has passed since its
     * first frame; the next minute starts at the next frame. */
    bool take(int64_t now_ms, Minute *out);

private:
    int64_t since_ms_ = -1;   /* the minute's first frame; -1: none yet */
    Minute m_;
};

}  // namespace woc

#endif
