/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
#include "dcsm2_port.h"

#include "dcsm/dcsm_client.h"
#include "log.h"

namespace crs {

namespace {

Refusal classify(bool ok, uint32_t status)
{
    if (!ok)
        return Refusal::Transient;
    switch (status) {
    case dcsm::E_DCSM_PRIOTOOLOW:
    case dcsm::E_DCSM_CONTENT_ALREADYMAPPED:
        return Refusal::Busy;
    case dcsm::E_DCSM_HANDLE_UNKNOWN:
    case dcsm::E_DCSM_CONTENTID_UNKNOWN:
    case dcsm::E_DCSM_SLOTID_UNKNOWN:
    case dcsm::E_DCSM_CLIENT_ALREADYREGISTERED:
        return Refusal::Config;
    default:
        return Refusal::Transient;
    }
}

}  // namespace

void Dcsm2Port::request(const TargetSpec &t)
{
    Content &c = contents_[t.scene_id];
    c = Content();
    c.spec = t;
    if (up_)
        fetches_.push_back(t.scene_id);
    wire_->fetch(t.scene_id);
}

void Dcsm2Port::release(const TargetSpec &t)
{
    auto it = contents_.find(t.scene_id);
    if (it == contents_.end())
        return;
    if (it->second.map_asked) {
        if (up_)
            unmaps_.push_back(Unmap{t.scene_id, 0});
        wire_->unmap(t.scene_id);
    }
    wire_->unfetch(t.scene_id);
    if (up_)
        unfetched_[t.scene_id]++;
    contents_.erase(it);
}

void Dcsm2Port::take_over(const TargetSpec &, uint64_t content)
{
    if (up_)
        unmaps_.push_back(Unmap{content, hmi_handle_});
    wire_->unmap_as(hmi_handle_, content);
}

uint64_t Dcsm2Port::take(std::deque<uint64_t> *q)
{
    if (q->empty())
        return 0;
    uint64_t s = q->front();
    q->pop_front();
    return s;
}

void Dcsm2Port::refuse(uint64_t scene, Content &c, Refusal r, const std::string &why, int64_t now_ms)
{
    c.phase = Phase::Refused;
    c.map_asked = false;
    if (manager_)
        manager_->on_refused(scene, r, why, now_ms);
}

void Dcsm2Port::on_availability(bool up, int64_t now_ms)
{
    log_info("dcsm: Dcsm2 %s", up ? "available" : "not available");
    up_ = up;
    fetches_.clear();
    maps_.clear();
    unmaps_.clear();
    contents_.clear();   /* gone with the service; nothing to release */
    unfetched_.clear();
    slots_.clear();
    if (manager_)
        manager_->on_availability(up, now_ms);
}

void Dcsm2Port::on_reply(uint16_t method, bool ok, uint32_t status, const std::string &status_text, int64_t now_ms)
{
    if (method == dcsm::kReqUnmapContent) {
        Unmap u;
        if (!unmaps_.empty()) {
            u = unmaps_.front();
            unmaps_.pop_front();
        }
        if (u.handle)
            log_info("dcsm: reply to the take-over unmap of 0x%llx as client 0x%llx: %s", (unsigned long long)u.scene,
                     (unsigned long long)u.handle, ok ? status_text.c_str() : "no valid reply");
        else
            log_info("dcsm: reply to request 0x%04x (content 0x%llx): %s", method, (unsigned long long)u.scene,
                     ok ? status_text.c_str() : "no valid reply");
        return;   /* nothing waits on an unmap */
    }
    const uint64_t scene = method == dcsm::kReqFetchContent ? take(&fetches_)
                           : method == dcsm::kReqMapContent ? take(&maps_) : 0;
    const std::string why = ok ? status_text : "no valid reply";
    log_info("dcsm: reply to request 0x%04x (content 0x%llx): %s", method, (unsigned long long)scene, why.c_str());
    if (ok && status == dcsm::E_DCSM_OK)
        return;   /* the status event follows */
    auto it = contents_.find(scene);
    if (it == contents_.end())
        return;   /* released since */
    Content &c = it->second;
    if ((method == dcsm::kReqFetchContent && c.phase == Phase::Fetching) ||
        (method == dcsm::kReqMapContent && c.phase == Phase::Mapping))
        refuse(scene, c, classify(ok, status), (method == dcsm::kReqFetchContent ? "fetch " : "map ") + why, now_ms);
}

void Dcsm2Port::on_fetch_status(uint64_t scene, uint32_t status, int64_t now_ms)
{
    log_info("dcsm: content 0x%llx fetch status %u", (unsigned long long)scene, status);
    auto un = unfetched_.find(scene);
    if (un != unfetched_.end()) {
        if (status == dcsm::E_FETCH_STATUS_REMOVED) {
            if (--un->second == 0)
                unfetched_.erase(un);
            return;   /* the answer to our unfetch */
        }
        if (status == dcsm::E_FETCH_STATUS_FETCHED)
            unfetched_.erase(un);   /* a later fetch: any earlier REMOVED has come */
    }
    auto it = contents_.find(scene);
    if (it == contents_.end())
        return;
    Content &c = it->second;
    switch (status) {
    case dcsm::E_FETCH_STATUS_FETCHED:
        if (c.phase != Phase::Fetching)
            break;
        c.phase = Phase::Mapping;
        c.map_asked = true;
        if (up_)
            maps_.push_back(scene);
        wire_->map(scene, c.spec.content_class, c.spec.slot);
        break;
    case dcsm::E_FETCH_STATUS_FAILED:
        if (c.phase == Phase::Fetching)
            refuse(scene, c, Refusal::Transient, "E_FETCH_STATUS_FAILED", now_ms);
        break;
    case dcsm::E_FETCH_STATUS_REMOVED:
        /* The KOMBI took the slot back by removing the fetch, with no map
         * transition: the stock map re-mapping over ours, its watchdog, or
         * its renderer unsubscribing the scene. */
        if (c.phase == Phase::Mapped || c.phase == Phase::Parked) {
            c.phase = Phase::Lost;
            c.map_asked = false;
            if (manager_)
                manager_->on_lost(scene, "fetch removed", now_ms);
        } else if (c.phase == Phase::Fetching || c.phase == Phase::Mapping) {
            refuse(scene, c, Refusal::Transient, "fetch removed", now_ms);
        }
        break;
    default:
        break;
    }
}

void Dcsm2Port::on_map_status(uint64_t scene, uint32_t initial, uint32_t final_, int64_t now_ms)
{
    log_info("dcsm: content 0x%llx map status %u -> %u", (unsigned long long)scene, initial, final_);
    auto it = contents_.find(scene);
    if (it == contents_.end())
        return;
    Content &c = it->second;
    const bool showing = final_ == dcsm::E_MAP_STATUS_MAPPED_FOREGROUND || final_ == dcsm::E_MAP_STATUS_MAPPED_BACKGROUND;
    if (showing && (c.phase == Phase::Mapping || c.phase == Phase::Parked)) {
        c.phase = Phase::Mapped;
        if (manager_)
            manager_->on_shown(scene, now_ms);
    } else if (final_ == dcsm::E_MAP_STATUS_MAPPED_INVISIBLE &&
               (c.phase == Phase::Mapping || c.phase == Phase::Mapped)) {
        /* Accepted, behind the content the slot shows: the KOMBI shows it
         * when that goes. */
        c.phase = Phase::Parked;
        if (manager_)
            manager_->on_parked(scene, now_ms);
    } else if (final_ == dcsm::E_MAP_STATUS_UNMAPPED && (c.phase == Phase::Mapped || c.phase == Phase::Parked)) {
        c.phase = Phase::Lost;
        c.map_asked = false;
        if (manager_)
            manager_->on_lost(scene, "unmapped", now_ms);
    }
}

void Dcsm2Port::on_slots(const std::vector<SlotInfo> &slots, int64_t now_ms)
{
    /* An entry is logged when it is new to this report or changed since the
     * last one: the KOMBI re-reports every slot on each arbitration. */
    std::map<std::pair<uint64_t, uint64_t>, SlotInfo> now;
    for (const SlotInfo &s : slots) {
        auto it = slots_.find({s.slot, s.content});
        if (it == slots_.end() || it->second.status != s.status || it->second.klass != s.klass ||
            it->second.map_status != s.map_status)
            log_info("dcsm: slot 0x%llx status %u content 0x%llx class %u map %u", (unsigned long long)s.slot,
                     s.status, (unsigned long long)s.content, s.klass, s.map_status);
        now[{s.slot, s.content}] = s;
    }
    slots_.swap(now);
    if (manager_)
        manager_->on_slots(slots, now_ms);
}

}  // namespace crs
