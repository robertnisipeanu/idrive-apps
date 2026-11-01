// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* Whether CarPlay's cluster stream (the alternate screen) is connected.
 *
 * For each screen stream the phone sets up, carplay's AirPlay receiver
 * (libNmeCarPlay) listens on a TCP port, 6031 for the alternate screen, and
 * keeps the phone's connection on it until that stream or the session is
 * torn down, however few frames come: how often a static map sends a frame
 * depends on the phone (one about every ten seconds, another about 30 a
 * second). The connection is a row of /proc/net/tcp6 (or tcp), a
 * world-readable table, with carplay's uid, that local port and state 01
 * (established). */
#ifndef WOC_ALT_SCREEN_H
#define WOC_ALT_SCREEN_H

#include <stdint.h>
#include <string>
#include <vector>

namespace woc {

/* Whether table (the text of /proc/net/tcp or tcp6) has an established
 * connection on local port port owned by uid. */
bool alt_screen_in(const std::string &table, uint16_t port, uint32_t uid);

class AltScreen {
public:
    enum State { Unknown, Absent, Connected };   /* Unknown: no table could be read */

    AltScreen(uint16_t port, uint32_t uid,
              std::vector<std::string> tables = {"/proc/net/tcp6", "/proc/net/tcp"});
    State read() const;

private:
    uint16_t port_;
    uint32_t uid_;
    std::vector<std::string> tables_;
};

/* The stream is live while its connection is there. Without it (carplay
 * takes another port when 6031 is busy, or the tables cannot be read): while
 * a frame was decoded within stall_ms, counting after a connection ended only
 * frames decoded over a second later, so the frames still on their way from
 * the stream that ended do not keep it up. */
class StreamLiveness {
public:
    explicit StreamLiveness(int stall_ms) : stall_ms_(stall_ms) {}
    /* last_frame_ms: when the last frame was decoded, -1 for none. */
    bool live(AltScreen::State alt, int64_t last_frame_ms, int64_t now_ms);

private:
    int stall_ms_;
    bool connected_ = false;
    int64_t ended_ms_ = -1;   /* when the last connection ended */
};

}  // namespace woc

#endif
