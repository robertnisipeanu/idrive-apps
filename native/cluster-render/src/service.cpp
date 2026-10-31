/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
#include "service.h"

#include <fcntl.h>
#include <unistd.h>

#include <algorithm>

namespace crs {

Service::Service(Gpu *gpu, Port *port, const ServiceConfig &cfg) : cfg_(cfg), slots_(port, nullptr)
{
    for (const TargetSpec &t : cfg_.targets)
        slots_.add(t);
    comp_.reset(new Compositor(gpu, &slots_, cfg_.budget, cfg_.upload_burst_ms));
    comp_->set_slow_flush_ms(cfg_.slow_flush_ms);
    comp_->set_fade_ms(cfg_.fade_ms);
    slots_.set_scenes(comp_.get());
    Governor *gov = &comp_->governor();
    slots_.on_evidence = [gov](Evidence e, const std::string &detail, int64_t now_ms) {
        gov->evidence(e, now_ms, detail);
    };
    server_.reset(new Server(comp_.get(), &slots_, cfg_.backend));
}

bool Service::start(std::string *err)
{
    return comp_->init(err) && server_->listen(cfg_.socket_path, cfg_.socket_mode, cfg_.socket_group, err);
}

size_t Service::poll_fds(std::vector<pollfd> *fds) const
{
    const size_t first = fds->size();
    server_->poll_fds(fds);
    return first;
}

int Service::timeout_ms(int64_t now_ms) const
{
    bool active = false;
    for (size_t i = 0; i < slots_.targets().size(); i++)
        active = active || slots_.published((int)i);
    /* Idle: four times a second, so a stalled layer's state, a slot poll and
     * the status file stay current. */
    int64_t t = active ? 1000 / std::max(1, cfg_.fps) : 250;
    for (int64_t w : {comp_->wake_in_ms(now_ms), slots_.wake_in_ms(now_ms)})
        if (w > 0 && w < t)
            t = w;
    return (int)t;
}

void Service::after_poll(const std::vector<pollfd> &fds, size_t first, int64_t now_ms)
{
    server_->handle(fds, first, now_ms);
    comp_->arrange(now_ms);
    slots_.tick(now_ms);
    comp_->render(now_ms);
    server_->report(now_ms);
    if (!cfg_.status_path.empty() && now_ms - status_ms_ >= 1000) {
        status_ms_ = now_ms;
        const std::string tmp = cfg_.status_path + ".tmp";
        const std::string text = server_->status_text(now_ms);
        int fd = open(tmp.c_str(), O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0644);
        if (fd >= 0) {
            const bool whole = write(fd, text.data(), text.size()) == (ssize_t)text.size();
            close(fd);
            if (whole)
                rename(tmp.c_str(), cfg_.status_path.c_str());
            else
                unlink(tmp.c_str());
        }
    }
}

void Service::shutdown(int64_t now_ms)
{
    for (size_t i = 0; i < slots_.targets().size(); i++)
        slots_.want((int)i, false, false);
    /* Lingering targets are released at once: past every linger. */
    slots_.tick(now_ms);
    slots_.tick(now_ms + 3600 * 1000);
}

}  // namespace crs
