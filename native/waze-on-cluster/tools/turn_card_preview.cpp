// SPDX-License-Identifier: GPL-3.0-or-later
/* Writes every kind of turn card, over a map-coloured ground, as one PAM
 * picture (RGB_ALPHA), to look at the drawing; "compact" the compact cards
 * (below the arrow):
 *
 *   make build/host/turn_card_preview && build/host/turn_card_preview [compact] > cards.pam
 */
#include <cstdio>
#include <string>
#include <vector>

#include "turn_card.h"

using namespace woc;

int main(int argc, char **argv)
{
    const bool compact = argc > 1 && std::string(argv[1]) == "compact";
    const unsigned ch = compact ? kTurnCardCompactH : kTurnCardH;
    struct Case {
        Maneuver::Kind kind;
        int exit;
        const char *dist, *road;
    } cases[] = {
        {Maneuver::Straight, 0, "1,2 km", "Avenida Exemplo"},
        {Maneuver::SlightLeft, 0, "300 m", "Rua das Ac\xC3\xA1" "cias"},
        {Maneuver::Left, 0, "200 m", "Rua Jo\xC3\xA3o das Flores, \xC3\x81rvore, S\xC3\xA3o Jos\xC3\xA9"},
        {Maneuver::SharpLeft, 0, "90 m", "Travessa Curta"},
        {Maneuver::SlightRight, 0, "450 m", "Estrada Velha"},
        {Maneuver::Right, 0, "20 m", "R. Exemplo"},
        {Maneuver::SharpRight, 0, "60 m", "Rua Diagonal"},
        {Maneuver::UTurn, 0, "150 m", "Retorno"},
        {Maneuver::UTurnRight, 0, "150 m", "U-turn"},
        {Maneuver::KeepLeft, 0, "800 m", "Marginal Esquerda"},
        {Maneuver::KeepRight, 0, "800 m", "Marginal Direita"},
        {Maneuver::ExitLeft, 0, "2 km", "Sa\xC3\xAD" "da 12"},
        {Maneuver::ExitRight, 0, "1,5 km", "Sa\xC3\xAD\x64\x61 7 - Centro"},
        {Maneuver::Roundabout, 90, "100 m", "1\xC2\xAA sa\xC3\xAD\x64\x61"},
        {Maneuver::Roundabout, 0, "100 m", "2\xC2\xAA sa\xC3\xAD\x64\x61"},
        {Maneuver::Roundabout, -90, "100 m", "3\xC2\xAA sa\xC3\xAD\x64\x61"},
        {Maneuver::Roundabout, 180, "100 m", "Retorno na rotat\xC3\xB3ria"},
        {Maneuver::Roundabout, 45, "100 m", "Rotat\xC3\xB3ria"},
        {Maneuver::Arrive, 0, "0 m", "Casa de Teste"},
        {Maneuver::ArriveLeft, 0, "50 m", "Destino \xC3\xA0 esquerda"},
        {Maneuver::ArriveRight, 0, "50 m", "Destino \xC3\xA0 direita"},
        {Maneuver::Other, 0, "70 m", "Balsa"},
        {Maneuver::Right, 0, "200 m", ""},
        {Maneuver::Left, 0, "1.234,5 km", "\xD0\x9B\xD0\xB5\xD0\xBD\xD0\xB8\xD0\xBD\xD1\x81\xD0\xBA\xD0\xB8\xD0\xB9 \xD0\xBF\xD1\x80\xD0\xBE\xD1\x81\xD0\xBF\xD0\xB5\xD0\xBA\xD1\x82 / Very long road name that will not fit"},
    };
    const int n = sizeof cases / sizeof cases[0], cols = 2, pad = 12;
    const int rows = (n + cols - 1) / cols;
    const int W = cols * (int)kTurnCardW + (cols + 1) * pad, H = rows * (int)ch + (rows + 1) * pad;
    std::vector<uint8_t> img((size_t)W * H * 4);
    for (int i = 0; i < W * H; i++) {
        img[i * 4] = 92, img[i * 4 + 1] = 110, img[i * 4 + 2] = 96, img[i * 4 + 3] = 255;
    }
    for (int k = 0; k < n; k++) {
        Maneuver m;
        m.kind = cases[k].kind;
        m.exit_deg = cases[k].exit;
        m.distance = cases[k].dist;
        m.road = cases[k].road;
        std::vector<uint8_t> card;
        render_turn_card(m, &card, compact);
        const int ox = pad + (k % cols) * ((int)kTurnCardW + pad), oy = pad + (k / cols) * ((int)ch + pad);
        for (unsigned y = 0; y < ch; y++)
            for (unsigned x = 0; x < kTurnCardW; x++) {
                const uint8_t *s = &card[(y * kTurnCardW + x) * 4];
                uint8_t *d = &img[((size_t)(oy + y) * W + ox + x) * 4];
                const float a = s[3] / 255.0f;
                for (int c = 0; c < 3; c++)
                    d[c] = (uint8_t)(s[c] * a + d[c] * (1 - a) + 0.5f);
            }
    }
    std::printf("P7\nWIDTH %d\nHEIGHT %d\nDEPTH 4\nMAXVAL 255\nTUPLTYPE RGB_ALPHA\nENDHDR\n", W, H);
    std::fwrite(img.data(), 1, img.size(), stdout);
    return 0;
}
