// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* H264Source: reads an H.264 Annex-B elementary stream from a FIFO and hands
 * the bytes to a sink on a reader thread, so the render loop never blocks on
 * the pipe. The CarPlay 2nd stream is written to this FIFO by the redirected
 * Cinemo sink (patch/carplay_patch.js --capture), or by the main-screen hook.
 *
 * The FIFO decouples carplay (writer) from this tool (reader). A reader exists
 * between start() and stop(), which the render holds for its service lifetime:
 * it holds the FIFO open O_RDWR and keeps draining, so carplay neither blocks
 * on a full pipe nor sees a readerless pipe. With the service stopped the FIFO
 * has no reader, so a carplay still streaming to it gets EPIPE/SIGPIPE on a
 * write or blocks opening it; reverting the sink patch restores the original
 * AVB path (README, PATCH.md). */
#ifndef WOC_H264_SOURCE_H
#define WOC_H264_SOURCE_H

#include <atomic>
#include <functional>
#include <string>
#include <thread>

namespace woc {

class H264Source {
public:
    /* sink is called with each chunk read, on the reader thread. */
    using Sink = std::function<void(const uint8_t *, size_t)>;

    H264Source();
    ~H264Source();

    /* Create the FIFO at path if absent (mode 0620, group-writable so the
     * carplay uid can write it), then open it for reading and start the
     * reader thread. The sink runs until stop(). */
    bool start(const std::string &path, const std::string &group, const Sink &sink, std::string *err);
    void stop();

    /* Bytes read since start, for the status line. */
    uint64_t bytes() const { return bytes_.load(); }
    /* True once the writer (carplay) has opened and sent something. */
    bool receiving() const { return bytes_.load() > 0; }

private:
    void loop();

    std::string path_;
    Sink sink_;
    int fd_ = -1;
    int wake_[2] = {-1, -1};   /* stop signal to the reader thread */
    std::thread thread_;
    std::atomic<bool> running_{false};
    std::atomic<uint64_t> bytes_{0};
};

}  // namespace woc

#endif
