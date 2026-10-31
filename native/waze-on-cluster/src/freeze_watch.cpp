// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
#include "freeze_watch.h"

#include <cstdlib>

namespace woc {

ChangeSampler::ChangeSampler(uint32_t w, uint32_t h, uint32_t step, uint32_t threshold)
    : w_(w), h_(h), step_(step ? step : 1), threshold_(threshold),
      last_((size_t)((w + step_ - 1) / step_) * ((h + step_ - 1) / step_))
{
}

bool ChangeSampler::changed(const uint8_t *y)
{
    bool diff = !have_;
    size_t i = 0;
    for (uint32_t r = 0; r < h_; r += step_) {
        const uint8_t *row = y + (size_t)r * w_;
        for (uint32_t c = 0; c < w_; c += step_, i++) {
            if (!diff && (uint32_t)std::abs((int)row[c] - (int)last_[i]) > threshold_)
                diff = true;
            last_[i] = row[c];
        }
    }
    have_ = true;
    return diff;
}

void FreezeWatch::frame(int64_t now_ms, bool changed)
{
    if (changed || unchanged_since_ms_ < 0) {
        unchanged_since_ms_ = now_ms;
        times_.clear();
        return;
    }
    times_.push_back(now_ms);
    while (!times_.empty() && now_ms - times_.front() > (int64_t)cfg_.ms)
        times_.pop_front();
}

bool FreezeWatch::frozen(int64_t now_ms) const
{
    if (!cfg_.ms || unchanged_since_ms_ < 0 || now_ms - unchanged_since_ms_ < (int64_t)cfg_.ms)
        return false;
    /* frames still coming at min_fps over the last ms: a stream that slowed
     * down or stopped is static, not frozen */
    size_t recent = 0;
    for (int64_t t : times_)
        if (now_ms - t <= (int64_t)cfg_.ms)
            recent++;
    return recent * 1000 >= (size_t)cfg_.min_fps * cfg_.ms;
}

}  // namespace woc
