/* SPDX-License-Identifier: MPL-2.0
 * Copyright (C) 2026 Robert Nisipeanu */
#include "map_geometry.h"

namespace crk {

QuadRect map_quad(uint32_t scene_w, uint32_t scene_h, uint32_t tex_w, uint32_t tex_h)
{
    uint64_t aw = scene_w, ah = scene_h;
    if (scene_w >= kMapAreaWidth && scene_h >= kMapAreaHeight) {
        aw = kMapAreaWidth;
        ah = kMapAreaHeight;
    } else if (scene_w == 800 && scene_h == 480) {
        /* The HUD uses a smaller centred map rather than the full scene. */
        aw = scene_w * 0.567f;
        ah = scene_h * 0.667f;
    }
    uint64_t w, h;
    if ((uint64_t)tex_w * ah <= aw * tex_h) {
        h = ah;                                       /* height-limited */
        w = (ah * tex_w + tex_h / 2) / tex_h;
    } else {
        w = aw;                                       /* width-limited */
        h = (aw * tex_h + tex_w / 2) / tex_w;
    }
    return QuadRect{(uint32_t)((scene_w - w) / 2), (uint32_t)((scene_h - h) / 2), (uint32_t)w, (uint32_t)h};
}

const char *texture_size_error(uint32_t tex_w, uint32_t tex_h)
{
    if (tex_w < 64 || tex_h < 32)
        return "texture smaller than 64x32";
    if (tex_w % 2 || tex_h % 2)
        return "texture width and height must be even";
    if (tex_w > kMapAreaWidth || tex_h > kMapAreaHeight)
        return "texture larger than the 1088x480 map area";
    if (tex_w % 4)
        return "texture width must be a multiple of 4";
    return nullptr;
}

}  // namespace crk
