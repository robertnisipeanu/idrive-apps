/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
#include "slots.h"

#include <algorithm>
#include <cstdio>

namespace crs {

namespace {

/* Retries of a contending target, and after a refusal or no answer. */
const int64_t kLadder[] = {2000, 5000, 10000, 20000, 30000};
const int kLadderSteps = sizeof kLadder / sizeof kLadder[0];

/* HmiMain3D publishes its cluster and HUD scenes with ids 0x0100xxxx. */
bool stock_scene(uint64_t id) { return (id >> 16) == 0x0100; }

}  // namespace

const char *holder_name(Holder h)
{
    switch (h) {
    case Holder::Us: return "us";
    case Holder::Stock: return "stock";
    case Holder::Foreign: return "foreign";
    default: return "none";
    }
}

const char *target_state_name(TargetState s)
{
    switch (s) {
    case TargetState::Acquiring: return "acquiring";
    case TargetState::Shown: return "shown";
    case TargetState::Lingering: return "lingering";
    case TargetState::Waiting: return "waiting";
    case TargetState::Unavailable: return "unavailable";
    default: return "idle";
    }
}

SlotManager::SlotManager(Port *port, Scenes *scenes) : port_(port), scenes_(scenes)
{
}

void SlotManager::add(const TargetSpec &t)
{
    specs_.push_back(t);
    t_.push_back(Target());
}

int SlotManager::index(const std::string &name) const
{
    for (size_t i = 0; i < specs_.size(); i++)
        if (specs_[i].name == name)
            return (int)i;
    return -1;
}

int SlotManager::by_scene(uint64_t scene_id) const
{
    /* A scene id belongs to at most one published target (scene_busy). */
    for (size_t i = 0; i < specs_.size(); i++)
        if (specs_[i].scene_id == scene_id && t_[i].published)
            return (int)i;
    return -1;
}

bool SlotManager::scene_busy(int i) const
{
    for (size_t j = 0; j < specs_.size(); j++)
        if ((int)j != i && specs_[j].scene_id == specs_[i].scene_id && t_[j].published)
            return true;
    return false;
}

const SlotInfo *SlotManager::slot(uint64_t id) const
{
    auto it = slots_.find(id);
    return it == slots_.end() ? nullptr : &it->second;
}

Holder SlotManager::holder_of(uint64_t content) const
{
    if (content == 0)
        return Holder::None;
    if (by_scene(content) >= 0)
        return Holder::Us;
    return stock_scene(content) ? Holder::Stock : Holder::Foreign;
}

Holder SlotManager::other_holder(int i) const
{
    const SlotInfo *s = slot(specs_[i].slot);
    const Holder h = s && s->status == 2 ? holder_of(s->content) : Holder::None;
    return h == Holder::Us ? Holder::None : h;
}

/* A slot the table names as someone else's is not asked for, unless a
 * contending layer takes it from the stock HMI: the target waits for it to
 * be free. */
bool SlotManager::yields(int i, int64_t now_ms)
{
    const Holder h = other_holder(i);
    if (h != Holder::Foreign && (h != Holder::Stock || t_[i].contend))
        return false;
    if (t_[i].status.state != TargetState::Waiting || t_[i].status.holder != h || t_[i].status.retry_ms >= 0)
        set(i, TargetState::Waiting, h, "slot in use", now_ms, -1);
    return true;
}

void SlotManager::want(int i, bool wanted, bool contend)
{
    t_[i].wanted = wanted;
    t_[i].contend = wanted && contend;
}

void SlotManager::set(int i, TargetState s, Holder h, const std::string &reason, int64_t now_ms, int64_t retry_ms)
{
    TargetStatus &st = t_[i].status;
    if (st.state != s)
        t_[i].since_ms = now_ms;
    st.state = s;
    st.holder = h;
    st.reason = reason;
    st.retry_ms = retry_ms;
}

void SlotManager::take_down(int i)
{
    Target &t = t_[i];
    if (!t.published)
        return;
    if (port_->available())
        port_->release(specs_[i]);
    scenes_->unpublish(specs_[i]);
    t.published = false;
}

void SlotManager::wait(int i, Holder h, bool use_ladder, const std::string &reason, int64_t now_ms, int64_t from_ms)
{
    Target &t = t_[i];
    int64_t retry = -1;
    if (use_ladder) {
        retry = (from_ms >= 0 ? from_ms : now_ms) + kLadder[std::min(t.ladder, kLadderSteps - 1)];
        t.ladder++;
    }
    set(i, TargetState::Waiting, h, reason, now_ms, retry);
}

void SlotManager::acquire(int i, int64_t now_ms)
{
    Target &t = t_[i];
    std::string err;
    if (!scenes_->publish(specs_[i], &err)) {
        wait(i, Holder::None, true, "scene: " + err, now_ms);
        return;
    }
    t.published = true;
    t.last_request_ms = now_ms;
    port_->request(specs_[i]);
    set(i, TargetState::Acquiring, Holder::None, "", now_ms);
}

void SlotManager::on_availability(bool up, int64_t now_ms)
{
    slots_.clear();
    if (up) {
        available_since_ms_ = now_ms;
        return;
    }
    available_since_ms_ = -1;
    for (Target &t : t_)
        t.verdict = false;
    /* The display is gone, and with it every mapping: nothing to release. */
    for (size_t i = 0; i < t_.size(); i++) {
        if (t_[i].published) {
            scenes_->unpublish(specs_[i]);
            t_[i].published = false;
        }
        set((int)i, t_[i].wanted ? TargetState::Unavailable : TargetState::Idle, Holder::None,
            t_[i].wanted ? "display service not available" : "", now_ms);
    }
}

void SlotManager::on_shown(uint64_t scene_id, int64_t now_ms)
{
    int i = by_scene(scene_id);
    if (i < 0 || t_[i].status.state != TargetState::Acquiring)
        return;   /* a late answer to a request taken down since */
    set(i, TargetState::Shown, Holder::Us, "", now_ms);
}

void SlotManager::on_refused(uint64_t scene_id, Refusal r, const std::string &why, int64_t now_ms)
{
    int i = by_scene(scene_id);
    if (i < 0 || t_[i].status.state != TargetState::Acquiring)
        return;
    /* Who holds the slot, read while our scene still counts as ours. */
    Holder h = Holder::None;
    if (r == Refusal::Busy) {
        const SlotInfo *s = slot(specs_[i].slot);
        h = s && s->status == 2 ? holder_of(s->content) : Holder::None;
        if (h == Holder::None || h == Holder::Us)
            h = Holder::Stock;   /* held by someone the table has not named yet */
    }
    take_down(i);
    if (h == Holder::Foreign || (h == Holder::Stock && !t_[i].contend))
        wait(i, h, false, "refused: " + why, now_ms);
    else
        wait(i, h, true, "refused: " + why, now_ms);
}

void SlotManager::on_lost(uint64_t scene_id, const std::string &why, int64_t now_ms)
{
    int i = by_scene(scene_id);
    if (i < 0)
        return;
    const TargetState s = t_[i].status.state;
    if (s != TargetState::Shown && s != TargetState::Lingering && s != TargetState::Acquiring)
        return;
    const SlotInfo *sl = slot(specs_[i].slot);
    const bool ours_named = sl && sl->status == 2 && sl->content == specs_[i].scene_id;
    const Holder h = other_holder(i);
    take_down(i);
    /* A scene removed while shown is evidence for the governor; one lost
     * before it showed is not. */
    const bool removal = s != TargetState::Acquiring;
    if (s == TargetState::Lingering) {
        if (h == Holder::None && !ours_named && on_evidence)
            on_evidence(Evidence::Removal, specs_[i].name + ": " + why, now_ms);
        set(i, TargetState::Idle, Holder::None, "", now_ms);
        return;
    }
    if (ours_named) {
        /* The table still names our scene id: a report from before the
         * loss, or someone else's content with that id (0x01000400 is also
         * the HMI's speech dialog). The next report, after our unfetch,
         * tells which; without one in kVerdictMs it was ours. */
        Target &t = t_[i];
        t.verdict = true;
        t.verdict_seq = slots_seq_;
        t.verdict_removal = removal;
        t.lost_ms = now_ms;
        port_->refresh_slots();
        set(i, TargetState::Waiting, Holder::None, "taken: " + why, now_ms, now_ms + kVerdictMs);
        return;
    }
    settle_loss(i, h, removal, "taken: " + why, now_ms, now_ms);
}

/* The ladder and the evidence count from lost_ms, when the scene went. */
void SlotManager::settle_loss(int i, Holder h, bool removal, const std::string &reason, int64_t now_ms,
                              int64_t lost_ms)
{
    if (h == Holder::None && removal && on_evidence)
        on_evidence(Evidence::Removal, specs_[i].name + ": " + reason, lost_ms);
    if (h == Holder::Foreign || (h == Holder::Stock && !t_[i].contend))
        wait(i, h, false, reason, now_ms);
    else
        wait(i, h, true, reason, now_ms, lost_ms);
}

void SlotManager::on_slots(const std::vector<SlotInfo> &slots, int64_t)
{
    for (const SlotInfo &s : slots)
        slots_[s.slot] = s;
    slots_seq_++;
}

void SlotManager::tick(int64_t now_ms)
{
    const bool up = port_->available();
    const bool settling = available_since_ms_ >= 0 && now_ms - available_since_ms_ < kSettleMs;
    bool poll_slots = false;

    for (size_t k = 0; k < specs_.size(); k++) {
        const int i = (int)k;
        Target &t = t_[i];
        const TargetSpec &spec = specs_[i];
        const TargetState s = t.status.state;

        if (!up) {
            if (s != TargetState::Idle && s != TargetState::Unavailable) {
                take_down(i);
                set(i, t.wanted ? TargetState::Unavailable : TargetState::Idle, Holder::None,
                    t.wanted ? "display service not available" : "", now_ms);
            } else if (s == TargetState::Idle && t.wanted) {
                set(i, TargetState::Unavailable, Holder::None, "display service not available", now_ms);
            } else if (s == TargetState::Unavailable && !t.wanted) {
                set(i, TargetState::Idle, Holder::None, "", now_ms);
            }
            continue;
        }

        switch (s) {
        case TargetState::Unavailable:
            set(i, TargetState::Idle, Holder::None, "", now_ms);
            /* fall through - it may be requested at once */
        case TargetState::Idle: {
            if (!t.wanted || settling)
                break;
            if (scene_busy(i)) {
                set(i, TargetState::Waiting, Holder::None, "scene id in use by another target", now_ms, now_ms);
                break;
            }
            if (yields(i, now_ms)) {
                poll_slots = true;
                break;
            }
            if (now_ms - t.last_request_ms < kMinRequestGapMs)
                break;
            acquire(i, now_ms);
            break;
        }
        case TargetState::Acquiring:
            if (now_ms - t.since_ms >= kStartTimeoutMs) {
                take_down(i);
                wait(i, Holder::None, true, "no answer from the display", now_ms);
            }
            break;
        case TargetState::Shown:
            if (!t.wanted)
                set(i, TargetState::Lingering, Holder::Us, "", now_ms);
            else if (now_ms - t.since_ms >= kLadderResetMs)
                t.ladder = 0;
            break;
        case TargetState::Lingering:
            if (t.wanted) {
                set(i, TargetState::Shown, Holder::Us, "", now_ms);
            } else if (now_ms - t.since_ms >= spec.linger_ms) {
                take_down(i);
                t.ladder = 0;
                set(i, TargetState::Idle, Holder::None, "", now_ms);
            }
            break;
        case TargetState::Waiting: {
            TargetStatus &st = t.status;
            if (t.verdict) {
                if (slots_seq_ == t.verdict_seq && now_ms < st.retry_ms)
                    break;
                const bool reported = slots_seq_ != t.verdict_seq;
                t.verdict = false;
                const SlotInfo *sl = slot(spec.slot);
                const bool named = sl && sl->status == 2 && sl->content == spec.scene_id;
                const Holder h = named ? (reported ? Holder::Stock : Holder::None) : other_holder(i);
                settle_loss(i, h, t.verdict_removal, st.reason, now_ms, t.lost_ms);
                break;
            }
            if (st.retry_ms < 0 && !t.wanted) {
                /* Idle checks the slot table again before any request. */
                set(i, TargetState::Idle, Holder::None, "", now_ms);
                break;
            }
            const SlotInfo *sl = slot(spec.slot);
            const bool slot_free = sl && sl->status == 1;
            bool ready;
            if (st.retry_ms >= 0) {
                ready = now_ms >= st.retry_ms && !scene_busy(i);
            } else if (st.holder == Holder::Stock && t.contend) {
                /* A contending layer arrived while yielding: retry on the ladder. */
                wait(i, Holder::Stock, true, st.reason, now_ms);
                ready = false;
            } else {
                ready = slot_free || (sl && sl->status == 2 && holder_of(sl->content) == Holder::None);
                if (!ready)
                    poll_slots = true;
            }
            if (!ready)
                break;
            if (!t.wanted) {
                set(i, TargetState::Idle, Holder::None, "", now_ms);
                break;
            }
            if (settling || now_ms - t.last_request_ms < kMinRequestGapMs)
                break;
            if (yields(i, now_ms)) {
                poll_slots = true;
                break;
            }
            acquire(i, now_ms);
            break;
        }
        }
    }

    if (poll_slots && now_ms >= slot_poll_ms_) {
        port_->refresh_slots();
        slot_poll_ms_ = now_ms + kSlotPollMs;
    }
}

int64_t SlotManager::wake_in_ms(int64_t now_ms) const
{
    /* Only timers still ahead: one already due and still pending waits on
     * something else (a busy scene id, the settle time), which is counted
     * on its own or falls to the caller's regular tick. */
    int64_t best = -1;
    auto at = [&](int64_t when) {
        int64_t d = when - now_ms;
        if (d > 0 && (best < 0 || d < best))
            best = d;
    };
    if (available_since_ms_ >= 0)
        at(available_since_ms_ + kSettleMs);
    for (size_t i = 0; i < specs_.size(); i++) {
        const Target &t = t_[i];
        switch (t.status.state) {
        case TargetState::Acquiring: at(t.since_ms + kStartTimeoutMs); break;
        case TargetState::Lingering: at(t.since_ms + specs_[i].linger_ms); break;
        case TargetState::Waiting:
            if (t.status.retry_ms >= 0)
                at(std::max(t.status.retry_ms, t.last_request_ms + kMinRequestGapMs));
            else
                at(slot_poll_ms_);
            break;
        case TargetState::Idle:
            if (t.wanted)
                at(t.last_request_ms + kMinRequestGapMs);
            break;
        default:
            break;
        }
    }
    return best;
}

}  // namespace crs
