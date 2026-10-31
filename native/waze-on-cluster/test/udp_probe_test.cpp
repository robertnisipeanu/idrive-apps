// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* Host test for UdpSource and FramingProbe: datagrams sent to the bound port
 * reach the sink with boundaries preserved, and the probe classifies the
 * leading bytes (Annex-B / RTP / AVTP) and keeps the sizes. */
#include <arpa/inet.h>
#include <cassert>
#include <cstdio>
#include <cstring>
#include <netinet/in.h>
#include <string>
#include <sys/socket.h>
#include <unistd.h>
#include <vector>

#include "../src/framing_probe.h"
#include "../src/udp_source.h"

using namespace woc;

static int failures;
static void ok(const char *name, bool cond)
{
    std::printf("%-4s %s\n", cond ? "ok" : "FAIL", name);
    if (!cond) failures++;
}

static void send_udp(uint16_t port, const std::vector<uint8_t> &p)
{
    int fd = socket(AF_INET, SOCK_DGRAM, 0);
    struct sockaddr_in a;
    std::memset(&a, 0, sizeof a);
    a.sin_family = AF_INET;
    a.sin_port = htons(port);
    a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    ssize_t n = sendto(fd, p.data(), p.size(), 0, (struct sockaddr *)&a, sizeof a);
    (void)n;
    close(fd);
}

int main()
{
    /* --- FramingProbe classification --- */
    {
        FramingProbe p;
        std::vector<uint8_t> annexb = {0, 0, 0, 1, 0x67, 0x42};
        p.record(annexb.data(), annexb.size());
        ok("probe: Annex-B start code recognised", p.summary().find("Annex-B") != std::string::npos);
    }
    {
        FramingProbe p;
        std::vector<uint8_t> rtp = {0x80, 0x60, 0x12, 0x34, 0, 0, 0, 0};   /* v2, PT 96 */
        p.record(rtp.data(), rtp.size());
        ok("probe: RTP v2 recognised, PT reported", p.summary().find("RTP") != std::string::npos &&
           p.summary().find("96") != std::string::npos);
    }
    {
        FramingProbe p;
        std::vector<uint8_t> avtp = {0x03, 0x81, 0x00, 0x00};   /* CVF subtype */
        p.record(avtp.data(), avtp.size());
        ok("probe: AVTP CVF subtype recognised", p.summary().find("AVTP") != std::string::npos);
    }
    {
        FramingProbe p;
        std::vector<uint8_t> big(1400, 0xab);
        for (int i = 0; i < 5; i++) p.record(big.data(), big.size());
        std::vector<uint8_t> small(40, 0xcd);
        p.record(small.data(), small.size());
        std::string r = p.report();
        ok("probe: report has totals and sizes", r.find("packets=6") != std::string::npos &&
           r.find("min_len=40") != std::string::npos && r.find("max_len=1400") != std::string::npos);
    }

    /* --- NAL cadence (the self-start keyframe question) --- */
    {
        /* One access unit: AUD(9), SPS(7), PPS(8), IDR(5). Both start-code
         * lengths, to exercise the scanner. */
        FramingProbe p;
        std::vector<uint8_t> au = {0, 0, 0, 1, 0x09, 0x10,
                                   0, 0, 0, 1, 0x67, 0x42, 0x00,
                                   0, 0, 1, 0x68, 0xce,
                                   0, 0, 0, 1, 0x65, 0x88, 0x84};
        p.record(au.data(), au.size());
        std::string r = p.report();
        ok("cadence: one SPS, one PPS, one IDR, one AUD counted",
           r.find("SPS=1 PPS=1 IDR=1") != std::string::npos && r.find("AUD=1") != std::string::npos);
        ok("cadence: single SPS/IDR flagged as late-join RISK", r.find("late-join: RISK") != std::string::npos);
    }
    {
        /* A start code split across two datagrams: 00 00 00 ends one packet, 01
         * 65(IDR) begins the next. The streaming scanner must still count it. */
        FramingProbe p;
        std::vector<uint8_t> a = {0x00, 0x00, 0x00};
        std::vector<uint8_t> b = {0x01, 0x65, 0x88};
        p.record(a.data(), a.size());
        p.record(b.data(), b.size());
        ok("cadence: start code split across packets still counted", p.summary().find("IDR=1") != std::string::npos);
    }
    {
        /* Recurring SPS+IDR (a real streaming GOP, one every 2 s at 10 fps):
         * late-join is OK. */
        FramingProbe p;
        std::vector<uint8_t> idr = {0, 0, 0, 1, 0x67, 0x42, 0, 0, 0, 1, 0x68, 0xce, 0, 0, 0, 1, 0x65, 0x88};
        std::vector<uint8_t> inter = {0, 0, 0, 1, 0x41, 0x9a};   /* non-IDR slice (type 1) */
        for (int t = 0; t <= 9000; t += 100) {
            const std::vector<uint8_t> &f = t % 2000 == 0 ? idr : inter;
            p.record(f.data(), f.size(), t);
        }
        std::string r = p.report();
        ok("cadence: recurring SPS+IDR flagged late-join OK", r.find("late-join: OK") != std::string::npos);
        ok("cadence: non-IDR slices counted", r.find("non-IDR=86") != std::string::npos);
    }
    {
        /* Only the opening keyframes: the session's first SPS+IDR (two IDR
         * slices) and the keyframe requestStream forces 300 ms later, then only
         * non-IDR slices for 10 s. Counts alone (SPS=2, IDR=3) would look
         * recurring; a decoder started at Show never gets a keyframe. */
        FramingProbe p;
        std::vector<uint8_t> idr2 = {0, 0, 0, 1, 0x67, 0x42, 0, 0, 0, 1, 0x68, 0xce,
                                     0, 0, 0, 1, 0x65, 0x88, 0, 0, 0, 1, 0x65, 0x99};
        std::vector<uint8_t> idr = {0, 0, 0, 1, 0x67, 0x42, 0, 0, 0, 1, 0x68, 0xce, 0, 0, 0, 1, 0x65, 0x88};
        std::vector<uint8_t> inter = {0, 0, 0, 1, 0x41, 0x9a};
        p.record(idr2.data(), idr2.size(), 0);
        p.record(idr.data(), idr.size(), 300);
        for (int t = 333; t <= 10000; t += 33) p.record(inter.data(), inter.size(), t);
        std::string r = p.report();
        ok("cadence: opening keyframes only counted", r.find("SPS=2") != std::string::npos && r.find("IDR=3") != std::string::npos);
        ok("cadence: opening keyframes only flagged late-join RISK", r.find("late-join: RISK") != std::string::npos);
    }
    {
        /* IDRs recur every 2 s for the first 4 s, then stop for 26 s: the
         * cadence seen at the start no longer holds, so late-join is RISK. */
        FramingProbe p;
        std::vector<uint8_t> idr = {0, 0, 0, 1, 0x67, 0x42, 0, 0, 0, 1, 0x68, 0xce, 0, 0, 0, 1, 0x65, 0x88};
        std::vector<uint8_t> inter = {0, 0, 0, 1, 0x41, 0x9a};
        for (int t = 0; t <= 30000; t += 100) {
            const std::vector<uint8_t> &f = (t % 2000 == 0 && t <= 4000) ? idr : inter;
            p.record(f.data(), f.size(), t);
        }
        ok("cadence: IDRs that stopped recurring flagged late-join RISK", p.report().find("late-join: RISK") != std::string::npos);
    }
    {
        /* RTP payload (no Annex-B start codes): cadence reports none. */
        FramingProbe p;
        std::vector<uint8_t> rtp = {0x80, 0x60, 0x12, 0x34, 1, 2, 3, 4, 5, 6};
        p.record(rtp.data(), rtp.size());
        ok("cadence: non-Annex-B reports no NAL units", p.report().find("no NAL units") != std::string::npos);
    }
    {
        /* RTP datagrams: record_rtp skips the start-code scan (this header's
         * timestamp bytes 00 00 01 65 would read as an IDR), and the
         * depacketised NAL units feed the cadence. The on-car stream's
         * shape: SPS+PPS+IDR at 0 and again at 300 ms (the forced keyframe),
         * then only non-IDR slices. */
        FramingProbe p;
        std::vector<uint8_t> rtp = {0x80, 0x60, 0x12, 0x34, 0x00, 0x00, 0x01, 0x65, 0, 0, 0, 0, 0x41, 0x9a};
        p.record_rtp(rtp.data(), rtp.size(), 0);
        ok("cadence: RTP header bytes not scanned for start codes", p.report().find("no NAL units") != std::string::npos);
        for (int t : {0, 300}) { p.nal(7, t); p.nal(8, t); p.nal(5, t); }
        for (int t = 316; t <= 60000; t += 50) { p.record_rtp(rtp.data(), rtp.size(), t); p.nal(1, t); }
        std::string r = p.report();
        ok("cadence: depacketised NAL units counted", r.find("SPS=2 PPS=2 IDR=2") != std::string::npos);
        ok("cadence: keyframes only at stream start flagged late-join RISK", r.find("late-join: RISK") != std::string::npos);
        ok("cadence: summary carries the RTP guess and counts", p.summary().find("RTP") != std::string::npos &&
           p.summary().find("SPS=2 IDR=2") != std::string::npos);
    }

    /* --- UdpSource receive --- */
    {
        const uint16_t port = 20571;
        FramingProbe probe;
        std::vector<std::vector<uint8_t>> got;
        UdpSource src;
        std::string err;
        auto sink = [&](const uint8_t *d, size_t n) { probe.record(d, n); got.emplace_back(d, d + n); };
        bool started = src.start(port, sink, &err);
        ok("udp: bind and start", started);
        if (started) {
            send_udp(port, {0, 0, 0, 1, 0x67});
            send_udp(port, std::vector<uint8_t>(1200, 0x5a));
            for (int i = 0; i < 100 && src.packets() < 2; i++) usleep(10 * 1000);
            src.stop();
            ok("udp: both datagrams received", src.packets() == 2);
            ok("udp: boundaries preserved", got.size() == 2 && got[0].size() == 5 && got[1].size() == 1200);
            ok("udp: byte count", src.bytes() == 1205);
            ok("udp: probe saw the stream", probe.summary().find("Annex-B") != std::string::npos);
        }
    }

    std::printf(failures ? "\n%d check(s) failed\n" : "\nall checks passed\n", failures);
    return failures ? 1 : 0;
}
