/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 IterioDev */
#include "dcsm27_port.h"

#include "log.h"

namespace crs {

namespace {

unsigned long long u(uint64_t v) { return (unsigned long long)v; }

}  // namespace

bool Dcsm27Port::offer(Content &c)
{
    std::string why;
    if (!wire_->offer(c.spec, &why)) {
        log_error("dcsm: offer of content %llu in category %llu refused: %s", u(c.spec.content), u(c.spec.slot),
                  why.c_str());
        answers_.push_back(Answer{c.spec.scene_id, true, "offer: " + why});
        return false;
    }
    log_info("dcsm: content %llu offered in category %llu (scene 0x%llx)", u(c.spec.content), u(c.spec.slot),
             u(c.spec.scene_id));
    c.phase = Phase::Offered;
    answers_.push_back(Answer{c.spec.scene_id, false, ""});
    return true;
}

Dcsm27Port::Content *Dcsm27Port::offered(uint64_t content)
{
    auto it = contents_.find(content);
    return it == contents_.end() || it->second.phase == Phase::Stopping ? nullptr : &it->second;
}

void Dcsm27Port::request(const TargetSpec &t)
{
    auto it = contents_.find(t.content);
    if (it != contents_.end() && it->second.phase == Phase::Stopping) {
        /* The library refuses the offer until the stop is accepted (the
         * slot manager waits for confirmed() first, at most kConfirmMs). */
        answers_.push_back(Answer{t.scene_id, true, "offer: its last stop is not accepted yet"});
        return;
    }
    Content &c = contents_[t.content];
    c = Content();
    c.spec = t;
    if (!offer(c))
        contents_.erase(t.content);
}

void Dcsm27Port::release(const TargetSpec &t)
{
    auto it = contents_.find(t.content);
    if (it == contents_.end()) {
        stopped_.push_back(t.scene_id);   /* never offered, or refused: nothing to wait for */
        return;
    }
    Content &c = it->second;
    if (c.phase == Phase::Stopping)
        return;
    std::string why;
    if (!wire_->stop_offer(t.content, &why)) {
        log_error("dcsm: stop of content %llu refused: %s", u(t.content), why.c_str());
        stopped_.push_back(t.scene_id);
        contents_.erase(it);
        return;
    }
    log_info("dcsm: content %llu: offer stopping", u(t.content));
    c.phase = Phase::Stopping;
}

void Dcsm27Port::take_over(const TargetSpec &, uint64_t)
{
    /* No counterpart on iDrive 8, and no slot table that would name a
     * holder to take over from: never called. */
}

void Dcsm27Port::on_availability(bool up, int64_t now_ms)
{
    log_info("dcsm: DCSM provider %s", up ? "available" : "not available");
    up_ = up;
    for (const auto &kv : contents_)
        stopped_.push_back(kv.second.spec.scene_id);
    contents_.clear();   /* gone with the framework; nothing to stop */
    answers_.clear();
    if (manager_)
        manager_->on_availability(up, now_ms);
}

void Dcsm27Port::dispatch(int64_t now_ms)
{
    std::vector<uint64_t> stopped;
    stopped.swap(stopped_);
    if (on_stopped)
        for (uint64_t scene : stopped)
            on_stopped(scene);
    std::vector<Answer> answers;
    answers.swap(answers_);
    for (const Answer &a : answers) {
        if (!manager_)
            continue;
        if (a.refused)
            manager_->on_refused(a.scene, Refusal::Transient, a.why, now_ms);
        else
            manager_->on_parked(a.scene, now_ms);
    }
}

bool Dcsm27Port::confirmed(const TargetSpec &t) const
{
    auto it = contents_.find(t.content);
    return it == contents_.end() || it->second.phase != Phase::Stopping;
}

bool Dcsm27Port::stopping() const
{
    for (const auto &kv : contents_)
        if (kv.second.phase == Phase::Stopping)
            return true;
    return false;
}

bool Dcsm27Port::holds(uint64_t scene_id) const
{
    for (const auto &kv : contents_)
        if (kv.second.spec.scene_id == scene_id)
            return true;
    return false;
}

void Dcsm27Port::on_size(uint64_t content, const ContentArea &a, int64_t)
{
    auto it = contents_.find(content);
    if (it == contents_.end())
        return;
    Content &c = it->second;
    ContentArea &was = c.area;
    bool changed = false;
    if (a.has_render && (!was.has_render || a.render_w != was.render_w || a.render_h != was.render_h)) {
        was.has_render = true;
        was.render_w = a.render_w;
        was.render_h = a.render_h;
        changed = true;
        if (a.render_w != c.spec.width || a.render_h != c.spec.height)
            log_warn("dcsm: content %llu: the cluster's canvas is %ux%u, target %s's scene %ux%u", u(content),
                      a.render_w, a.render_h, c.spec.name.c_str(), c.spec.width, c.spec.height);
    }
    auto same = [](const Rect &x, const Rect &y) { return x.x == y.x && x.y == y.y && x.w == y.w && x.h == y.h; };
    if (a.has_rect && (!was.has_rect || !same(a.rect, was.rect))) {
        was.has_rect = true;
        was.rect = a.rect;
        changed = true;
    }
    if (a.has_safe && (!was.has_safe || !same(a.safe, was.safe))) {
        was.has_safe = true;
        was.safe = a.safe;
        changed = true;
    }
    if (a.has_layout && (!was.has_layout || a.layout != was.layout)) {
        was.has_layout = true;
        was.layout = a.layout;
        changed = true;
    }
    /* The cluster repeats it many times per change (VERIFIED on the car):
     * logged when it changes. */
    if (changed)
        log_info("dcsm: content %llu: canvas %ux%u, rect %ux%u@%d,%d, safe %ux%u@%d,%d, layout %u", u(content),
                 was.render_w, was.render_h, was.rect.w, was.rect.h, was.rect.x, was.rect.y, was.safe.w, was.safe.h,
                 was.safe.x, was.safe.y, was.layout);
}

void Dcsm27Port::on_ready_requested(uint64_t content, int64_t)
{
    if (!offered(content))
        return;
    std::string why;
    if (wire_->ready(content, &why))
        log_info("dcsm: content %llu ready", u(content));
    else
        log_error("dcsm: content %llu: markContentReady: %s", u(content), why.c_str());
}

void Dcsm27Port::on_show(uint64_t content, int64_t now_ms)
{
    Content *c = offered(content);
    if (!c)
        return;
    log_info("dcsm: content %llu shown", u(content));
    c->phase = Phase::Shown;
    if (manager_)
        manager_->on_shown(c->spec.scene_id, now_ms);
}

void Dcsm27Port::on_hide(uint64_t content, int64_t now_ms)
{
    Content *c = offered(content);
    if (!c)
        return;
    log_info("dcsm: content %llu hidden", u(content));
    c->phase = Phase::Offered;
    if (manager_)
        manager_->on_parked(c->spec.scene_id, now_ms);
}

void Dcsm27Port::on_release(uint64_t content, int64_t now_ms)
{
    Content *c = offered(content);
    if (!c)
        return;
    log_info("dcsm: content %llu released by the cluster, still offered", u(content));
    c->phase = Phase::Offered;
    if (manager_)
        manager_->on_parked(c->spec.scene_id, now_ms);
}

void Dcsm27Port::on_stop_accepted(uint64_t content, int64_t now_ms)
{
    auto it = contents_.find(content);
    if (it == contents_.end())
        return;
    Content &c = it->second;
    log_info("dcsm: content %llu: offer stopped", u(content));
    const uint64_t scene = c.spec.scene_id;
    const bool asked = c.phase == Phase::Stopping;
    stopped_.push_back(scene);
    contents_.erase(it);
    /* Only a stop we asked for is accepted (RAMSES 27's DcsmComponent);
     * should another come, the offer is gone all the same. */
    if (!asked && manager_)
        manager_->on_lost(scene, "offer stopped", now_ms);
}

}  // namespace crs
