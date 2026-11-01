// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* What losses in the phone's stream did to the picture, for the status
 * reason, the log and the minute line.
 *
 * The phone sends a keyframe only when its stream starts, so a loss is
 * decoded through: the decoder conceals what is missing and the map shows
 * smudges until the phone codes those areas again. The stream is clean, or
 * decoding through a loss from that loss until the first frame the decoder
 * does not flag corrupted, or waiting for a keyframe while the decoder has
 * given up on its sequence (decoder_msdk.h) until it starts a new one. The
 * reason names when the episode began (its first loss, or the wait), so it
 * stays the same, and the status is logged once, for the whole episode.
 *
 * Each loss and each return to a clean picture is a log line, at most
 * kLinesPerMinute a minute; the minute line counts them all. Not
 * thread-safe. */
#ifndef WOC_STREAM_HEALTH_H
#define WOC_STREAM_HEALTH_H

#include <stdint.h>
#include <string>

namespace woc {

class StreamHealth {
public:
    static const unsigned kLinesPerMinute = 10;
    /* After a loss with no frame for this long the reason says so. */
    static const int64_t kNoFrameMs = 2000;

    struct Minute {
        uint32_t losses = 0, lost = 0, corrupted = 0;
    };

    /* A sequence gap at now_ms (monotonic) and wall_ms (since the epoch):
     * the packet expected, the one that came, the sequence numbers between,
     * and how many of those the receive queue dropped. The line to log;
     * empty past the minute's lines. */
    std::string loss(int64_t now_ms, int64_t wall_ms, const char *source, uint16_t expected, uint16_t got,
                     uint32_t lost, uint32_t queue_dropped);
    /* A decoded frame and its decoder corruption flags (0: clean). The
     * line to log, or empty. */
    std::string frame(int64_t now_ms, uint16_t corrupted);
    /* The decoder gave up on its sequence (on) or started a new one. The
     * line to log for a new one after a wait, or empty. */
    std::string waiting(int64_t now_ms, int64_t wall_ms, bool on);

    /* Empty while clean; resync_held is why patchd does not restart
     * CarPlay for a new stream, empty when it has not said. */
    std::string reason(int64_t now_ms, const std::string &resync_held) const;
    /* The counts since the last call. */
    Minute take_minute();

private:
    enum State { Clean, Through, Waiting };
    bool line_due(int64_t now_ms);

    State state_ = Clean;
    std::string since_;            /* the episode's start, "HH:MM:SS" UTC */
    int64_t loss_ms_ = 0, waiting_ms_ = 0;
    uint32_t frames_since_ = 0, corrupted_since_ = 0;
    Minute minute_;
    int64_t lines_since_ms_ = -1;
    unsigned lines_ = 0;
};

}  // namespace woc

#endif
