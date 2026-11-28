// SPDX-License-Identifier: GPL-3.0-or-later
#include "guidance_link.h"

#include <fcntl.h>
#include <unistd.h>

#include <vector>

#include <vsomeip/vsomeip.hpp>

#include "log.h"
#include "route_box.h"

namespace woc {

namespace {

const vsomeip::service_t kService = 0xFB1B;   /* GuidanceEventList */
const vsomeip::instance_t kInstance = 0x0080;
const vsomeip::major_version_t kMajor = 5;
const vsomeip::event_t kEvent = 0x8002;        /* the route box of each screen */
const vsomeip::eventgroup_t kGroup = 0x0002;
const vsomeip::service_t kGuidance = 0xFB1A;   /* Guidance */
const vsomeip::major_version_t kGuidanceMajor = 7;
const vsomeip::event_t kGuiding = 0x8015;      /* guiding: u32, 1 on, 0 off */
const vsomeip::eventgroup_t kGuidingGroup = 0x0015;
const char kAppName[] = "woc-guidance";

int64_t steady_ms()
{
    return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now().time_since_epoch())
        .count();
}

}  // namespace

const int64_t GuidanceLink::kSettleMs;

GuidanceLink::GuidanceLink()
{
    if (pipe2(wake_, O_NONBLOCK | O_CLOEXEC) < 0)
        wake_[0] = wake_[1] = -1;
}

GuidanceLink::~GuidanceLink()
{
    stop();
    if (wake_[0] >= 0) close(wake_[0]);
    if (wake_[1] >= 0) close(wake_[1]);
}

void GuidanceLink::wake()
{
    char c = 0;
    ssize_t n = write(wake_[1], &c, 1);
    (void)n;
}

bool GuidanceLink::start(std::string *err)
{
    if (wake_[0] < 0) {
        *err = "pipe failed";
        return false;
    }
    /* No VSOMEIP_CONFIGURATION: the unit's /etc/vsomeip, as the HMI and
     * cluster-render have it. */
    app_ = vsomeip::runtime::get()->create_application(kAppName);
    if (!app_ || !app_->init()) {
        app_.reset();
        *err = "vsomeip application did not initialise";
        return false;
    }
    app_->register_availability_handler(
        kService, kInstance, [this](vsomeip::service_t, vsomeip::instance_t, bool up) { on_availability(up); },
        vsomeip::ANY_MAJOR, vsomeip::ANY_MINOR);
    app_->register_message_handler(kService, kInstance, kEvent,
                                   [this](const std::shared_ptr<vsomeip::message> &m) { on_message(m); });
    app_->register_subscription_status_handler(
        kService, kInstance, kGroup, kEvent,
        [](const vsomeip::service_t, const vsomeip::instance_t, const vsomeip::eventgroup_t, const vsomeip::event_t,
           const uint16_t code) {
            if (code == 0)
                log_info("guidance: the navigation's route box subscribed");
            else
                log_warn("guidance: the route box's subscription refused (%u)", (unsigned)code);
        },
        true);
    app_->register_availability_handler(
        kGuidance, kInstance, [this](vsomeip::service_t, vsomeip::instance_t, bool up) { on_guide_availability(up); },
        vsomeip::ANY_MAJOR, vsomeip::ANY_MINOR);
    app_->register_message_handler(kGuidance, kInstance, kGuiding,
                                   [this](const std::shared_ptr<vsomeip::message> &m) { on_guiding(m); });
    app_->register_subscription_status_handler(
        kGuidance, kInstance, kGuidingGroup, kGuiding,
        [](const vsomeip::service_t, const vsomeip::instance_t, const vsomeip::eventgroup_t, const vsomeip::event_t,
           const uint16_t code) {
            if (code == 0)
                log_info("guidance: whether the navigation guides, subscribed");
            else
                log_warn("guidance: the guiding's subscription refused (%u): an empty box is no card at once",
                         (unsigned)code);
        },
        true);
    app_->request_service(kService, kInstance, kMajor, vsomeip::ANY_MINOR);
    app_->request_service(kGuidance, kInstance, kGuidanceMajor, vsomeip::ANY_MINOR);
    std::shared_ptr<vsomeip::application> app = app_;
    thread_ = std::thread([app] { app->start(); });
    log_info("guidance: vsomeip application %s, waiting for the navigation's route box (0x%04x.0x%04x)", kAppName,
             (unsigned)kService, (unsigned)kInstance);
    return true;
}

void GuidanceLink::stop()
{
    if (!app_)
        return;
    bool subscribed, guide_subscribed;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        subscribed = subscribed_;
        guide_subscribed = guide_subscribed_;
    }
    if (subscribed) {
        app_->unsubscribe(kService, kInstance, kGroup);
        app_->release_event(kService, kInstance, kEvent);
    }
    if (guide_subscribed) {
        app_->unsubscribe(kGuidance, kInstance, kGuidingGroup);
        app_->release_event(kGuidance, kInstance, kGuiding);
    }
    app_->release_service(kService, kInstance);
    app_->release_service(kGuidance, kInstance);
    app_->clear_all_handler();
    app_->stop();
    if (thread_.joinable())
        thread_.join();
    app_.reset();
}

void GuidanceLink::on_availability(bool up)
{
    {
        std::lock_guard<std::mutex> lock(mutex_);
        if (up == up_)
            return;
        up_ = up;
        if (up)
            up_since_ = std::chrono::steady_clock::now();
        else
            card_.set_box(Maneuver(), steady_ms());   /* no box: nothing to hold either */
    }
    log_info("guidance: the navigation's route box %s", up ? "offered" : "gone");
    wake();
}

void GuidanceLink::on_guide_availability(bool up)
{
    {
        std::lock_guard<std::mutex> lock(mutex_);
        if (up == guide_up_)
            return;
        guide_up_ = up;
        if (up)
            guide_up_since_ = std::chrono::steady_clock::now();
        else
            card_.forget_guiding();
    }
    log_info("guidance: the navigation's Guidance service %s", up ? "offered" : "gone");
    wake();
}

void GuidanceLink::on_guiding(const std::shared_ptr<vsomeip::message> &msg)
{
    const std::shared_ptr<vsomeip::payload> pl = msg ? msg->get_payload() : nullptr;
    if (!pl || pl->get_length() < 4)
        return;
    const vsomeip::byte_t *d = pl->get_data();
    const bool on = ((uint32_t)d[0] << 24 | (uint32_t)d[1] << 16 | (uint32_t)d[2] << 8 | (uint32_t)d[3]) != 0;
    bool changed;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        changed = card_.guiding() != (on ? 1 : 0);
        card_.set_guiding(on);
    }
    if (changed)
        log_info("guidance: the navigation %s", on ? "guides" : "does not guide");
    wake();
}

void GuidanceLink::on_message(const std::shared_ptr<vsomeip::message> &msg)
{
    const std::shared_ptr<vsomeip::payload> pl = msg ? msg->get_payload() : nullptr;
    if (!pl)
        return;
    std::vector<RouteBoxEvent> events;
    if (!parse_route_box(pl->get_data(), pl->get_length(), kClusterRouteBox, &events))
        return;   /* about other screens only */
    Maneuver m;
    const bool whole = route_box_maneuver(events, &m);
    {
        std::lock_guard<std::mutex> lock(mutex_);
        notifications_++;
        if (!events.empty()) {
            const RouteBoxEvent &e = events.front();
            const uint32_t key = (e.kind & 0xFFFF) << 16 | (e.direction & 0xFFFF);
            if (!event_known(e.kind, e.direction) && !logged_events_.count(key))
                new_events_.insert(key);
            if (e.kind != kRouteBoxEmpty && !unit_known(e.unit) && !logged_units_.count(e.unit))
                new_units_.insert(e.unit);
        }
        /* the list mid-rebuild: the box keeps what it had */
        if (whole)
            card_.set_box(m, steady_ms());
    }
    wake();
}

bool GuidanceLink::take(Maneuver *m)
{
    if (!app_)
        return false;
    char buf[64];
    while (read(wake_[0], buf, sizeof buf) > 0) {
    }
    bool subscribe = false, guide_subscribe = false, changed = false, first = false;
    std::set<uint32_t> events, units;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        const auto now = std::chrono::steady_clock::now();
        if (up_ && !subscribed_ && now - up_since_ >= std::chrono::milliseconds(kSettleMs)) {
            subscribed_ = true;
            subscribe = true;
        }
        if (guide_up_ && !guide_subscribed_ && now - guide_up_since_ >= std::chrono::milliseconds(kSettleMs)) {
            guide_subscribed_ = true;
            guide_subscribe = true;
        }
        if (notifications_ && !first_logged_) {
            first_logged_ = true;
            first = true;
        }
        events.swap(new_events_);
        units.swap(new_units_);
        logged_events_.insert(events.begin(), events.end());
        logged_units_.insert(units.begin(), units.end());
        /* each pass, as a hold's time runs out too (guided_card.h) */
        const Maneuver shown = card_.shown(steady_ms());
        if (shown != published_) {
            published_ = shown;
            *m = shown;
            changed = true;
        }
    }
    if (subscribe) {
        /* outside the lock: vsomeip may call the handlers from here */
        app_->request_event(kService, kInstance, kEvent, std::set<vsomeip::eventgroup_t>{kGroup},
                            vsomeip::event_type_e::ET_UNKNOWN, vsomeip::reliability_type_e::RT_UNKNOWN);
        app_->subscribe(kService, kInstance, kGroup, kMajor);
        log_info("guidance: asking for the route box, its service offered %lld s ago",
                 (long long)(kSettleMs / 1000));
    }
    if (guide_subscribe) {
        app_->request_event(kGuidance, kInstance, kGuiding, std::set<vsomeip::eventgroup_t>{kGuidingGroup},
                            vsomeip::event_type_e::ET_UNKNOWN, vsomeip::reliability_type_e::RT_UNKNOWN);
        app_->subscribe(kGuidance, kInstance, kGuidingGroup, kGuidanceMajor);
        log_info("guidance: asking whether the navigation guides, its Guidance service offered %lld s ago",
                 (long long)(kSettleMs / 1000));
    }
    if (first)
        log_info("guidance: the first route box for the cluster came");
    for (uint32_t k : events)
        log_info("guidance: route box event kind %u, direction %u, not known yet: a plain mark on the card",
                 (unsigned)(k >> 16), (unsigned)(k & 0xFFFF));
    for (uint32_t u : units)
        log_info("guidance: route box distance unit %u not known yet: the number alone", (unsigned)u);
    return changed;
}

}  // namespace woc
