// SPDX-License-Identifier: GPL-3.0-or-later
/* Which manoeuvre the turn card shows: the app's example while it lasts,
 * the navigation's (guidance_link.h) otherwise.
 *
 * The app ends its example itself after 10 s ({"cmd":"maneuver","kind":
 * "none"}), but from a timer of its page: with CarPlay full screen on the
 * CID the page is in the background, the end does not come until the page
 * is shown again, and the example stood over the navigation's manoeuvres
 * for a whole drive (2026-11-21). So an example ends here too, kExampleMs
 * after it came, whatever the app sends. */
#ifndef WOC_CARD_CHOICE_H
#define WOC_CARD_CHOICE_H

#include <stdint.h>

#include "turn_card.h"

namespace woc {

class CardChoice {
public:
    /* A little past the app's own 10 s, so its end comes first. */
    static const int64_t kExampleMs = 12000;

    /* The app's example at now; kind none ends it. */
    void set_example(const Maneuver &m, int64_t now)
    {
        example_ = m;
        until_ = now + kExampleMs;
    }
    /* The navigation's manoeuvre; none while it does not guide. */
    void set_guided(const Maneuver &m) { guided_ = m; }
    /* Ends an example past its time: true when it ended now (the card
     * changes). */
    bool expire(int64_t now)
    {
        if (example_.kind == Maneuver::None || now < until_)
            return false;
        example_ = Maneuver();
        return true;
    }
    bool example() const { return example_.kind != Maneuver::None; }
    const Maneuver &shown() const { return example() ? example_ : guided_; }

private:
    Maneuver example_, guided_;
    int64_t until_ = 0;
};

}  // namespace woc

#endif
