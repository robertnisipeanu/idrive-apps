// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
#include "avb_source.h"

#include <cstdio>
#include <unistd.h>

#include "log.h"

/* The IAS AVB bridge's C receiver API (libias-media_transport-avb_ufipc_bridge,
 * /usr/lib on the unit; a link-only stub carries its SONAME, Makefile). A
 * packet is a size and a data pointer, as the unit's own receivers get it. */
extern "C" {
struct IasAvbPacket {
    uint32_t size;
    void *data;
};
typedef void (*IasAvbH264Cb)(void *handle, const IasAvbPacket *pkt, void *user);
void *ias_avbbridge_create_receiver(const char *receiver, const char *stream);
int ias_avbbridge_register_H264_cb(void *handle, IasAvbH264Cb cb, void *user);
void ias_avbbridge_destroy_receiver(void *handle);
}

namespace woc {

AvbSource::~AvbSource() { stop(); }

void AvbSource::on_packet(void *handle, const void *pkt, void *user)
{
    (void)handle;
    const IasAvbPacket *p = static_cast<const IasAvbPacket *>(pkt);
    AvbSource *self = static_cast<AvbSource *>(user);
    std::lock_guard<std::mutex> lock(self->cb_mutex_);
    if (!p || !p->data || !p->size || !self->running_.load())
        return;
    self->bytes_.fetch_add(p->size);
    self->packets_.fetch_add(1);
    self->sink_(static_cast<const uint8_t *>(p->data), p->size);
}

bool AvbSource::start(const std::string &stream, const Sink &sink, std::string *err)
{
    sink_ = sink;
    bytes_ = 0;
    packets_ = 0;

    char name[64];
    std::snprintf(name, sizeof name, "woc.avb.%d", (int)getpid());
    handle_ = ias_avbbridge_create_receiver(name, stream.c_str());
    if (!handle_) {
        *err = "create_receiver(" + stream + ") failed";
        return false;
    }
    running_ = true;
    int r = ias_avbbridge_register_H264_cb(
        handle_, [](void *h, const IasAvbPacket *p, void *u) { on_packet(h, p, u); }, this);
    if (r != 0) {
        *err = "register_H264_cb returned " + std::to_string(r);
        running_ = false;
        ias_avbbridge_destroy_receiver(handle_);
        handle_ = nullptr;
        return false;
    }
    log_info("avb: receiver %s on %s", name, stream.c_str());
    return true;
}

void AvbSource::stop()
{
    if (!running_.exchange(false))
        return;
    /* Barrier only: wait out a callback in flight, then destroy with the
     * lock released. Holding it across destroy could deadlock if destroy
     * waits for the bridge's callback thread, which may be blocked on this
     * mutex. A callback arriving after the barrier sees running_ false and
     * returns without touching the sink. */
    { std::lock_guard<std::mutex> lock(cb_mutex_); }
    if (handle_) {
        ias_avbbridge_destroy_receiver(handle_);
        handle_ = nullptr;
    }
}

}  // namespace woc
