// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* AvbSource: receives the CarPlay 2nd stream from the head unit's IAS AVB
 * media bus as an extra receiver (the libmavl pattern) and hands each bus
 * packet to a sink on the bridge's thread.
 *
 * The stock sink for the 2nd stream is the media-bus stream
 * media_transport.avb_streaming.15: with the patch's AVB capture mode,
 * CarPlay writes there exactly as stock, and this joins as one more
 * receiver alongside the unit's own. Each bus packet is one RTP datagram
 * (VERIFIED on the car), so the sink sees the same datagrams the UDP source
 * would. Receiving in-process keeps the stream off a UDP socket, whose
 * receive buffer drops datagrams under load. */
#ifndef WOC_AVB_SOURCE_H
#define WOC_AVB_SOURCE_H

#include <atomic>
#include <cstdint>
#include <functional>
#include <mutex>
#include <string>

namespace woc {

class AvbSource {
public:
    /* sink is called once per bus packet, on the bridge's thread, which
     * delivers no other packet while it runs. */
    using Sink = std::function<void(const uint8_t *, size_t)>;

    ~AvbSource();

    /* Join stream (e.g. media_transport.avb_streaming.15) as a receiver. */
    bool start(const std::string &stream, const Sink &sink, std::string *err);
    void stop();

    uint64_t bytes() const { return bytes_.load(); }
    uint64_t packets() const { return packets_.load(); }

private:
    static void on_packet(void *handle, const void *pkt, void *user);

    Sink sink_;
    /* Held across a callback's sink call; stop() clears running_ and takes
     * it as a barrier, so a callback in flight finishes before the receiver
     * is destroyed (with the lock released). */
    std::mutex cb_mutex_;
    void *handle_ = nullptr;
    std::atomic<bool> running_{false};
    std::atomic<uint64_t> bytes_{0};
    std::atomic<uint64_t> packets_{0};
};

}  // namespace woc

#endif
