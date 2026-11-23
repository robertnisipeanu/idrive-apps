/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
#include "curves.h"

namespace crs {

namespace {

/* The eased fraction of a segment at u (0-1). */
float ease(Curve c, float u)
{
    switch (c) {
    case Curve::EaseIn: return u * u * u;
    case Curve::EaseOut: {
        const float v = 1.0f - u;
        return 1.0f - v * v * v;
    }
    case Curve::EaseInOut:
        return u < 0.5f ? 4.0f * u * u * u : 1.0f - 4.0f * (1.0f - u) * (1.0f - u) * (1.0f - u);
    default: return u;
    }
}

}  // namespace

void sample_curve(Curve c, Animation *a)
{
    const size_t n = a->t.size(), w = a->width;
    if (c == Curve::Linear || c == Curve::Step || n < 2)
        return;
    const uint32_t steps = curve_steps(n);
    std::vector<uint32_t> t;
    std::vector<float> v;
    t.reserve((n - 1) * steps + 1);
    v.reserve(((n - 1) * steps + 1) * w);
    auto key = [&](size_t k, size_t i) { return a->v[k * w + i]; };
    for (size_t k = 0; k + 1 < n; k++) {
        const uint32_t t0 = a->t[k], t1 = a->t[k + 1];
        /* Steps no closer than a millisecond: the keys' times stay apart. */
        const uint32_t s = t1 - t0 < steps ? t1 - t0 : steps;
        for (uint32_t j = 0; j < s; j++) {
            const float u = (float)j / (float)s;
            t.push_back(t0 + (uint32_t)((uint64_t)(t1 - t0) * j / s));
            for (size_t i = 0; i < w; i++) {
                const float p1 = key(k, i), p2 = key(k + 1, i);
                if (c != Curve::Smooth) {
                    v.push_back(p1 + (p2 - p1) * ease(c, u));
                    continue;
                }
                /* Catmull-Rom over the segment's time: slopes per ms from the
                 * neighbours, scaled to the segment. */
                const float dt = (float)(t1 - t0);
                const float m1 = k > 0 ? (p2 - key(k - 1, i)) / (float)(t1 - a->t[k - 1]) * dt : p2 - p1;
                const float m2 = k + 2 < n ? (key(k + 2, i) - p1) / (float)(a->t[k + 2] - t0) * dt : p2 - p1;
                const float u2 = u * u, u3 = u2 * u;
                v.push_back((2 * u3 - 3 * u2 + 1) * p1 + (u3 - 2 * u2 + u) * m1 + (-2 * u3 + 3 * u2) * p2 +
                            (u3 - u2) * m2);
            }
        }
    }
    t.push_back(a->t.back());
    for (size_t i = 0; i < w; i++)
        v.push_back(key(n - 1, i));
    a->t.swap(t);
    a->v.swap(v);
    a->step = false;
}

}  // namespace crs
