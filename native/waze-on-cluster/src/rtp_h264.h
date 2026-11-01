// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* RTP H.264 depacketiser: one RTP datagram (RFC 3550) carrying an H.264
 * payload (RFC 6184) in, Annex-B NAL units out, for nal_reader.h / the
 * decoder.
 *
 * CarPlay's projection bridge muxes the 2nd stream as AVC_RTP: one RTP packet
 * per datagram, payload type 96, no CSRC or header extension (VERIFIED from
 * the AVB stream 15 capture, test/data). Its payloads are single NAL units
 * (SPS, PPS, small slices) and FU-A fragments (large slices, including the
 * IDR). STAP-A is handled too; STAP-B, MTAP and FU-B (interleaved mode only)
 * are dropped.
 *
 * Access units. Every NAL unit of an access unit carries the same RTP
 * timestamp, so a timestamp change ends the previous access unit, and so does
 * the marker bit on a packet that completes a slice (the RFC's last-packet
 * rule). The phone sets the marker only on SPS and PPS, which do not end an
 * access unit, so on this stream the timestamp rule frames every picture: a
 * picture is complete when the next one's first packet arrives.
 *
 * Losses. A sequence-number gap drops only the FU-A in progress, the one NAL
 * unit missing bytes; every NAL unit after it is delivered, so the decoder
 * keeps decoding through the loss and conceals what is missing. A fragment
 * that joins an FU-A mid-way (after a loss, or a start mid-stream) is dropped
 * with its FU-A. Each gap is reported (on_gap) before anything after it is
 * delivered.
 *
 * Not thread-safe; one caller at a time. No allocation once the buffers have
 * grown to the largest NAL unit. */
#ifndef WOC_RTP_H264_H
#define WOC_RTP_H264_H

#include <stddef.h>
#include <stdint.h>
#include <functional>
#include <vector>

namespace woc {

class RtpH264 {
public:
    /* Called with one whole NAL unit behind a 00 00 00 01 start code
     * (end_of_au false), or with len 0 and end_of_au true at the end of an
     * access unit. `data` is valid only during the call. */
    using Sink = std::function<void(const uint8_t *data, size_t len, bool end_of_au)>;

    /* A sequence-number discontinuity: the packet expected and the one that
     * came; lost is how many sequence numbers lie between them (mod 2^16). */
    struct Gap {
        uint16_t expected = 0, got = 0;
        uint32_t lost = 0;
    };

    struct Stats {
        uint64_t packets = 0;   /* RTP packets parsed */
        uint64_t nals = 0;      /* NAL units delivered */
        uint64_t aus = 0;       /* access unit ends delivered */
        uint64_t gaps = 0;      /* sequence-number discontinuities */
        uint64_t lost = 0;      /* packets missing by sequence number, over all gaps */
        uint64_t dropped = 0;   /* NAL units or fragments discarded (loss, unsupported) */
        uint64_t bad = 0;       /* datagrams that are not a parseable RTP H.264 packet */
    };

    /* One datagram. Returns false, and drops it, if it is not an RTP v2
     * packet with a parseable H.264 payload. */
    bool push(const uint8_t *pkt, size_t len, const Sink &sink);

    const Stats &stats() const { return stats_; }

    std::function<void(const Gap &)> on_gap;

private:
    void deliver(const uint8_t *annexb, size_t len, const Sink &sink);
    void single(const uint8_t *nal, size_t len, const Sink &sink);
    void drop_fu();
    void end_au(const Sink &sink);

    std::vector<uint8_t> nal_;   /* start code + a single NAL unit or STAP-A entry, being delivered */
    std::vector<uint8_t> fu_;    /* start code + the FU-A NAL unit being reassembled */
    bool in_fu_ = false;
    bool have_seq_ = false, have_ts_ = false;
    uint16_t seq_ = 0;
    uint32_t ts_ = 0;
    bool au_open_ = false;       /* NAL units delivered since the last access unit end */
    bool vcl_done_ = false;      /* this packet completed a slice */
    Stats stats_;
};

}  // namespace woc

#endif
