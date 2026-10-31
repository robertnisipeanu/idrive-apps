// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* UdpSource: receives the CarPlay 2nd stream from a local UDP socket and hands
 * each datagram to a sink on a receiver thread, the stream-sink counterpart of
 * h264_source.h's FIFO reader.
 *
 * CarPlay's projection bridge muxes the 2nd stream as AVC_RTP and writes it to
 * a *stream* sink. On the car the bridge rejected a seekable file:// and
 * accepts the stock avb:// stream; udp://tcp:// map to Cinemo's NmeVfsSocket
 * (see README). A udp://127.0.0.1:<port> sink is the local stream equivalent:
 * carplay sends here, this binds and receives. Datagram boundaries are
 * preserved, so the sink sees one call per packet — what the framing probe
 * needs to characterise the wire format. */
#ifndef WOC_UDP_SOURCE_H
#define WOC_UDP_SOURCE_H

#include <atomic>
#include <cstdint>
#include <functional>
#include <string>
#include <thread>

namespace woc {

class UdpSource {
public:
    /* sink is called once per datagram, on the receiver thread. */
    using Sink = std::function<void(const uint8_t *, size_t)>;

    UdpSource();
    ~UdpSource();

    /* Bind 127.0.0.1:port (UDP) and start the receiver thread. */
    bool start(uint16_t port, const Sink &sink, std::string *err);
    void stop();

    uint64_t bytes() const { return bytes_.load(); }
    uint64_t packets() const { return packets_.load(); }
    bool receiving() const { return packets_.load() > 0; }

private:
    void loop();

    Sink sink_;
    int fd_ = -1;
    int wake_[2] = {-1, -1};
    std::thread thread_;
    std::atomic<bool> running_{false};
    std::atomic<uint64_t> bytes_{0};
    std::atomic<uint64_t> packets_{0};
};

}  // namespace woc

#endif
