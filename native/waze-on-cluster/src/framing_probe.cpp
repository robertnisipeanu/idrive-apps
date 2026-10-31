// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
#include "framing_probe.h"

#include <chrono>
#include <cstdio>

namespace woc {

static int64_t steady_ms()
{
    return std::chrono::duration_cast<std::chrono::milliseconds>(
               std::chrono::steady_clock::now().time_since_epoch())
        .count();
}

void FramingProbe::record(const uint8_t *data, size_t len)
{
    record(data, len, steady_ms());
}

void FramingProbe::record(const uint8_t *data, size_t len, int64_t now)
{
    std::lock_guard<std::mutex> lock(mutex_);
    record_locked(data, len, now);
    scan_nals(data, len, now);
}

void FramingProbe::record_rtp(const uint8_t *data, size_t len)
{
    record_rtp(data, len, steady_ms());
}

void FramingProbe::record_rtp(const uint8_t *data, size_t len, int64_t now)
{
    std::lock_guard<std::mutex> lock(mutex_);
    record_locked(data, len, now);
}

uint64_t FramingProbe::keyframes() const
{
    std::lock_guard<std::mutex> lock(mutex_);
    return nal_sps_ + nal_idr_;
}

void FramingProbe::nal(uint8_t type)
{
    nal(type, steady_ms());
}

void FramingProbe::nal(uint8_t type, int64_t now)
{
    std::lock_guard<std::mutex> lock(mutex_);
    record_nal((uint8_t)(type & 0x1f), now);
}

void FramingProbe::record_locked(const uint8_t *data, size_t len, int64_t now)
{
    if (first_ms_ < 0) first_ms_ = now;
    last_ms_ = now;
    if (packets_ == 0 || len < min_len_) min_len_ = len;
    if (len > max_len_) max_len_ = len;
    packets_++;
    bytes_ += len;
    if (sizes_.size() < kKeptSizes)
        sizes_.push_back((uint32_t)len);
    if (heads_.size() < kKeptHex) {
        size_t n = len < kHexBytes ? len : kHexBytes;
        heads_.emplace_back(data, data + n);
    }
}

/* A streaming Annex-B scanner: find 00 00 01 (preceded by any number of extra
 * zeros) and read the NAL header that follows. State persists across calls, so
 * a start code split across datagrams is still found and nothing is double
 * counted. */
void FramingProbe::scan_nals(const uint8_t *data, size_t len, int64_t now_ms)
{
    for (size_t i = 0; i < len; i++) {
        uint8_t b = data[i];
        if (expect_type_) {
            record_nal((uint8_t)(b & 0x1f), now_ms);
            expect_type_ = false;
            zeros_ = 0;
        } else if (b == 0x00) {
            zeros_++;
        } else if (b == 0x01 && zeros_ >= 2) {
            expect_type_ = true;   /* 00 00 01 seen; the NAL header is next */
            zeros_ = 0;
        } else {
            zeros_ = 0;
        }
    }
}

void FramingProbe::record_nal(uint8_t type, int64_t now_ms)
{
    nal_total_++;
    switch (type) {
    case 7:   /* SPS */
        nal_sps_++;
        if (sps_first_ms_ < 0) sps_first_ms_ = now_ms;
        sps_last_ms_ = now_ms;
        break;
    case 8:   /* PPS */
        nal_pps_++;
        break;
    case 5:   /* IDR slice */
        nal_idr_++;
        if (idr_first_ms_ < 0) idr_first_ms_ = now_ms;
        else if (idr_prev_ms_ >= 0 && now_ms - idr_prev_ms_ > idr_max_gap_ms_) idr_max_gap_ms_ = now_ms - idr_prev_ms_;
        idr_prev_ms_ = idr_last_ms_ = now_ms;
        break;
    case 1:   /* non-IDR slice */
        nal_nonidr_++;
        break;
    case 6:   /* SEI */
        nal_sei_++;
        break;
    case 9:   /* access unit delimiter */
        nal_aud_++;
        break;
    default:
        nal_other_++;
        break;
    }
}

/* Advisory, from the first packet's leading bytes. The raw hex below it is what
 * the decision rests on; this line only points at the likely format. */
static std::string guess(const std::vector<uint8_t> &h)
{
    if (h.size() >= 4 && h[0] == 0 && h[1] == 0 && h[2] == 0 && h[3] == 1) return "H.264 Annex-B (00 00 00 01 start code)";
    if (h.size() >= 3 && h[0] == 0 && h[1] == 0 && h[2] == 1) return "H.264 Annex-B (00 00 01 start code)";
    if (h.size() >= 2 && (h[0] & 0xc0) == 0x80) return "likely RTP (v2); payload type " + std::to_string(h[1] & 0x7f);
    if (h.size() >= 1 && h[0] == 0x03) return "likely IEEE-1722/AVTP CVF (subtype 0x03)";
    return "unknown — read the leading bytes";
}

std::string FramingProbe::report() const
{
    std::lock_guard<std::mutex> lock(mutex_);
    if (packets_ == 0)
        return "";   /* nothing received yet; the caller writes no probe file */
    char buf[256];
    std::string s = "== waze-on-cluster framing probe ==\n";
    std::snprintf(buf, sizeof buf, "packets=%llu bytes=%llu min_len=%zu max_len=%zu\n",
                  (unsigned long long)packets_, (unsigned long long)bytes_, min_len_, max_len_);
    s += buf;
    if (!heads_.empty()) {
        s += "guess: ";
        s += guess(heads_[0]);
        s += "\n";
    }
    s += "first packet sizes:";
    for (uint32_t z : sizes_) { std::snprintf(buf, sizeof buf, " %u", z); s += buf; }
    s += "\n";
    for (size_t i = 0; i < heads_.size(); i++) {
        std::snprintf(buf, sizeof buf, "packet[%zu] first %zu bytes:\n  ", i, heads_[i].size());
        s += buf;
        for (size_t j = 0; j < heads_[i].size(); j++) {
            std::snprintf(buf, sizeof buf, "%02x ", heads_[i][j]);
            s += buf;
            if ((j & 15) == 15 && j + 1 < heads_[i].size()) s += "\n  ";
        }
        s += "\n";
    }
    /* NAL cadence. A decoder that missed the stream's opening keyframe can
     * only sync on a later SPS-bearing IDR, so this says whether those recur. */
    if (nal_total_ == 0) {
        s += "cadence: no NAL units seen (not Annex-B or RTP H.264, or no video yet)\n";
    } else {
        std::snprintf(buf, sizeof buf,
                      "NAL units: total=%llu SPS=%llu PPS=%llu IDR=%llu non-IDR=%llu SEI=%llu AUD=%llu other=%llu\n",
                      (unsigned long long)nal_total_, (unsigned long long)nal_sps_, (unsigned long long)nal_pps_,
                      (unsigned long long)nal_idr_, (unsigned long long)nal_nonidr_, (unsigned long long)nal_sei_,
                      (unsigned long long)nal_aud_, (unsigned long long)nal_other_);
        s += buf;
        if (nal_sps_ > 0) {
            std::snprintf(buf, sizeof buf, "SPS: %llu, first +%lld ms, last +%lld ms\n", (unsigned long long)nal_sps_,
                          (long long)(sps_first_ms_ - first_ms_), (long long)(sps_last_ms_ - first_ms_));
            s += buf;
        }
        if (nal_idr_ > 0) {
            std::snprintf(buf, sizeof buf, "IDR: %llu, first +%lld ms, last +%lld ms, max gap %lld ms\n",
                          (unsigned long long)nal_idr_, (long long)(idr_first_ms_ - first_ms_),
                          (long long)(idr_last_ms_ - first_ms_), (long long)idr_max_gap_ms_);
            s += buf;
        }
        /* OK needs SPS and IDR each seen again >= kRecurMs after their first
         * (counts alone would pass on the opening keyframes, and on one IDR
         * split into several slices), and the latest packet within one max IDR
         * gap of the last IDR (the cadence still holds now). */
        bool recur = sps_first_ms_ >= 0 && sps_last_ms_ - sps_first_ms_ >= kRecurMs &&
                     idr_first_ms_ >= 0 && idr_last_ms_ - idr_first_ms_ >= kRecurMs &&
                     last_ms_ - idr_last_ms_ <= idr_max_gap_ms_;
        s += recur
                 ? "late-join: OK — SPS and IDR recur, a decoder started mid-stream syncs within one IDR gap\n"
                 : "late-join: RISK — SPS/IDR not seen to recur after the opening keyframes; only a decoder up at stream start syncs, and a loss freezes the map until the next stream (see PATCH.md, keyframe cadence)\n";
    }
    return s;
}

std::string FramingProbe::summary() const
{
    std::lock_guard<std::mutex> lock(mutex_);
    if (packets_ == 0)
        return "no packets";
    char buf[192];
    char cad[48] = "";
    if (nal_total_ > 0)
        std::snprintf(cad, sizeof cad, ", SPS=%llu IDR=%llu", (unsigned long long)nal_sps_, (unsigned long long)nal_idr_);
    std::snprintf(buf, sizeof buf, "%llu pkts, %llu B, len %zu-%zu, %s%s",
                  (unsigned long long)packets_, (unsigned long long)bytes_, min_len_, max_len_,
                  heads_.empty() ? "?" : guess(heads_[0]).c_str(), cad);
    return buf;
}

}  // namespace woc
