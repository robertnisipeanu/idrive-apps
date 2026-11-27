// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
#include "atlas_scale.h"

#include <fcntl.h>
#include <unistd.h>
#ifdef __linux__
#include <sys/eventfd.h>
#include <sys/resource.h>
#include <sys/syscall.h>
#endif

#include "yuv_atlas.h"

namespace woc {

namespace {
const uint32_t kOne = 1u << 12;   /* the weights of one output pixel sum to this */
}

/* Output pixel i covers source [i*src/dst, (i+1)*src/dst); each source pixel
 * it touches weighs the length of the overlap, in units of 1/dst of a pixel,
 * normalised so the weights sum to exactly kOne. */
void AtlasScaler::Axis::build(uint32_t src, uint32_t dst)
{
    first.assign(dst, 0);
    count.assign(dst, 0);
    offset.assign(dst, 0);
    weight.clear();
    for (uint32_t i = 0; i < dst; i++) {
        const uint64_t a = (uint64_t)i * src, b = (uint64_t)(i + 1) * src;   /* in 1/dst units */
        const uint32_t s0 = (uint32_t)(a / dst), s1 = (uint32_t)((b + dst - 1) / dst);
        first[i] = s0;
        count[i] = s1 - s0;
        offset[i] = (uint32_t)weight.size();
        uint32_t sum = 0;
        for (uint32_t s = s0; s < s1; s++) {
            const uint64_t lo = (uint64_t)s * dst > a ? (uint64_t)s * dst : a;
            const uint64_t hi = (uint64_t)(s + 1) * dst < b ? (uint64_t)(s + 1) * dst : b;
            const uint32_t wgt = (uint32_t)(((hi - lo) * kOne + src / 2) / src);
            weight.push_back((uint16_t)wgt);
            sum += wgt;
        }
        /* the rounding error goes to the largest weight, so the sum is exact */
        uint32_t big = offset[i];
        for (uint32_t k = offset[i]; k < offset[i] + count[i]; k++)
            if (weight[k] > weight[big])
                big = k;
        weight[big] = (uint16_t)(weight[big] + (int32_t)kOne - (int32_t)sum);
    }
}

bool AtlasScaler::configure(uint32_t w, uint32_t h, uint32_t dw, uint32_t dh, unsigned level_bits, uint32_t crop_x,
                            uint32_t crop_y, uint32_t crop_w, uint32_t crop_h)
{
    if (!crop_w) {
        crop_x = crop_y = 0;
        crop_w = w;
        crop_h = h;
    }
    if (!w || !h || !dw || !dh || w % 2 || h % 2 || dw % 2 || dh % 2 || !crop_h || (crop_x | crop_y | crop_w | crop_h) % 2 ||
        (uint64_t)crop_x + crop_w > w || (uint64_t)crop_y + crop_h > h || dw > crop_w || dh > crop_h || level_bits > 3) {
        dw_ = dh_ = 0;
        return false;
    }
    if (w == w_ && h == h_ && dw == dw_ && dh == dh_ && level_bits == bits_ && crop_x == crop_x_ && crop_y == crop_y_ &&
        crop_w == crop_w_ && crop_h == crop_h_)
        return true;
    w_ = w;
    h_ = h;
    dw_ = dw;
    dh_ = dh;
    crop_x_ = crop_x;
    crop_y_ = crop_y;
    crop_w_ = crop_w;
    crop_h_ = crop_h;
    bits_ = level_bits;
    yx_.build(crop_w, dw);
    yy_.build(crop_h, dh);
    cx_.build(crop_w / 2, dw / 2);
    cy_.build(crop_h / 2, dh / 2);
    return true;
}

/* Horizontal into a power-of-two ring buffer of 16-bit rows (scaled 256: the
 * kOne-weighted sum over 16), then vertical row by row into 32-bit sums
 * (scaled 2^20), keeping the horizontal strip resident in L1 cache. */
void AtlasScaler::plane(const uint8_t *src, uint32_t sp, uint32_t sh, uint8_t *dst, uint32_t dp, const Axis &x,
                        const Axis &y)
{
    const uint32_t dw = (uint32_t)x.first.size(), dh = (uint32_t)y.first.size();
    uint32_t max_k = 1;
    for (uint32_t j = 0; j < dh; j++)
        if (y.count[j] > max_k)
            max_k = y.count[j];
    uint32_t ring_h = 1;
    while (ring_h < max_k)
        ring_h <<= 1;
    const uint32_t mask = ring_h - 1;
    rows_.resize((size_t)ring_h * dw);
    acc_.resize(dw);

    uint32_t built = 0;
    for (uint32_t j = 0; j < dh; j++) {
        const uint32_t need = y.first[j] + y.count[j];
        const uint32_t limit = need < sh ? need : sh;
        while (built < limit) {
            const uint8_t *s = src + (size_t)built * sp;
            uint16_t *o = &rows_[(size_t)(built & mask) * dw];
            for (uint32_t i = 0; i < dw; i++) {
                const uint8_t *p = s + x.first[i];
                const uint16_t *wt = &x.weight[x.offset[i]];
                uint32_t a = 0;
                for (uint32_t k = 0; k < x.count[i]; k++)
                    a += (uint32_t)p[k] * wt[k];
                o[i] = (uint16_t)((a + 8) >> 4);
            }
            built++;
        }
        uint32_t *a = acc_.data();
        for (uint32_t i = 0; i < dw; i++)
            a[i] = 1u << 19;   /* rounds the shift below */
        const uint16_t *wt = &y.weight[y.offset[j]];
        for (uint32_t k = 0; k < y.count[j]; k++) {
            const uint16_t *row = &rows_[(size_t)((y.first[j] + k) & mask) * dw];
            const uint32_t w = wt[k];
            for (uint32_t i = 0; i < dw; i++)
                a[i] += (uint32_t)row[i] * w;
        }
        uint8_t *o = dst + (size_t)j * dp;
        for (uint32_t i = 0; i < dw; i++) {
            const uint32_t v = a[i] >> 20;
            o[i] = (uint8_t)(v > 255 ? 255 : v);
        }
    }
}

void AtlasScaler::scale(const uint8_t *src, std::vector<uint8_t> *dst)
{
    dst->resize(dst_bytes());
    uint8_t *d = dst->data();
    /* Y, from the crop's top-left */
    plane(src + (size_t)crop_y_ * w_ + crop_x_, w_, crop_h_, d, dw_, yx_, yy_);
    /* U and V, side by side under Y */
    const uint8_t *su = src + (size_t)w_ * h_ + (size_t)(crop_y_ / 2) * w_ + crop_x_ / 2, *sv = su + w_ / 2;
    uint8_t *du = d + (size_t)dw_ * dh_, *dv = du + dw_ / 2;
    plane(su, w_, crop_h_ / 2, du, dw_, cx_, cy_);
    plane(sv, w_, crop_h_ / 2, dv, dw_, cx_, cy_);
    uint8_t rlut[256];
    const uint8_t *round_lut = nullptr;
    if (bits_ && black_bg_) {
        for (int v = 0; v < 256; v++)
            rlut[v] = (uint8_t)v;
        crk::round_levels(rlut, rlut, 256, bits_);
        round_lut = rlut;
    }
    const bool rounded = black_bg_ && key_background(d, round_lut);
    if (radius_) {
        const uint32_t cr = radius_ / 2;
        const uint8_t *clut = rounded ? round_lut : nullptr;
        corners(d, dw_, dw_, dh_, radius_, ycov_, 16, clut);
        if (cr) {
            corners(du, dw_, dw_ / 2, dh_ / 2, cr, ccov_, 128, clut);
            corners(dv, dw_, dw_ / 2, dh_ / 2, cr, ccov_, 128, clut);
        }
    }
    if (bits_ && !rounded)
        crk::round_levels(d, d, dst->size(), bits_);
}

/* The background is the most common Y (a night map's field covers most of
 * the frame), followed at a quarter of each frame's change so a frame with
 * a big label does not flicker it. Y up to kKeyLo above it goes black, the
 * next kKeyRamp fade in, the rest stays; U and V of each 2 x 2 block fade
 * by the most visible of its four Y. A background lighter than kKeyMaxBg
 * (a day map) is left alone.
 *
 * Green is never keyed: parks (Waze's and Google Maps' night greens are about
 * as dark as the grey-blue field) stay, and green pixels don't count towards
 * the background, so a park filling the frame can't become it. Green in
 * YUV: V well below neutral and U not above it - the field's blue has U
 * above. */
static inline bool is_green(int u, int v)
{
    return v - 128 <= -6 && u - 128 <= 2;
}
bool AtlasScaler::key_background(uint8_t *d, const uint8_t *rlut)
{
    static const int kKeyLo = 8, kKeyRamp = 28, kKeyMaxBg = 150;   /* Waze's night field is grey-blue, a day map's near white */
    const size_t n = (size_t)dw_ * dh_;
    const uint32_t half_w = dw_ >> 1;
    const uint8_t *cu = d + n;
    uint32_t hist[256] = {0};
    for (uint32_t y = 0; y < dh_; y++) {
        const uint8_t *yp = d + (size_t)y * dw_;
        const uint8_t *up = cu + (size_t)(y >> 1) * dw_;
        const uint8_t *vp = up + half_w;
        for (uint32_t x = 0; x < dw_; x += 3) {
            const uint32_t cx = x >> 1;
            if (!is_green(up[cx], vp[cx]))
                hist[yp[x]]++;
        }
    }
    int mode = 0;
    for (int v = 1; v < 256; v++)
        if (hist[v] > hist[mode])
            mode = v;
    bg_ = bg_ < 0 ? mode * 16 : bg_ + (mode * 16 - bg_) / 4;
    const int bg = bg_ / 16;
    if (bg > kKeyMaxBg)
        return false;
    uint16_t k[256];
    uint8_t y_lut[256];
    for (int v = 0; v < 256; v++) {
        const int over = v - bg - kKeyLo;
        const uint16_t kv = (uint16_t)(over <= 0 ? 0 : over >= kKeyRamp ? 256 : over * 256 / kKeyRamp);
        k[v] = kv;
        const uint8_t yv = (uint8_t)(16 + ((v - 16) * (int)kv) / 256);
        y_lut[v] = rlut ? rlut[yv] : yv;
    }
    uint8_t *u = d + n, *v = u + half_w;
    for (uint32_t y = 0; y < dh_; y += 2) {
        uint8_t *p0 = d + (size_t)y * dw_;
        uint8_t *p1 = p0 + dw_;
        uint8_t *ur = u + (size_t)(y >> 1) * dw_;
        uint8_t *vr = v + (size_t)(y >> 1) * dw_;
        for (uint32_t x = 0, cx = 0; x < dw_; x += 2, cx++) {
            const uint8_t uc = ur[cx], vc = vr[cx];
            if (is_green(uc, vc)) {
                if (rlut) {
                    p0[x] = rlut[p0[x]];
                    p0[x + 1] = rlut[p0[x + 1]];
                    p1[x] = rlut[p1[x]];
                    p1[x + 1] = rlut[p1[x + 1]];
                    ur[cx] = rlut[uc];
                    vr[cx] = rlut[vc];
                }
                continue;
            }
            const uint8_t y0 = p0[x], y1 = p0[x + 1], y2 = p1[x], y3 = p1[x + 1];
            const uint32_t k0 = k[y0], k1 = k[y1], k2 = k[y2], k3 = k[y3];
            p0[x] = y_lut[y0];
            p0[x + 1] = y_lut[y1];
            p1[x] = y_lut[y2];
            p1[x + 1] = y_lut[y3];
            uint32_t kc = k0 > k1 ? k0 : k1;
            kc = kc > k2 ? kc : k2;
            kc = kc > k3 ? kc : k3;
            if (kc >= 256) {
                if (rlut) {
                    ur[cx] = rlut[uc];
                    vr[cx] = rlut[vc];
                }
                continue;
            }
            const uint8_t nu = (uint8_t)(128 + ((int)uc - 128) * (int)kc / 256);
            const uint8_t nv = (uint8_t)(128 + ((int)vc - 128) * (int)kc / 256);
            ur[cx] = rlut ? rlut[nu] : nu;
            vr[cx] = rlut ? rlut[nv] : nv;
        }
    }
    return rlut != nullptr;
}

/* Each pixel of the r x r top-left corner square: how much of it (0-256) lies
 * inside the circle of radius r centred at (r, r), from 4 x 4 samples. */
void AtlasScaler::coverage(uint32_t r, std::vector<uint16_t> *cov)
{
    cov->assign((size_t)r * r, 256);
    const double rr = (double)r * r;
    for (uint32_t y = 0; y < r; y++)
        for (uint32_t x = 0; x < r; x++) {
            int in = 0;
            for (int sy = 0; sy < 4; sy++)
                for (int sx = 0; sx < 4; sx++) {
                    const double dx = r - (x + (sx + 0.5) / 4), dy = r - (y + (sy + 0.5) / 4);
                    in += dx * dx + dy * dy <= rr;
                }
            (*cov)[(size_t)y * r + x] = (uint16_t)(in * 16);
        }
}

void AtlasScaler::set_corner_radius(uint32_t r)
{
    if (dw_ && (r * 2 > dw_ || r * 2 > dh_))
        r = (dw_ < dh_ ? dw_ : dh_) / 2;
    if (r == radius_)
        return;
    radius_ = r;
    ycov_.clear();
    ccov_.clear();
    if (r) {
        coverage(r, &ycov_);
        if (r / 2)
            coverage(r / 2, &ccov_);
    }
}

void AtlasScaler::corners(uint8_t *p, uint32_t dp, uint32_t pw, uint32_t ph, uint32_t r, const std::vector<uint16_t> &cov,
                          uint8_t black, const uint8_t *rlut)
{
    if (r * 2 > pw || r * 2 > ph)
        return;
    for (uint32_t y = 0; y < r; y++)
        for (uint32_t x = 0; x < r; x++) {
            const uint32_t c = cov[(size_t)y * r + x];
            if (c >= 256)
                continue;
            /* the same coverage, mirrored into each corner */
            const uint32_t xs[2] = {x, pw - 1 - x}, ys[2] = {y, ph - 1 - y};
            for (uint32_t yi = 0; yi < 2; yi++)
                for (uint32_t xi = 0; xi < 2; xi++) {
                    uint8_t &v = p[(size_t)ys[yi] * dp + xs[xi]];
                    const uint8_t nv = (uint8_t)(black + (((int)v - black) * (int)c) / 256);
                    v = rlut ? rlut[nv] : nv;
                }
        }
}

ScaleWorker::ScaleWorker()
{
#ifdef __linux__
    done_fd_ = eventfd(0, EFD_NONBLOCK | EFD_CLOEXEC);
#else
    int p[2];
    if (pipe(p) == 0) {
        fcntl(p[0], F_SETFL, O_NONBLOCK);
        fcntl(p[1], F_SETFL, O_NONBLOCK);
        fcntl(p[0], F_SETFD, FD_CLOEXEC);
        fcntl(p[1], F_SETFD, FD_CLOEXEC);
        done_fd_ = p[0];
        done_wr_ = p[1];
    }
#endif
}

ScaleWorker::~ScaleWorker()
{
    if (thread_.joinable()) {
        {
            std::lock_guard<std::mutex> l(mu_);
            stop_ = true;
        }
        cv_.notify_one();
        thread_.join();
    }
    if (done_fd_ >= 0)
        close(done_fd_);
    if (done_wr_ >= 0)
        close(done_wr_);
}

void ScaleWorker::signal_done()
{
#ifdef __linux__
    if (done_fd_ >= 0) {
        const uint64_t one = 1;
        const ssize_t w = write(done_fd_, &one, sizeof one);
        (void)w;
    }
#else
    if (done_wr_ >= 0) {
        const char b = 1;
        const ssize_t w = write(done_wr_, &b, 1);
        (void)w;
    }
#endif
}

void ScaleWorker::drain_done()
{
    if (done_fd_ < 0)
        return;
#ifdef __linux__
    uint64_t v = 0;
    const ssize_t r = read(done_fd_, &v, sizeof v);
    (void)r;
#else
    char buf[16];
    while (read(done_fd_, buf, sizeof buf) > 0) {
    }
#endif
}

bool ScaleWorker::submit(std::vector<uint8_t> *atlas, uint64_t id, const ScaleShape &shape)
{
    if (!idle() || shape.dw > (shape.crop_w ? shape.crop_w : shape.w) || shape.dh > (shape.crop_w ? shape.crop_h : shape.h) ||
        atlas->size() != (size_t)shape.w * (shape.h + shape.h / 2))
        return false;
    in_.swap(*atlas);
    id_ = id;
    shape_ = shape;
    if (!thread_.joinable())
        thread_ = std::thread(&ScaleWorker::run, this);
    {
        std::lock_guard<std::mutex> l(mu_);
        stage_.store(kQueued, std::memory_order_release);
    }
    cv_.notify_one();
    return true;
}

bool ScaleWorker::take(std::vector<uint8_t> *out, uint64_t *id, const ScaleShape &shape, std::vector<uint8_t> *in)
{
    if (stage_.load(std::memory_order_acquire) != kDone)
        return false;
    drain_done();
    if (made_ == shape && !out_.empty()) {
        out->swap(out_);
        *id = id_;
    } else {
        out->clear();
    }
    if (in)
        in->swap(in_);
    stage_.store(kIdle, std::memory_order_release);
    return true;
}

void ScaleWorker::run()
{
#ifdef __linux__
    /* below the map's threads: the HUD takes only spare CPU */
    setpriority(PRIO_PROCESS, (id_t)syscall(SYS_gettid), 10);
#endif
    for (;;) {
        {
            std::unique_lock<std::mutex> l(mu_);
            cv_.wait(l, [this] { return stop_ || stage_.load(std::memory_order_acquire) == kQueued; });
            if (stop_)
                return;
        }
        if (made_ != shape_ || !scaler_.configured()) {
            made_ = ScaleShape();
            if (scaler_.configure(shape_.w, shape_.h, shape_.dw, shape_.dh, shape_.level_bits,
                                  shape_.crop_x, shape_.crop_y, shape_.crop_w, shape_.crop_h)) {
                scaler_.set_corner_radius(shape_.radius);
                scaler_.set_black_background(shape_.black);
                made_ = shape_;
            }
        }
        if (made_ == shape_)
            scaler_.scale(in_.data(), &out_);
        else
            out_.clear();
        frames_++;
        stage_.store(kDone, std::memory_order_release);
        signal_done();
    }
}

}  // namespace woc
