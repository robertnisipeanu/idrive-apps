// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* FramingProbe: records what the CarPlay 2nd stream looks like on the wire
 * (raw H.264 Annex-B, RTP, or 1722/AVTP) and its NAL unit cadence. It is fed
 * every chunk/datagram the sources receive, keeps the first packets' sizes and
 * leading bytes, and renders a short report the diagnostics serve. Recording
 * is cheap and always on. */
#ifndef WOC_FRAMING_PROBE_H
#define WOC_FRAMING_PROBE_H

#include <cstdint>
#include <mutex>
#include <string>
#include <vector>

namespace woc {

class FramingProbe {
public:
    /* Record one received unit (a UDP datagram, or a FIFO read). Thread-safe;
     * the sources call it from their receiver threads. */
    void record(const uint8_t *data, size_t len);
    /* The same, at an explicit steady-clock time in ms (the tests' clock). */
    void record(const uint8_t *data, size_t len, int64_t now_ms);
    /* An RTP datagram: recorded without the Annex-B scan (its header bytes
     * could fake a start code); its NAL units arrive through nal() from the
     * depacketiser (rtp_h264.h). */
    void record_rtp(const uint8_t *data, size_t len);
    void record_rtp(const uint8_t *data, size_t len, int64_t now_ms);
    /* One NAL unit of the given type, for the cadence. Thread-safe. */
    void nal(uint8_t type);
    void nal(uint8_t type, int64_t now_ms);

    /* A multi-line report: totals, a guess at the framing, the first packets'
     * sizes and the leading bytes of the first few. */
    std::string report() const;
    /* A one-line summary for the status page. */
    std::string summary() const;
    /* SPS and IDR units seen so far, on either path. Thread-safe. */
    uint64_t keyframes() const;

private:
    static const size_t kKeptSizes = 64;   /* packet sizes kept */
    static const size_t kKeptHex = 8;      /* packets whose leading bytes are kept */
    static const size_t kHexBytes = 64;    /* leading bytes kept per packet */
    /* late-join counts SPS and IDR as recurring only when one arrives at least
     * this long after the first: the session's opening SPS+IDR and the keyframe
     * requestStream forces at self-start both land within the first second. */
    static const int64_t kRecurMs = 2000;

    void record_locked(const uint8_t *data, size_t len, int64_t now_ms);
    /* Streaming Annex-B start-code scan over every byte of a raw stream, so
     * the NAL cadence survives packet splits with O(1) state. The cadence
     * answers whether the phone re-sends SPS+IDR, i.e. whether a decoder that
     * misses the stream's opening keyframe (or loses sync to packet loss) can
     * ever sync again. */
    void scan_nals(const uint8_t *data, size_t len, int64_t now_ms);
    void record_nal(uint8_t type, int64_t now_ms);

    mutable std::mutex mutex_;
    uint64_t packets_ = 0;
    uint64_t bytes_ = 0;
    size_t min_len_ = 0, max_len_ = 0;
    std::vector<uint32_t> sizes_;                      /* first kKeptSizes lengths */
    std::vector<std::vector<uint8_t>> heads_;          /* leading bytes, first kKeptHex */

    int64_t first_ms_ = -1;        /* first packet, the base for the deltas below */
    int64_t last_ms_ = -1;         /* latest packet */
    int zeros_ = 0;                /* trailing consecutive 0x00 (start-code scan state) */
    bool expect_type_ = false;     /* the next byte is a NAL header */
    uint64_t nal_total_ = 0, nal_sps_ = 0, nal_pps_ = 0, nal_idr_ = 0,
             nal_nonidr_ = 0, nal_sei_ = 0, nal_aud_ = 0, nal_other_ = 0;
    int64_t sps_first_ms_ = -1, sps_last_ms_ = -1;
    int64_t idr_first_ms_ = -1, idr_last_ms_ = -1, idr_prev_ms_ = -1, idr_max_gap_ms_ = -1;
};

}  // namespace woc

#endif
