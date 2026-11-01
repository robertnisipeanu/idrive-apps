// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* The receive queue's backlog (packet_queue.h) as the decode thread meets
 * it: how long each packet it takes has waited, and the frames it decodes
 * without a picture to catch up (video_producer.h), a minute at a time for
 * the log and since the start for probe.txt.
 *
 * Catching up keeps a packet's wait within about one picture's output and a
 * few frames' decoding (well under kLagUs on the unit's GPU), so waits of
 * kLagUs or more on every packet for kLagForMs mean the decoder is slower
 * than the stream even without the pictures: the decoder is behind until a
 * packet waits less than half of kLagUs, or no packet comes for kPauseMs
 * (the stream paused or ended). Not thread-safe. */
#ifndef WOC_BACKLOG_H
#define WOC_BACKLOG_H

#include <stdint.h>
#include <cstdio>
#include <string>

#include "frame_clock.h"

namespace woc {

class Backlog {
public:
    static const int64_t kLagUs = 200000;
    static const int64_t kLagForMs = 5000;
    static const int64_t kPauseMs = 1000;

    struct Minute {
        crk::Spread wait_us;     /* the packets taken */
        uint32_t skipped = 0;    /* frames decoded without a picture */
    };

    /* A packet taken at now_ms after waiting wait_us. The line to log when
     * the decoder falls behind the stream or catches up with it; empty
     * otherwise. */
    std::string packet(int64_t now_ms, int64_t wait_us)
    {
        minute_.wait_us.add(wait_us);
        if (wait_us > max_us_)
            max_us_ = wait_us;
        if (last_ms_ >= 0 && now_ms - last_ms_ > kPauseMs) {
            over_since_ms_ = -1;
            behind_ = false;
        }
        last_ms_ = now_ms;
        char line[200] = "";
        if (wait_us < kLagUs) {
            over_since_ms_ = -1;
            if (behind_ && wait_us < kLagUs / 2) {
                behind_ = false;
                std::snprintf(line, sizeof line,
                              "waze: the decoder caught up with the stream after %lld s behind it "
                              "(packets waited at most %lld ms)",
                              (long long)((now_ms - behind_since_ms_) / 1000), (long long)(behind_max_us_ / 1000));
            }
        } else {
            if (over_since_ms_ < 0)
                over_since_ms_ = now_ms;
            if (behind_ && wait_us > behind_max_us_)
                behind_max_us_ = wait_us;
            if (!behind_ && now_ms - over_since_ms_ >= kLagForMs) {
                behind_ = true;
                behind_since_ms_ = over_since_ms_;
                behind_max_us_ = wait_us;
                std::snprintf(line, sizeof line,
                              "waze: the decoder is behind the stream: every packet for %lld s waited over %lld ms "
                              "in the receive queue, now %lld ms, with pictures skipped to catch up",
                              (long long)((now_ms - over_since_ms_) / 1000), (long long)(kLagUs / 1000),
                              (long long)(wait_us / 1000));
            }
        }
        return line;
    }

    void skipped()
    {
        minute_.skipped++;
        skipped_total_++;
    }

    /* The counts since the last call. */
    Minute take_minute()
    {
        const Minute m = minute_;
        minute_ = Minute();
        return m;
    }

    int64_t max_wait_us() const { return max_us_; }
    uint64_t skipped_total() const { return skipped_total_; }
    /* Behind the stream at now_ms: not once the packets paused. */
    bool behind(int64_t now_ms) const { return behind_ && now_ms - last_ms_ <= kPauseMs; }

private:
    Minute minute_;
    int64_t max_us_ = 0;
    uint64_t skipped_total_ = 0;
    int64_t over_since_ms_ = -1;   /* the first of the packets in a row that waited kLagUs or more */
    int64_t last_ms_ = -1;         /* the last packet taken */
    bool behind_ = false;
    int64_t behind_since_ms_ = 0, behind_max_us_ = 0;
};

}  // namespace woc

#endif
