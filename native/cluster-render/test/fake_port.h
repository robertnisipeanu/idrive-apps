/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
/* A display port for host runs (slots.h): grants every request after
 * grant_ms, and lets a test play the stock HMI taking a slot, the slot
 * coming free and the display service going away. */
#ifndef CRS_FAKE_PORT_H
#define CRS_FAKE_PORT_H

#include <map>
#include <string>
#include <vector>

#include "../src/slots.h"

namespace crs {

class FakePort : public Port {
public:
    SlotManager *m = nullptr;
    bool up = true;
    int64_t grant_ms = 50;
    int requests = 0, releases = 0;
    std::map<uint64_t, int64_t> pending;   /* scene -> when it is granted */
    std::vector<SlotInfo> table;

    bool available() const override { return up; }
    void request(const TargetSpec &t) override
    {
        requests++;
        pending[t.scene_id] = now + grant_ms;
        set_slot(t.slot, 2, t.scene_id);
    }
    void release(const TargetSpec &t) override
    {
        releases++;
        pending.erase(t.scene_id);
        set_slot(t.slot, 1, 0);
    }
    void refresh_slots() override
    {
        if (m)
            m->on_slots(table, now);
    }

    void tick(int64_t t)
    {
        now = t;
        for (auto it = pending.begin(); it != pending.end();) {
            if (t >= it->second) {
                const uint64_t scene = it->first;
                it = pending.erase(it);
                m->on_shown(scene, t);
            } else {
                ++it;
            }
        }
    }
    /* The stock HMI maps its own content over the target's slot. */
    void steal(const TargetSpec &t, uint64_t stock_scene = 0x01000101)
    {
        set_slot(t.slot, 2, stock_scene);
        m->on_slots(table, now);
        m->on_lost(t.scene_id, "fetch removed", now);
    }
    void free_slot(const TargetSpec &t)
    {
        set_slot(t.slot, 1, 0);
        m->on_slots(table, now);
    }
    void set_up(bool on)
    {
        up = on;
        pending.clear();
        m->on_availability(on, now);
    }

    int64_t now = 0;

private:
    void set_slot(uint64_t slot, uint32_t status, uint64_t content)
    {
        for (SlotInfo &s : table)
            if (s.slot == slot) {
                s.status = status;
                s.content = content;
                return;
            }
        SlotInfo s;
        s.slot = slot;
        s.status = status;
        s.content = content;
        table.push_back(s);
    }
};

}  // namespace crs

#endif
