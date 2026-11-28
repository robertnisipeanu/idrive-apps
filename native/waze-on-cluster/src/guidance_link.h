// SPDX-License-Identifier: GPL-3.0-or-later
/* The BMW navigation's route box on the cluster (route_box.h), read from
 * SOME/IP the way the HMI reads it: GuidanceEventList 0xFB1B major 5,
 * instance 0x0080, event 0x8002 in eventgroup 0x0002. The turn card shows
 * its next manoeuvre while the navigation guides, CarPlay's included.
 *
 * A vsomeip application of this process ("woc-guidance", not one of the
 * unit's fixed client ids), with the unit's own /etc/vsomeip: uid 5000's
 * security policy allows requests to 0xFB1A, 0xFB1B and 0xFB1C (the unit's
 * /etc/vsomeip/5000_5000/vsomeip_security.json; cluster-render's
 * dcsm/DCSM.md "Running as uid 5000"). It only reads: no method is
 * called, nothing is offered.
 *
 * The event is requested with no type of its own (ET_UNKNOWN) and its group
 * subscribed only once the navigation has offered the service for
 * kSettleMs: a request that comes before the provider's registration, and
 * names a type, can stand in the routing manager's table in its place.
 *
 * It also reads whether the navigation guides: Guidance 0xFB1A major 7,
 * event 0x8015 in eventgroup 0x0015 (a u32, 1 on, 0 off), which uid 5000's
 * policy allows too, subscribed the same way. With it the card holds its
 * manoeuvre through the box's empty spells while the navigation guides
 * (guided_card.h).
 *
 * vsomeip's thread parses each notification and keeps the box's manoeuvre
 * and the guiding; fd() turns readable when one comes, and take() hands the
 * card's manoeuvre to the main loop, each pass, as the hold's time runs out
 * too. The route box's service gone, the box is empty; the Guidance
 * service's, the guiding is not known. The log names event kinds,
 * directions and units the card does not know yet (route_box.h) and the
 * guiding's changes, never a road. */
#ifndef WOC_GUIDANCE_LINK_H
#define WOC_GUIDANCE_LINK_H

#include <stdint.h>

#include <chrono>
#include <memory>
#include <mutex>
#include <set>
#include <string>
#include <thread>

#include "guided_card.h"
#include "turn_card.h"

namespace vsomeip_v3 { class application; class message; }

namespace woc {

class GuidanceLink {
public:
    static const int64_t kSettleMs = 5000;

    GuidanceLink();
    ~GuidanceLink();

    /* Starts the application and its thread. false (and why) if vsomeip
     * does not initialise: the card then shows only the app's example. */
    bool start(std::string *err);
    void stop();

    /* Readable when a notification came, or a subscription may be due;
     * -1 before start. */
    int fd() const { return wake_[0]; }
    /* On the main loop, each pass: subscribes once due; true and the card's
     * manoeuvre when it changed since the last call. */
    bool take(Maneuver *m);

private:
    void wake();
    void on_availability(bool up);
    void on_guide_availability(bool up);
    void on_message(const std::shared_ptr<vsomeip_v3::message> &msg);
    void on_guiding(const std::shared_ptr<vsomeip_v3::message> &msg);

    int wake_[2] = {-1, -1};
    std::shared_ptr<vsomeip_v3::application> app_;
    std::thread thread_;

    std::mutex mutex_;   /* what follows: written by vsomeip's thread */
    bool up_ = false;    /* the route box's service */
    std::chrono::steady_clock::time_point up_since_;
    bool subscribed_ = false;
    bool guide_up_ = false;   /* the Guidance service */
    std::chrono::steady_clock::time_point guide_up_since_;
    bool guide_subscribed_ = false;
    GuidedCard card_;
    Maneuver published_;   /* the card's manoeuvre take() last handed over */
    /* events (kind << 16 | direction) and units not known, not logged yet */
    std::set<uint32_t> new_events_, new_units_;
    std::set<uint32_t> logged_events_, logged_units_;
    uint64_t notifications_ = 0;
    bool first_logged_ = false;
};

}  // namespace woc

#endif
