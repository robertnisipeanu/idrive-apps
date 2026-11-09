// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 JustAnotherPU
#include "hud_arrows.h"

#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

#include <cerrno>
#include <cstdio>
#include <cstring>

#include "log.h"

namespace woc {

namespace {

std::string reading_text(const Reading &r)
{
    return r.maneuver.empty() ? std::string("none") : r.maneuver + (r.distance.empty() ? "" : " " + r.distance);
}

std::string json_str(const std::string &s)
{
    std::string o = "\"";
    for (char c : s)
        if (c == '"' || c == '\\') o += '\\', o += c;
        else if ((unsigned char)c >= 0x20) o += c;
    return o + "\"";
}

long dir_mtime(const std::string &dir)
{
    struct stat st;
    return stat(dir.c_str(), &st) == 0 ? (long)st.st_mtime : 0;
}

}  // namespace

void NativeGuidanceHud::show(const Reading &r, int64_t now_ms)
{
    if (r == want_ && written_ms_ > -1000000)
        return;
    want_ = r;
    write(now_ms);
}

void NativeGuidanceHud::poll(int64_t now_ms)
{
    if (now_ms - written_ms_ >= 1000)   /* the heartbeat: hudguide clears a stale reading */
        write(now_ms);
}

void NativeGuidanceHud::write(int64_t now_ms)
{
    written_ms_ = now_ms;
    const std::string tmp = path_ + ".tmp";
    const std::string line = "{\"maneuver\":" + json_str(want_.maneuver) + ",\"distance\":" + json_str(want_.distance) +
                             ",\"at\":" + std::to_string((long long)now_ms) + "}\n";
    const int fd = open(tmp.c_str(), O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0644);
    bool ok = fd >= 0 && ::write(fd, line.data(), line.size()) == (ssize_t)line.size();
    if (fd >= 0) close(fd);
    ok = ok && rename(tmp.c_str(), path_.c_str()) == 0;
    if (!ok) {
        unlink(tmp.c_str());
        if (!failed_) log_warn("hud arrows: cannot write %s: %s", path_.c_str(), strerror(errno));
    } else {
        writes_++;
    }
    failed_ = !ok;
}

void NativeGuidanceHud::clear()
{
    want_ = Reading();
    written_ms_ = -1000000;
    unlink(path_.c_str());
}

std::string NativeGuidanceHud::state() const
{
    char buf[256];
    std::snprintf(buf, sizeof buf, "%s to %s, %u writes%s", reading_text(want_).c_str(), path_.c_str(), writes_,
                  failed_ ? ", the last failed" : "");
    return buf;
}

/* The card's glyph templates: the folder's dist-*.pgm (the built-in stroke
 * font is not the card's), read again when the folder changes. */
void HudArrows::load_templates()
{
    tpl_mtime_ = dir_mtime(cfg_.templates_dir);
    tpl_ = Templates();
    std::string log;
    tpl_.load_dir(cfg_.templates_dir, &log);
    log_info("hud arrows: card distance: %zu glyphs from %s%s", tpl_.glyphs(), cfg_.templates_dir.c_str(),
             tpl_.glyphs() ? "" : " (none: arrows without the distance; tools/hud_font_templates.py)");
}

void HudArrows::set_active(bool on, int64_t now_ms)
{
    if (on == active_)
        return;
    active_ = on;
    log_info("hud arrows: %s", on ? "on" : "off");
    if (on) {
        if (!grab_) {
            load_templates();
            tpl_checked_ms_ = now_ms;
            card_.reset(new CardReader(cfg_.card, &tpl_));
            grab_.reset(new ScreenGrab(cfg_.grab));
        }
        grab_->want(true);
        return;
    }
    if (grab_)
        grab_->want(false);
    debounce_ = Debounce(cfg_.stable);
    hold_ = CardHold();
    last_read_ = Reading();
    out_.clear();
}

void HudArrows::poll(int64_t now_ms)
{
    if (!active_)
        return;
    if (now_ms - last_sample_ms_ >= (int64_t)cfg_.sample_ms) {
        last_sample_ms_ = now_ms;
        if (now_ms - tpl_checked_ms_ >= 10000) {
            tpl_checked_ms_ = now_ms;
            if (dir_mtime(cfg_.templates_dir) != tpl_mtime_)
                load_templates();
        }
        Reading r;
        const bool got = grab_->latest(&scr_, now_ms, 1500);
        if (got)
            r = card_->read(scr_.data(), cfg_.grab.w, cfg_.grab.h);
        last_read_ = hold_.pick(r, !r.maneuver.empty(), now_ms);
        Reading out;
        if (debounce_.push(last_read_, &out)) {
            log_info("hud arrows: %s", reading_text(out).c_str());
            out_.show(out, now_ms);
        }
    }
    out_.poll(now_ms);
}

std::string HudArrows::report() const
{
    return std::string("hud arrows: ") + (active_ ? "on" : "off") +
           (grab_ ? ", last read " + reading_text(last_read_) + ", shown " + reading_text(debounce_.current()) + "; " +
                        grab_->state() + "; " + out_.state()
                  : std::string()) +
           "\n";
}

}  // namespace woc
