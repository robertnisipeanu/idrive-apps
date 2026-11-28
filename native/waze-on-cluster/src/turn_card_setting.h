// SPDX-License-Identifier: GPL-3.0-or-later
/* Whether the turn card (turn_card.h) is drawn over the cluster map and
 * where: "off", "bottom" (under the phone's own UI) or "top". turn_card in
 * the configuration, unless the app's choice is saved in the state file,
 * which the app's setting writes ({"cmd":"turn_card","mode":...} on the
 * control socket). Another value in either, or a state file that does not
 * read, counts as off, with a warning. The state file is written whole and
 * renamed into place; one that cannot be written leaves the choice in
 * effect until the service stops, with a warning. */
#ifndef WOC_TURN_CARD_SETTING_H
#define WOC_TURN_CARD_SETTING_H

#include <string>

namespace woc {

class TurnCardSetting {
public:
    enum Mode { Off, Bottom, Top };

    /* conf: turn_card's value; state_path: the app's choice. */
    TurnCardSetting(const std::string &conf, const std::string &state_path);
    Mode mode() const { return mode_; }
    const char *name() const;
    /* The app's choice, "off", "bottom" or "top"; false for any other
     * value, nothing changed. */
    bool set(const std::string &value);

private:
    std::string path_;
    Mode mode_ = Off;
};

}  // namespace woc

#endif
