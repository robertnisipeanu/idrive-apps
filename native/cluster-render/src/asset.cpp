/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
#include "asset.h"

#include <cstdio>
#include <cstring>

#include "cluster_render/protocol.h"
#include "log.h"

namespace crs {

Asset::Asset(uint32_t id, int target, crk::UploadPacer &pacer, const AssetParams &p)
    : id_(id), target_(target), pacer_(pacer), p_(p), px_((size_t)p.w * p.h * bpp(), 0)
{
}

const char *Asset::size_error(TexFormat f, uint32_t w, uint32_t h)
{
    if (w < 1 || h < 1)
        return "an asset is at least 1x1";
    if (w > 2048 || h > 2048)
        return "an asset is at most 2048x2048";
    if ((size_t)w * h * (f == TexFormat::R8 ? 1 : 4) + 64 > cr::kMaxMessage)
        return "an asset's pixels must fit one frame message (5,529,600 bytes)";
    return nullptr;
}

bool Asset::update(const std::vector<crk::PixelRect> &rects, const uint8_t *data, size_t n, std::string *err)
{
    const uint32_t b = bpp();
    if (rects.empty()) {
        if (n != px_.size()) {
            *err = "a whole asset is " + std::to_string(px_.size()) + " bytes";
            return false;
        }
        std::memcpy(px_.data(), data, n);
        whole_ = true;
        dirty_.clear();
        have_ = true;
        return true;
    }
    size_t need = 0;
    for (const crk::PixelRect &r : rects) {
        if (r.w == 0 || r.h == 0 || r.x + r.w > p_.w || r.y + r.h > p_.h || r.x + r.w < r.x || r.y + r.h < r.y) {
            *err = "rectangle outside the asset";
            return false;
        }
        need += (size_t)r.w * r.h * b;
    }
    if (n != need) {
        *err = "rectangles need " + std::to_string(need) + " bytes";
        return false;
    }
    for (const crk::PixelRect &r : rects) {
        for (uint32_t y = 0; y < r.h; y++)
            std::memcpy(&px_[((size_t)(r.y + y) * p_.w + r.x) * b], data + (size_t)y * r.w * b, (size_t)r.w * b);
        data += (size_t)r.w * r.h * b;
        if (!whole_) {
            if (dirty_.size() >= kMaxRects) {
                whole_ = true;
                dirty_.clear();
            } else {
                dirty_.push_back(r);
            }
        }
    }
    have_ = true;
    return true;
}

bool Asset::attach(Graph *g)
{
    g_ = g;
    buf_ = g->buffer(p_.format, p_.w, p_.h, p_.sampling, p_.wrap);
    if (!buf_) {
        g_ = nullptr;
        log_error("asset %u: %ux%u buffer refused", id_, p_.w, p_.h);
        return false;
    }
    whole_ = true;   /* a new buffer holds nothing yet */
    clean_ = false;
    dirty_.clear();
    return true;
}

void Asset::detach(bool drop)
{
    if (g_ && drop && buf_)
        g_->drop_buffer(buf_);
    g_ = nullptr;
    buf_ = 0;
    clean_ = false;
    whole_ = true;
    dirty_.clear();
    staged_ = 0;
}

Stage Asset::stage(int64_t now_ms)
{
    staged_ = 0;
    if (!g_ || !have_ || (!whole_ && dirty_.empty()) || !pacer_.ready(now_ms))
        return Stage::Idle;
    const std::vector<crk::PixelRect> all{crk::PixelRect{0, 0, p_.w, p_.h}};
    bool written = true;
    staged_whole_ = whole_;
    staged_ = crk::write_rects(
        px_.data(), p_.w, bpp(), whole_ ? all : dirty_, &scratch_,
        [this](const uint8_t *px, const crk::PixelRect &r) { return g_->write(buf_, r.x, r.y, r.w, r.h, px); },
        &written);
    /* Charged at once: the layers staged after it see what is left. */
    pacer_.spend(staged_);
    if (!written)
        clean_ = false;
    return written ? Stage::Wrote : Stage::Failed;
}

void Asset::committed(bool ok)
{
    if (ok) {
        writes_++;
        bytes_ += staged_;
        whole_ = false;
        if (staged_whole_)
            clean_ = true;
    } else {
        failed_++;
        whole_ = true;
        clean_ = false;
    }
    dirty_.clear();
    staged_ = 0;
}

std::string Asset::stats() const
{
    char b[96];
    std::snprintf(b, sizeof b, "%llu writes, %llu KB, %llu failed", (unsigned long long)writes_,
                  (unsigned long long)(bytes_ / 1024), (unsigned long long)failed_);
    return b;
}

}  // namespace crs
