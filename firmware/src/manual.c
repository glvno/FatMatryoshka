/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 morgulbrut */
/* The manual page of the settings menu (MANUAL tab): a short text, one line per entry, at most MAN_COLS characters after
 * the marker. The first character is the style: '#' a heading (accent colour), ' ' text, '~' dim. The font has capitals
 * only. Keep it in step with the buttons (main.c), the MIDI handling (midi_drain) and the limits (engine.c, proto.c). */
#define MAN_COLS 35u

static const char *const MANUAL[] = {
    "#CONTROLS",
#if ENG_VOICES > 1
    " KEYS: 27 KEYS F3-G5, SELECTED VOICE",
    " OCT-/OCT+: OCTAVE (+-3)",
    " SEL: NEXT VOICE 1>2>3>4",
#else
    " KEYS: 27 KEYS F3-G5",
    " OCT-/OCT+: OCTAVE (+-3)",
    " SEL: UNUSED (ONE VOICE BUILD)",
#endif
    " HOME: TAP = MAIN PAGE, HOLD = MENU",
    " GLO: MIXER",
    " ARP/SEQ/LFO: MELODY/RHYTHM/CHAOS",
    " PLAY: START/STOP ARP OF THE VOICE",
    " SAVE: STORE THE WHOLE STATE",
    " FX: SELECTED MODULE ON/OFF",
    "   (BYPASS: IN > OUTS, OR SILENT)",
    " ENV EDIT REC: UNUSED",
    " SELECT: STEP THROUGH THE MODULES",
    " K1-K4: PARAMETERS OF THE MODULE",
    "   (MAIN MODULE: ITS K1-K4)",
    " PRESET: PREV/NEXT PATCH",
    " ALGO: TABS (IN THIS MENU)",
    " FAST TURN: STEPS X5 (KNOB ACCEL)",
#if ENG_VOICES > 1
    " MIXER: K1-K4 LEVEL, KEYS F# G# A#",
    "   C# (OP1-OP4) MUTE, LED = MUTED",
    "   ALGO: POLYPHONY OF THE VOICE 1-8",
#else
    " MIXER: K1 LEVEL, KEY F# (OP1) MUTE,",
    "   LED = MUTED, ALGO: POLYPHONY 1-8",
    "   K2: MORPH A > B (THE EDITOR SETS",
    "   THE B SIDE FROM ANOTHER PATCH)",
#endif
    "",
    "#MIDI MAPPING",
    " PORTS: USB (MODULAR-1) + TRS DIN",
#if ENG_VOICES > 1
    " ONE CHANNEL PER VOICE, DEFAULT 1-4",
    "   (OMNI = ALL, MIDI TAB)",
#else
    " CHANNEL: DEFAULT 1 (OMNI = ALL,",
    "   MIDI TAB)",
#endif
    " NOTE ON/OFF: PLAYS, VELOCITY USED",
    " CC 123: ALL NOTES OFF",
    " PROGRAM CHANGE N: PATCH N+1",
    " CLOCK (24 PPQN): MAIN CLOCK OUTPUT",
    " START/CONTINUE LET IT THROUGH,",
    "   STOP MUTES IT",
    " CLOCK SOURCE: LOWEST RUNNING ARP,",
    "   ELSE MIDI CLOCK",
    " BEND: +-2 ST ON PITCH, BEND OUT",
    " CC 1: MOD OUT, AFTERTOUCH: AT OUT",
    " CC 16-19: MAIN K1-K4, CC 20: MORPH",
    " OTHER CC: NOT MAPPED",
    " SYSEX: EDITOR LINK (USB)",
    "",
    "#EDITOR",
    " WIGGISMODULAR.GITHUB.IO/MODULAR-1",
    " CHROME OR EDGE. BUILD PATCHES,",
#if ENG_VOICES > 1
    " SEND TO THE SELECTED VOICE,",
#else
    " SEND PATCHES TO THE FM-1,",
#endif
    " PATCH BANK, FIRMWARE (FLASH TAB).",
    " ARP SETTINGS: ALSO FROM THE EDITOR",
    "   (SAVED WITH THE PATCH THERE)",
    " BRACKET ON A KNOB BAR: THE TRAVEL",
    "   OF A MACRO RANGE (EDITOR MATRIX)",
    " CONNECT ONLY WHEN NEEDED: CHROMIUM",
    "   CAN CRASH WHEN THE FM-1 RESETS",
    "",
    "#MEMORY",
#if ENG_VOICES > 1
    " PER VOICE: 32 MODULES, 192 CABLES,",
    "   PATCH MAX 3072 BYTES, 1-8 NOTES",
    " SHARED BY THE 4 VOICES: 108 SIGNAL",
    "   BUFFERS, 72 MODULE INSTANCES,",
    "   4 DELAYS (MAX 521 MS, PING-PONG",
    "   HALVES IT), 2 REVERBS, 6 STRINGS,",
    "   1 CHORUS. NO ROOM = NOT LOADED",
    " 1 ARP PER VOICE, SCALE FROM V1",
    " PATCH BANK: 32 SLOTS",
    " SAVE: 3840 BYTES FOR 4 PATCHES",
    "   + ARPS, ELSE ERROR",
#else
    " PATCH: 32 MODULES, 192 CABLES,",
    "   MAX 3072 BYTES, 1-8 NOTES",
    " 255 SIGNAL BUFFERS, 128 MODULE",
    "   INSTANCES, 1 DELAY (MAX 521 MS,",
    "   PING-PONG HALVES IT), 1 REVERB,",
    "   8 STRINGS, 1 CHORUS, 1 GRANULAR",
    "   (1 S). NO ROOM = NOT LOADED",
    " PATCH BANK: 32 SLOTS",
    " SAVE: 3840 BYTES FOR THE PATCH",
    "   + ARP, ELSE ERROR",
#endif
    " NO FPU: FIXED POINT AUDIO. CPU AT",
    "   TOP RIGHT, NEAR 100% = DROP A",
    "   VOICE OR A MODULE",
};
#define MAN_N ((uint32_t)(sizeof MANUAL / sizeof MANUAL[0]))
