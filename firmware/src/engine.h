/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 morgulbrut */
/* Fixed-point patch engine: the C port of web/src/engine.ts and modules.ts. Integer only (the FM-1 has no FPU).
 * Signals and parameters are Q16.16 (1.0 = 65536); the sample rate is ENG_SR. ENG_VOICES patches play at once (the
 * panel's "voices"; 1 unless the build says otherwise). Polyphony is per poly group (a poly assembly of the editor): up to
 * POLY_MAX_GROUPS per patch, each running its modules once per part (1..ENG_MAX_PARTS), as the reference. */
#pragma once
#include <stdint.h>

#define ENG_SR 44100u
#define ENG_BLOCK 128u
#define ENG_ONE 65536
#define ENG_PATCH_VERSION 21
#define ENG_PATCH_COMPAT_VERSION 21
#define ENG_MAX_PARTS 8               /* parts of a poly group (notes it plays at once) */
#define ENG_GROUP_REC (4u + 5u * ENG_MAX_PARTS)   /* a poly group record: parts, assign, legato, priority, five flaw bytes per part (patchbin.ts GROUP_REC) */

/* where the module records of a patch binary start: after the 8 header bytes, the poly groups' records (ENG_GROUP_REC each,
 * header byte 3 = their count) and, with any group, one membership byte per module. 0 if the binary is too short. */
static inline uint32_t eng_records_at(const uint8_t *p, uint32_t len)
{
    uint32_t at;
    if (len < 8u)
        return 0;
    at = 8u + ENG_GROUP_REC * p[3] + (p[3] ? p[2] : 0u);
    return at <= len ? at : 0;
}

/* Install a patch from its binary form (web/src/patchbin.ts) into the selected voice. 0 on success, negative on error
 * (the voice is then silent). Resets all module state. Never call while eng_render runs (stop the audio ISR's call first). */
int eng_load(const uint8_t *p, uint32_t len);
void eng_set_param(uint32_t module, uint32_t param, int32_t q16);
uint32_t delay_div(int32_t time_q16);                               /* the note length (DELAY_DIV_*) a synced delay's time value selects */
int32_t eng_get_param(uint32_t module, uint32_t param);
int32_t eng_get_eff(uint32_t module, uint32_t param);               /* what the last block used: base + modulation */
void eng_set_att(uint32_t module, uint32_t input, int32_t q16);      /* attenuverter of p1 / p2, Q16 */
int32_t eng_att(uint32_t module, uint32_t input);
/* a macro range of input 0 / 1 (p1 / p2) on a parameter: the input's value lands between lo and hi (0..255 of the
 * parameter's range, octaves for a log one) instead of adding to the base; on 0 removes it. 0 = no room / bad arguments */
int eng_set_range(uint32_t module, uint32_t input, uint32_t param, int on, uint32_t lo, uint32_t hi);
/* the range of input 0 / 1 on a parameter, 1 if there is one (lo / hi as above) */
int eng_range(uint32_t module, uint32_t input, uint32_t param, uint32_t *lo, uint32_t *hi);
void eng_set_bypass(uint32_t module, int on);                        /* bypass: the outputs carry the through input (defs.h thru) or silence; the state is kept */
int eng_bypass(uint32_t module);
/* the patch has a morph B set (the Main module's MORPH parameter fades every parameter from A to B) */
int eng_has_morph(void);
int eng_nmodules(void);
int eng_ncables(void);
void eng_cable(uint32_t i, uint32_t *from, uint32_t *from_port, uint32_t *to, uint32_t *to_port);   /* cable i of the patch */
int eng_type(uint32_t module);                                       /* defs.h T_*, -1 if no such module */
/* the matrix: bit mask of the parameters source s (0 p1, 1 p2, 2..5 knobs k1..k4) controls; 0 on modules without a matrix */
uint32_t eng_map(uint32_t module, uint32_t source);
/* the parameters knob k (0..3) changes while the module is selected: its matrix column, and on the modules without a
 * matrix (fm1, output) the k-th parameter */
uint32_t eng_knob_mask(uint32_t module, uint32_t knob);
/* the FM-1 panel module whose knob k drives parameter j of `module` through a cable (then the knob, not the parameter, is turned), else -1 */
int eng_knob_panel(uint32_t module, uint32_t knob, uint32_t j);
/* the value of a parameter after `clicks` knob clicks of `unit_per_click` (Q16 fraction of the range; octaves for the cutoff) */
int32_t eng_step_param(uint32_t module, uint32_t param, int32_t clicks, int32_t unit_per_click);
int eng_param_is_log(uint32_t module, uint32_t param);
/* index of the first module of a type (defs.h T_*), -1 if the patch has none */
int eng_find(uint32_t type);
/* the parts of the patch's first poly group (1 without one: everything plays the shared keyboard), 0 if none is loaded */
int eng_parts(void);
int eng_groups(void);                                                /* the poly groups of the loaded patch */
/* a setting of poly group g (0 = the first): ENG_POLY_* (assign, legato, priority 0..2), -1 if none.
 * eng_poly_set changes all but the parts at once (0 = refused); the parts need a reload (the binary's group record). */
enum { ENG_POLY_PARTS, ENG_POLY_ASSIGN, ENG_POLY_LEGATO, ENG_POLY_PRIORITY, ENG_NPOLY };
int eng_poly_get(uint32_t g, uint32_t field);
int eng_poly_set(uint32_t g, uint32_t field, uint32_t v);
void eng_note_on(uint32_t note, int32_t vel_q16);
void eng_note_off(uint32_t note);
void eng_all_notes_off(void);
/* the voices (patches that play together): the calls above and the patch / parameter calls act on the selected one; the
 * _v calls name the voice (the arpeggiator plays its own). eng_render mixes all voices. The memories (signal buffers,
 * module instances, delay / reverb / string / chorus lines) are pools shared by the voices: a patch loads when enough is
 * free (engine.c). */
#ifndef ENG_VOICES
#define ENG_VOICES 1                  /* patches that play at once, voices 1..ENG_VOICES (build switch: -DENG_VOICES=4 for the four-voice panel) */
#endif
#if ENG_VOICES < 1 || ENG_VOICES > 4
#error "ENG_VOICES is 1..4 (the panel has four voice colours, mute keys and channel rows)"
#endif
/* an initialiser with one entry per voice: ENG_VOICE_INIT(a, b, c, d) is {a} .. {a, b, c, d} (entries with commas go
 * through a macro of their own, so the commas are inside parentheses) */
#if ENG_VOICES == 1
#define ENG_VOICE_INIT(a, b, c, d) {a}
#elif ENG_VOICES == 2
#define ENG_VOICE_INIT(a, b, c, d) {a, b}
#elif ENG_VOICES == 3
#define ENG_VOICE_INIT(a, b, c, d) {a, b, c}
#else
#define ENG_VOICE_INIT(a, b, c, d) {a, b, c, d}
#endif
void eng_voice_select(uint32_t v);
void eng_voice_gain(uint32_t v, int32_t q16);        /* the mixer: a voice's level, Q16 (0 = muted) */
uint32_t eng_voice(void);
void eng_note_on_v(uint32_t v, uint32_t note, int32_t vel_q16);
void eng_note_off_v(uint32_t v, uint32_t note);
void eng_all_notes_off_v(uint32_t v);
/* one clock tick (24 per quarter note); the Main module's clock output pulses once per block that saw one */
void eng_clock_tick(void);
/* the performance controls of a voice: ENG_CTL_BEND (-1..1 Q16: +-2 semitones on the Main module's pitch and its bend
 * output), ENG_CTL_MOD (the mod wheel, 0..1, the mod output), ENG_CTL_AT (channel aftertouch, 0..1, the at output) */
enum { ENG_CTL_BEND, ENG_CTL_MOD, ENG_CTL_AT, ENG_NCTL };
void eng_ctl_v(uint32_t v, uint32_t which, int32_t q16);
/* n frames of stereo, Q16, clamped to +-1.0; any n, processed in blocks of ENG_BLOCK */
void eng_render(int32_t *l, int32_t *r, uint32_t n);
