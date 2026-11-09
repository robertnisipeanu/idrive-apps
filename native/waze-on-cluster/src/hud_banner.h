// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 JustAnotherPU
/* The Waze instruction banner read from decoded frames (README.md "HUD
 * arrows"). Waze sends CarPlay no route-guidance metadata, so the HUD learns
 * nothing from it; it draws its banner (a manoeuvre icon from a small fixed
 * set, the distance, the street) into the map video, inside the safe area.
 *
 * Two fixed rects of the frame's luma are read: the icon's and the
 * distance's (hud_icon_rect, hud_dist_rect). Each is binarised on its own
 * (Otsu; the background is the class most of the rect's border belongs to,
 * so day and night banners, light on dark or dark on light, read the same).
 * The icon: the bounding box of its larger parts, fitted into 24x24 with its
 * aspect kept, compared with every icon template (min/max overlap); the best
 * at or above min_score names the manoeuvre, else there is no banner. The
 * distance: the parts split into glyphs left to right, each fitted into
 * 16x16 and compared with the glyph templates (its height against the
 * line's counts too: m is half as tall as a digit), a small low part a
 * decimal point; then parsed as a number and one of m, km, ft, mi.
 *
 * Templates come from a folder of PGM files (tools/hud_templates.py makes
 * them from labelled PNGs): icon-<manoeuvre>-<n>.pgm, one icon crop each,
 * and dist-<text>-<n>.pgm, a distance crop whose glyphs are its text's
 * characters, spaces left out ("dist-1.2km-1.pgm"). Icon templates from the
 * folder replace the built-in ones, glyph templates likewise. The built-in
 * ones are our own drawings (hud_draw.h): placeholders, not Waze's icons. */
#ifndef WOC_HUD_BANNER_H
#define WOC_HUD_BANNER_H

#include <stdint.h>
#include <string>
#include <vector>

#include "hud_draw.h"

namespace woc {

struct Rect {
    unsigned x = 0, y = 0, w = 0, h = 0;
};
/* g's foreground (1) and background (0): Otsu, the background the class
 * most of g's border is; false for a flat g. */
bool binarise_fg(const Gray &g, std::vector<uint8_t> *mask);

/* "WxH+X+Y" */
bool parse_rect(const std::string &s, Rect *r);

/* The rect r of a w x h luma plane; false when it is not inside it. */
bool crop(const uint8_t *y, unsigned w, unsigned h, const Rect &r, Gray *out);

struct Reading {
    std::string maneuver;   /* empty: no banner */
    std::string distance;   /* "300 m", "1.2 km"; empty when not read */
    float score = 0;        /* the icon's match */
    bool operator==(const Reading &o) const { return maneuver == o.maneuver && distance == o.distance; }
    bool operator!=(const Reading &o) const { return !(*this == o); }
};

class Templates {
public:
    /* Our drawings: the glyphs always, the icons only when icons is set. */
    void add_builtin(bool icons);
    /* The folder's PGM files; returns how many templates it added, with a
     * line in *log for each file it could not use. A missing folder adds
     * none. */
    int load_dir(const std::string &dir, std::string *log);
    bool add_icon(const std::string &label, const Gray &g);
    /* A distance crop and its text: false unless its glyphs are as many as
     * the text's characters. */
    bool add_line(const std::string &text, const Gray &g);
    size_t icons() const { return icons_.size(); }
    size_t glyphs() const { return glyphs_.size(); }

    struct T {
        std::string label;
        std::vector<float> v;
        float rel_h = 1;   /* a glyph's height over the line's */
        bool builtin = false;
    };
    const std::vector<T> &icon_set() const { return icons_; }
    const std::vector<T> &glyph_set() const { return glyphs_; }

private:
    std::vector<T> icons_, glyphs_;
};

class Recogniser {
public:
    Recogniser(const Templates *t, const Rect &icon, const Rect &dist, float min_score = 0.6f);
    Reading read(const uint8_t *y, unsigned w, unsigned h) const;
    /* The glyphs of a distance crop, read as text without spaces ("1.2km"). */
    std::string read_text(const Gray &g) const;

private:
    const Templates *t_;
    Rect icon_, dist_;
    float min_score_;
};

/* A reading is reported once it was read `stable` times in a row and differs
 * from the last one reported. */
class Debounce {
public:
    explicit Debounce(unsigned stable = 2) : stable_(stable) {}
    bool push(const Reading &r, Reading *out);
    const Reading &current() const { return shown_; }

private:
    unsigned stable_, seen_ = 0;
    Reading cand_, shown_;
};

/* The centre screen card's reading kept over a missed read: the card is read
 * at 2 fps and misses some frames (seen on the car 2026-11-04: "left 50 m",
 * "left", "left 70 m" a second apart), and a miss fell back to the map,
 * which has no distance. For hold_ms after a card reading, a read without
 * the card gives that card reading again; a card reading of the same
 * manoeuvre without a distance keeps the last distance. */
class CardHold {
public:
    explicit CardHold(int64_t hold_ms = 3000) : hold_ms_(hold_ms) {}
    Reading pick(const Reading &r, bool from_card, int64_t now_ms);

private:
    int64_t hold_ms_, card_ms_ = -1000000000;
    Reading card_;
};

/* The distance from text such as "300m", "1.2km", "0,3mi": "300 m",
 * "1.2 km"; empty when it is none of those, or when a digit was lost
 * ("00 m", "07 m": a leading zero then a digit; "0 m" is Waze at the turn). */
std::string parse_distance(const std::string &text);

/* An 8-bit grey PNG (stored deflate) of g, and a binary PGM reader. */
bool write_png(const std::string &path, const Gray &g);
bool read_pgm(const std::string &path, Gray *g);

}  // namespace woc

#endif
