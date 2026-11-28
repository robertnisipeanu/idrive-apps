// SPDX-License-Identifier: GPL-3.0-or-later
/* The BMW navigation's route box: the next manoeuvres it shows on each
 * screen, as GuidanceEventList (SOME/IP 0xFB1B, major 5, instance 0x0080)
 * sends them in its event 0x8002, and the turn card's manoeuvre made of the
 * cluster's (turn_card.h). guidance_link.h receives the event.
 *
 * The payload is CommonAPI's big-endian serialisation: strings a u32 length
 * over a UTF-8 BOM, the text and a NUL; a union a u32 length, a u32 tag and
 * that many bytes. Each screen ("IC.RB.Main" the cluster's box,
 * "CID.WidgetRB.Big" the central display's) is its name, then
 *
 *   u32 (1 or 2), u32 0, u32 0, u8 (the events shown), u32 the events' bytes
 *
 * and its events, the next manoeuvre first, each a union:
 *
 *   u32 length, u32 kind  2 a turn, 4 a fork, 5 a roundabout, 6 the
 *                         destination, 7 an empty slot; others (ferries,
 *                         motorway entries...) not seen yet
 *   ...                   (33 bytes)
 *   string distance       "300"; " " or "" when none is shown
 *   u32    unit           4 metres, 1 kilometres ("1,5"); 0 without a distance
 *   f64    (1.0)
 *   u32, u32, u32         the text's union: lengths and tag 1
 *   string text           the road it leads to, or an instruction ("towards ...")
 *   ...                   (40 bytes, u32 4 and u32 1 at 20)
 *   u32    direction      a turn: 1 straight on, 2 left, 3 slight left,
 *                         4 sharp left, 5 right, 6 slight right, 7 sharp
 *                         right, 8 and 9 a U-turn; a fork: 1 keep left,
 *                         2 keep right; the destination: 1 on the left,
 *                         2 ahead, 3 on the right
 *   u32 4, u32 1, ...
 *
 * A roundabout has, where the direction would be,
 *
 *   u16    exit angle     degrees clockwise from straight on, 1 to 360:
 *                         90 right, 180 back, 270 left, 360 straight on
 *   u8     exit           1 the first; 0 a U-turn round it
 *   u32    2              where traffic keeps right (carplay mirrors its
 *                         exits when it is not 2)
 *   u32 4, u32 1, ...
 *
 * These are BMW's GuidingTypes that carplay converts CarPlay's manoeuvres
 * to: its U-turns a turn's 8, which a drive where traffic
 * keeps right had as 9 (Google Maps' "make a U-turn" on the road the turn
 * before led to; 8 not seen), its keep left and right a fork's 1 and 2, a
 * roundabout's exit CarPlay's angle (360 added to one of 0 or less, 180 for
 * a U-turn round it) and number. Drives had the turns noted on the road,
 * and a fork and roundabouts the kinds 4 and 5 with these fields. This is
 * how a car sent it (iDrive 7, Google Maps over CarPlay, 2026-11), not an
 * interface definition: a payload laid out otherwise yields no manoeuvre. */
#ifndef WOC_ROUTE_BOX_H
#define WOC_ROUTE_BOX_H

#include <stddef.h>
#include <stdint.h>

#include <string>
#include <vector>

#include "turn_card.h"

namespace woc {

/* The cluster's route box. */
extern const char kClusterRouteBox[];   /* "IC.RB.Main" */

/* Event kinds (the union's tags) and turn directions, as the navigation
 * sends them. */
const uint32_t kRouteBoxTurn = 2, kRouteBoxFork = 4, kRouteBoxRoundabout = 5, kRouteBoxDestination = 6,
               kRouteBoxEmpty = 7;

/* One event of a screen's route box. */
struct RouteBoxEvent {
    uint32_t kind = 0;        /* one of the kRouteBox kinds, or one not known */
    std::string distance;     /* "300"; blank when none is shown */
    uint32_t unit = 0;        /* 4 metres, 1 kilometres */
    std::string text;         /* the road, or an instruction */
    uint32_t direction = 0;   /* a roundabout: the u32 after its exit (2); 0: not found */
    uint16_t exit_angle = 0;  /* a roundabout: 1 to 360 clockwise from straight on; 0: not found */
    uint8_t exit_number = 0;  /* a roundabout: 1 the first exit, 0 a U-turn round it */
};

/* The events of the screen named screen in an event 0x8002 payload, in
 * order, empty slots included. false: the payload does not name that screen
 * (it may name others), so it says nothing of it; true: what that screen
 * shows (no events, or empty slots only: no manoeuvre). */
bool parse_route_box(const uint8_t *p, size_t n, const std::string &screen, std::vector<RouteBoxEvent> *out);

/* The card's arrow for an event; Maneuver::Other for a kind or direction
 * not known yet, Maneuver::None for an empty slot. */
Maneuver::Kind kind_of_event(uint32_t kind, uint32_t direction);
/* Whether kind_of_event knows that event (an empty slot counts as known). */
bool event_known(uint32_t kind, uint32_t direction);

/* distance as the card shows it: "300 m" for unit 4, "1,5 km" for unit 1,
 * the number alone for a unit not known yet, "" when it is blank. */
std::string route_box_distance(const std::string &distance, uint32_t unit);
/* Whether route_box_distance knows unit (0, 1 or 4). */
bool unit_known(uint32_t unit);

/* The turn card's manoeuvre for a screen's events: the first one's; none
 * when every slot is empty. A roundabout's exit_deg is its exit angle from
 * -179 to 180 (270 is -90), and a roundabout without an exit angle the
 * plain mark. The road is the event's text without spaces at its ends, two
 * names it puts two spaces between ("Cidade A  Cidade B") joined by " · ".
 * false: the first slot is empty and a later one is not, as the navigation
 * sends while it rebuilds the list: the card keeps what it shows. */
bool route_box_maneuver(const std::vector<RouteBoxEvent> &events, Maneuver *out);

}  // namespace woc

#endif
