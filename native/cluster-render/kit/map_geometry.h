/* SPDX-License-Identifier: MPL-2.0
 * Copyright (C) 2026 Robert Nisipeanu */
/* Where the map quad goes in the scene the cluster maps.
 *
 * The cluster's central map area is the stock navigation map's rect between
 * the dials: 1088x480 panel pixels (the Kombi's navicontent mesh). A scene
 * reaches the cluster in one of two shapes:
 *   - the Map slot 0x100: the cluster draws the scene onto that area 1:1, so
 *     the 1088x480 scene is the map area and the map fills it, under the
 *     gauges like the stock map;
 *   - a whole-panel slot such as 0x203: the scene is the 1920x720 panel and
 *     the map takes the map area's size, centred, with the rest of the scene
 *     transparent so the gauges show around it.
 * A scene at least the map area's size in both dimensions is a panel scene;
 * a smaller one (the Map slot) is itself the map area. The 800x480 HUD uses
 * a smaller centred map. The texture is fitted with its aspect kept, in whole
 * pixels. */
#ifndef CRK_MAP_GEOMETRY_H
#define CRK_MAP_GEOMETRY_H

#include <stdint.h>

namespace crk {

constexpr uint32_t kMapAreaWidth = 1088;
constexpr uint32_t kMapAreaHeight = 480;

/* Scene pixels. The quad is centred on both axes, so y is the same measured
 * from the top or (as the scene's camera does) from the bottom. */
struct QuadRect {
    uint32_t x, y, w, h;
};

QuadRect map_quad(uint32_t scene_w, uint32_t scene_h, uint32_t tex_w, uint32_t tex_h);

/* Why a tex_w x tex_h frame cannot be the map texture (its 4:2:0 atlas,
 * yuv_atlas.h), or null. Both sides even (the H.264 4:2:0 picture the phone
 * sends), at least 64x32, and at most the map area: more pixels than the area
 * shows are only scaled away. The width is a multiple of 4, so every atlas
 * row is a whole number of 4-byte words (GL's default unpack alignment). */
const char *texture_size_error(uint32_t tex_w, uint32_t tex_h);

}  // namespace crk

#endif
