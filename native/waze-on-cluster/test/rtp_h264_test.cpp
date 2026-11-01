// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* Host tests for the RTP H.264 depacketiser (no GPU).
 *
 * Synthetic packets cover each payload structure and the loss rules. The
 * golden tests replay real wire bytes, test/data/stream15_start.rtp: 10 RTP
 * packets of AVB stream 15 (the phone's cluster video, captured on the car
 * with Edit 3 self-start), each behind a u32 little-endian length. They are
 * the last 3 fragments of an FU-A from the previous stream, then the new
 * stream's first SPS, PPS, IDR and 4 P slices, all single NAL units. The
 * capture stops there: the next frame draws the route and street names.
 * ffmpeg decodes the depacketised stream as 1920x900 High@4.2. The gap
 * settler (gap_settler.h) runs on the same packets: a new stream or a loss,
 * and which pictures began after the loss. */
#include "../src/gap_settler.h"
#include "../src/nal_reader.h"
#include "../src/rtp_h264.h"

#include <cstdio>
#include <string>
#include <vector>

using namespace woc;

static int failures;

#define CHECK(cond) do { if (!(cond)) { std::printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); failures++; } } while (0)

typedef std::vector<uint8_t> Bytes;

/* What the sink saw: each NAL unit's Annex-B bytes, or an empty entry for an
 * access unit end. */
struct Out {
    std::vector<Bytes> ev;
    RtpH264::Sink sink() { return [this](const uint8_t *d, size_t n, bool eoa) { ev.push_back(eoa ? Bytes() : Bytes(d, d + n)); }; }
};

struct Opt {
    int cc = 0;              /* CSRC count */
    int ext_words = -1;      /* header extension length in 32-bit words; -1 for none */
    int pad = 0;             /* padding bytes, the last one the count */
    int version = 2;
};

static Bytes rtp(uint16_t seq, uint32_t ts, bool marker, const Bytes &payload, const Opt &o = Opt())
{
    Bytes p;
    p.push_back((uint8_t)(o.version << 6 | (o.pad ? 0x20 : 0) | (o.ext_words >= 0 ? 0x10 : 0) | o.cc));
    p.push_back((uint8_t)((marker ? 0x80 : 0) | 96));
    p.push_back((uint8_t)(seq >> 8)); p.push_back((uint8_t)seq);
    for (int s = 24; s >= 0; s -= 8) p.push_back((uint8_t)(ts >> s));
    for (int i = 0; i < 4; i++) p.push_back(0x11);                          /* SSRC */
    for (int i = 0; i < o.cc * 4; i++) p.push_back(0x22);                   /* CSRCs */
    if (o.ext_words >= 0) {
        p.push_back(0xbe); p.push_back(0xde);
        p.push_back((uint8_t)(o.ext_words >> 8)); p.push_back((uint8_t)o.ext_words);
        for (int i = 0; i < o.ext_words * 4; i++) p.push_back(0x33);
    }
    p.insert(p.end(), payload.begin(), payload.end());
    for (int i = 1; i < o.pad; i++) p.push_back(0);
    if (o.pad) p.push_back((uint8_t)o.pad);
    return p;
}

static Bytes annexb(const Bytes &nal)
{
    Bytes b = {0, 0, 0, 1};
    b.insert(b.end(), nal.begin(), nal.end());
    return b;
}

static bool push(RtpH264 &r, Out &o, const Bytes &p) { return r.push(p.data(), p.size(), o.sink()); }

static const Bytes kSps = {0x67, 0x64, 0x00, 0x2a, 0xac};
static const Bytes kPps = {0x68, 0xee, 0x3c, 0xb0};
static const Bytes kIdr = {0x65, 0x88, 0x84, 0x0b};
static const Bytes kP = {0x41, 0x9a, 0x38, 0x15};
static const Bytes kAuEnd;

static void single_nal_units()
{
    RtpH264 r;
    Out o;
    CHECK(push(r, o, rtp(1, 1000, true, kSps)));    /* the phone marks SPS and PPS */
    CHECK(push(r, o, rtp(2, 1000, true, kPps)));
    CHECK(push(r, o, rtp(3, 1000, false, kIdr)));
    CHECK(push(r, o, rtp(4, 2500, false, kP)));
    /* The timestamp change ends the IDR access unit; marked SPS/PPS do not. */
    std::vector<Bytes> want = {annexb(kSps), annexb(kPps), annexb(kIdr), kAuEnd, annexb(kP)};
    CHECK(o.ev == want);
    CHECK(r.stats().packets == 4 && r.stats().nals == 4 && r.stats().aus == 1);
    CHECK(r.stats().gaps == 0 && r.stats().dropped == 0 && r.stats().bad == 0);
}

static void marker_ends_au_on_slice()
{
    RtpH264 r;
    Out o;
    push(r, o, rtp(1, 1000, true, kP));
    std::vector<Bytes> want = {annexb(kP), kAuEnd};
    CHECK(o.ev == want);
    push(r, o, rtp(2, 2500, false, kP));   /* the new timestamp adds no second end */
    want.push_back(annexb(kP));
    CHECK(o.ev == want);
}

static void fu_a_three_parts()
{
    /* An IDR slice 65 a1 a2 b1 b2 c1 split in 3: indicator NRI from the
     * original header (0x60 | 28), FU header S/E bits and type 5. */
    RtpH264 r;
    Out o;
    push(r, o, rtp(10, 1000, false, {0x7c, 0x85, 0xa1, 0xa2}));
    push(r, o, rtp(11, 1000, false, {0x7c, 0x05, 0xb1, 0xb2}));
    CHECK(o.ev.empty());                    /* nothing until the end fragment */
    push(r, o, rtp(12, 1000, false, {0x7c, 0x45, 0xc1}));
    std::vector<Bytes> want = {annexb({0x65, 0xa1, 0xa2, 0xb1, 0xb2, 0xc1})};
    CHECK(o.ev == want);

    /* The reconstructed header takes F|NRI from the indicator: NRI 2, type 1. */
    push(r, o, rtp(13, 2500, false, {0x5c, 0x81, 0xd1}));
    push(r, o, rtp(14, 2500, false, {0x5c, 0x41, 0xd2}));
    want.push_back(kAuEnd);
    want.push_back(annexb({0x41, 0xd1, 0xd2}));
    CHECK(o.ev == want);
    CHECK(r.stats().nals == 2 && r.stats().dropped == 0);
}

static void stap_a_pair()
{
    RtpH264 r;
    Out o;
    Bytes stap = {0x78, 0x00, (uint8_t)kSps.size()};
    stap.insert(stap.end(), kSps.begin(), kSps.end());
    stap.push_back(0x00);
    stap.push_back((uint8_t)kPps.size());
    stap.insert(stap.end(), kPps.begin(), kPps.end());
    CHECK(push(r, o, rtp(1, 1000, false, stap)));
    std::vector<Bytes> want = {annexb(kSps), annexb(kPps)};
    CHECK(o.ev == want);

    /* An entry running past the payload is malformed: the entries before it
     * stand, the packet counts as bad. */
    Out o2;
    RtpH264 r2;
    CHECK(!push(r2, o2, rtp(1, 1000, false, {0x78, 0x00, 0x02, 0x41, 0x9a, 0x00, 0x09, 0x41})));
    CHECK(o2.ev.size() == 1 && o2.ev[0] == annexb({0x41, 0x9a}));
    CHECK(r2.stats().bad == 1);
}

static void gap_mid_fu_decodes_through()
{
    RtpH264 r;
    Out o;
    std::vector<RtpH264::Gap> gaps;
    r.on_gap = [&](const RtpH264::Gap &g) { gaps.push_back(g); };
    push(r, o, rtp(10, 1000, false, {0x7c, 0x81, 0xa1}));
    push(r, o, rtp(11, 1000, false, {0x7c, 0x01, 0xa2}));
    /* seq 12 lost */
    push(r, o, rtp(13, 1000, false, {0x7c, 0x41, 0xa3}));
    CHECK(o.ev.empty());                    /* the torn FU-A is never delivered */
    push(r, o, rtp(14, 2500, false, kP));   /* the next picture is, with no keyframe */
    std::vector<Bytes> want = {annexb(kP)};
    CHECK(o.ev == want);
    /* The partial FU-A and its orphaned end fragment. */
    CHECK(r.stats().gaps == 1 && r.stats().lost == 1 && r.stats().dropped == 2);
    CHECK(gaps.size() == 1 && gaps[0].expected == 12 && gaps[0].got == 13 && gaps[0].lost == 1);
}

static void lost_single_nal()
{
    /* The second of three slices of one picture is lost: the other two
     * still make its access unit. */
    const Bytes s1 = {0x41, 0x9a, 0x01}, s3 = {0x41, 0x9a, 0x03};
    RtpH264 r;
    Out o;
    size_t reported_at = 0;
    r.on_gap = [&](const RtpH264::Gap &) { reported_at = o.ev.size(); };
    push(r, o, rtp(1, 1000, false, s1));
    push(r, o, rtp(3, 1000, false, s3));
    push(r, o, rtp(4, 2500, false, kP));
    std::vector<Bytes> want = {annexb(s1), annexb(s3), kAuEnd, annexb(kP)};
    CHECK(o.ev == want);
    CHECK(r.stats().gaps == 1 && r.stats().lost == 1 && r.stats().dropped == 0);
    CHECK(reported_at == 1);   /* before the slice that follows the gap */
}

static void gap_at_au_boundary()
{
    /* The packet that starts the second picture is lost, and with it the
     * first fragment of the third picture's FU-A. */
    const Bytes tail = {0x41, 0x9a, 0x02};
    RtpH264 r;
    Out o;
    push(r, o, rtp(1, 1000, false, kP));
    push(r, o, rtp(3, 2500, false, tail));                 /* seq 2 lost */
    push(r, o, rtp(5, 4000, false, {0x5c, 0x41, 0xa2}));   /* seq 4, the FU-A start, lost */
    push(r, o, rtp(6, 5500, false, kP));
    std::vector<Bytes> want = {annexb(kP), kAuEnd, annexb(tail), kAuEnd, annexb(kP)};
    CHECK(o.ev == want);
    CHECK(r.stats().gaps == 2 && r.stats().lost == 2 && r.stats().dropped == 1 && r.stats().aus == 2);
}

static void timestamp_change_drops_open_fu()
{
    RtpH264 r;
    Out o;
    push(r, o, rtp(1, 1000, false, {0x7c, 0x85, 0xa1}));
    push(r, o, rtp(2, 2500, false, kP));    /* no end fragment, new picture */
    std::vector<Bytes> want = {annexb(kP)};
    CHECK(o.ev == want);
    CHECK(r.stats().dropped == 1);
}

static void join_mid_fu()
{
    /* A start mid-stream: fragments before the first start fragment are
     * dropped. */
    RtpH264 r;
    Out o;
    push(r, o, rtp(100, 1000, false, {0x5c, 0x01, 0xa1}));
    push(r, o, rtp(101, 1000, false, {0x5c, 0x41, 0xa2}));
    push(r, o, rtp(102, 2500, false, kP));
    std::vector<Bytes> want = {annexb(kP)};
    CHECK(o.ev == want);
    CHECK(r.stats().dropped == 2 && r.stats().gaps == 0);
}

static void header_fields()
{
    /* CSRCs, a header extension and padding are all skipped. */
    RtpH264 r;
    Out o;
    Opt opt;
    opt.cc = 2;
    opt.ext_words = 1;
    opt.pad = 3;
    CHECK(push(r, o, rtp(1, 1000, false, kP, opt)));
    std::vector<Bytes> want = {annexb(kP)};
    CHECK(o.ev == want);

    Opt v1;
    v1.version = 1;
    CHECK(!push(r, o, rtp(2, 1000, false, kP, v1)));
    Bytes short_pkt = {0x80, 0x60, 0x00, 0x03};
    CHECK(!push(r, o, short_pkt));
    Bytes overpad = rtp(4, 1000, false, kP);
    overpad[0] |= 0x20;
    overpad.back() = 200;                   /* more padding than the packet holds */
    CHECK(!push(r, o, overpad));
    Bytes longext = rtp(5, 1000, false, kP);
    longext[0] |= 0x10;                     /* the payload read as an extension header: 0x3815 words */
    CHECK(!push(r, o, longext));
    CHECK(!push(r, o, rtp(6, 1000, false, {})));
    CHECK(o.ev == want);
    CHECK(r.stats().bad == 5);
}

static void unsupported_types_dropped()
{
    RtpH264 r;
    Out o;
    push(r, o, rtp(1, 1000, false, {0x19, 0x00}));   /* STAP-B */
    push(r, o, rtp(2, 1000, false, {0x1d, 0x81}));   /* FU-B */
    CHECK(o.ev.empty() && r.stats().dropped == 2 && r.stats().bad == 0);
}

static bool read_fixture(const char *path, std::vector<Bytes> *pkts)
{
    FILE *f = std::fopen(path, "rb");
    if (!f) return false;
    uint8_t len[4];
    bool ok = true;
    while (std::fread(len, 1, 4, f) == 4) {
        size_t n = (size_t)len[0] | (size_t)len[1] << 8 | (size_t)len[2] << 16 | (size_t)len[3] << 24;
        Bytes p(n);
        if (std::fread(p.data(), 1, n, f) != n) { ok = false; break; }
        pkts->push_back(p);
    }
    std::fclose(f);
    return ok;
}

static void golden_stream15(const char *path)
{
    std::vector<Bytes> pkts;
    CHECK(read_fixture(path, &pkts));
    CHECK(pkts.size() == 10);
    if (pkts.size() != 10) return;

    RtpH264 r;
    Out o;
    for (const Bytes &p : pkts) CHECK(push(r, o, p));

    /* The old stream's FU-A tail is dropped; the new stream starts at a
     * sequence jump, with its SPS. */
    std::vector<int> types;
    for (const Bytes &e : o.ev) types.push_back(e.empty() ? -1 : e[4] & 0x1f);
    std::vector<int> want_types = {7, 8, 5, -1, 1, -1, 1, -1, 1, -1, 1};
    CHECK(types == want_types);
    CHECK(r.stats().packets == 10 && r.stats().gaps == 1 && r.stats().dropped == 3 && r.stats().bad == 0);
    /* Each NAL unit is its packet's payload behind a start code. */
    size_t k = 3;
    for (const Bytes &e : o.ev) {
        if (e.empty()) continue;
        if (k >= pkts.size()) { CHECK(k < pkts.size()); break; }
        Bytes nal(pkts[k].begin() + 12, pkts[k].end());
        CHECK(e == annexb(nal));
        k++;
    }
    /* SPS: High profile (100), level 4.2. */
    CHECK(!o.ev.empty() && o.ev[0].size() > 7 && o.ev[0][5] == 100 && o.ev[0][7] == 42);

    /* Into the decoder's framing: each access unit end delivers one picture,
     * the first carrying the SPS and the IDR. */
    NalReader nr;
    std::vector<AccessUnit> aus;
    std::vector<Bytes> au_bytes;
    auto sink = [&](const AccessUnit &au) { aus.push_back(au); au_bytes.emplace_back(au.data, au.data + au.size); };
    for (const Bytes &e : o.ev) nr.push(e.data(), e.size(), e.empty(), sink);
    CHECK(aus.size() == 4);
    nr.flush(sink);
    CHECK(aus.size() == 5);
    if (aus.size() == 5 && o.ev.size() >= 3) {
        CHECK(aus[0].sps && aus[0].idr);
        for (size_t i = 1; i < 5; i++) CHECK(!aus[i].sps && !aus[i].idr && !aus[i].b);
        CHECK(au_bytes[0].size() == o.ev[0].size() + o.ev[1].size() + o.ev[2].size());
    }
}

/* The capture with packets taken out: each loss costs only the NAL units it
 * carried, and the decoder's framing still gets every other picture. */
static void golden_with_gaps(const char *path)
{
    std::vector<Bytes> pkts;
    CHECK(read_fixture(path, &pkts));
    if (pkts.size() != 10) return;

    /* The first P slice (packet 6) lost: the IDR's picture ends at the next
     * timestamp and the three other P pictures follow. */
    RtpH264 r;
    Out o;
    for (size_t k = 0; k < pkts.size(); k++)
        if (k != 6) push(r, o, pkts[k]);
    std::vector<int> types;
    for (const Bytes &e : o.ev) types.push_back(e.empty() ? -1 : e[4] & 0x1f);
    std::vector<int> want_types = {7, 8, 5, -1, 1, -1, 1, -1, 1};
    CHECK(types == want_types);
    CHECK(r.stats().gaps == 2);
    NalReader nr;
    int aus = 0, idr = 0;
    auto sink = [&](const AccessUnit &au) { aus++; idr += au.idr; };
    for (const Bytes &e : o.ev) nr.push(e.data(), e.size(), e.empty(), sink);
    nr.flush(sink);
    CHECK(aus == 4 && idr == 1);

    /* The IDR's packet lost: the stream goes on with its P pictures. */
    RtpH264 r2;
    Out o2;
    for (size_t k = 0; k < pkts.size(); k++)
        if (k != 5) push(r2, o2, pkts[k]);
    types.clear();
    for (const Bytes &e : o2.ev) types.push_back(e.empty() ? -1 : e[4] & 0x1f);
    want_types = {7, 8, -1, 1, -1, 1, -1, 1, -1, 1};
    CHECK(types == want_types);
}

/* The depacketiser into the settler, as the producer wires them: each
 * settled gap's outcome, and for each picture end whether it began after
 * the latest loss. */
struct Settled {
    std::vector<int> outcomes;
    std::vector<bool> after;
};

static Settled settle(const std::vector<Bytes> &pkts)
{
    RtpH264 r;
    GapSettler gs;
    Settled out;
    r.on_gap = [&](const RtpH264::Gap &g) { gs.gap(g, 1, 0); };
    const RtpH264::Sink sink = [&](const uint8_t *d, size_t n, bool eoa) {
        if (eoa) {
            out.after.push_back(gs.after_loss());
            gs.au_end();
            return;
        }
        (void)n;
        const GapSettler::Outcome o = gs.nal(d[4] & 0x1f);
        if (o != GapSettler::None) out.outcomes.push_back(o);
    };
    for (const Bytes &p : pkts) r.push(p.data(), p.size(), sink);
    return out;
}

static void gaps_settled(const char *path)
{
    std::vector<Bytes> pkts;
    CHECK(read_fixture(path, &pkts));
    if (pkts.size() != 10) return;

    /* The capture: the jump to the new stream's SPS is a new stream. */
    Settled a = settle(pkts);
    CHECK(a.outcomes == std::vector<int>{GapSettler::NewStream});
    CHECK(a.after == std::vector<bool>(4, true));

    /* The first P slice lost: a loss; the IDR's picture, ended by the
     * packet after the gap, is not after it; the next ones are. */
    std::vector<Bytes> cut;
    for (size_t k = 0; k < pkts.size(); k++)
        if (k != 6) cut.push_back(pkts[k]);
    Settled b = settle(cut);
    CHECK((b.outcomes == std::vector<int>{GapSettler::NewStream, GapSettler::Loss}));
    CHECK((b.after == std::vector<bool>{false, true, true}));

    /* A slice lost inside a picture: that picture is not after the loss,
     * though the loss settles at its next slice. */
    const Bytes s1 = {0x41, 0x9a, 0x01}, s3 = {0x41, 0x9a, 0x03};
    Settled c = settle({rtp(1, 1000, false, s1), rtp(3, 1000, false, s3), rtp(4, 2500, false, kP),
                        rtp(5, 4000, false, kP)});
    CHECK(c.outcomes == std::vector<int>{GapSettler::Loss});
    CHECK((c.after == std::vector<bool>{false, true}));
}

int main(int argc, char **argv)
{
    single_nal_units();
    marker_ends_au_on_slice();
    fu_a_three_parts();
    stap_a_pair();
    gap_mid_fu_decodes_through();
    lost_single_nal();
    gap_at_au_boundary();
    timestamp_change_drops_open_fu();
    join_mid_fu();
    header_fields();
    unsupported_types_dropped();
    golden_stream15(argc > 1 ? argv[1] : "test/data/stream15_start.rtp");
    golden_with_gaps(argc > 1 ? argv[1] : "test/data/stream15_start.rtp");
    gaps_settled(argc > 1 ? argv[1] : "test/data/stream15_start.rtp");
    if (failures) {
        std::printf("%d check(s) failed\n", failures);
        return 1;
    }
    std::printf("rtp_h264_test: all checks passed\n");
    return 0;
}
