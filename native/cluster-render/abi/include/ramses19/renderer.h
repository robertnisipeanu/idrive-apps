// SPDX-License-Identifier: MPL-2.0
// Copyright (C) 2026 Robert Nisipeanu
// Declares the API of RAMSES (https://github.com/bmwcarit/ramses), BMW Car IT GmbH, MPL-2.0.
// Local renderer (preview) for libramses 19.0.14.
// Renderer events (dispatchEvents / IRendererEventHandler) are not declared;
// see ABI.md.
#ifndef RAMSES19_RENDERER_H
#define RAMSES19_RENDERER_H

#include "framework.h"

namespace ramses
{
    class RendererConfig : public StatusObject
    {
    public:
        RendererConfig(int32_t argc, const char* const* argv);
        ~RendererConfig();
        status_t enableSystemCompositorControl();
        status_t setWaylandSocketEmbedded(const char* socketname);
        status_t setWaylandSocketEmbeddedGroup(const char* groupname);
        static status_t SetSystemCompositorWaylandDisplay(RendererConfig& config, const char* waylandDisplay);
        RAMSES19_VALUE_STORAGE(RendererConfig);
    };

    class DisplayConfig : public StatusObject
    {
    public:
        DisplayConfig(int32_t argc, const char* const* argv);
        ~DisplayConfig();
        status_t setWindowRectangle(int32_t x, int32_t y, uint32_t width, uint32_t height);
        status_t setWindowFullscreen(bool fullscreen);
        status_t setWindowBorderless(bool borderless);
        status_t setWindowIviVisible();
        status_t setWaylandIviSurfaceID(uint32_t waylandIviSurfaceID);
        status_t setWaylandIviLayerID(uint32_t waylandIviLayerID);
        uint32_t getWaylandIviSurfaceID() const;
        uint32_t getWaylandIviLayerID() const;
        status_t setMultiSampling(uint32_t numSamples);
        status_t setClearColor(float red, float green, float blue, float alpha);
        status_t setOffscreen(bool offscreenFlag);
        status_t setResizable(bool resizable);
        status_t setPerspectiveProjection(float fieldOfViewY, float aspectRatio, float nearPlane, float farPlane);
        status_t setOrthographicProjection(float leftPlane, float rightPlane, float bottomPlane, float topPlane,
                                           float nearPlane, float farPlane);
        static status_t SetWaylandDisplay(DisplayConfig& config, const char* waylandDisplay);
        RAMSES19_VALUE_STORAGE(DisplayConfig);
    };

    class RamsesRenderer : public StatusObject
    {
    public:
        RamsesRenderer(RamsesFramework& framework, const RendererConfig& config);
        ~RamsesRenderer();

        displayId_t createDisplay(const DisplayConfig& config);
        status_t destroyDisplay(displayId_t displayId);

        status_t subscribeScene(sceneId_t sceneId);
        status_t unsubscribeScene(sceneId_t sceneId);
        status_t mapScene(displayId_t displayId, sceneId_t sceneId, int32_t sceneRenderOrder = 0);
        status_t unmapScene(sceneId_t sceneId);
        status_t showScene(sceneId_t sceneId);
        status_t hideScene(sceneId_t sceneId);

        status_t flush();
        status_t doOneLoop();
        status_t startThread();
        status_t stopThread();
        status_t setLoopMode(ELoopMode loopMode);
        status_t setMaximumFramerate(float maximumFramerate);
        status_t setSurfaceVisibility(uint32_t surfaceId, bool visibility);
        status_t setSurfaceOpacity(uint32_t surfaceId, float opacity);
        status_t setSurfaceRectangle(uint32_t surfaceId, int32_t x, int32_t y, int32_t width, int32_t height);
        status_t setLayerVisibility(uint32_t layerId, bool visibility);
        status_t takeSystemCompositorScreenshot(const char* fileName);
        status_t readPixels(displayId_t displayId, uint32_t x, uint32_t y, uint32_t width, uint32_t height);
        status_t logRendererInfo();

        const char* getStatusMessage(status_t status) const;
        RAMSES19_VALUE_STORAGE(RamsesRenderer);
    };
}

#endif
