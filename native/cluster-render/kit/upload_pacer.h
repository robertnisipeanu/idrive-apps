/* SPDX-License-Identifier: MPL-2.0
 * Copyright (C) 2026 Robert Nisipeanu */
/* Paces the map buffer's writes to an average byte rate.
 *
 * Every write's raw bytes travel to the KOMBI's renderer, in the flush's
 * scene actions, through vsomeipd. INFERRED: it shares one TCP connection
 * with every head-unit participant's scene data, whose queue drops messages
 * past endpoint-queue-limit-external (20 MiB, VERIFIED); the KOMBI's
 * renderer unsubscribes a scene whose SceneActionList counter skips
 * (VERIFIED), which the cluster reports as the fetch REMOVED. Sending faster
 * than the link carries would then cost our scene and the HMI's.
 *
 * A frame may go whenever the allowance is positive; its bytes are then
 * charged, so the average stays at the rate, the allowance going negative by
 * at most one frame. Unused allowance is kept up to burst_ms of the rate, which
 * bounds the bytes sent back to back after a quiet spell, and debt is kept for
 * as long as the pacer lives, across sessions. A frame held
 * back is not lost: the next upload is diffed against what the buffer
 * holds, so it carries every change since. */
#ifndef CRK_UPLOAD_PACER_H
#define CRK_UPLOAD_PACER_H

#include <stdint.h>

namespace crk {

class UploadPacer {
public:
    /* Rates above this are taken as it, so that a refill cannot overflow. */
    static constexpr uint64_t kMaxRate = uint64_t(INT64_MAX) / 4000;

    /* bytes_per_s 0: no limit. The first ready() starts with a full burst's
     * allowance. */
    explicit UploadPacer(uint64_t bytes_per_s = 0, int64_t burst_ms = 1000)
        : rate_(int64_t(bytes_per_s < kMaxRate ? bytes_per_s : kMaxRate)),
          burst_ms_(burst_ms < 1 ? 1 : burst_ms > 1000 ? 1000 : burst_ms)
    {
    }

    bool limited() const { return rate_ != 0; }

    /* A new average rate (0: no limit); the allowance or debt carries over,
     * within the new burst. */
    void set_rate(uint64_t bytes_per_s)
    {
        rate_ = int64_t(bytes_per_s < kMaxRate ? bytes_per_s : kMaxRate);
        const int64_t cap = rate_ * burst_ms_ / 1000;
        if (rate_ != 0 && allowance_ > cap)
            allowance_ = cap;
    }

    /* Brings the allowance up to now_ms; whether a frame may go then. */
    bool ready(int64_t now_ms)
    {
        if (rate_ == 0)
            return true;
        const int64_t cap = rate_ * burst_ms_ / 1000;
        if (last_ms_ < 0) {
            allowance_ = cap;
            last_ms_ = now_ms;
        } else if (now_ms > last_ms_) {
            /* A gap long enough to repay the debt and refill the allowance
             * fills it; capping it there keeps rate_ * gap in range. */
            const int64_t enough = 1000 + (allowance_ < 0 ? (-allowance_ / rate_ + 1) * 1000 : 0);
            int64_t gap = now_ms - last_ms_;
            if (gap > enough)
                gap = enough;
            allowance_ += rate_ * gap / 1000;
            if (allowance_ > cap)
                allowance_ = cap;
            last_ms_ = now_ms;
        }
        return allowance_ > 0;
    }

    /* The bytes that may go now, as of the last ready(); negative: the
     * debt still to repay. Unlimited: INT64_MAX. */
    int64_t allowance() const { return rate_ == 0 ? INT64_MAX : allowance_; }
    /* Charges bytes sent. Call ready() first, so the allowance is current. */
    void spend(uint64_t bytes)
    {
        if (rate_ != 0)
            allowance_ -= int64_t(bytes);
    }

private:
    int64_t rate_;
    int64_t burst_ms_;
    int64_t allowance_ = 0;
    int64_t last_ms_ = -1;
};

}  // namespace crk

#endif
