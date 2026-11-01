// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
#include "stream_health.h"

#include <cstdio>

#include "log.h"

namespace woc {

bool StreamHealth::line_due(int64_t now_ms)
{
    if (lines_since_ms_ < 0 || now_ms - lines_since_ms_ >= 60000) {
        lines_since_ms_ = now_ms;
        lines_ = 0;
    }
    return lines_++ < kLinesPerMinute;
}

std::string StreamHealth::loss(int64_t now_ms, int64_t wall_ms, const char *source, uint16_t expected, uint16_t got,
                               uint32_t lost, uint32_t queue_dropped)
{
    minute_.losses++;
    minute_.lost += lost;
    if (state_ == Clean) {
        state_ = Through;
        since_ = cld::utc_time(wall_ms).substr(11, 8);
        loss_ms_ = now_ms;
        frames_since_ = corrupted_since_ = 0;
    }
    if (!line_due(now_ms))
        return std::string();
    char line[256];
    std::snprintf(line, sizeof line, "waze: lost %u packets of the stream from %s (sequence %u, expected %u%s); %s",
                  lost, source, got, expected,
                  queue_dropped ? ("; " + std::to_string(queue_dropped) + " dropped by the receive queue").c_str() : "",
                  state_ == Waiting ? "the decoder waits for a keyframe" : "decoding through it");
    return line;
}

std::string StreamHealth::frame(int64_t now_ms, uint16_t corrupted)
{
    if (corrupted)
        minute_.corrupted++;
    if (state_ != Through)
        return std::string();
    frames_since_++;
    if (corrupted) {
        corrupted_since_++;
        if (corrupted_since_ > 1 || !line_due(now_ms))
            return std::string();
        char line[128];
        std::snprintf(line, sizeof line, "waze: the first frame after the loss is corrupted (decoder flags 0x%x)",
                      (unsigned)corrupted);
        return line;
    }
    state_ = Clean;
    if (!line_due(now_ms))
        return std::string();
    char line[160];
    std::snprintf(line, sizeof line, "waze: the picture is clean again %lld ms after the loss at %s (%u corrupted frames)",
                  (long long)(now_ms - loss_ms_), since_.c_str(), corrupted_since_);
    return line;
}

std::string StreamHealth::waiting(int64_t now_ms, int64_t wall_ms, bool on)
{
    if (on) {
        if (state_ != Waiting) {
            waiting_ms_ = now_ms;
            since_ = cld::utc_time(wall_ms).substr(11, 8);
        }
        state_ = Waiting;
        return std::string();
    }
    if (state_ != Waiting)
        return std::string();
    state_ = Clean;
    return "waze: decoding again from a keyframe after " + std::to_string((now_ms - waiting_ms_) / 1000) +
           " s waiting";
}

std::string StreamHealth::reason(int64_t now_ms, const std::string &resync_held) const
{
    switch (state_) {
    case Waiting:
        return "waiting for a keyframe since " + since_ + (resync_held.empty() ? "" : "; resync held: " + resync_held);
    case Through:
        return "lost part of the stream at " + since_ +
               (frames_since_ == 0 && now_ms - loss_ms_ >= kNoFrameMs ? "; nothing decoded since" : "; decoding through it");
    default:
        return std::string();
    }
}

StreamHealth::Minute StreamHealth::take_minute()
{
    const Minute m = minute_;
    minute_ = Minute();
    return m;
}

}  // namespace woc
