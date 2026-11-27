/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
/* The rules the service adds to iDrive 7's targets: the guide hold's
 * settings, the HUD's and the panel's fallback.
 *
 * The guide hold's settings (cluster-render.conf "guide hold", iDrive 7):
 * unless guide_hold = 0, a hold (slots.h) that follows the map while the
 * box is mapped in its slot, appended to the targets: one in 0x105 or
 * 0x103, whichever the slot table reports the box in (guide_slots = auto),
 * or one per slot of guide_slots. */
#ifndef CRS_HOLDS_H
#define CRS_HOLDS_H

#include <stdint.h>
#include <string>
#include <vector>

#include "slots.h"

namespace crs {

/* The settings as written. */
struct HoldSettings {
    std::string hold, slots, scene_id, content_class, take_over;   /* guide_hold, guide_slots, ... */
    std::string small_scene_id;   /* guide_small_scene_id; empty: no small scene */
};

/* Appends a hold per slot of slots unless hold is 0; hold other than 0 or 1
 * counts as 1, with *warn saying so. slots: auto, one hold guide_auto with
 * scene_id whose slot is 0x105 or 0x103 (TargetSpec::table_slots;
 * kSmallFirstSlot until the table names one),
 * neither another target's; or hex slot ids 0x1-0xfff, separated by commas
 * or spaces, each once and no other target's. Scene ids from scene_id up,
 * one per slot, each in allowed and no other target's.
 * take_over: the hex content ids the holds' take-overs may unmap, at least
 * one, separated the same way. Anything else adds no hold: false, with
 * *warn naming it, and targets left as they were.
 * small_scene_id: then each hold's small scene (TargetSpec::pairs_with,
 * <hold>_small, content class kSmallClass, 16x16), ids from it up, one per
 * hold, appended after the holds, each in its hold's slot (guide_slots
 * auto: kSmallFirstSlot until the box is seen). One that is not a number, not in
 * allowed or another target's leaves the holds without small scenes, with
 * *warn saying why; true. */
bool load_holds(const HoldSettings &cfg, const std::vector<uint64_t> &allowed, std::vector<TargetSpec> *targets,
                std::string *warn);

/* The content class of a hold's small scene: the class of the HMI's box in
 * its top layout (0x01000314), which the KOMBI shows in the box's slot
 * while a warning disables slots 0x101/0x102 (VERIFIED on the car). */
const uint32_t kSmallClass = 1024;

/* The hold's and its small scene's slot under guide_slots auto before the
 * box is seen in one: the slot every car log shows the box and its top
 * layout in (0x103; 0x105 only ever seen empty). Both move with the box
 * (move_hold). */
const uint64_t kSmallFirstSlot = 0x103;

/* The HUD's slot and scene on iDrive 7 (README.md "The HUD"). */
const uint64_t kHudSlot = 0x323, kHudScene = 0x01000400;

/* The iDrive 7 HUD's rules for t, the hud target: only slot kHudSlot with
 * scene kHudScene, never
 * taking a slot from the stock HMI; then its layers write from the HUD's
 * share of the budget. False,
 * with *why, for any other slot or a take-over: the HUD is left out. */
bool hud_rules(TargetSpec *t, std::string *why);

/* The panel target t's rules (README.md "Scene ids"): its fallback scene
 * id, as written (panel_fallback_scene_id), a number in allowed, becomes
 * t's fallback unless it is t's own id or empty.
 * False, with *err, for any other fallback: the service does not start. */
bool fallback_rules(TargetSpec *t, const std::string &fallback, const std::vector<uint64_t> &allowed,
                    std::string *err);

}  // namespace crs

#endif
