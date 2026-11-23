/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
/* The text helper's fragment shader (cluster_render/text.h) drawn by a GLES 2
 * context on the host (Mesa's software renderer, through EGL loaded at run
 * time): "AV" with kerning that pulls V over A's box, both glyphs hollow, so
 * a pixel two boxes cover shows the lit one. Skipped, and says so, where the
 * host has no EGL; failed instead with CR_REQUIRE_GL set (CI). */
#include <dlfcn.h>

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "cluster_render/text.h"

namespace {

int failures = 0;

void ok(const char *what, bool good)
{
    std::printf("%s %s\n", good ? "ok  " : "FAIL", what);
    failures += !good;
}

typedef void *(*GetProc)(const char *);
GetProc get_proc = nullptr;

template <typename F> F gl(const char *name) { return (F)get_proc(name); }

/* A surfaceless GLES 2 context, current; false when there is none. */
bool context(std::string *why)
{
    void *egl = dlopen("libEGL.so.1", RTLD_NOW);
    if (!egl) {
        *why = "no libEGL.so.1";
        return false;
    }
    get_proc = (GetProc)dlsym(egl, "eglGetProcAddress");
    typedef void *Display;
    auto platform_display = (Display(*)(unsigned, void *, const int *))get_proc("eglGetPlatformDisplayEXT");
    auto initialize = (unsigned (*)(Display, int *, int *))dlsym(egl, "eglInitialize");
    auto bind_api = (unsigned (*)(unsigned))dlsym(egl, "eglBindAPI");
    auto choose = (unsigned (*)(Display, const int *, void **, int, int *))dlsym(egl, "eglChooseConfig");
    auto create = (void *(*)(Display, void *, void *, const int *))dlsym(egl, "eglCreateContext");
    auto make_current = (unsigned (*)(Display, void *, void *, void *))dlsym(egl, "eglMakeCurrent");
    Display d = platform_display ? platform_display(0x31DD /* EGL_PLATFORM_SURFACELESS_MESA */, nullptr, nullptr)
                                 : nullptr;
    int major = 0, minor = 0;
    if (!d || !initialize || !initialize(d, &major, &minor)) {
        *why = "no surfaceless EGL display";
        return false;
    }
    bind_api(0x30A0 /* EGL_OPENGL_ES_API */);
    const int config_attrs[] = {0x3040 /* EGL_RENDERABLE_TYPE */, 4 /* EGL_OPENGL_ES2_BIT */, 0x3038};
    void *config = nullptr;
    int n = 0;
    choose(d, config_attrs, &config, 1, &n);
    const int context_attrs[] = {0x3098 /* EGL_CONTEXT_CLIENT_VERSION */, 2, 0x3038};
    void *c = create(d, n ? config : nullptr, nullptr, context_attrs);
    if (!c || !make_current(d, nullptr, nullptr, c)) {
        *why = "no GLES 2 context";
        return false;
    }
    return true;
}

const unsigned GL_FRAGMENT_SHADER = 0x8B30, GL_VERTEX_SHADER = 0x8B31, GL_COMPILE_STATUS = 0x8B81,
               GL_LINK_STATUS = 0x8B82, GL_TEXTURE_2D = 0x0DE1, GL_LUMINANCE = 0x1909, GL_RGBA = 0x1908,
               GL_UNSIGNED_BYTE = 0x1401, GL_TEXTURE_MIN_FILTER = 0x2801, GL_TEXTURE_MAG_FILTER = 0x2800,
               GL_TEXTURE_WRAP_S = 0x2802, GL_TEXTURE_WRAP_T = 0x2803, GL_LINEAR = 0x2601,
               GL_CLAMP_TO_EDGE = 0x812F, GL_FRAMEBUFFER = 0x8D40, GL_COLOR_ATTACHMENT0 = 0x8CE0,
               GL_FRAMEBUFFER_COMPLETE = 0x8CD5, GL_COLOR_BUFFER_BIT = 0x4000, GL_FLOAT = 0x1406,
               GL_TRIANGLE_STRIP = 0x0005, GL_UNPACK_ALIGNMENT = 0x0CF5, GL_PACK_ALIGNMENT = 0x0D05;

/* The service's quad vertex shader's v_uv (src/compositor.cpp), the quad
 * filling the viewport. */
const char *const kVs = "#version 100\n"
                        "attribute vec2 a_position;\n"
                        "varying vec2 v_uv;\n"
                        "void main() {\n"
                        "    v_uv = vec2(a_position.x, 1.0 - a_position.y);\n"
                        "    gl_Position = vec4(a_position * 2.0 - 1.0, 0.0, 1.0);\n"
                        "}\n";

unsigned shader(unsigned kind, const std::string &src)
{
    const unsigned s = gl<unsigned (*)(unsigned)>("glCreateShader")(kind);
    const char *text = src.c_str();
    gl<void (*)(unsigned, int, const char *const *, const int *)>("glShaderSource")(s, 1, &text, nullptr);
    gl<void (*)(unsigned)>("glCompileShader")(s);
    int good = 0;
    gl<void (*)(unsigned, unsigned, int *)>("glGetShaderiv")(s, GL_COMPILE_STATUS, &good);
    if (!good) {
        char log[1024] = {};
        gl<void (*)(unsigned, int, int *, char *)>("glGetShaderInfoLog")(s, sizeof log, nullptr, log);
        std::printf("     %s\n", log);
    }
    return good ? s : 0;
}

/* The line of text drawn w x h by the helper's shader, n glyphs, from
 * font's atlas; its middle row's alpha per pixel. */
std::vector<int> draw(const cr::Font &font, const std::string &text, unsigned n, int w, int h)
{
    float width = 0;
    const std::vector<cr::GlyphBox> boxes = font.layout(text, (float)h, 0, &width);
    std::vector<float> v(n * 4, 0.0f);
    for (size_t i = 0; i < boxes.size() && i < n; i++) {
        v[i * 4] = boxes[i].x0 / (float)w;
        v[i * 4 + 1] = boxes[i].x1 / (float)w;
        v[i * 4 + 2] = boxes[i].u0 / (float)font.width();
        v[i * 4 + 3] = boxes[i].u1 / (float)font.width();
    }
    const unsigned vs = shader(GL_VERTEX_SHADER, kVs), fs = shader(GL_FRAGMENT_SHADER, cr::text_fragment_shader(n));
    if (!vs || !fs)
        return {};
    const unsigned prog = gl<unsigned (*)()>("glCreateProgram")();
    gl<void (*)(unsigned, unsigned)>("glAttachShader")(prog, vs);
    gl<void (*)(unsigned, unsigned)>("glAttachShader")(prog, fs);
    gl<void (*)(unsigned, unsigned, const char *)>("glBindAttribLocation")(prog, 0, "a_position");
    gl<void (*)(unsigned)>("glLinkProgram")(prog);
    int linked = 0;
    gl<void (*)(unsigned, unsigned, int *)>("glGetProgramiv")(prog, GL_LINK_STATUS, &linked);
    if (!linked)
        return {};
    gl<void (*)(unsigned)>("glUseProgram")(prog);
    auto loc = [&](const char *name) { return gl<int (*)(unsigned, const char *)>("glGetUniformLocation")(prog, name); };

    auto gen_bind_texture = [&](int tw, int th, unsigned format, const void *px) {
        unsigned t = 0;
        gl<void (*)(int, unsigned *)>("glGenTextures")(1, &t);
        gl<void (*)(unsigned, unsigned)>("glBindTexture")(GL_TEXTURE_2D, t);
        gl<void (*)(unsigned, int)>("glPixelStorei")(GL_UNPACK_ALIGNMENT, 1);
        gl<void (*)(unsigned, int, int, int, int, int, unsigned, unsigned, const void *)>("glTexImage2D")(
            GL_TEXTURE_2D, 0, (int)format, tw, th, 0, format, GL_UNSIGNED_BYTE, px);
        auto param = gl<void (*)(unsigned, unsigned, int)>("glTexParameteri");
        param(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
        param(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
        param(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
        param(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
        return t;
    };
    const unsigned target = gen_bind_texture(w, h, GL_RGBA, nullptr);
    unsigned fbo = 0;
    gl<void (*)(int, unsigned *)>("glGenFramebuffers")(1, &fbo);
    gl<void (*)(unsigned, unsigned)>("glBindFramebuffer")(GL_FRAMEBUFFER, fbo);
    gl<void (*)(unsigned, unsigned, unsigned, unsigned, int)>("glFramebufferTexture2D")(
        GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, target, 0);
    if (gl<unsigned (*)(unsigned)>("glCheckFramebufferStatus")(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE)
        return {};
    gen_bind_texture((int)font.width(), (int)font.line_height(), GL_LUMINANCE, font.pixels().data());

    gl<void (*)(int, int)>("glUniform1i")(loc("u_atlas"), 0);
    gl<void (*)(int, int, const float *)>("glUniform4fv")(loc("u_glyphs"), (int)n, v.data());
    gl<void (*)(int, float)>("glUniform1f")(loc("u_count"), (float)std::min<size_t>(boxes.size(), n));
    const float white[4] = {1, 1, 1, 1};
    gl<void (*)(int, int, const float *)>("glUniform4fv")(loc("u_color"), 1, white);
    gl<void (*)(int, int, int, int)>("glViewport")(0, 0, w, h);
    gl<void (*)(float, float, float, float)>("glClearColor")(0, 0, 0, 0);
    gl<void (*)(unsigned)>("glClear")(GL_COLOR_BUFFER_BIT);
    const float quad[8] = {0, 0, 1, 0, 0, 1, 1, 1};
    gl<void (*)(unsigned, int, unsigned, unsigned char, int, const void *)>("glVertexAttribPointer")(
        0, 2, GL_FLOAT, 0, 0, quad);
    gl<void (*)(unsigned)>("glEnableVertexAttribArray")(0);
    gl<void (*)(unsigned, int, int)>("glDrawArrays")(GL_TRIANGLE_STRIP, 0, 4);
    std::vector<uint8_t> px((size_t)w * h * 4);
    gl<void (*)(unsigned, int)>("glPixelStorei")(GL_PACK_ALIGNMENT, 1);
    gl<void (*)(int, int, int, int, unsigned, unsigned, void *)>("glReadPixels")(0, 0, w, h, GL_RGBA, GL_UNSIGNED_BYTE,
                                                                                  px.data());
    std::vector<int> row(w);
    for (int x = 0; x < w; x++)
        row[x] = px[((size_t)(h / 2) * w + x) * 4 + 3];
    return row;
}

}  // namespace

int main()
{
    std::string why;
    if (!context(&why)) {
        if (std::getenv("CR_REQUIRE_GL")) {
            std::printf("FAIL text GL: %s, and CR_REQUIRE_GL is set\n", why.c_str());
            return 1;
        }
        std::printf("skip text_gl_check: %s: the text shader is not drawn on this host\n", why.c_str());
        return 0;
    }
    /* A and V: 6 wide, their outer columns lit, hollow between; V kerned
     * 2 pixels over A, so A's right column (x 5) lies in V's box, over V's
     * unlit second column. */
    std::vector<cr::GlyphBitmap> gs(2);
    for (int i = 0; i < 2; i++) {
        gs[i].code = i ? 'V' : 'A';
        gs[i].w = 6;
        gs[i].h = 8;
        gs[i].pixels.assign(48, 0);
        for (int y = 0; y < 8; y++)
            gs[i].pixels[y * 6] = gs[i].pixels[y * 6 + 5] = 255;
    }
    const cr::Font font = cr::Font::from_glyphs(8, gs, {{{'A', 'V'}, -2}});
    const std::vector<int> row = draw(font, "AV", cr::kMaxTextGlyphs, 16, 8);
    ok("text GL: the shader compiled, linked and drawn", row.size() == 16);
    if (row.size() == 16) {
        std::printf("     alpha by pixel:");
        for (int a : row)
            std::printf(" %d", a);
        std::printf("\n");
        ok("text GL: A's columns and V's lit, A's right one inside V's box too",
           row[0] > 200 && row[5] > 200 && row[4] > 200 && row[9] > 200);
        ok("text GL: hollow between, nothing past the text", row[2] < 50 && row[7] < 50 && row[12] < 50);
    }
    std::printf(failures ? "%d FAILED\n" : "all ok\n", failures);
    return failures ? 1 : 0;
}
