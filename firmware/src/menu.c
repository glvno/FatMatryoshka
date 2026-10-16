/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 morgulbrut */
/* Two pages of the panel, after ui.c and before main.c:
 *
 * MIXER (GLO): K1..K4 the level of voice 1..4, the black keys F# G# A# C# (OP1..OP4) mute them (and play no notes then),
 * ALGORITHM sets the polyphony of the selected voice's patch (main.c poly_set). A build with fewer voices (engine.h
 * ENG_VOICES) has that many rows, mute keys and channel rows; the one-voice build uses K2 for the patch's MORPH and K3 / K4
 * for its voicing (LEGATO, PRIORITY of the Main module).
 *
 * MENU (HOME held 0.7 s, HOME again closes it): the settings, in tabs like Felucca's menu (its layout, its rows are ours).
 * ALGORITHM steps between the tabs, PRESET and SELECT between the rows, K1..K4 and OCT- / OCT+ change the value of the
 * selected row. The values are applied at once and saved with the state (SAVE: main.c save bits).
 *
 * The state is plain bytes the main loop writes; the audio ISR only sees the voice levels through eng_voice_gain. */

#ifndef FELUCCA_VERSION
#define FELUCCA_VERSION "M1"
#endif
static void leds_avail(void);
static void leds_octave(void);
static void uboot_now(void);
static void defaults_now(void);

/* ---- mixer */

static int voice_poly(uint32_t v)       /* the polyphony of voice v's patch (0: none loaded) */
{
    int n;
    uint32_t keep = eng_voice();
    eng_voice_select(v);
    n = eng_poly();
    eng_voice_select(keep);
    return n;
}

/* the keys that mute voice 1..4: the black keys F#3, G#3, A#3, C#4 (OP1..OP4) */
static const uint8_t MIX_KEY_BIT[ENG_VOICES] = ENG_VOICE_INIT(1, 3, 5, 8);
#define MIX_KEYS ((1u << 1) | (ENG_VOICES > 1 ? 1u << 3 : 0u) | (ENG_VOICES > 2 ? 1u << 5 : 0u) | (ENG_VOICES > 3 ? 1u << 8 : 0u))

static uint8_t mix_vol[ENG_VOICES] = ENG_VOICE_INIT(100, 100, 100, 100);   /* percent, square law (so the lower half has some travel) */
static uint8_t mix_mute[ENG_VOICES];

static void mix_apply(uint32_t v)
{
    uint32_t p = mix_vol[v];
    eng_voice_gain(v, mix_mute[v] ? 0 : (int32_t)((p * p * 65536u) / 10000u));
    fm1_led_key(14u + MIX_KEY_BIT[v], mix_mute[v]);        /* the mute key's LED is lit while its voice is muted */
}

static void mix_apply_all(void)
{
    uint32_t v;
    for (v = 0; v < ENG_VOICES; v++)
        mix_apply(v);
}

static void mix_row(uint32_t v, int32_t y)
{
    char line[40], num[12], *p = line;
    uint16_t col = VOICE_COLOR[v];
    uint32_t w = (uint32_t)mix_vol[v] * 216u / 100u;
    p = put(p, "K");
    *p++ = (char)('1' + v);
    if (ENG_VOICES > 1) {
        p = put(p, "  VOICE ");
        *p++ = (char)('1' + v);
    } else {
        p = put(p, "  LEVEL");
    }
    p = put(p, "  (OP");
    *p++ = (char)('1' + v);
    p = put(p, ": MUTE)");
    pad(p, line, 28);
    text5x7(12, (uint32_t)y, line, 1, C_DIM, C_BG);
    if (mix_mute[v]) {
        p = put(line, "MUTED");
    } else {
        fmt_int(num, mix_vol[v]);
        p = put(line, num);
        *p++ = '%';
    }
    pad(p, line, 14);
    text_mid(12, (uint32_t)y + 11u, line, mix_mute[v] ? C_RED : C_FG, C_BG);
    {                                   /* the polyphony at the right: MONO / POLY n (ALGO changes the selected voice's) */
        int n = voice_poly(v);
        if (n <= 1)
            p = put(line, n ? "MONO" : "-");
        else {
            fmt_int(num, n);
            p = put(line, "POLY ");
            p = put(p, num);
        }
        pad(p, line, 7);
        text_mid(165, (uint32_t)y + 11u, line, v == eng_voice() ? C_FG : C_DIM, C_BG);
    }
    lcd_fill(12, (uint32_t)y + 27u, w, 4, mix_mute[v] ? C_DIM : col);
    lcd_fill(12 + w, (uint32_t)y + 27u, 216u - w, 4, 0x2104u);
}

#if ENG_VOICES == 1
/* the one-voice build's second mixer row: the patch's MORPH position (the Main module's parameter; K2) */
static void morph_row(int32_t y)
{
    char line[40], num[12], *p;
    int m = eng_find(T_FM1), has = eng_has_morph();
    uint32_t pct = m >= 0 ? (uint32_t)clampi(eng_get_param((uint32_t)m, FM1_P_MORPH), 0, 65536) * 100u / 65536u : 0u, w = pct * 216u / 100u;
    p = put(line, "K2  MORPH  (A > B OF THE PATCH)");
    pad(p, line, 28);
    text5x7(12, (uint32_t)y, line, 1, C_DIM, C_BG);
    if (!has)
        p = put(line, "NO B SIDE");
    else {
        fmt_int(num, (int32_t)pct);
        p = put(line, num);
        *p++ = '%';
    }
    pad(p, line, 14);
    text_mid(12, (uint32_t)y + 11u, line, has ? C_FG : C_DIM, C_BG);
    lcd_fill(12, (uint32_t)y + 27u, w, 4, has ? C_ACC : C_DIM);
    lcd_fill(12 + w, (uint32_t)y + 27u, 216u - w, 4, 0x2104u);
}

/* the one-voice build's third row: the patch's voicing (the Main module's LEGATO on K3, PRIORITY on K4; main.c choice_turn) */
static void voicing_row(int32_t y)
{
    char line[40], *p;
    int m = eng_find(T_FM1);
    const def_t *d = &DEFS[T_FM1];
    uint32_t j;
    p = put(line, "K3  LEGATO      K4  PRIORITY");
    pad(p, line, 28);
    text5x7(12, (uint32_t)y, line, 1, C_DIM, C_BG);
    for (j = 0; j < 2u; j++) {
        uint32_t par = j ? FM1_P_PRIORITY : FM1_P_LEGATO;
        int32_t c = m >= 0 ? clampi(round_q16(eng_get_param((uint32_t)m, par)), 0, 2) : 0;
        p = put(line, m >= 0 ? d->pchoice[par][c] : "-");
        pad(p, line, 9);
        text_mid(12u + 96u * j, (uint32_t)y + 11u, line, m >= 0 ? C_FG : C_DIM, C_BG);
    }
}
#endif

static void mixer_draw(int full)
{
    uint32_t v;
    if (full)
        text5x7(12, 226, ENG_VOICES > 1 ? "K1-4: LEVEL  OP1-4: MUTE  ALGO: POLY" : "K1 LEVEL K2 MORPH OP1 MUTE ALGO POLY", 1, 0x4208u, C_BG);
    for (v = 0; v < ENG_VOICES; v++)
        mix_row(v, 32 + 48 * (int32_t)v);
#if ENG_VOICES == 1
    morph_row(80);
    voicing_row(128);
#endif
}

static void mix_turn(uint32_t v, int32_t clicks, int fast)
{
    int32_t x = (int32_t)mix_vol[v] + clicks * (fast ? 5 : 1);
    mix_vol[v] = (uint8_t)(x < 0 ? 0 : x > 100 ? 100 : x);
    mix_apply(v);
    if (!ui_dirty)
        ui_dirty = 1;
}

static void mix_toggle(uint32_t v)
{
    mix_mute[v] ^= 1u;
    mix_apply(v);
    if (!ui_dirty)
        ui_dirty = 1;
}

/* ---- settings menu */

enum { MR_LEDS, MR_CPU, MR_ACCEL, MR_OCT, MR_CH1, MR_CH2, MR_CH3, MR_CH4, MR_CLOCK, MR_PROG, MR_VERSION, MR_PEAK, MR_UPDATE, MR_DEFAULTS, MR_COUNT };
enum { MT_DISPLAY, MT_CONTROL, MT_MIDI, MT_SYSTEM, MT_MANUAL, MT_COUNT };   /* (MANUAL has no rows: a text) */
#define MT_NONE MT_COUNT                         /* the tab of a row this build has not (a channel row of a voice it lacks): never shown */
#define CH_TAB(v) ((v) < ENG_VOICES ? MT_MIDI : MT_NONE)
#if ENG_VOICES > 1
#define CH_ROW_NAMES "V1 CHANNEL", "V2 CHANNEL", "V3 CHANNEL", "V4 CHANNEL"
#else
#define CH_ROW_NAMES "MIDI CHANNEL", "", "", ""
#endif
static const char *const ROW_NAME[MR_COUNT] = {"LEDS", "CPU IN BAR", "KNOB ACCEL", "OCTAVE", CH_ROW_NAMES, "CLOCK IN", "PROG CHANGE",
                                              "VERSION", "CPU PEAK", "UPDATE MODE", "DEFAULTS"};
static const uint8_t ROW_TAB[MR_COUNT] = {MT_DISPLAY, MT_DISPLAY, MT_CONTROL, MT_CONTROL, CH_TAB(0), CH_TAB(1), CH_TAB(2), CH_TAB(3), MT_MIDI, MT_MIDI, MT_SYSTEM, MT_SYSTEM, MT_SYSTEM, MT_SYSTEM};
static const char *const TAB_NAME[MT_COUNT] = {"DISPLAY", "CONTROL", "MIDI", "SYSTEM", "MANUAL"};

static uint8_t menu_tab, menu_sel = MR_LEDS;     /* the tab and the selected row (a row number) */
static uint32_t cpu_peak;                       /* the highest CPU % since boot */
static uint32_t update_arm;                     /* UPDATE MODE / DEFAULTS: fm1_ms | 1 of the first OCT+ (the row is menu_sel) */

static uint32_t menu_first(uint32_t tab)
{
    uint32_t r = 0;
    while (r < MR_COUNT && ROW_TAB[r] != tab)
        r++;
    return r < MR_COUNT ? r : 0u;                 /* (the manual has no rows) */
}

static uint32_t menu_count(uint32_t tab)
{
    uint32_t r, n = 0;
    for (r = 0; r < MR_COUNT; r++)
        n += ROW_TAB[r] == tab;
    return n;
}

static uint32_t menu_row_at(uint32_t tab, uint32_t k)   /* the k-th row of the tab (its rows need not be contiguous: CH_TAB) */
{
    uint32_t r;
    for (r = 0; r < MR_COUNT; r++)
        if (ROW_TAB[r] == tab && k-- == 0u)
            return r;
    return menu_first(tab);
}

static uint32_t menu_pos(uint32_t row)                  /* the position of a row within its tab */
{
    uint32_t r, k = 0;
    for (r = 0; r < row; r++)
        k += ROW_TAB[r] == ROW_TAB[row];
    return k;
}

static void menu_value(uint32_t row, char *out)
{
    static const char *const ONOFF[2] = {"OFF", "ON"};
    char *p = out;
    switch (row) {
    case MR_LEDS: p = put(p, cfg.leds == 0 ? "OFF" : cfg.leds == 1 ? "DIM LOW" : "DIM HIGH"); break;
    case MR_CPU: p = put(p, ONOFF[cfg.cpu_bar]); break;
    case MR_ACCEL: p = put(p, ONOFF[cfg.accel]); break;
    case MR_OCT:
        if (octave > 0)
            *p++ = '+';
        fmt_int(p, octave);
        p += str_len(p);
        break;
    case MR_CH1:
    case MR_CH2:
    case MR_CH3:
    case MR_CH4: {
        uint32_t c = cfg.ch[row - MR_CH1];
        if (!c) {
            p = put(p, "OMNI");
        } else {
            fmt_int(p, (int32_t)c);
            p += str_len(p);
        }
        break;
    }
    case MR_CLOCK: p = put(p, ONOFF[cfg.clock_in]); break;
    case MR_PROG: p = put(p, ONOFF[cfg.prog_chg]); break;
    case MR_VERSION: p = put(p, FELUCCA_VERSION); break;
    case MR_PEAK:
        fmt_int(p, (int32_t)cpu_peak);
        p += str_len(p);
        *p++ = '%';
        break;
    default: p = put(p, update_arm && row == menu_sel ? "OCT+ AGAIN" : "OCT+ TWICE"); break;
    }
    *p = 0;
}

static void menu_row_draw(uint32_t row, uint32_t y, int hot)
{
    char name[20], val[16], *p;
    uint32_t w;
    uint16_t bg = hot ? 0x2104u : C_BG;
    lcd_fill(0, y, 240, 22, bg);
    p = put(name, ROW_NAME[row]);
    *p = 0;
    text_mid(12, y + 5u, name, hot ? C_FG : C_DIM, bg);
    if (hot)
        lcd_fill(0, y, 4, 22, C_ACC);
    menu_value(row, val);
    w = str_len(val) * 9u;
    text_mid(228u - w, y + 5u, val, hot ? C_ACC : C_FG, bg);
}

/* the MANUAL tab (manual.c): MAN_VIS lines from man_top, SELECT scrolls */
#include "manual.c"
#define MAN_Y 62u
#define MAN_VIS 16u
#define MAN_PITCH 10u
static uint32_t man_top;

static void manual_draw(void)
{
    uint32_t i, h = MAN_VIS * MAN_PITCH, thumb, ty;
    for (i = 0; i < MAN_VIS; i++) {
        uint32_t k = man_top + i, y = MAN_Y + i * MAN_PITCH, c = 0, nm = 0;
        char line[MAN_COLS + 2u], *p = line;
        uint16_t col = C_FG;
        const char *s = k < MAN_N ? MANUAL[k] : "";
        if (s[0] == '#')
            col = C_ACC;
        else if (s[0] == '~')
            col = C_DIM;
        else if (s[0] == ' ' && s[1] != ' ')         /* "NAME: text": the name (up to a colon in the first 18) in the accent colour */
            while (s[1u + c] && c < 18u && s[1u + c] != ':')
                c++;
        if (s[0] == ' ' && s[1] != ' ' && s[1u + c] == ':')
            nm = c + 1u;
        if (nm) {                                   /* the name with its colon, then the rest */
            uint32_t j;
            for (j = 0; j < nm; j++)
                line[j] = s[1u + j];
            line[nm] = 0;
            text5x7(12, y, line, 1, C_ACC, C_BG);
            p = put(line, s + 1u + nm);
            pad(p, line, MAN_COLS - nm);
            text5x7(12u + 6u * nm, y, line, 1, col, C_BG);
            continue;
        }
        if (s[0])
            p = put(p, s + 1);
        pad(p, line, MAN_COLS);
        text5x7(12, y, line, 1, col, C_BG);
    }
    thumb = h * MAN_VIS / MAN_N;                    /* the scroll bar at the right */
    thumb = thumb < 8u ? 8u : thumb;
    ty = MAN_N > MAN_VIS ? (h - thumb) * man_top / (MAN_N - MAN_VIS) : 0u;
    lcd_fill(232, MAN_Y, 4, h, 0x2104u);
    lcd_fill(232, MAN_Y + ty, 4, thumb, C_ACC);
}

static void manual_scroll(int32_t s)
{
    int32_t t = (int32_t)man_top + s, max = (int32_t)MAN_N - (int32_t)MAN_VIS;
    t = t > max ? max : t < 0 ? 0 : t;
    if ((uint32_t)t != man_top) {
        man_top = (uint32_t)t;
        ui_dirty = 1;
    }
}

static void menu_draw(int full)
{
    static uint8_t shown = 255;
    uint32_t t, r, n = menu_count(menu_tab), y = 72u;
    if (full || shown != menu_tab) {                /* (a new tab: the page is cleared, the hint changes) */
        lcd_fill(0, 24, 240, 216, C_BG);
        text5x7(12, 230, menu_tab == MT_MANUAL ? "SELECT: SCROLL      ALGO: TAB" : "ALGO: TAB  PRESET: ROW  K1-4: VALUE", 1, 0x4208u, C_BG);
        shown = menu_tab;
    }
    for (t = 0; t < MT_COUNT; t++)       /* the tabs: bars, the open one in the accent colour */
        lcd_fill(12u + t * 44u, 30, 40, 4, t == menu_tab ? C_ACC : 0x2104u);
    {
        char line[20], *p = put(line, TAB_NAME[menu_tab]);
        pad(p, line, 12);
        text_mid(12, 42, line, C_ACC, C_BG);
    }
    if (menu_tab == MT_MANUAL) {
        manual_draw();
        return;
    }
    for (r = 0; r < n; r++) {
        uint32_t row = menu_row_at(menu_tab, r);
        menu_row_draw(row, y + r * 24u, row == menu_sel);
    }
    if (y + n * 24u < 224u)
        lcd_fill(0, y + n * 24u, 240, 224u - (y + n * 24u), C_BG);   /* (the rows a longer tab had) */
}

static void menu_open(void)             /* via page_set (main.c): the tab and row it was left at */
{
    if (ROW_TAB[menu_sel] != menu_tab)
        menu_sel = (uint8_t)menu_first(menu_tab);
    update_arm = 0;
}

static void menu_set_row(uint32_t row, int32_t s)       /* s > 0: the next value, s < 0: the previous (stopping at the ends) */
{
    int up = s > 0;
    int32_t d = s > 0 ? 1 : -1;
    if (menu_tab == MT_MANUAL)
        return;                                     /* (no row: the buttons do nothing on the manual) */
    switch (row) {
    case MR_LEDS: {
        int32_t v = (int32_t)cfg.leds + d;
        cfg.leds = (uint8_t)(v < 0 ? 0 : v > 2 ? 2 : v);
        leds_avail();
        break;
    }
    case MR_CPU: cfg.cpu_bar = (uint8_t)up; header_draw(); break;
    case MR_ACCEL: cfg.accel = (uint8_t)up; break;
    case MR_OCT:
        octave += d;
        octave = octave < -3 ? -3 : octave > 3 ? 3 : octave;
        leds_octave();
        break;
    case MR_CH1:
    case MR_CH2:
    case MR_CH3:
    case MR_CH4: {
        int32_t v = (int32_t)cfg.ch[row - MR_CH1] + d;
        cfg.ch[row - MR_CH1] = (uint8_t)(v < 0 ? 0 : v > 16 ? 16 : v);
        break;
    }
    case MR_CLOCK: cfg.clock_in = (uint8_t)up; break;
    case MR_PROG: cfg.prog_chg = (uint8_t)up; break;
    case MR_UPDATE:
    case MR_DEFAULTS:
        if (!up)
            break;
        if (update_arm && fm1_ms - (update_arm & ~1u) < 3000u) {
            update_arm = 0;
            if (row == MR_UPDATE)
                uboot_now();
            else
                defaults_now();
        } else {
            update_arm = fm1_ms | 1u;
        }
        break;
    default: break;
    }
    ui_dirty = 1;
}

static void menu_move(int32_t s)                        /* PRESET / SELECT: the next / previous row of the tab */
{
    uint32_t n = menu_count(menu_tab), k = menu_pos(menu_sel);
    if (!n)
        return;
    k = (k + (s > 0 ? 1u : n - 1u)) % n;
    menu_sel = (uint8_t)menu_row_at(menu_tab, k);
    update_arm = 0;
    ui_dirty = 1;
}

static void menu_tab_go(int32_t s)                      /* ALGORITHM: the next / previous tab */
{
    uint32_t t = (menu_tab + (s > 0 ? 1u : MT_COUNT - 1u)) % MT_COUNT;
    menu_tab = (uint8_t)t;
    menu_sel = (uint8_t)menu_first(t);
    update_arm = 0;
    ui_dirty = 1;
}

/* the knobs while the menu is open: st[] as in knobs_poll */
static void menu_knobs(const int32_t *st)
{
    uint32_t k;
    if (st[1])
        menu_tab_go(st[1]);
    if (menu_tab == MT_MANUAL) {                    /* the manual: SELECT (and PRESET) scroll */
        manual_scroll(st[0] + st[6]);
        return;
    }
    if (st[6])
        menu_move(st[6]);
    else if (st[0])
        menu_move(st[0]);
    for (k = 0; k < 4u; k++)
        if (st[2u + k])
            menu_set_row(menu_sel, st[2u + k]);
}

/* the CPU load in the bar: the peak ISR time of the last half second, in % of the 128 frame half buffer (2.9 ms) */
static void cpu_poll(void)
{
    static uint32_t t0;
    uint32_t pct;
    if (fm1_ms - t0 < 500u)
        return;
    t0 = fm1_ms;
    pct = eng_us_max * 100u / 2902u;
    eng_us_max = 0;
    if (pct > 999u)
        pct = 999u;
    if (pct > cpu_peak)
        cpu_peak = pct;
    if (pct != cpu_pct) {
        cpu_pct = pct;
        if (cfg.cpu_bar && !msg_until && !load_err)
            header_draw();
        if (page == PAGE_MENU && ROW_TAB[MR_PEAK] == menu_tab && !ui_dirty)
            ui_dirty = 1;
    }
}
