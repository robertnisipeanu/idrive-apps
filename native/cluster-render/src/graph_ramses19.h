/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
/* The iDrive 7 renderer: graph.h on the unit's RAMSES 19 client library
 * (../abi/ABI.md), whose scenes the KOMBI's renderer draws.
 *
 * Each target is one scene with a pixel-space orthographic camera over the
 * target. Every quad is a mesh node (the shared unit quad, an appearance of
 * its effect) under two group nodes that place and turn it, ordered within
 * the render group of its 2D pass. Without views there is one 2D pass. Each
 * view is a render pass of its own with a perspective or orthographic camera
 * and a render group of its parts' mesh nodes, whose geometry is immutable
 * resources; the passes' render order follows the draw order (plan_passes).
 * Buffers are Texture2DBuffers with one sampler each. Animations are one
 * real-time animation system per scene, made at the first one, played by the
 * renderer. */
#ifndef CRS_GRAPH_RAMSES19_H
#define CRS_GRAPH_RAMSES19_H

#include <map>

#include "graph.h"

namespace ramses {
class RamsesClient;
class Effect;
class Vector2fArray;
class UInt16Array;
}  // namespace ramses

namespace crs {

class Ramses19Gpu : public Gpu {
public:
    explicit Ramses19Gpu(ramses::RamsesClient &client);
    ~Ramses19Gpu() override;
    /* The unit quad's vertices and indices, shared by every scene. */
    bool init(std::string *err);

    int effect(const char *vs, const char *fs, std::string *err) override;
    void drop_effect(int effect) override;
    unsigned attributes(int effect) const override;
    std::unique_ptr<Graph> scene(const TargetSpec &t, std::string *err) override;

private:
    ramses::RamsesClient &client_;
    const ramses::Vector2fArray *pos_ = nullptr;
    const ramses::UInt16Array *idx_ = nullptr;
    std::map<int, ramses::Effect *> effects_;
    int next_ = 1;
};

}  // namespace crs

#endif
