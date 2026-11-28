// SPDX-License-Identifier: GPL-3.0-or-later
#include "turn_card_setting.h"

#include <fcntl.h>
#include <unistd.h>

#include <fstream>

#include "log.h"

namespace woc {

namespace {

const char kKey[] = "turn_card";

bool known(const std::string &value, TurnCardSetting::Mode *out)
{
    if (value == "off")
        *out = TurnCardSetting::Off;
    else if (value == "bottom")
        *out = TurnCardSetting::Bottom;
    else if (value == "top")
        *out = TurnCardSetting::Top;
    else
        return false;
    return true;
}

/* A mode's name as the mode; anything else counts as off, with a warning
 * naming where it came from. */
TurnCardSetting::Mode parse(const std::string &value, const std::string &from)
{
    TurnCardSetting::Mode m = TurnCardSetting::Off;
    if (!known(value, &m))
        log_warn("%s: %s must be off, bottom or top, not \"%s\": no turn card", from.c_str(), kKey, value.c_str());
    return m;
}

}  // namespace

TurnCardSetting::TurnCardSetting(const std::string &conf, const std::string &state_path) : path_(state_path)
{
    mode_ = parse(conf, "settings");
    if (access(path_.c_str(), F_OK) != 0)
        return;
    std::ifstream f(path_);
    if (!f) {
        log_warn("%s: cannot read it: no turn card", path_.c_str());
        mode_ = Off;
        return;
    }
    std::string line, value = "(none)";
    const std::string prefix = std::string(kKey) + " = ";
    while (std::getline(f, line))
        if (line.compare(0, prefix.size(), prefix) == 0)
            value = line.substr(prefix.size());
    mode_ = parse(value, path_);
}

const char *TurnCardSetting::name() const
{
    return mode_ == Bottom ? "bottom" : mode_ == Top ? "top" : "off";
}

bool TurnCardSetting::set(const std::string &value)
{
    Mode m;
    if (!known(value, &m))
        return false;
    mode_ = m;
    const std::string text = std::string(kKey) + " = " + value + "\n", tmp = path_ + ".tmp";
    const int fd = open(tmp.c_str(), O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0644);
    const bool whole = fd >= 0 && write(fd, text.data(), text.size()) == (ssize_t)text.size() && fsync(fd) == 0;
    if (fd >= 0)
        close(fd);
    if (!whole || rename(tmp.c_str(), path_.c_str()) != 0) {
        unlink(tmp.c_str());
        log_warn("turn card: cannot write %s; the choice (%s) lasts until the service stops", path_.c_str(), name());
    }
    return true;
}

}  // namespace woc
