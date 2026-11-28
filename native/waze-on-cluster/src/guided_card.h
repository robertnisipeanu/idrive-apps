// SPDX-License-Identifier: GPL-3.0-or-later
/* The turn card's manoeuvre from the navigation (guidance_link.h): the route
 * box's, held a while when the box empties while the navigation still
 * guides.
 *
 * The box empties on its own while the navigation guides: for about 1 s at
 * each recalculation, and right after a route starts, where a drive's box
 * (2026-11-21) showed the way out ("towards ...", no distance) for a few ms
 * and then nothing for 47 s, until the first turn was 20 m away, the
 * central display's box too, while CarPlay kept that instruction on the
 * phone. With the Guidance service's guiding (0xFB1A event 0x8015, 1 on, 0
 * off: on at each route's start, off on arriving or when the route is
 * cancelled, on through those empty boxes) the card keeps
 *  - an instruction with no distance (the way out) while the navigation
 *    guides;
 *  - one with a distance for kGraceMs, so a recalculation does not blink
 *    it and one already passed does not stay.
 * Guiding off, or not known (no such event came), an empty box is no card
 * at once, as before. */
#ifndef WOC_GUIDED_CARD_H
#define WOC_GUIDED_CARD_H

#include <stdint.h>

#include "turn_card.h"

namespace woc {

class GuidedCard {
public:
    static const int64_t kGraceMs = 2500;

    /* The route box's manoeuvre at now; kind none: the box is empty. */
    void set_box(const Maneuver &m, int64_t now)
    {
        box_ = m;
        if (m.kind != Maneuver::None) {
            last_ = m;
            empty_since_ = -1;
        } else if (empty_since_ < 0) {
            empty_since_ = now;
        }
    }
    /* The navigation guiding or not (0xFB1A 0x8015). Off (arrived, the
     * route cancelled) forgets the manoeuvre held; on keeps it, as the
     * box's first one may come a few ms before. */
    void set_guiding(bool on)
    {
        if (!on)
            last_ = Maneuver();
        guiding_ = on ? 1 : 0;
    }
    /* Not known again (the Guidance service gone). */
    void forget_guiding() { guiding_ = -1; }
    int guiding() const { return guiding_; }

    /* The manoeuvre the card shows at now. */
    Maneuver shown(int64_t now) const
    {
        if (box_.kind != Maneuver::None)
            return box_;
        if (guiding_ != 1 || last_.kind == Maneuver::None)
            return Maneuver();
        if (last_.distance.empty())   /* the way out: while the navigation guides */
            return last_;
        if (empty_since_ >= 0 && now - empty_since_ < kGraceMs)
            return last_;
        return Maneuver();
    }

private:
    Maneuver box_, last_;   /* last_: the box's last manoeuvre */
    int64_t empty_since_ = -1;
    int guiding_ = -1;      /* -1 not known, 0 off, 1 on */
};

}  // namespace woc

#endif
