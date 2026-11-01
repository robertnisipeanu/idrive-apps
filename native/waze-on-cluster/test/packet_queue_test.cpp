// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* Host test for the receive queue (packet_queue.h): packets come out in
 * order; an overflow drops the oldest, is counted, and the next packet out
 * says how many went before it; a consumer that stalls for a while within
 * the queue's headroom loses nothing; large datagrams leave no large buffer
 * behind. */
#include <cstdio>
#include <thread>

#include "../src/packet_queue.h"

using namespace woc;

static int failures;
static void ok(const char *name, bool cond)
{
    std::printf("%-4s %s\n", cond ? "ok" : "FAIL", name);
    if (!cond) failures++;
}

static void push_n(PacketQueue &q, uint32_t from, uint32_t n, size_t len, int source)
{
    std::vector<uint8_t> b(len);
    for (uint32_t i = from; i < from + n; i++) {
        for (size_t k = 0; k < len && k < 4; k++) b[k] = (uint8_t)(i >> (8 * k));
        q.push(b.data(), len, source);
    }
}

static uint32_t id(const PacketQueue::Packet &p)
{
    return (uint32_t)p.data[0] | (uint32_t)p.data[1] << 8 | (uint32_t)p.data[2] << 16 | (uint32_t)p.data[3] << 24;
}

int main()
{
    {
        PacketQueue q(8, 1 << 20);
        push_n(q, 0, 5, 100, 1);
        push_n(q, 5, 1, 1400, 2);
        PacketQueue::Packet p;
        bool order = true;
        for (uint32_t i = 0; i < 6; i++)
            order = order && q.pop(&p, 0) && id(p) == i && p.dropped == 0 && p.source == (i < 5 ? 1 : 2);
        ok("packets come out in order, with their sizes and sources", order && p.data.size() == 1400);
        ok("an empty queue times out", !q.pop(&p, 10));
    }
    {
        /* 8 slots, 12 pushed: the 4 oldest go, and packet 4 says so. */
        PacketQueue q(8, 1 << 20);
        push_n(q, 0, 12, 100, 1);
        PacketQueue::Packet p;
        ok("a full queue drops its oldest packets and counts them", q.overflows() == 4 && q.high_water() == 8);
        ok("the oldest left carries the drops before it", q.pop(&p, 0) && id(p) == 4 && p.dropped == 4);
        bool rest = true;
        for (uint32_t i = 5; i < 12; i++)
            rest = rest && q.pop(&p, 0) && id(p) == i && p.dropped == 0;
        ok("the rest follow with none", rest);
    }
    {
        /* The byte bound: 3 packets of 400 B fit in 1000 B. */
        PacketQueue q(64, 1000);
        push_n(q, 0, 4, 400, 1);
        PacketQueue::Packet p;
        ok("the byte bound drops the oldest too", q.overflows() == 2 && q.pop(&p, 0) && id(p) == 2 && p.dropped == 2);
        push_n(q, 10, 1, 2000, 1);
        push_n(q, 11, 1, 100, 1);
        ok("a datagram over the byte bound empties the queue and is dropped itself; the next says so",
           q.overflows() == 4 && q.pop(&p, 0) && id(p) == 11 && p.dropped == 2 && !q.pop(&p, 0));
    }
    {
        /* A consumer that stalls 200 ms against 1,100 packets a second of
         * 1,400 B: the queue holds what arrives meanwhile. */
        PacketQueue q(4096, 6 << 20);
        const uint32_t total = 1100;
        std::thread producer([&] {
            for (uint32_t i = 0; i < total; i += 11) {
                push_n(q, i, 11, 1400, 1);
                std::this_thread::sleep_for(std::chrono::milliseconds(1));
            }
        });
        std::this_thread::sleep_for(std::chrono::milliseconds(200));
        PacketQueue::Packet p;
        uint32_t next = 0;
        bool in_order = true;
        while (next < total && q.pop(&p, 1000)) {
            in_order = in_order && id(p) == next && p.dropped == 0;
            next++;
        }
        producer.join();
        ok("a slow consumer loses nothing within the headroom, in order", next == total && in_order && q.overflows() == 0);
    }
    {
        /* Datagrams of 60 KB through a queue of the stream's bounds: the
         * slots keep no buffer that large once the packets are out. */
        PacketQueue q(4096, 6 << 20);
        PacketQueue::Packet p;
        for (int round = 0; round < 50; round++) {
            push_n(q, 0, 100, 60000, 1);
            while (q.pop(&p, 0)) {
            }
        }
        ok("large datagrams leave at most 2 KB a slot behind", q.held_bytes() <= 4096 * PacketQueue::kKeepBytes &&
                                                                    q.held_bytes() < 1000000 && q.overflows() == 0);
        bool popped = true;
        for (int k = 0; k < 2; k++) {
            push_n(q, 0, 1, 1400, 1);
            popped = popped && q.pop(&p, 0);
        }
        ok("stream-sized ones keep their buffers", popped && q.held_bytes() >= 1400);
    }
    {
        /* Three 60 KB datagrams, then one of 150 KB that only fits once all
         * three are dropped: the dropped slots keep nothing large. */
        PacketQueue q(64, 200000);
        push_n(q, 0, 3, 60000, 1);
        push_n(q, 3, 1, 150000, 1);
        PacketQueue::Packet p;
        ok("an overflow of large datagrams frees the dropped slots' buffers",
           q.overflows() == 3 && q.held_bytes() < 150000 + 4 * PacketQueue::kKeepBytes && q.pop(&p, 0) && id(p) == 3 &&
               p.dropped == 3);
    }
    {
        PacketQueue q(8, 1 << 20);
        bool popped = true;
        std::thread waiter([&] {
            PacketQueue::Packet p;
            popped = q.pop(&p, 5000);
        });
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
        q.close();
        waiter.join();
        ok("close wakes a waiting pop, which returns nothing", !popped);
    }
    if (failures) {
        std::printf("%d check(s) failed\n", failures);
        return 1;
    }
    return 0;
}
