/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 morgulbrut */
/* The GLO page of the LCD (GLO button): the patch's settings that are not a module's. For now one row:
 *   K1 VOICES  1 (MONO) .. ENG_MAX_VOICES; the firmware reloads the patch with the new count (main.c voices_set).
 * Included after ui.c (put, pad, text_mid, colours, PAGE_GLO) and arp_ui.c (the row geometry). */

static void glo_row(uint32_t k, const char *label, const char *val, int active, int32_t bar)
{
    char line[40], v[24], *p = line;
    uint32_t y = AU_ROW0 + AU_ROWH * k;
    *p++ = 'K';
    *p++ = (char)('1' + k);
    *p++ = ' ';
    p = put(p, label);
    pad(p, line, 36);
    text5x7(12, y, line, 1, C_DIM, C_BG);
    p = put(v, val);
    pad(p, v, 24);
    text_mid(12, y + 10u, v, active ? C_FG : C_DIM, C_BG);
    if (bar >= 0) {
        uint32_t w = (uint32_t)bar > 216u ? 216u : (uint32_t)bar;
        lcd_fill(12, y + 24u, w, 2, C_ACC);
        lcd_fill(12 + w, y + 24u, 216u - w, 2, 0x2104u);
    } else {
        lcd_fill(12, y + 24u, 216u, 2, C_BG);
    }
}

static void glo_view_draw(int full)
{
    char val[24], *p = val;
    int32_t nv = eng_voices();
    text5x7(12, AU_TOP + 2u, "GLO", 1, C_DIM, C_BG);
    text_mid(12, AU_TOP + 12u, "PATCH   ", C_ACC, C_BG);
    if (nv <= 1) {
        p = put(p, nv ? "MONO" : "-");
    } else {
        char num[8];
        fmt_int(num, nv);
        p = put(p, num);
        p = put(p, " VOICES");
    }
    *p = 0;
    glo_row(0, "VOICES", val, nv > 0, nv > 0 ? (int32_t)(((uint32_t)nv - 1u) * 216u / (ENG_MAX_VOICES - 1u)) : -1);
    glo_row(1, "", "-", 0, -1);
    glo_row(2, "", "-", 0, -1);
    glo_row(3, "", "-", 0, -1);
    if (full)
        text5x7(12, 232, "GLO: BACK  SAVE: KEEP IT", 1, 0x4208u, C_BG);
}
