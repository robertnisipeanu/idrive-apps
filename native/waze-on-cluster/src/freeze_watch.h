// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* What CarPlay's cluster stream shows, from its decoded pictures.
 *
 * A blank picture: the phone sends one when the cluster has nothing to
 * show. A stream starts blank (93 frames in about 2 s on the car, then a
 * pause) and stays so until a navigation app draws its cluster view (in
 * the field, once a route starts in Waze or Google Maps). A map always draws something, so the map
 * goes up only once the stream shows a non-blank picture and comes down
 * again once its picture has stayed blank for blank_ms: the stock map shows
 * instead of a black centre.
 *
 * A frozen stream: the phone keeps sending frames (15-21 a second on the
 * car) that all decode to the same blank picture until CarPlay reconnects.
 * A static map (a red light, parked) can send the same picture just as
 * steadily: one phone sends a frame about every ten seconds, another keeps
 * its full rate. So the rate alone does not tell the two apart; the picture
 * does.
 *
 * ChangeSampler compares each frame's luma, sampled on a grid, with the
 * previous one, and says whether the picture is blank. FreezeWatch says
 * what the stream has to show (picture) and calls the stream frozen once
 * frames have kept coming at least min_fps for ms, all of them blank and
 * none changed, and not frozen at the next changed or non-blank frame.
 * Until the stream has shown a picture that takes three times as long: one
 * that starts blank and keeps sending it at full rate (a reconnect that did
 * not take) is frozen, while the start's short burst and pause is not. A
 * stream ends when CarPlay's cluster stream stops being live; the frames
 * from then on, the one that makes it live again among them, are the next
 * stream's. FrameTally sums the same verdicts a minute at a time
 * for the log. */
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
    unsigned ms = 10000;        /* 0: never frozen */
    unsigned min_fps = 3;
    unsigned blank_ms = 10000;  /* a picture blank this long: nothing to show */
};

/* What a stream has to show: no frame yet; only blank pictures (none
 * non-blank yet, or blank for blank_ms since its last non-blank one); or a
 * picture (the last one non-blank, or blank for less than blank_ms). */
enum class Picture { None, Blank, Shown };

class FreezeWatch {
public:
    explicit FreezeWatch(const FreezeConfig &cfg) : cfg_(cfg) {}
    void frame(int64_t now_ms, bool changed, bool blank);
    /* Whether CarPlay's cluster stream is live. Going not live ends the
     * stream: what its frames showed is forgotten, and the next stream has
     * no frame yet. */
    void live(bool on);
    bool frozen(int64_t now_ms) const;
    Picture picture(int64_t now_ms) const;

private:
    FreezeConfig cfg_;
    bool live_ = false;
    bool framed_ = false;               /* None (no frame) or Blank: their status lines differ */
    bool pictured_ = false;             /* the stream has shown a non-blank picture */
    int64_t blank_since_ms_ = -1;       /* the first blank frame since the last non-blank one */
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
