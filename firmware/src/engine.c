/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 morgulbrut */
/* Fixed-point patch engine, see engine.h. The reference is web/src/engine.ts / modules.ts; formulas are kept
 * line by line where possible. Polyphony as in engine.ts: a per-voice module has one instance (inst_t) per voice, a
 * shared one (delay, reverb, output, and whatever hears no pitch / gate / vel) has one and sums the voices it reads. Number formats: signals, parameters Q16.16; oscillator phase u32 (2^32 = 1 cycle);
 * filter coefficients Q24; envelope level and rates Q30. Build: -DENG_POOL=... places the big buffers (device:
 * the .pool section). Needs 64-bit multiply (hardware) and, at block rate and on waveform edges, 64/32 division. */
#include "engine.h"
#include "defs.h"
#include "dsp_tables.h"
#include "wt_tables.h"

#ifndef ENG_POOL
#define ENG_POOL
#endif

/* Per voice (a patch): modules, cables, summed inputs. The memories below them are one pool for all ENG_VOICES voices:
 * each slot has an owner, a load frees the loading voice's slots and takes free ones (slot_take), so a big polyphonic
 * patch on one voice and small ones on the others share what the FM-1 has. A patch that finds no free slot does not load
 * (-4 lines, -6 buffers, -7 instances): NO ROOM on the panel, the voice falls back to its old patch.
 * The pool sizes follow the voice count (engine.h ENG_VOICES): the one-voice build gives its one patch more signal
 * buffers and instances and keeps one delay and one reverb (docs/HANDOFF.md); the four-voice build has the sizes of
 * the 1.0.2 panel. Keep DEVICE in web/src/patchbin.ts, the HELLO reply (proto.c) and the MEMORY lines of manual.c in step. */
#define ENG_MAX_MODULES 32          /* per voice */
#define ENG_MAX_CABLES 192
#define MAX_SUM 128                 /* summed inputs per voice (an input of an instance with two or more sources) */
#define MAX_SRC 256                 /* their sources: a shared input reading a per-note output has one per note */
#if ENG_VOICES == 1
#define ENG_MAX_INST 128            /* module instances: a shared module has one, a per-note module one per note */
#define ENG_NBUF 255u               /* signal buffers of ENG_BLOCK samples (a connected output, a summed input) */
#define ENG_NDELAY 1                /* delay lines */
#define ENG_NREV 1                  /* reverb memories */
#define ENG_NSTRING 8               /* string lines (a per-note module: one per note) */
#define ENG_NCHORUS 1               /* chorus lines (a shared module, like the delay) */
#else
#define ENG_MAX_INST 96             /* module instances, all voices: a shared module has one, a per-note module one per note */
#define ENG_NBUF 128u               /* signal buffers of ENG_BLOCK samples, all voices (a connected output, a summed input) */
#define ENG_NDELAY 4                /* delay lines, all voices (one each when every voice has a delay) */
#define ENG_NREV 2                  /* reverb memories, all voices */
#define ENG_NSTRING 6               /* string lines, all voices (a per-note module: one per note) */
#define ENG_NCHORUS 1               /* chorus lines, all voices (a shared module, like the delay) */
#endif
#define RV_LEN 5934u                /* the four combs (1116 1188 1277 1356) and two allpasses (556 441), int16 Q13 */
#define DELAY_LEN 23000u            /* 521 ms (the reference engine, web/src/modules.ts, has the same length; ping-pong halves it) */
#define STR_LEN 1104u               /* ceil(ENG_SR / 40) + 1: the lowest string is 40 Hz, as the reference */
#define CH_LEN 927u                 /* ceil(ENG_SR * 0.021): 12 ms +- 8 ms of sweep */
#define MAX_HELD 16

#define INC_C4 25480119u            /* 261.6255653 Hz at ENG_SR, u32 phase per sample */
#define DT_MAX 1932735283u          /* 0.45 of a cycle per sample (the reference limits osc to 0.45, cutoff to 0.45 sr) */
#define TURN_PER_RAD 683565276u     /* 2^32 / 2 pi */

typedef int32_t esig_t;

static inline int32_t mulq(int32_t a, int32_t b, unsigned s) { return (int32_t)(((int64_t)a * b) >> s); }
static inline int32_t mul16(int32_t a, int32_t b) { return mulq(a, b, 16); }
/* rounded to nearest: no bias, which the filter's integrators would turn into a DC offset at low cutoffs */
static inline int32_t mulr(int32_t a, int32_t b, unsigned s) { return (int32_t)(((int64_t)a * b + ((int64_t)1 << (s - 1))) >> s); }
static inline int32_t clampi(int32_t v, int32_t lo, int32_t hi) { return v < lo ? lo : v > hi ? hi : v; }

/* ------------------------------------------------------------------ number helpers */

/* base * 2^(x / 65536), saturating at 2^32 - 1. base: a phase increment, x: octaves Q16.16 */
static uint32_t exp2_scale(uint32_t base, int32_t x)
{
    int32_t n = x >> 16;
    uint32_t fr = (uint32_t)x & 0xFFFFu, i = fr >> 8, r = fr & 255u;
    uint32_t m = EXP2_T[i] + (uint32_t)(((uint64_t)(EXP2_T[i + 1u] - EXP2_T[i]) * r) >> 8);   /* Q28, 1..2 */
    uint64_t v = ((uint64_t)base * m) >> 28;
    if (n >= 0) {
        if (n >= 32 || v >= (1ull << (32 - n)))
            return 0xFFFFFFFFu;
        return (uint32_t)(v << n);
    }
    return -n >= 64 ? 0u : (uint32_t)(v >> -n);
}

/* sin(2 pi phase), phase u32 turns -> Q16 */
static int32_t sin_turn(uint32_t ph)
{
    uint32_t i = ph >> 22, fr = (ph >> 6) & 0xFFFFu;
    int32_t s0 = SIN_T[i], s1 = SIN_T[i + 1u];
    return (s0 + (int32_t)(((int64_t)(s1 - s0) * fr) >> 16)) >> 14;
}

/* 1 / (d / 2^24) in Q24 for d (Q24) in [2^24, 2^30): 32-bit divide for a first estimate, one Newton step */
static int32_t recip24(int32_t d)
{
    int32_t x = (int32_t)(0xFFFFFFFFu / ((uint32_t)d >> 8)) << 8;
    int32_t t = (int32_t)(((int64_t)d * x) >> 24);
    return (int32_t)(((int64_t)x * ((2 << 24) - t)) >> 24);
}

static inline int32_t round_q16(int32_t v) { return (v + 32768) >> 16; }   /* Math.round for the integer params */

/* poly-BLEP residual, phase t and increment dt in u32 turns -> Q16 */
static int32_t poly_blep(uint32_t t, uint32_t dt)
{
    if (dt == 0u)
        return 0;
    if (t < dt) {
        int32_t u = (int32_t)(((uint64_t)t << 16) / dt);
        return 2 * u - (int32_t)(((int64_t)u * u) >> 16) - ENG_ONE;
    }
    if (t > 0u - dt) {
        int32_t u = (int32_t)(((uint64_t)(0u - t) << 16) / dt);      /* -(t - 1) / dt */
        return (int32_t)(((int64_t)u * u) >> 16) - 2 * u + ENG_ONE;
    }
    return 0;
}

/* the waveforms of modules.ts wave(): 0 sine, 1 triangle, 2 saw, 3 square. phase and pw in u32 turns */
static int32_t wave(int32_t kind, uint32_t ph, uint32_t dt, uint32_t pw)
{
    switch (kind) {
    case 0:
        return sin_turn(ph);
    case 1: {
        int32_t s = (int32_t)ph;
        uint32_t a = s < 0 ? 0u - (uint32_t)s : (uint32_t)s;     /* |phase - round(phase)| in 2^32 */
        return (int32_t)(a >> 14) - ENG_ONE;
    }
    case 2:
        return (int32_t)(ph >> 15) - ENG_ONE - poly_blep(ph, dt);
    default: {
        int32_t v = ph < pw ? ENG_ONE : -ENG_ONE;
        v += poly_blep(ph, dt);
        v -= poly_blep(ph - pw, dt);
        return v;
    }
    }
}


/* log2 of a Q16 value (or of any positive integer: the offset cancels in ratios), Q16 */
static int32_t log2_q16(uint32_t x)
{
    uint32_t n, m, i, r;
    if (!x)
        return -(32 << 16);
    n = 31u - (uint32_t)__builtin_clz(x);
    m = (x << (31u - n)) & 0x7FFFFFFFu;                  /* the mantissa's fraction, 31 bits */
    i = m >> 23;
    r = (m >> 7) & 0xFFFFu;
    return (int32_t)(n << 16) + (int32_t)(LOG2_T[i] + (uint32_t)(((uint64_t)(LOG2_T[i + 1u] - LOG2_T[i]) * r) >> 16));
}

/* 2^(e / 65536) as an integer (a Q16 value), saturating */
static uint32_t exp2_q16(int32_t e)
{
    int32_t n = e >> 16;
    uint32_t fr = (uint32_t)e & 0xFFFFu, i = fr >> 8, r = fr & 255u;
    uint64_t m = EXP2_T[i] + (uint32_t)(((uint64_t)(EXP2_T[i + 1u] - EXP2_T[i]) * r) >> 8);   /* Q28 */
    if (n < 0)
        return 0;
    if (n > 31)
        return 0x7FFFFFFFu;
    m = (m << n) >> 28;
    return m > 0x7FFFFFFFu ? 0x7FFFFFFFu : (uint32_t)m;
}

static uint32_t isqrt32(uint32_t x)
{
    uint32_t r = 0, b = 1u << 30;
    while (b > x)
        b >>= 2;
    for (; b; b >>= 2) {
        if (x >= r + b) {
            x -= r + b;
            r = (r >> 1) + b;
        } else
            r >>= 1;
    }
    return r;
}

/* a parameter's position in its range as Q16 0..1: linear, or logarithmic for the cutoff (plog 2: bent, the position is
 * the square root of the octave fraction, so the low end gets more of the knob) */
static int32_t unit_of(const def_t *d, uint32_t j, int32_t v)
{
    int32_t lo = d->pmin[j], hi = d->pmax[j];
    v = clampi(v, lo, hi);
    if (d->plog && d->plog[j]) {
        int32_t l0 = log2_q16((uint32_t)lo);
        int32_t t = (int32_t)(((int64_t)(log2_q16((uint32_t)v) - l0) << 16) / (log2_q16((uint32_t)hi) - l0));
        return d->plog[j] == 2 ? (int32_t)isqrt32((uint32_t)t << 16) : t;
    }
    return (int32_t)(((int64_t)(v - lo) << 16) / (hi - lo));
}

static int32_t value_of(const def_t *d, uint32_t j, int32_t u)
{
    int32_t lo = d->pmin[j], hi = d->pmax[j];
    u = clampi(u, 0, ENG_ONE);
    if (d->plog && d->plog[j]) {
        int32_t l0 = log2_q16((uint32_t)lo), t = d->plog[j] == 2 ? (int32_t)(((int64_t)u * u) >> 16) : u;
        return clampi((int32_t)exp2_q16(l0 + (int32_t)(((int64_t)t * (log2_q16((uint32_t)hi) - l0)) >> 16)), lo, hi);
    }
    return lo + (int32_t)(((int64_t)u * (hi - lo)) >> 16);
}

/* ------------------------------------------------------------------ engine state */

/* one running copy of a module: its buffers, effective parameters and DSP state. A shared module has one, a per-voice
 * module one per voice (engine.ts: Inst) */
typedef struct {
    uint8_t sum0, nsum;              /* its summed inputs in E.sum[] */
    int32_t eff[MAX_PAR];
    const esig_t *in[MAX_IN];
    esig_t *out[MAX_OUT];
    union {
        struct { uint32_t phase; int32_t s1, y1, y2, pm1, xb, ap[8]; uint32_t ph[4]; } osc;   /* s1: last sync sample; FM mode: feedback history, pm interpolation, decimator; ph: unison voices 2..5 (plain path) */
        struct { uint32_t phase, seed; int32_t held; uint32_t since; int32_t interval; uint16_t ticks; uint8_t clk_hi, rst_hi; } lfo;   /* interval: clock edge distance in samples, Q8 */
        struct { int32_t y; } gld;         /* Q24 */
        struct { uint32_t seed; int32_t y; } noise;   /* y: the colour one-pole, Q24 */
        struct { int32_t ic1[3], ic2[3]; } vow;       /* three band passes, Q20 */
        struct { uint32_t phase; int32_t ap[8], fbv; } phs;   /* the sweep LFO, x1 / y1 of the four allpasses, the feedback sample */
        struct { int32_t held, cnt; } crush;
        struct { int32_t v; uint8_t stage, prev; } adsr;
        struct { int32_t ic1, ic2, jc1, jc2; } flt;   /* stage 1 and stage 2 integrators */
        struct { int32_t s[4]; } lad;                 /* the four one-pole states, Q20 */
        struct { int32_t env; } dyn;                  /* the peak follower, Q24 */
        struct { int16_t *buf; uint32_t w, t, seen, beat; uint32_t ring[DELAY_CLK_PPQN]; uint8_t prev; } dly;   /* t, ring, seen, beat: the clock tempo */
        struct { int16_t *buf; uint16_t ci[4], ai[2]; int32_t lp[4]; } rev;
        struct { int32_t v; uint32_t t; uint8_t stage, prev; } env;  /* Q30, like the ADSR; t: samples in the segment */
        struct { int16_t *buf; uint32_t w, seed; int32_t lp, s1, err, burst, blen; } str;   /* Q13 line with error feedback */
        struct { uint32_t phase; int32_t s1; } wt;
        struct { int16_t *buf; uint32_t w, phase; } ch;
        struct { uint32_t seed; int32_t c1, r1; int8_t pos, down; } seq;
        struct { int32_t count, c1, r1; } cdv;
        struct { int32_t v, c1; } sh;
        struct { int32_t rem, t1; } pls;
    } s;
} inst_t;

typedef struct {
    uint8_t type, conn;
    uint8_t inst0, ninst;            /* its instances in inst_pool[]: ninst > 1 = it runs once per voice (the panel too: its
                                        pitch / gate / vel are per voice, its knob outputs one buffer shared by its instances) */
    uint16_t map[6];                 /* the matrix: bit j of map[s] = source s controls parameter j. s: p1 p2 k1 k2 k3 k4 */
    int32_t att[2];                  /* attenuverters of p1, p2: Q16, -1..1 */
    int32_t par[MAX_PAR];
} node_t;

typedef struct {
    esig_t *dst;
    uint16_t first, n;       /* sources in sum_src[] */
} sum_t;

/* a note of a polyphonic patch: what the panel outputs plus what the allocator needs (engine.ts: VoiceState). (A "voice"
 * in the panel's words is a whole patch, eng_t; the notes within it are its polyphony.) */
typedef struct {
    int32_t pitch, gate, vel;
    uint8_t note, on, retrig;        /* on: a key holds it; retrig: taken over while sounding, the next block's gate starts low */
    uint32_t on_stamp, off_stamp;
} pv_t;

typedef struct {
    uint8_t loaded, nmod, nsum, norder, nout, nv, ninst;
    uint16_t nsrc;
    uint8_t order[ENG_MAX_MODULES], outputs[ENG_MAX_MODULES];
    uint8_t from_m[ENG_MAX_CABLES], from_p[ENG_MAX_CABLES], to_m[ENG_MAX_CABLES], to_p[ENG_MAX_CABLES];
    uint16_t ncab, nbuf, ndly, nrev, nstr, nch;
    node_t node[ENG_MAX_MODULES];
    sum_t sum[MAX_SUM];
    const esig_t *sum_src[MAX_SRC];
    struct { uint8_t note; int32_t vel; } held[MAX_HELD];
    uint8_t nheld;
    pv_t vc[ENG_MAX_POLY];
    uint32_t stamp;
    uint32_t clk_seen, clk_pulse;    /* the Main module's clock output: ticks seen so far, the pulse length of this block */
} eng_t;

/* the voices: one engine per patch that plays. E is the one the API calls act on (eng_voice_select; the panel code), the
 * audio ISR walks all of them and puts the pointer back. The clock is shared: ticks (24 ppqn) come from the arpeggiator
 * or MIDI in (eng_clock_tick). */
static eng_t EV[ENG_VOICES] ENG_POOL;
static eng_t *eng_p = EV;
#define E (*eng_p)
#define VOICE_NO ((uint32_t)(eng_p - EV))
static volatile uint32_t clk_ticks;

/* the memories, shared by the voices: slot i of a pool belongs to voice own[i] - 1 (0: free) */
static inst_t inst_pool[ENG_MAX_INST] ENG_POOL;
static uint8_t inst_own[ENG_MAX_INST];
static uint32_t cur_v;               /* the note whose instance is being rendered (0 for a shared module) */
static esig_t buf_pool[ENG_NBUF][ENG_BLOCK] ENG_POOL;
static uint8_t buf_own[ENG_NBUF];
static int16_t dly_pool[ENG_NDELAY][DELAY_LEN] ENG_POOL;
static uint8_t dly_own[ENG_NDELAY];
static int16_t rev_pool[ENG_NREV][RV_LEN] ENG_POOL;
static uint8_t rev_own[ENG_NREV];
static int16_t str_pool[ENG_NSTRING][STR_LEN] ENG_POOL;
static uint8_t str_own[ENG_NSTRING];
static int16_t ch_pool[ENG_NCHORUS][CH_LEN] ENG_POOL;
static uint8_t ch_own[ENG_NCHORUS];
static const esig_t zero_buf[ENG_BLOCK];
static esig_t dummy_out[ENG_BLOCK];

static void pool_free(uint8_t *own, uint32_t n)          /* the slots of the selected voice back to the pool */
{
    uint32_t i;
    for (i = 0; i < n; i++)
        if (own[i] == VOICE_NO + 1u)
            own[i] = 0;
}

static int slots_take(uint8_t *own, uint32_t n, uint32_t count)   /* `count` free slots in a row for the selected voice, -1 if none */
{
    uint32_t i, run = 0;
    for (i = 0; i < n; i++) {
        run = own[i] ? 0 : run + 1;
        if (run == count) {
            uint32_t k;
            for (k = i + 1 - count; k <= i; k++)
                own[k] = (uint8_t)(VOICE_NO + 1u);
            return (int)(i + 1 - count);
        }
    }
    return -1;
}

static int slot_take(uint8_t *own, uint32_t n) { return slots_take(own, n, 1); }

/* ------------------------------------------------------------------ patch loading */

static void visit(uint32_t id, uint8_t *st)
{
    uint32_t c;
    st[id] = 1;
    for (c = 0; c < E.ncab; c++) {
        if (E.to_m[c] != id)
            continue;
        if (st[E.from_m[c]] == 0)
            visit(E.from_m[c], st);
    }
    st[id] = 2;
    E.order[E.norder++] = (uint8_t)id;
}

static esig_t *buf_alloc(void)
{
    esig_t *b;
    uint32_t i;
    int k = slot_take(buf_own, ENG_NBUF);
    if (k < 0)
        return 0;
    E.nbuf++;
    b = buf_pool[k];
    for (i = 0; i < ENG_BLOCK; i++)
        b[i] = 0;
    return b;
}

static void init_state(const node_t *nd, inst_t *it)
{
    switch (nd->type) {
    case T_LFO:
        it->s.lfo.seed = 0x2545f491u;
        it->s.lfo.since = ENG_SR;
        break;
    case T_NOISE:
        it->s.noise.seed = 0x1234567u;
        break;
    case T_STRING:
        it->s.str.seed = 0x3779b97fu;
        it->s.str.blen = 1;
        break;
    case T_SEQ:
        it->s.seq.seed = 0x9e3779b9u;
        break;
    case T_CLKDIV:
        it->s.cdv.count = -1;
        break;
    default:
        break;
    }
}

/* does output port p of module m differ per note? (the panel's knobs and clock do not, its pitch / gate / vel / spread do) */
static int port_poly(uint32_t m, uint32_t p)
{
    const node_t *nd = &E.node[m];
    return nd->ninst > 1 && !(nd->type == T_FM1 && ((p >= FM1_O_K1 && p <= FM1_O_K4) || p == FM1_O_CLOCK));
}

/* the buffer of output p of module m as voice v sees it */
static esig_t *buf_of(uint32_t m, uint32_t p, uint32_t v)
{
    const node_t *nd = &E.node[m];
    return inst_pool[nd->inst0 + (nd->ninst > 1 ? v : 0)].out[p];
}

static inline int32_t rd32(const uint8_t *p)
{
    return (int32_t)((uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 | (uint32_t)p[3] << 24);
}

/* bytes a module record has beyond its type byte and parameters: the attenuverters and the matrix */
static inline uint32_t eng_record_extra(const def_t *d) { return d->cvbase >= 0 ? 20u : 0u; }

int eng_load(const uint8_t *p, uint32_t len)
{
    uint32_t i, j, c, k, v, at = 8, ncab, nv;
    uint8_t st[ENG_MAX_MODULES];
    E.loaded = 0;
    E.nheld = 0;
    E.stamp = 0;
    E.clk_seen = clk_ticks;
    E.clk_pulse = 0;
    for (v = 0; v < ENG_MAX_POLY; v++) {
        uint8_t *z = (uint8_t *)&E.vc[v];
        for (j = 0; j < sizeof E.vc[v]; j++)
            z[j] = 0;
    }
    pool_free(inst_own, ENG_MAX_INST);           /* what this voice's old patch held */
    pool_free(buf_own, ENG_NBUF);
    pool_free(dly_own, ENG_NDELAY);
    pool_free(rev_own, ENG_NREV);
    pool_free(str_own, ENG_NSTRING);
    pool_free(ch_own, ENG_NCHORUS);
    if (len < 8u || p[0] != 0xA1 || p[1] != ENG_PATCH_VERSION)
        return -1;
    E.nmod = p[2];
    nv = p[3] ? p[3] : 1u;                       /* 0: a patch from before polyphony */
    if (nv > ENG_MAX_POLY)
        nv = ENG_MAX_POLY;
    E.nv = (uint8_t)nv;
    ncab = (uint32_t)p[4] | (uint32_t)p[5] << 8;
    if (E.nmod > ENG_MAX_MODULES || ncab > ENG_MAX_CABLES)
        return -2;
    E.ncab = (uint16_t)ncab;
    E.nbuf = 0;
    E.ndly = 0;
    E.nrev = 0;
    E.nstr = 0;
    E.nch = 0;
    E.ninst = 0;
    for (i = 0; i < E.nmod; i++) {
        node_t *nd = &E.node[i];
        const def_t *d;
        uint8_t *z = (uint8_t *)nd;
        for (j = 0; j < sizeof *nd; j++)
            z[j] = 0;
        if (at >= len || p[at] >= N_TYPES)
            return -3;
        nd->type = p[at++];
        d = &DEFS[nd->type];
        if (at + eng_record_extra(d) + 4u * d->npar > len)
            return -3;
        for (j = 0; j < d->npar; j++, at += 4)
            nd->par[j] = rd32(p + at);
        if (d->cvbase >= 0) {
            nd->att[0] = rd32(p + at);
            nd->att[1] = rd32(p + at + 4);
            at += 8;
            for (j = 0; j < 6u; j++, at += 2)
                nd->map[j] = (uint16_t)((uint32_t)p[at] | (uint32_t)p[at + 1] << 8);
        }
        nd->ninst = 1;
    }
    if (at + 4u * ncab > len)
        return -3;
    for (c = 0; c < ncab; c++, at += 4) {
        uint8_t fm = p[at], fp = p[at + 1], tm = p[at + 2], tp = p[at + 3];
        if (fm >= E.nmod || tm >= E.nmod || fm == tm)
            return -5;
        if (fp >= DEFS[E.node[fm].type].nout || tp >= DEFS[E.node[tm].type].nin)
            return -5;
        E.from_m[c] = fm;
        E.from_p[c] = fp;
        E.to_m[c] = tm;
        E.to_p[c] = tp;
        E.node[tm].conn |= (uint8_t)(1u << tp);
    }
    /* which modules run once per voice (patch.ts voiceSplit): with several voices the panel's pitch / gate / vel are per
     * voice, and so is everything downstream of them except delay, reverb and output */
    if (nv > 1) {
        uint32_t grew;
        for (i = 0; i < E.nmod; i++)
            if (E.node[i].type == T_FM1)
                E.node[i].ninst = (uint8_t)nv;
        do {
            grew = 0;
            for (c = 0; c < ncab; c++) {
                node_t *t = &E.node[E.to_m[c]];
                if (t->ninst > 1 || t->type == T_DELAY || t->type == T_REVERB || t->type == T_CHORUS || t->type == T_OUTPUT)
                    continue;
                if (port_poly(E.from_m[c], E.from_p[c])) {
                    t->ninst = (uint8_t)nv;
                    grew = 1;
                }
            }
        } while (grew);
    }
    /* the instances: state, the delay / reverb / string / chorus memories from the shared pools */
    for (i = 0; i < E.nmod; i++) {
        node_t *nd = &E.node[i];
        int i0 = slots_take(inst_own, ENG_MAX_INST, nd->ninst);
        if (i0 < 0)
            return -7;
        nd->inst0 = (uint8_t)i0;
        E.ninst = (uint8_t)(E.ninst + nd->ninst);
        for (k = 0; k < nd->ninst; k++) {
            inst_t *it = &inst_pool[nd->inst0 + k];
            uint8_t *z = (uint8_t *)it;
            for (j = 0; j < sizeof *it; j++)
                z[j] = 0;
            init_state(nd, it);
            if (nd->type == T_REVERB) {
                int s = slot_take(rev_own, ENG_NREV);
                if (s < 0)
                    return -4;
                E.nrev++;
                it->s.rev.buf = rev_pool[s];
                for (j = 0; j < RV_LEN; j++)
                    it->s.rev.buf[j] = 0;
            }
            if (nd->type == T_DELAY) {
                int s = slot_take(dly_own, ENG_NDELAY);
                if (s < 0)
                    return -4;
                E.ndly++;
                it->s.dly.buf = dly_pool[s];
                it->s.dly.beat = ENG_SR / 2u;             /* 120 bpm until a clock has come in */
                for (j = 0; j < DELAY_LEN; j++)
                    it->s.dly.buf[j] = 0;
            }
            if (nd->type == T_STRING) {
                int s = slot_take(str_own, ENG_NSTRING);
                if (s < 0)
                    return -4;
                E.nstr++;
                it->s.str.buf = str_pool[s];
                for (j = 0; j < STR_LEN; j++)
                    it->s.str.buf[j] = 0;
            }
            if (nd->type == T_CHORUS) {
                int s = slot_take(ch_own, ENG_NCHORUS);
                if (s < 0)
                    return -4;
                E.nch++;
                it->s.ch.buf = ch_pool[s];
                for (j = 0; j < CH_LEN; j++)
                    it->s.ch.buf[j] = 0;
            }
        }
    }
    /* output buffers: one per connected output port and instance (a shared port of a per-voice module, the panel's
     * knobs, has one buffer in every instance), the dummy for the unconnected ports */
    for (i = 0; i < E.nmod; i++)
        for (k = 0; k < E.node[i].ninst; k++)
            for (j = 0; j < DEFS[E.node[i].type].nout; j++)
                inst_pool[E.node[i].inst0 + k].out[j] = dummy_out;
    for (c = 0; c < ncab; c++) {
        node_t *nd = &E.node[E.from_m[c]];
        uint32_t fp = E.from_p[c];
        if (inst_pool[nd->inst0].out[fp] != dummy_out)
            continue;
        if (port_poly(E.from_m[c], fp)) {
            for (k = 0; k < nd->ninst; k++)
                if (!(inst_pool[nd->inst0 + k].out[fp] = buf_alloc()))
                    return -6;
        } else {
            esig_t *b = buf_alloc();
            if (!b)
                return -6;
            for (k = 0; k < nd->ninst; k++)
                inst_pool[nd->inst0 + k].out[fp] = b;
        }
    }
    /* inputs of every instance: none -> zeros, one source -> that buffer itself, several -> a summing buffer. A per-voice
     * instance reads its own voice of a per-voice output; a shared module reads every voice of one (summed) */
    E.nsum = 0;
    E.nsrc = 0;
    for (i = 0; i < E.nmod; i++) {
        node_t *nd = &E.node[i];
        for (k = 0; k < nd->ninst; k++) {
            inst_t *it = &inst_pool[nd->inst0 + k];
            it->sum0 = E.nsum;
            for (j = 0; j < DEFS[nd->type].nin; j++) {
                uint32_t n = 0, first = E.nsrc;
                const esig_t *one = 0;
                for (c = 0; c < ncab; c++) {
                    if (E.to_m[c] != i || E.to_p[c] != j)
                        continue;
                    if (nd->ninst == 1 && port_poly(E.from_m[c], E.from_p[c])) {
                        for (v = 0; v < nv; v++, n++) {
                            if (E.nsrc >= MAX_SRC)
                                return -6;
                            one = E.sum_src[E.nsrc++] = buf_of(E.from_m[c], E.from_p[c], v);
                        }
                    } else {
                        if (E.nsrc >= MAX_SRC)
                            return -6;
                        one = E.sum_src[E.nsrc++] = buf_of(E.from_m[c], E.from_p[c], k);
                        n++;
                    }
                }
                if (n == 0) {
                    it->in[j] = zero_buf;
                } else if (n == 1) {
                    it->in[j] = one;
                    E.nsrc = (uint16_t)first;                /* not summed: the entry is not needed */
                } else {
                    esig_t *b = buf_alloc();
                    if (!b || E.nsum >= MAX_SUM)
                        return -6;
                    it->in[j] = b;
                    E.sum[E.nsum].dst = b;
                    E.sum[E.nsum].first = (uint16_t)first;
                    E.sum[E.nsum].n = (uint16_t)n;
                    E.nsum++;
                }
            }
            it->nsum = (uint8_t)(E.nsum - it->sum0);
        }
    }
    for (i = 0; i < E.nmod; i++)
        st[i] = 0;
    E.norder = 0;
    for (i = 0; i < E.nmod; i++)
        if (st[i] == 0)
            visit(i, st);
    E.nout = 0;
    for (i = 0; i < E.norder; i++)
        if (E.node[E.order[i]].type == T_OUTPUT)
            E.outputs[E.nout++] = E.order[i];
    E.loaded = 1;
    return 0;
}

int eng_poly(void) { return E.loaded ? E.nv : 0; }

void eng_set_att(uint32_t module, uint32_t input, int32_t q16)
{
    if (module < E.nmod && input < 2u)
        E.node[module].att[input] = q16;
}

/* what turning knob k (0..3) changes on a module: the matrix column of k1..k4, and on the modules that have no matrix
 * (fm1, output) the n-th parameter */
uint32_t eng_knob_mask(uint32_t module, uint32_t knob)
{
    const def_t *d;
    if (module >= E.nmod || knob >= 4u)
        return 0;
    d = &DEFS[E.node[module].type];
    if (d->cvbase >= 0)
        return E.node[module].map[2u + knob];
    return knob < d->npar ? 1u << knob : 0u;
}

/* Is parameter j of `module` driven by a cable from the FM-1 panel's knob k (a K1..K4 output into p1 or p2, whose matrix column
 * has j)? Then turning that knob while `module` is selected must move the panel's knob, not the base value: the two would add up
 * (and clamp), and the knob would seem to jam at the end of the range. Returns the panel's module index or -1. */
int eng_knob_panel(uint32_t module, uint32_t knob, uint32_t j)
{
    const def_t *d;
    uint32_t c;
    if (module >= E.nmod || knob >= 4u)
        return -1;
    d = &DEFS[E.node[module].type];
    if (d->cvbase < 0)
        return -1;
    for (c = 0; c < E.ncab; c++) {
        uint32_t pin;
        if (E.to_m[c] != module || E.to_p[c] < (uint32_t)d->cvbase || E.to_p[c] > (uint32_t)d->cvbase + 1u)
            continue;
        if (E.node[E.from_m[c]].type != T_FM1 || E.from_p[c] != FM1_O_K1 + knob)
            continue;
        pin = E.to_p[c] - (uint32_t)d->cvbase;
        if (E.node[module].map[pin] >> j & 1u)
            return (int)E.from_m[c];
    }
    return -1;
}

int eng_ncables(void) { return E.loaded ? E.ncab : 0; }
void eng_cable(uint32_t i, uint32_t *from, uint32_t *from_port, uint32_t *to, uint32_t *to_port)
{
    if (i >= E.ncab)
        return;
    *from = E.from_m[i];
    *from_port = E.from_p[i];
    *to = E.to_m[i];
    *to_port = E.to_p[i];
}

int eng_nmodules(void) { return E.loaded ? E.nmod : 0; }
int eng_type(uint32_t module) { return module < E.nmod ? E.node[module].type : -1; }
uint32_t eng_map(uint32_t module, uint32_t source)
{
    return module < E.nmod && source < 6u && DEFS[E.node[module].type].cvbase >= 0 ? E.node[module].map[source] : 0u;
}
int32_t eng_att(uint32_t module, uint32_t input)
{
    return module < E.nmod && input < 2u ? E.node[module].att[input] : 0;
}

void eng_set_param(uint32_t module, uint32_t param, int32_t q16)
{
    if (module < E.nmod && param < DEFS[E.node[module].type].npar)
        E.node[module].par[param] = q16;
}

/* for the knobs: a parameter moved by `clicks` steps of 1/100 of its range (octaves for the cutoff) */
int32_t eng_step_param(uint32_t module, uint32_t j, int32_t clicks, int32_t unit_per_click)
{
    const def_t *d;
    if (module >= E.nmod || j >= DEFS[E.node[module].type].npar)
        return 0;
    d = &DEFS[E.node[module].type];
    return value_of(d, j, unit_of(d, j, E.node[module].par[j]) + clicks * unit_per_click);
}

int eng_param_is_log(uint32_t module, uint32_t j)
{
    return module < E.nmod && j < DEFS[E.node[module].type].npar && DEFS[E.node[module].type].plog && DEFS[E.node[module].type].plog[j];
}

/* the value the module used in the last block: the base plus what the parameter inputs added */
int32_t eng_get_eff(uint32_t module, uint32_t param)
{
    return module < E.nmod && param < DEFS[E.node[module].type].npar ? inst_pool[E.node[module].inst0].eff[param] : 0;
}

int32_t eng_get_param(uint32_t module, uint32_t param)
{
    return module < E.nmod && param < DEFS[E.node[module].type].npar ? E.node[module].par[param] : 0;
}

int eng_find(uint32_t type)
{
    uint32_t i;
    if (!E.loaded)
        return -1;
    for (i = 0; i < E.nmod; i++)
        if (E.node[i].type == type)
            return (int)i;
    return -1;
}

/* ------------------------------------------------------------------ voices (engine.ts noteOn / noteOff) */

static int32_t note_pitch(uint32_t note)
{
    int32_t v = ((int32_t)note - 60) * 32768;      /* (note - 60) / 12 octaves = k * 65536 / 12 */
    return (v >= 0 ? v + 3 : v - 3) / 6;
}

/* mono: last note priority, legato (the gate stays up while any key is down) */
static void update_voice(void)
{
    pv_t *x = &E.vc[0];
    if (E.nheld) {
        x->pitch = note_pitch(E.held[E.nheld - 1].note);
        x->vel = E.held[E.nheld - 1].vel;
        x->gate = ENG_ONE;
        x->note = E.held[E.nheld - 1].note;
        x->on = 1;
    } else {
        x->gate = 0;
        x->on = 0;
    }
}

void eng_note_off(uint32_t note)
{
    uint32_t i, k = 0;
    if (E.nv > 1) {
        for (i = 0; i < E.nv; i++)
            if (E.vc[i].on && E.vc[i].note == note) {
                E.vc[i].on = 0;
                E.vc[i].gate = 0;
                E.vc[i].off_stamp = ++E.stamp;
            }
        return;
    }
    for (i = 0; i < E.nheld; i++)
        if (E.held[i].note != note)
            E.held[k++] = E.held[i];
    E.nheld = (uint8_t)k;
    update_voice();
}

/* several notes: the note that already plays the key, else the one free for the longest, else the oldest (stolen:
 * its gate dips for one sample so the envelopes restart) */
void eng_note_on(uint32_t note, int32_t vel_q16)
{
    if (E.nv > 1) {
        uint32_t i, stamp = ++E.stamp;
        int v = -1;
        pv_t *x;
        for (i = 0; i < E.nv; i++)
            if (E.vc[i].on && E.vc[i].note == note)
                v = (int)i;
        if (v < 0)
            for (i = 0; i < E.nv; i++)
                if (!E.vc[i].on && (v < 0 || E.vc[i].off_stamp < E.vc[v].off_stamp))
                    v = (int)i;
        if (v < 0) {
            v = 0;
            for (i = 1; i < E.nv; i++)
                if (E.vc[i].on_stamp < E.vc[v].on_stamp)
                    v = (int)i;
        }
        x = &E.vc[v];
        if (x->on)
            x->retrig = 1;
        x->note = (uint8_t)note;
        x->pitch = note_pitch(note);
        x->vel = vel_q16;
        x->gate = ENG_ONE;
        x->on = 1;
        x->on_stamp = stamp;
        return;
    }
    eng_note_off(note);
    if (E.nheld == MAX_HELD) {
        uint32_t i;
        for (i = 1; i < MAX_HELD; i++)
            E.held[i - 1] = E.held[i];
        E.nheld--;
    }
    E.held[E.nheld].note = (uint8_t)note;
    E.held[E.nheld].vel = vel_q16;
    E.nheld++;
    update_voice();
}

void eng_clock_tick(void)
{
    clk_ticks++;
}

void eng_all_notes_off(void)
{
    uint32_t i;
    E.nheld = 0;
    for (i = 0; i < ENG_MAX_POLY; i++) {
        E.vc[i].on = 0;
        E.vc[i].gate = 0;
        E.vc[i].retrig = 0;
    }
}

/* ------------------------------------------------------------------ modules */

#define EF(it, name) ((it)->eff[name])

static void fill(esig_t *o, int32_t v, uint32_t n)
{
    uint32_t i;
    for (i = 0; i < n; i++)
        o[i] = v;
}

static void m_fm1(const node_t *nd, inst_t *it, uint32_t n)
{
    pv_t *x = &E.vc[cur_v];
    if (cur_v == 0) {                   /* clock: a pulse of half a block per block that saw a tick; nothing without a source */
        E.clk_pulse = E.clk_seen != clk_ticks ? (n + 1u) / 2u : 0u;
        E.clk_seen = clk_ticks;
    }
    fill(it->out[FM1_O_PITCH], x->pitch, n);
    fill(it->out[FM1_O_GATE], x->gate, n);
    fill(it->out[FM1_O_VEL], x->vel, n);
    if (x->retrig) {
        it->out[FM1_O_GATE][0] = 0;              /* one low sample: the envelopes of a stolen voice see a new gate */
        x->retrig = 0;
    }
    fill(it->out[FM1_O_K1], EF(it, FM1_P_K1), n);
    fill(it->out[FM1_O_K2], EF(it, FM1_P_K2), n);
    fill(it->out[FM1_O_K3], EF(it, FM1_P_K3), n);
    fill(it->out[FM1_O_K4], EF(it, FM1_P_K4), n);
    {
        esig_t *ck = it->out[FM1_O_CLOCK];
        uint32_t i;
        for (i = 0; i < n; i++)
            ck[i] = i < E.clk_pulse ? ENG_ONE : 0;
    }
    fill(it->out[FM1_O_SPREAD], E.nv > 1 ? (int32_t)((((int64_t)2 * (int32_t)cur_v - ((int32_t)E.nv - 1)) << 16) / ((int32_t)E.nv - 1)) : 0, n);
}

/* The FM oscillator (pm connected with pm > 0, or feedback) runs at twice the rate: two waves per frame, the pm input
 * interpolated between frames, then a polyphase half-band decimator of four first-order allpass sections (two per path),
 * flat to 19.4 kHz, 41 dB down above 24.7 kHz (what would fold onto the passband). The same Q16 coefficients as modules.ts.
 * Feedback: fb = 1 moves the phase by pi per unit of the two-sample average of the raw wave (the DX7's level 7). */
static const int32_t HB_A[4] = {5376, 17567, 35764, 55599};

static inline int32_t allpass16(int32_t *s, int32_t a, int32_t x)      /* y = a (x - y1) + x1; s[0] = x1, s[1] = y1 */
{
    int32_t y = mulr(a, x - s[1], 16) + s[0];
    s[0] = x;
    s[1] = y;
    return y;
}

static void m_osc(const node_t *nd, inst_t *it, uint32_t n)
{
    const esig_t *pitch = it->in[OSC_I_PITCH], *pm = it->in[OSC_I_PM], *sync = it->in[OSC_I_SYNC];
    esig_t *out = it->out[OSC_O_OUT];
    int32_t pw_q = clampi(EF(it, OSC_P_PW), 3277, 62259);                  /* 0.05 .. 0.95 */
    uint32_t pw = (uint32_t)pw_q << 16, phase = it->s.osc.phase, i;
    int32_t base = EF(it, OSC_P_COARSE) / 12 + EF(it, OSC_P_FINE) / 1200;
    int32_t kind = round_q16(EF(it, OSC_P_WAVE)), lvl = EF(it, OSC_P_LEVEL), fb = EF(it, OSC_P_FB);
    int32_t idx = nd->conn & (1u << OSC_I_PM) ? EF(it, OSC_P_PM) : 0;
    int32_t y1, y2, pm1, xb, *ap = it->s.osc.ap, s1 = it->s.osc.s1;
    if (idx <= 0 && fb <= 0) {                                             /* the plain oscillator: one wave per frame */
        int32_t nu = clampi(round_q16(EF(it, OSC_P_UNISON)), 1, 5), det = EF(it, OSC_P_DETUNE), doct[5], j;
        uint32_t *ph = it->s.osc.ph;
        static const int32_t INV_N[6] = {0, 65536, 32768, 21845, 16384, 13107};
        for (j = 0; j < nu; j++)                                           /* unison voice j: -detune .. +detune cents, in octaves */
            doct[j] = nu > 1 ? (int32_t)(((int64_t)det * (2 * j - (nu - 1))) / ((int64_t)(nu - 1) * 1200)) : 0;
        for (i = 0; i < n; i++) {
            int rst = sync[i] >= 32768 && s1 < 32768;                      /* a rising edge on sync restarts the phases */
            uint32_t dt = exp2_scale(INC_C4, pitch[i] + base + doct[0]);
            int32_t y;
            if (dt > DT_MAX)
                dt = DT_MAX;
            s1 = sync[i];
            if (rst)
                phase = 0;
            phase += dt;
            y = wave(kind, phase, dt, pw);
            if (nu == 1) {
                out[i] = mul16(y, lvl);
                continue;
            }
            for (j = 1; j < nu; j++) {
                uint32_t dtj = exp2_scale(INC_C4, pitch[i] + base + doct[j]);
                if (dtj > DT_MAX)
                    dtj = DT_MAX;
                if (rst)
                    ph[j - 1] = 0;
                ph[j - 1] += dtj;
                y += wave(kind, ph[j - 1], dtj, pw);
            }
            out[i] = mul16(mul16(y, INV_N[nu]), lvl);
        }
        it->s.osc.phase = phase;
        it->s.osc.s1 = s1;
        it->s.osc.y1 = it->s.osc.y2 = it->s.osc.pm1 = it->s.osc.xb = 0;
        for (i = 0; i < 8; i++)
            ap[i] = 0;
        return;
    }
    y1 = it->s.osc.y1;
    y2 = it->s.osc.y2;
    pm1 = it->s.osc.pm1;
    xb = it->s.osc.xb;
    for (i = 0; i < n; i++) {
        uint32_t dt = exp2_scale(INC_C4, pitch[i] + base), sub;
        int32_t pm_now = idx > 0 ? pm[i] : 0, pm_mid = (pm1 + pm_now) >> 1, ya = 0;
        if (dt > DT_MAX)
            dt = DT_MAX;
        dt >>= 1;
        if (sync[i] >= 32768 && s1 < 32768)
            phase = 0;
        s1 = sync[i];
        pm1 = pm_now;
        for (sub = 0; sub < 2; sub++) {
            uint32_t ph;
            int32_t y;
            phase += dt;
            ph = phase + (uint32_t)(((int64_t)mul16(idx, sub ? pm_now : pm_mid) * TURN_PER_RAD) >> 16)
                       + (uint32_t)((int64_t)mul16(fb, (y1 + y2) >> 1) << 15);   /* fb: Q16 of pi = half a turn */
            y = wave(kind, ph, dt, pw);
            y2 = y1;
            y1 = y;
            if (sub) {        /* path 0 takes the even sub-sample, path 1 the odd one of the previous frame (the z^-1) */
                int32_t p0 = allpass16(ap + 4, HB_A[2], allpass16(ap, HB_A[0], ya));
                int32_t p1 = allpass16(ap + 6, HB_A[3], allpass16(ap + 2, HB_A[1], xb));
                xb = y;
                out[i] = mul16((p0 + p1) >> 1, lvl);
            } else
                ya = y;
        }
    }
    it->s.osc.phase = phase;
    it->s.osc.s1 = s1;
    it->s.osc.y1 = y1;
    it->s.osc.y2 = y2;
    it->s.osc.pm1 = pm1;
    it->s.osc.xb = xb;
}

static void lfo_cycle(inst_t *it)
{
    it->s.lfo.seed = it->s.lfo.seed * 1664525u + 1013904223u;
    it->s.lfo.held = (int32_t)(it->s.lfo.seed >> 15) - ENG_ONE;
}

/* free: rate in Hz. sync: one cycle per note length (DELAY_DIV_NUM / DELAY_DIV_DEN, as the delay) that snaps to every n-th edge of clk
 * (24 ppqn, n = ticks per cycle), runs at the measured clock speed in between and at bpm when there is no clock. */
static void m_lfo(const node_t *nd, inst_t *it, uint32_t n)
{
    esig_t *out = it->out[0];
    const esig_t *clk = it->in[LFO_I_CLK], *rst = it->in[LFO_I_RESET];
    uint32_t dtfree = (uint32_t)(((uint64_t)(uint32_t)EF(it, LFO_P_RATE) << 16) / ENG_SR), phase = it->s.lfo.phase, i, dt;
    int32_t kind = round_q16(EF(it, LFO_P_WAVE)), depth = EF(it, LFO_P_DEPTH);
    int sync = EF(it, LFO_P_SYNC) >= 32768;
    int32_t div = clampi((EF(it, LFO_P_DIV) + 32768) >> 16, 0, DELAY_NDIV - 1), bpm = EF(it, LFO_P_BPM);
    uint32_t per = 24u * DELAY_DIV_NUM[div] / DELAY_DIV_DEN[div], dtbpm;
    if (bpm < 65536)
        bpm = 65536;
    dtbpm = (uint32_t)(((uint64_t)(uint32_t)bpm * DELAY_DIV_DEN[div] << 16) / (60u * DELAY_DIV_NUM[div] * ENG_SR));
    for (i = 0; i < n; i++) {
        uint32_t prev = phase;
        int32_t w;
        int c = clk[i] >= 32768, r = rst[i] >= 32768, live;
        if (it->s.lfo.since < ENG_SR)
            it->s.lfo.since++;
        if (c && !it->s.lfo.clk_hi) {
            int32_t d8 = (int32_t)(it->s.lfo.since << 8);
            if (it->s.lfo.since >= ENG_SR / 2)
                it->s.lfo.interval = 0;
            else
                it->s.lfo.interval = it->s.lfo.interval > 0 ? it->s.lfo.interval + (d8 - it->s.lfo.interval) / 8 : d8;
            it->s.lfo.since = 0;
            if (sync && ++it->s.lfo.ticks >= per) {
                it->s.lfo.ticks = 0;
                phase = prev = 0;
                lfo_cycle(it);
            }
        }
        it->s.lfo.clk_hi = (uint8_t)c;
        if (r && !it->s.lfo.rst_hi) {
            phase = prev = 0;
            it->s.lfo.ticks = 0;
            lfo_cycle(it);
        }
        it->s.lfo.rst_hi = (uint8_t)r;
        live = sync && it->s.lfo.interval > 0 && it->s.lfo.since < ENG_SR / 2;
        dt = !sync ? dtfree : live ? (uint32_t)((1ull << 40) / ((uint64_t)per * (uint32_t)it->s.lfo.interval)) : dtbpm;
        phase += dt;
        if (phase < prev) {
            if (live)
                phase = 0xFFFFFFFFu;        /* wait for the clock's next cycle start */
            else
                lfo_cycle(it);              /* a new cycle: sample & hold takes a new random value */
        }
        w = kind == 4 ? it->s.lfo.held : wave(kind, phase, dt, 0x80000000u);
        out[i] = mul16(w, depth);
    }
    it->s.lfo.phase = phase;
    (void)nd;
}

/* white noise through a one-pole with c = 2^(-5 color): color 0 is c = 1, the plain noise bit for bit. y is Q24. */
static void m_noise(const node_t *nd, inst_t *it, uint32_t n)
{
    esig_t *out = it->out[0];
    uint32_t seed = it->s.noise.seed, i;
    int32_t lvl = EF(it, NOISE_P_LEVEL), y = it->s.noise.y;
    int32_t k = (int32_t)exp2_q16((16 << 16) - 5 * EF(it, NOISE_P_COLOR));
    for (i = 0; i < n; i++) {
        seed = seed * 1664525u + 1013904223u;
        y += mulq(k, (((int32_t)(seed >> 15) - ENG_ONE) << 8) - y, 16);
        out[i] = mul16((y + 128) >> 8, lvl);
    }
    it->s.noise.seed = seed;
    it->s.noise.y = y;
}

static void m_const(const node_t *nd, inst_t *it, uint32_t n) { fill(it->out[0], EF(it, 0), n); }

static void m_scale(const node_t *nd, inst_t *it, uint32_t n)
{
    const esig_t *in = it->in[SCALE_I_IN];
    esig_t *out = it->out[0];
    int32_t g = EF(it, SCALE_P_GAIN), o = EF(it, SCALE_P_OFFSET);
    uint32_t i;
    for (i = 0; i < n; i++)
        out[i] = mul16(in[i], g) + o;
}

static int32_t env_rate(int32_t t_q16);
static int32_t env_rate_n(uint32_t n);

/* a one-pole glide: 99 % of a step in `time` (the envelope's rate curve, Q30 per sample). The state is Q24 (+-128):
 * in Q16 the step k * (in - y) would round to nothing while still 1 % short of the target, which a pitch can hear. */
static void m_glide(const node_t *nd, inst_t *it, uint32_t n)
{
    const esig_t *in = it->in[GLIDE_I_IN];
    esig_t *out = it->out[0];
    int32_t k = env_rate(EF(it, GLIDE_P_TIME)), y = it->s.gld.y;
    uint32_t i;
    for (i = 0; i < n; i++) {
        y += mulq(k, (clampi(in[i], -(1 << 23), (1 << 23) - 1) << 8) - y, 30);
        out[i] = (y + 128) >> 8;
    }
    it->s.gld.y = y;
}

/* waveshaper: drive, then a cubic soft clip (1.5 x - x^3 / 2 up to the knee at 1), a hard clip or a triangle fold */
static void m_shape(const node_t *nd, inst_t *it, uint32_t n)
{
    const esig_t *in = it->in[SHAPE_I_IN];
    esig_t *out = it->out[0];
    int32_t drive = EF(it, SHAPE_P_DRIVE), mode = round_q16(EF(it, SHAPE_P_MODE)), lvl = EF(it, SHAPE_P_LEVEL);
    uint32_t i;
    for (i = 0; i < n; i++) {
        int32_t x = mul16(in[i], drive), y;                                /* up to +-32 */
        if (mode == 1)
            y = clampi(x, -ENG_ONE, ENG_ONE);
        else if (mode == 2) {
            int32_t t = (x + ENG_ONE) & (4 * ENG_ONE - 1);                  /* 0 .. 4: a triangle of period 4 */
            y = t < 2 * ENG_ONE ? t - ENG_ONE : 3 * ENG_ONE - t;
        } else if (x >= ENG_ONE)
            y = ENG_ONE;
        else if (x <= -ENG_ONE)
            y = -ENG_ONE;
        else {
            int32_t x3 = mul16(mul16(x, x), x);
            y = x + (x >> 1) - (x3 >> 1);
        }
        out[i] = mul16(y, lvl);
    }
}

/* 1 - exp(-4.6 / samples) in Q30, samples in Q8 (at least 1) */
static int32_t env_rate_q8(uint64_t tsr)
{
    uint64_t y;
    if (tsr < 256u)
        tsr = 256u;
    y = 1264438371942ull / tsr;                                       /* 4.6 in Q30 / samples */
    if (y < (1ull << 26)) {                                           /* series: y - y^2/2 + y^3/6 - y^4/24 */
        int64_t y2 = (int64_t)((y * y) >> 30), y3 = (y2 * (int64_t)y) >> 30, y4 = (y3 * (int64_t)y) >> 30;
        return (int32_t)((int64_t)y - y2 / 2 + y3 / 6 - y4 / 24);
    } else {                                                          /* exp(-y) = 2^(-y log2 e) */
        uint64_t z = (y * 1549082005ull) >> 30;                       /* Q30 */
        uint32_t n = (uint32_t)(z >> 30), f = (uint32_t)z & 0x3FFFFFFFu, i = f >> 22, r = (f >> 14) & 255u;
        uint32_t e31 = EXPN_T[i] - (uint32_t)(((uint64_t)(EXPN_T[i] - EXPN_T[i + 1u]) * r) >> 8);
        uint32_t e30 = n >= 31u ? 0u : e31 >> (n + 1u);
        return (int32_t)(1u << 30) - (int32_t)e30;
    }
}

/* 1 - exp(-4.6 / max(t * sr, 1)) in Q30, t in seconds Q16 */
static int32_t env_rate(int32_t t_q16) { return env_rate_q8(((uint64_t)(uint32_t)t_q16 * ENG_SR) >> 8); }
/* the same for a segment of n whole samples */
static int32_t env_rate_n(uint32_t n) { return env_rate_q8((uint64_t)n << 8); }

static void m_adsr(const node_t *nd, inst_t *it, uint32_t n)
{
    const esig_t *gate = it->in[ADSR_I_GATE];
    esig_t *out = it->out[0];
    int32_t ad = env_rate(EF(it, ADSR_P_D)), ar = env_rate(EF(it, ADSR_P_R));
    uint64_t asr = ((uint64_t)(uint32_t)EF(it, ADSR_P_A) * ENG_SR) >> 8;
    int32_t ainc, sus = EF(it, ADSR_P_S) << 14, v = it->s.adsr.v;
    uint8_t stage = it->s.adsr.stage, prev = it->s.adsr.prev;
    uint32_t i;
    if (asr < 256u)
        asr = 256u;
    ainc = (int32_t)((1ull << 38) / asr);
    for (i = 0; i < n; i++) {
        uint8_t g = gate[i] > 32768 ? 1 : 0;
        if (g && !prev)
            stage = 1;
        else if (!g && prev)
            stage = 4;
        prev = g;
        switch (stage) {
        case 1:
            v += ainc;
            if (v >= (1 << 30)) {
                v = 1 << 30;
                stage = 2;
            }
            break;
        case 2: {
            int32_t d = sus - v;
            v += mulq(d, ad, 30);
            d = sus - v;
            if ((d < 0 ? -d : d) < 107374)
                stage = 3;
            break;
        }
        case 3:
            v = sus;
            break;
        case 4:
            v -= mulq(v, ar, 30);
            if (v < 107374) {
                v = 0;
                stage = 0;
            }
            break;
        }
        out[i] = v >> 14;
    }
    it->s.adsr.v = v;
    it->s.adsr.stage = stage;
    it->s.adsr.prev = prev;
}

static void m_vca(const node_t *nd, inst_t *it, uint32_t n)
{
    const esig_t *in = it->in[VCA_I_IN], *cv = it->in[VCA_I_CV];
    esig_t *out = it->out[0];
    int32_t g = EF(it, VCA_P_GAIN);
    uint32_t i;
    if (!(nd->conn & (1u << VCA_I_CV)))
        for (i = 0; i < n; i++)
            out[i] = mul16(in[i], g);
    else
        for (i = 0; i < n; i++)
            out[i] = mul16(mul16(in[i], cv[i]), g);
}

typedef struct {
    int32_t g, a1, a2, a3;
} svf_coef_t;

/* the coefficients of one stage for the tan() warped cutoff g */
static void svf_stage(svf_coef_t *c, int32_t g, int32_t k24)
{
    int32_t den = (1 << 24) + mulq(g, g + k24, 24);
    c->g = g;
    c->a1 = recip24(den);
    c->a2 = mulq(g, c->a1, 24);
    c->a3 = mulq(g, c->a2, 24);
}

/* the warped cutoff g = tan(pi fc / sr) for a cutoff given as a phase increment (cutoff / sr in u32 turns) */
static int32_t svf_g(uint32_t rinc)
{
    uint32_t i, fr;
    int32_t t0, t1;
    if (rinc > DT_MAX)
        rinc = DT_MAX;
    i = rinc >> 22;
    fr = (rinc >> 6) & 0xFFFFu;
    t0 = TAN_T[i];
    t1 = TAN_T[i + 1u];
    return t0 + (int32_t)(((int64_t)(t1 - t0) * fr) >> 16);
}

#define SQRT2_24 23726566   /* stage 2's k: sqrt(2) in Q24 (Q 0.7), the resonance comes from stage 1 only */

/* Two stages: stage 1 (12 dB) gives lp12, bp, hp; stage 2 filters lp12 again (lp24); mix fades lp24 -> hp by morph.
 * The integrator states are Q20 (+-2048: room for the resonance peak), the signals Q16; products are rounded.
 * Key tracking moves the cutoff by the voice pitch (octaves, C4 = as set), like the host engine, once per block. */
static void m_filter(const node_t *nd, inst_t *it, uint32_t n)
{
    const esig_t *in = it->in[FILTER_I_IN], *cv = it->in[FILTER_I_CV], *mo = it->in[FILTER_I_MORPH];
    esig_t *lp = it->out[FILTER_O_LP12], *bp = it->out[FILTER_O_BP], *hp = it->out[FILTER_O_HP];
    esig_t *lp24 = it->out[FILTER_O_LP24], *mix = it->out[FILTER_O_MIX];
    int32_t k24 = (2 << 24) - mulq(EF(it, FILTER_P_RES), 33218888, 16);   /* 2 - 1.98 res */
    int32_t cvamt = EF(it, FILTER_P_CVAMT), ic1 = it->s.flt.ic1, ic2 = it->s.flt.ic2, jc1 = it->s.flt.jc1, jc2 = it->s.flt.jc2;
    int32_t morph = EF(it, FILTER_P_MORPH), tr = EF(it, FILTER_P_TRACK) >= 32768 ? E.vc[cur_v].pitch : 0;
    uint32_t base = (uint32_t)(((uint64_t)(uint32_t)EF(it, FILTER_P_CUTOFF) << 16) / ENG_SR), i;
    svf_coef_t c, d;
    int fixed = !(nd->conn & (1u << FILTER_I_CV));
    int msig = nd->conn & (1u << FILTER_I_MORPH);
    if (tr)
        base = exp2_scale(base, tr);
    if (fixed) {
        int32_t g = svf_g(base);
        svf_stage(&c, g, k24);
        svf_stage(&d, g, SQRT2_24);
    }
    for (i = 0; i < n; i++) {
        int32_t v0 = in[i] << 4, v3, v1, v2, w3, w1, w2, h, m;               /* Q20 */
        if (!fixed) {
            int32_t g = svf_g(exp2_scale(base, mul16(cv[i], cvamt)));
            svf_stage(&c, g, k24);
            svf_stage(&d, g, SQRT2_24);
        }
        v3 = v0 - ic2;
        v1 = mulr(c.a1, ic1, 24) + mulr(c.a2, v3, 24);
        v2 = ic2 + mulr(c.a2, ic1, 24) + mulr(c.a3, v3, 24);
        ic1 = clampi(2 * v1 - ic1, -(1 << 30), 1 << 30);
        ic2 = clampi(2 * v2 - ic2, -(1 << 30), 1 << 30);
        h = v0 - mulr(v1, k24, 24) - v2;
        w3 = v2 - jc2;
        w1 = mulr(d.a1, jc1, 24) + mulr(d.a2, w3, 24);
        w2 = jc2 + mulr(d.a2, jc1, 24) + mulr(d.a3, w3, 24);
        jc1 = clampi(2 * w1 - jc1, -(1 << 30), 1 << 30);
        jc2 = clampi(2 * w2 - jc2, -(1 << 30), 1 << 30);
        m = clampi(msig ? morph + mo[i] : morph, 0, 65536);
        lp[i] = (v2 + 8) >> 4;
        bp[i] = (v1 + 8) >> 4;
        hp[i] = (h + 8) >> 4;
        lp24[i] = (w2 + 8) >> 4;
        mix[i] = (w2 + mul16(h - w2, m) + 8) >> 4;
    }
    it->s.flt.ic1 = ic1;
    it->s.flt.ic2 = ic2;
    it->s.flt.jc1 = jc1;
    it->s.flt.jc2 = jc2;
}

#define LAD_SAT_KNEE (3 << 19)      /* 1.5 in Q20: the saturator's knee */
#define LAD_SAT_CUBE 2485513        /* 1 / 6.75 in Q24 */

/* Ladder filter with drive (modules.ts `ladder`): four TPT one-poles (G = g / (1 + g), Q24) in a loop with k = 4 res.
 * The loop is solved linearly per sample (y4 = F (G^4 x + S), S the states' share, F = 1 / (1 + k G^4)), the loop input
 * u = sat(drive x - k y4) then runs through the stages; sat is v - v^3 / 6.75 up to |v| = 1.5, +-1 beyond. The
 * coefficients come once per block from the block mean of cv, cvamt and key tracking (no per-sample recip24: the SVF
 * keeps that for audio-rate cutoff). States Q20, products rounded; the saturator bounds the states, so no clamps. */
static void m_ladder(const node_t *nd, inst_t *it, uint32_t n)
{
    const esig_t *in = it->in[LADDER_I_IN], *cv = it->in[LADDER_I_CV];
    esig_t *lp24 = it->out[LADDER_O_LP24], *lp12 = it->out[LADDER_O_LP12];
    int32_t *s = it->s.lad.s;
    int32_t drive = EF(it, LADDER_P_DRIVE), cvamt = EF(it, LADDER_P_CVAMT);
    int32_t k24 = EF(it, LADDER_P_RES) << 10;                                     /* 4 res, Q24 */
    int32_t tr = EF(it, LADDER_P_TRACK) >= 32768 ? E.vc[cur_v].pitch : 0, x = tr;
    uint32_t base = (uint32_t)(((uint64_t)(uint32_t)EF(it, LADDER_P_CUTOFF) << 16) / ENG_SR), i;
    int32_t g, G, G2, G3, G4, hG, F;
    if (nd->conn & (1u << LADDER_I_CV)) {
        int64_t sum = 0;
        for (i = 0; i < n; i++)
            sum += cv[i];
        x += mul16((int32_t)(sum / (int32_t)n), cvamt);
    }
    if (x)
        base = exp2_scale(base, x);
    g = svf_g(base);
    G = mulq(g, recip24((1 << 24) + g), 24);
    G2 = mulq(G, G, 24);
    G3 = mulq(G2, G, 24);
    G4 = mulq(G3, G, 24);
    hG = (1 << 24) - G;
    F = recip24((1 << 24) + mulq(k24, G4, 24));
    for (i = 0; i < n; i++) {
        int32_t x20 = in[i] << 4, S, y4, u, y2 = 0, j;
        S = mulr(G3, s[0], 24) + mulr(G2, s[1], 24) + mulr(G, s[2], 24) + s[3];
        S = mulr(S, hG, 24);
        y4 = mulr(F, mulr(G4, x20, 24) + S, 24);
        u = mulq(x20, drive, 16) - mulq(k24, y4, 24);
        if (u >= LAD_SAT_KNEE)
            u = 1 << 20;
        else if (u <= -LAD_SAT_KNEE)
            u = -(1 << 20);
        else
            u -= mulq(mulq(mulq(u, u, 20), u, 20), LAD_SAT_CUBE, 24);
        for (j = 0; j < 4; j++) {
            int32_t v = mulr(G, u - s[j], 24);
            u = v + s[j];
            s[j] = u + v;
            if (j == 1)
                y2 = u;
        }
        lp24[i] = (u + 8) >> 4;
        lp12[i] = (y2 + 8) >> 4;
    }
}

#define DB_TO_LOG2 10885            /* 1 / 6.0206 in Q16: dB -> octaves (log2) */

/* Envelope follower and compressor (modules.ts `dyn`): a peak follower (Q24, attack / release rates Q30 as the glide) of
 * |side| (or |in|), out = in x gain with gain = 2^(makeup - slope (log2 env - log2 thresh)) above the threshold, the
 * makeup alone below it; env output Q16. One log2_q16 + exp2_q16 per sample while above the threshold. */
static void m_dyn(const node_t *nd, inst_t *it, uint32_t n)
{
    const esig_t *in = it->in[DYN_I_IN], *det = nd->conn & (1u << DYN_I_SIDE) ? it->in[DYN_I_SIDE] : in;
    esig_t *out = it->out[DYN_O_OUT], *eo = it->out[DYN_O_ENV];
    int32_t ka = env_rate(EF(it, DYN_P_ATTACK)), kr = env_rate(EF(it, DYN_P_RELEASE)), env = it->s.dyn.env;
    int32_t thr_log = mul16(EF(it, DYN_P_THRESH), DB_TO_LOG2), makeup_log = mul16(EF(it, DYN_P_GAIN), DB_TO_LOG2);
    int32_t ratio = EF(it, DYN_P_RATIO) < ENG_ONE ? ENG_ONE : EF(it, DYN_P_RATIO);
    int32_t slope = ENG_ONE - (int32_t)((1ull << 32) / (uint32_t)ratio);                 /* 1 - 1 / ratio */
    int32_t thr24 = (int32_t)exp2_q16(thr_log + (24 << 16)), makeup = (int32_t)exp2_q16(makeup_log + (16 << 16));   /* (exp2_q16 gives a plain integer: + 16 octaves for Q16, + 24 for Q24) */
    uint32_t i;
    for (i = 0; i < n; i++) {
        int32_t a = det[i] < 0 ? -det[i] : det[i], g;
        a = (a > (1 << 23) - 1 ? (1 << 23) - 1 : a) << 8;
        env += mulq(a > env ? ka : kr, a - env, 30);
        if (env > thr24)
            g = (int32_t)exp2_q16((16 << 16) + makeup_log - mul16(slope, log2_q16((uint32_t)env) - (24 << 16) - thr_log));
        else
            g = makeup;
        out[i] = mul16(in[i], g);
        eo[i] = (env + 128) >> 8;
    }
    it->s.dyn.env = env;
}

static void m_math(const node_t *nd, inst_t *it, uint32_t n)      /* modules.ts `math`: a' = a ka + off, b' = b kb */
{
    const esig_t *ia = it->in[MATH_I_A], *ib = it->in[MATH_I_B];
    esig_t **o = it->out;
    int32_t ka = EF(it, MATH_P_KA), kb = EF(it, MATH_P_KB), off = EF(it, MATH_P_OFF);
    uint32_t i;
    for (i = 0; i < n; i++) {
        int32_t a = mul16(ia[i], ka) + off, b = mul16(ib[i], kb);
        o[MATH_O_ADD][i] = a + b;
        o[MATH_O_SUB][i] = a - b;
        o[MATH_O_MUL][i] = mul16(a, b);
        o[MATH_O_MIN][i] = a < b ? a : b;
        o[MATH_O_MAX][i] = a > b ? a : b;
        o[MATH_O_ABS][i] = a < 0 ? -a : a;
        o[MATH_O_CMP][i] = a > b ? ENG_ONE : 0;
    }
    (void)nd;
}

static void m_logic(const node_t *nd, inst_t *it, uint32_t n)     /* modules.ts `logic`: gates high at or above thresh */
{
    const esig_t *ia = it->in[LOGIC_I_A], *ib = it->in[LOGIC_I_B];
    esig_t **o = it->out;
    int32_t t = EF(it, LOGIC_P_THRESH);
    uint32_t i;
    for (i = 0; i < n; i++) {
        int a = ia[i] >= t, b = ib[i] >= t;
        o[LOGIC_O_AND][i] = a && b ? ENG_ONE : 0;
        o[LOGIC_O_OR][i] = a || b ? ENG_ONE : 0;
        o[LOGIC_O_XOR][i] = a != b ? ENG_ONE : 0;
        o[LOGIC_O_NOT][i] = a ? 0 : ENG_ONE;
    }
    (void)nd;
}

static void m_mixer(const node_t *nd, inst_t *it, uint32_t n)
{
    const esig_t *a = it->in[MIXER_I_IN1], *b = it->in[MIXER_I_IN2], *c = it->in[MIXER_I_IN3], *d = it->in[MIXER_I_IN4];
    esig_t *out = it->out[0];
    int32_t la = EF(it, MIXER_P_L1), lb = EF(it, MIXER_P_L2), lc = EF(it, MIXER_P_L3), ld = EF(it, MIXER_P_L4);
    uint32_t i;
    for (i = 0; i < n; i++)
        out[i] = mul16(a[i], la) + mul16(b[i], lb) + mul16(c[i], lc) + mul16(d[i], ld);
}

/* the delay line holds Q13 (+-4.0) in int16: half the memory of Q16 in int32, 1.2e-4 resolution */
static inline int16_t dly_pack(int32_t v)
{
    int32_t q = (v + 4) >> 3;
    return (int16_t)clampi(q, -32768, 32767);
}

#define DELAY_HALF (DELAY_LEN / 2u)

/* the note length the time knob selects while the delay is synced: its range split into DELAY_NDIV steps (also used by the LCD) */
uint32_t delay_div(int32_t time_q16)
{
    int64_t lo = DEFS[T_DELAY].pmin[DELAY_P_TIME], range = DEFS[T_DELAY].pmax[DELAY_P_TIME] - lo;
    int64_t i = (((int64_t)time_q16 - lo) * (DELAY_NDIV - 1) * 2 + range) / (range * 2);
    return (uint32_t)(i < 0 ? 0 : i > DELAY_NDIV - 1 ? DELAY_NDIV - 1 : i);
}

/* free or synced time (see modules.ts); ping-pong splits the buffer in two halves, A (input, left) and B (right), see modules.ts */
static void m_delay(const node_t *nd, inst_t *it, uint32_t n)
{
    const esig_t *in = it->in[DELAY_I_IN];
    esig_t *out = it->out[DELAY_O_OUT], *outr = it->out[DELAY_O_R];
    int16_t *buf = it->s.dly.buf;
    uint32_t w = it->s.dly.w, i, d;
    int32_t fb = EF(it, DELAY_P_FB), mix = EF(it, DELAY_P_MIX), dry = ENG_ONE - mix;
    int pp = EF(it, DELAY_P_PINGPONG) >= 32768;
    int64_t smp, top = pp ? (int64_t)DELAY_HALF - 1 : (int64_t)DELAY_LEN - 1;
    if (nd->conn & (1u << DELAY_I_CLK)) {   /* tempo: the time of the last 24 clock pulses, smoothed */
        const esig_t *clk = it->in[DELAY_I_CLK];
        for (i = 0; i < n; i++) {
            int hi = clk[i] >= 32768;
            it->s.dly.t++;
            if (hi && !it->s.dly.prev) {
                uint32_t k = it->s.dly.seen % DELAY_CLK_PPQN;
                if (it->s.dly.seen >= DELAY_CLK_PPQN) {
                    uint32_t m = it->s.dly.t - it->s.dly.ring[k];
                    if (m >= ENG_SR / 5u && m <= ENG_SR * 3u / 2u)
                        it->s.dly.beat = it->s.dly.seen == DELAY_CLK_PPQN ? m : (uint32_t)((int32_t)it->s.dly.beat + ((int32_t)m - (int32_t)it->s.dly.beat) / 4);
                }
                it->s.dly.ring[k] = it->s.dly.t;
                it->s.dly.seen++;
            }
            it->s.dly.prev = (uint8_t)hi;
        }
    }
    if (EF(it, DELAY_P_SYNC) >= 32768) {
        uint32_t div = delay_div(EF(it, DELAY_P_TIME));
        smp = ((int64_t)DELAY_DIV_NUM[div] * it->s.dly.beat * 2 + DELAY_DIV_DEN[div]) / ((int64_t)DELAY_DIV_DEN[div] * 2);
    } else
        smp = ((int64_t)EF(it, DELAY_P_TIME) * ENG_SR + (int64_t)500 * 65536) / (1000 * 65536);   /* round(t_ms / 1000 * sr) */
    d = (uint32_t)(smp < 1 ? 1 : smp > top ? top : smp);
    if (!pp) {
        for (i = 0; i < n; i++) {
            uint32_t rp = w >= d ? w - d : w + DELAY_LEN - d;
            int32_t r = (int32_t)buf[rp] * 8;
            buf[w] = dly_pack(in[i] + mul16(r, fb));
            if (++w == DELAY_LEN)
                w = 0;
            out[i] = mul16(in[i], dry) + mul16(r, mix);
            outr[i] = out[i];
        }
    } else {
        int16_t *bb = buf + DELAY_HALF;
        if (w >= DELAY_HALF)
            w = 0;
        for (i = 0; i < n; i++) {
            uint32_t rp = w >= d ? w - d : w + DELAY_HALF - d;
            int32_t ea = (int32_t)buf[rp] * 8, eb = (int32_t)bb[rp] * 8, dr = mul16(in[i], dry);
            bb[w] = dly_pack(mul16(ea, fb));
            buf[w] = dly_pack(in[i] + mul16(eb, fb));
            if (++w == DELAY_HALF)
                w = 0;
            out[i] = dr + mul16(ea, mix);
            outr[i] = dr + mul16(eb, mix);
        }
    }
    it->s.dly.w = w;
}

/* ---- reverb: the same Freeverb-style network as modules.ts, in Q16 with int16 (Q13) delay memory */

static const uint16_t RV_COMB[4] = {1116, 1188, 1277, 1356};
static const uint16_t RV_AP[2] = {556, 441};

static void m_reverb(const node_t *nd, inst_t *it, uint32_t n)
{
    const esig_t *in = it->in[REVERB_I_IN];
    esig_t *out = it->out[0];
    int16_t *base = it->s.rev.buf, *comb[4], *ap[2];
    int32_t fb = 45875 + mul16(EF(it, REVERB_P_SIZE), 18350);          /* 0.70 + 0.28 size */
    int32_t d1 = mul16(EF(it, REVERB_P_DAMP), 26214), mix = EF(it, REVERB_P_MIX), dry = ENG_ONE - mix;
    uint32_t i, k, off = 0;
    for (k = 0; k < 4u; k++) {
        comb[k] = base + off;
        off += RV_COMB[k];
    }
    for (k = 0; k < 2u; k++) {
        ap[k] = base + off;
        off += RV_AP[k];
    }
    for (i = 0; i < n; i++) {
        int32_t x = in[i], g = x >> 4, sum = 0;                        /* the input at 1/16 */
        for (k = 0; k < 4u; k++) {
            uint32_t ix = it->s.rev.ci[k];
            int32_t o = (int32_t)comb[k][ix] * 8;
            it->s.rev.lp[k] = mulr(o, ENG_ONE - d1, 16) + mulr(it->s.rev.lp[k], d1, 16);
            comb[k][ix] = dly_pack(g + mulr(it->s.rev.lp[k], fb, 16));
            if (++ix == RV_COMB[k])
                ix = 0;
            it->s.rev.ci[k] = (uint16_t)ix;
            sum += o;
        }
        for (k = 0; k < 2u; k++) {
            uint32_t ix = it->s.rev.ai[k];
            int32_t bo = (int32_t)ap[k][ix] * 8, y = bo - sum;
            ap[k][ix] = dly_pack(sum + (bo >> 1));
            if (++ix == RV_AP[k])
                ix = 0;
            it->s.rev.ai[k] = (uint16_t)ix;
            sum = y;
        }
        out[i] = mulr(x, dry, 16) + mulr(sum, mix, 16);
    }
}

/* The level / rate envelope (modules.ts env): three segments to l1 l2 l3 in r1 r2 r3 on the gate, hold l3, release to l4
 * in r4. Rising: linear at the rate that covers 0..1 in r (the ADSR attack); falling: 99 % in r (the ADSR decay), then the
 * segment ends (the last 1 % is stepped). Q30. */
static void m_env(const node_t *nd, inst_t *it, uint32_t n)
{
    const esig_t *gate = it->in[ENV_I_GATE];
    esig_t *out = it->out[0];
    int32_t lv[6], inc[6], k[6], v = it->s.env.v;
    uint32_t len[6], tt = it->s.env.t;
    uint8_t stage = it->s.env.stage, prev = it->s.env.prev;
    uint32_t i, st;
    static const uint8_t LP[6] = {ENV_P_L4, ENV_P_L1, ENV_P_L2, ENV_P_L3, ENV_P_L3, ENV_P_L4};
    static const uint8_t RP[6] = {0, ENV_P_R1, ENV_P_R2, ENV_P_R3, 0, ENV_P_R4};
    for (st = 0; st < 6u; st++) {
        uint64_t tsr;
        lv[st] = EF(it, LP[st]) << 14;
        if (st == 0 || st == 4) {
            inc[st] = k[st] = 0;
            len[st] = 1;
            continue;
        }
        tsr = ((uint64_t)(uint32_t)EF(it, RP[st]) * ENG_SR + 32768u) >> 16;   /* round(r * sr) samples */
        if (tsr < 1u)
            tsr = 1u;
        len[st] = (uint32_t)tsr;
        inc[st] = (int32_t)((1ull << 30) / tsr);
        k[st] = env_rate_n((uint32_t)tsr);
    }
    for (i = 0; i < n; i++) {
        uint8_t g = gate[i] > 32768 ? 1 : 0;
        uint32_t guard;
        if (g && !prev) {
            stage = 1;
            tt = 0;
        } else if (!g && prev) {
            stage = 5;
            tt = 0;
        }
        prev = g;
        for (guard = 0; guard < 4u; guard++) {
            int32_t t;
            if (stage == 0 || stage == 4) {
                v = lv[stage];
                break;
            }
            t = lv[stage];
            tt++;
            if (v < t) {
                v += inc[stage];
                if (v < t)
                    break;
            } else if (tt < len[stage]) {
                v += mulq(t - v, k[stage], 30);
                break;
            }
            v = t;
            stage = stage == 5 ? 0 : (uint8_t)(stage + 1);
            tt = 0;
        }
        out[i] = v >> 14;
    }
    it->s.env.t = tt;
    it->s.env.v = v;
    it->s.env.stage = stage;
    it->s.env.prev = prev;
}

#define LOG2_1000_Q16 653124        /* log2(1000): decay is the time to -60 dB */

/* The plucked string (modules.ts string): a Q13 delay line of one period with a one-pole in the loop, written with
 * first-order error feedback so the int16 rounding does not pile up in the loop. Period, loop gain and the damping's
 * delay compensation are set once per block from the block's first pitch. */
static void m_string(const node_t *nd, inst_t *it, uint32_t n)
{
    const esig_t *pitch = it->in[STRING_I_PITCH], *gate = it->in[STRING_I_GATE], *exc = it->in[STRING_I_EXC];
    esig_t *out = it->out[0];
    int16_t *buf = it->s.str.buf;
    uint32_t dt = exp2_scale(INC_C4, pitch[0] + EF(it, STRING_P_COARSE) / 12), w = it->s.str.w, seed = it->s.str.seed, i, di;
    int32_t per, cl, dl, d, fr, g, bl, lvl = EF(it, STRING_P_LEVEL), kind = round_q16(EF(it, STRING_P_BURST));
    int32_t lp = it->s.str.lp, s1 = it->s.str.s1, err = it->s.str.err, burst = it->s.str.burst, blen = it->s.str.blen;
    int64_t e;
    if (dt == 0u)
        dt = 1u;
    per = (int32_t)clampi((int64_t)((1ull << 48) / dt) > 0x7FFFFFFF ? 0x7FFFFFFF : (int32_t)((1ull << 48) / dt), 2 << 16, (int32_t)(STR_LEN - 2u) << 16);   /* period, Q16 samples */
    cl = ENG_ONE - mul16(EF(it, STRING_P_DAMP), 58982);                    /* 1 - 0.9 damp */
    dl = (int32_t)(((int64_t)(ENG_ONE - cl) << 16) / cl);                 /* the one-pole's low-frequency delay */
    d = per - dl;
    if (d < ENG_ONE)
        d = ENG_ONE;
    di = (uint32_t)d >> 16;
    fr = d & 0xFFFF;
    e = -(((int64_t)LOG2_1000_Q16 * per) >> 16);                           /* -log2(1000) * period, Q16 */
    e = (e << 16) / ((int64_t)EF(it, STRING_P_DECAY) * ENG_SR);           /* / (decay * sr): octaves, Q16 */
    g = (int32_t)exp2_scale(ENG_ONE, (int32_t)(e < -(60 << 16) ? -(60 << 16) : e));
    bl = (per + 32768) >> 16;
    for (i = 0; i < n; i++) {
        int32_t x = exc[i], r0, r1, r, y, wq;
        int16_t q;
        uint32_t p0 = w >= di ? w - di : w + STR_LEN - di, p1 = p0 ? p0 - 1u : STR_LEN - 1u;
        if (gate[i] >= 32768 && s1 < 32768) {
            burst = bl;
            blen = bl;
        }
        s1 = gate[i];
        if (burst > 0) {
            if (kind == 0) {
                seed = seed * 1664525u + 1013904223u;
                x += (int32_t)(seed >> 15) - ENG_ONE;
            } else
                x += blen - burst < (blen >> 1) ? ENG_ONE : -ENG_ONE;
            burst--;
        }
        r0 = (int32_t)buf[p0] * 8;
        r1 = (int32_t)buf[p1] * 8;
        r = r0 + mulr(r1 - r0, fr, 16);
        lp += mulr(r - lp, cl, 16);
        y = clampi(x + mulr(lp, g, 16), -2 * ENG_ONE, 2 * ENG_ONE);
        wq = y + err;
        q = dly_pack(wq);
        err = wq - (int32_t)q * 8;
        buf[w] = q;
        if (++w == STR_LEN)
            w = 0;
        out[i] = mul16(y, lvl);
    }
    it->s.str.w = w;
    it->s.str.seed = seed;
    it->s.str.lp = lp;
    it->s.str.s1 = s1;
    it->s.str.err = err;
    it->s.str.burst = burst;
    it->s.str.blen = blen;
}

/* The wavetable oscillator (modules.ts wavetable): two neighbouring frames of a bank read with linear interpolation and
 * crossfaded by pos; the mip level (32 / 16 / 8 harmonics) from the block's first pitch. Phase modulation as the plain
 * oscillator's (no oversampling). */
static void m_wavetable(const node_t *nd, inst_t *it, uint32_t n)
{
    const esig_t *pitch = it->in[WAVETABLE_I_PITCH], *pm = it->in[WAVETABLE_I_PM], *sync = it->in[WAVETABLE_I_SYNC];
    esig_t *out = it->out[0];
    int32_t base = EF(it, WAVETABLE_P_COARSE) / 12 + EF(it, WAVETABLE_P_FINE) / 1200;
    int32_t bank = clampi(round_q16(EF(it, WAVETABLE_P_BANK)), 0, WT_FRAMES / 8 - 1), lvl = EF(it, WAVETABLE_P_LEVEL);
    int32_t pos7 = clampi(EF(it, WAVETABLE_P_POS), 0, ENG_ONE) * 7, f0 = pos7 >> 16, f1 = f0 < 7 ? f0 + 1 : 7, fm = pos7 & 0xFFFF;
    int32_t idx = nd->conn & (1u << WAVETABLE_I_PM) ? EF(it, WAVETABLE_P_PM) : 0, s1 = it->s.wt.s1;
    uint32_t dt0 = exp2_scale(INC_C4, pitch[0] + base), phase = it->s.wt.phase, i;
    uint32_t mip = dt0 < 67108864u ? 0u : dt0 < 134217728u ? 1u : 2u;
    const int16_t *ta = WT_T[mip][bank * 8 + f0], *tb = WT_T[mip][bank * 8 + f1];
    for (i = 0; i < n; i++) {
        uint32_t dt = exp2_scale(INC_C4, pitch[i] + base), ph, xi, xf;
        int32_t ya, yb;
        if (dt > DT_MAX)
            dt = DT_MAX;
        if (sync[i] >= 32768 && s1 < 32768)
            phase = 0;
        s1 = sync[i];
        phase += dt;
        ph = phase + (uint32_t)(((int64_t)mul16(idx, pm[i]) * TURN_PER_RAD) >> 16);
        xi = ph >> 24;
        xf = (ph >> 8) & 0xFFFFu;
        ya = ta[xi] * 2 + (int32_t)(((int64_t)(ta[xi + 1] - ta[xi]) * 2 * (int32_t)xf) >> 16);
        yb = tb[xi] * 2 + (int32_t)(((int64_t)(tb[xi + 1] - tb[xi]) * 2 * (int32_t)xf) >> 16);
        out[i] = mul16(ya + mul16(yb - ya, fm), lvl);
    }
    it->s.wt.phase = phase;
    it->s.wt.s1 = s1;
}

#define CH_BASE_Q16 34681651u       /* 0.012 * ENG_SR samples, Q16 */
#define CH_SWING_Q16 23121101u      /* 0.008 * ENG_SR samples, Q16 */

/* The stereo chorus (modules.ts chorus): a Q13 line, two taps swept in quadrature by a sine around 12 ms by up to 8 ms. */
static void m_chorus(const node_t *nd, inst_t *it, uint32_t n)
{
    const esig_t *in = it->in[CHORUS_I_IN];
    esig_t *l = it->out[CHORUS_O_L], *r = it->out[CHORUS_O_R];
    int16_t *buf = it->s.ch.buf;
    uint32_t w = it->s.ch.w, phase = it->s.ch.phase, i;
    uint32_t dphi = (uint32_t)(((uint64_t)(uint32_t)EF(it, CHORUS_P_RATE) << 16) / ENG_SR);
    int32_t swing = mul16((int32_t)CH_SWING_Q16, EF(it, CHORUS_P_DEPTH)), mix = EF(it, CHORUS_P_MIX), dry = ENG_ONE - mix;
    for (i = 0; i < n; i++) {
        int32_t x = in[i], tap[2], k;
        uint32_t dd[2];
        buf[w] = dly_pack(x);
        dd[0] = CH_BASE_Q16 + (uint32_t)mul16(swing, sin_turn(phase));
        dd[1] = CH_BASE_Q16 + (uint32_t)mul16(swing, sin_turn(phase + 0x40000000u));
        for (k = 0; k < 2; k++) {
            uint32_t di = dd[k] >> 16, p0 = w >= di ? w - di : w + CH_LEN - di, p1 = p0 ? p0 - 1u : CH_LEN - 1u;
            int32_t a = (int32_t)buf[p0] * 8, b = (int32_t)buf[p1] * 8;
            tap[k] = a + mulr(b - a, (int32_t)(dd[k] & 0xFFFFu), 16);
        }
        l[i] = mul16(x, dry) + mul16(tap[0], mix);
        r[i] = mul16(x, dry) + mul16(tap[1], mix);
        if (++w == CH_LEN)
            w = 0;
        phase += dphi;
    }
    it->s.ch.w = w;
    it->s.ch.phase = phase;
}

/* The step sequencer (modules.ts seq): out is the current step all the time, gate follows the clock unless the step is a
 * rest (fully down, -1). A rising clock edge advances (fwd, back, pendulum, random), a rising reset edge goes to step 1. */
static void m_seq(const node_t *nd, inst_t *it, uint32_t n)
{
    const esig_t *clock = it->in[SEQ_I_CLOCK], *reset = it->in[SEQ_I_RESET];
    esig_t *out = it->out[SEQ_O_OUT], *gate = it->out[SEQ_O_GATE];
    int32_t len = clampi(round_q16(EF(it, SEQ_P_LEN)), 1, 8), dir = round_q16(EF(it, SEQ_P_DIR));
    int32_t pos = it->s.seq.pos, down = it->s.seq.down, c1 = it->s.seq.c1, r1 = it->s.seq.r1;
    uint32_t seed = it->s.seq.seed, i;
    for (i = 0; i < n; i++) {
        int rst = reset[i] >= 32768 && r1 < 32768, clk = clock[i] >= 32768 && c1 < 32768;
        int32_t v;
        r1 = reset[i];
        c1 = clock[i];
        if (rst) {
            pos = 0;
            down = 0;
        } else if (clk) {
            if (pos >= len)
                pos = len - 1;
            if (dir == 1)
                pos = (pos + len - 1) % len;
            else if (dir == 2) {
                if (!down) {
                    if (pos + 1 < len)
                        pos++;
                    else {
                        pos = len - 2 > 0 ? len - 2 : 0;
                        down = 1;
                    }
                } else if (pos > 0)
                    pos--;
                else {
                    pos = len - 1 < 1 ? len - 1 : 1;
                    down = 0;
                }
            } else if (dir == 3) {
                seed = seed * 1664525u + 1013904223u;
                pos = (int32_t)((seed >> 16) % (uint32_t)len);
            } else
                pos = (pos + 1) % len;
        }
        v = EF(it, SEQ_P_S1 + (pos < len ? pos : len - 1));
        out[i] = v;
        gate[i] = clock[i] >= 32768 && v > -ENG_ONE ? ENG_ONE : 0;
    }
    it->s.seq.pos = (int8_t)pos;
    it->s.seq.down = (int8_t)down;
    it->s.seq.c1 = c1;
    it->s.seq.r1 = r1;
    it->s.seq.seed = seed;
}

static void m_clkdiv(const node_t *nd, inst_t *it, uint32_t n)
{
    const esig_t *clock = it->in[CLKDIV_I_CLOCK], *reset = it->in[CLKDIV_I_RESET];
    int32_t div = clampi(round_q16(EF(it, CLKDIV_P_DIV)), 1, 16), count = it->s.cdv.count, c1 = it->s.cdv.c1, r1 = it->s.cdv.r1;
    uint32_t i;
    for (i = 0; i < n; i++) {
        int hi;
        if (reset[i] >= 32768 && r1 < 32768)
            count = -1;
        else if (clock[i] >= 32768 && c1 < 32768)
            count = (count + 1) % (16 * div);
        r1 = reset[i];
        c1 = clock[i];
        hi = clock[i] >= 32768 && count >= 0;
        it->out[CLKDIV_O_OUT][i] = hi && count % div == 0 ? ENG_ONE : 0;
        it->out[CLKDIV_O_D2][i] = hi && (count & 1) == 0 ? ENG_ONE : 0;
        it->out[CLKDIV_O_D4][i] = hi && (count & 3) == 0 ? ENG_ONE : 0;
        it->out[CLKDIV_O_D8][i] = hi && (count & 7) == 0 ? ENG_ONE : 0;
    }
    it->s.cdv.count = count;
    it->s.cdv.c1 = c1;
    it->s.cdv.r1 = r1;
}

static void m_sh(const node_t *nd, inst_t *it, uint32_t n)
{
    const esig_t *in = it->in[SH_I_IN], *clock = it->in[SH_I_CLOCK];
    esig_t *out = it->out[0];
    int track = round_q16(EF(it, SH_P_MODE)) == 1;
    int32_t v = it->s.sh.v, c1 = it->s.sh.c1;
    uint32_t i;
    for (i = 0; i < n; i++) {
        int up = clock[i] >= 32768;
        if (track ? up : up && c1 < 32768)
            v = in[i];
        c1 = clock[i];
        out[i] = v;
    }
    it->s.sh.v = v;
    it->s.sh.c1 = c1;
}

/* the quantizer's scales (modules.ts SCALES), semitones above the root */
static const uint8_t SC_CHROM[] = {0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11}, SC_MAJ[] = {0, 2, 4, 5, 7, 9, 11}, SC_MIN[] = {0, 2, 3, 5, 7, 8, 10};
static const uint8_t SC_PMAJ[] = {0, 2, 4, 7, 9}, SC_PMIN[] = {0, 3, 5, 7, 10}, SC_DOR[] = {0, 2, 3, 5, 7, 9, 10}, SC_MIX[] = {0, 2, 4, 5, 7, 9, 10};
static const uint8_t SC_BLUES[] = {0, 3, 5, 6, 7, 10}, SC_WHOLE[] = {0, 2, 4, 6, 8, 10}, SC_FIFTH[] = {0, 7}, SC_OCT[] = {0};
static const struct { const uint8_t *st; uint8_t n; } SCALES[] = {
    {SC_CHROM, 12}, {SC_MAJ, 7}, {SC_MIN, 7}, {SC_PMAJ, 5}, {SC_PMIN, 5}, {SC_DOR, 7}, {SC_MIX, 7}, {SC_BLUES, 6}, {SC_WHOLE, 6}, {SC_FIFTH, 2}, {SC_OCT, 1},
};
#define N_SCALES ((int32_t)(sizeof SCALES / sizeof SCALES[0]))
#define OCT_Q16 (12 * ENG_ONE)

static void m_quant(const node_t *nd, inst_t *it, uint32_t n)
{
    const esig_t *in = it->in[QUANT_I_IN];
    esig_t *out = it->out[0];
    int32_t si = clampi(round_q16(EF(it, QUANT_P_SCALE)), 0, N_SCALES - 1), root = round_q16(EF(it, QUANT_P_ROOT));
    const uint8_t *sc = SCALES[si].st;
    uint32_t ns = SCALES[si].n, i, k;
    for (i = 0; i < n; i++) {
        int32_t semis = clampi(in[i], -(1 << 27), 1 << 27) * 12 - root * ENG_ONE, oct, w, best, bd;
        oct = semis >= 0 ? semis / OCT_Q16 : -((-semis + OCT_Q16 - 1) / OCT_Q16);     /* floor */
        w = semis - oct * OCT_Q16;
        best = sc[0] * ENG_ONE;
        bd = w - best < 0 ? best - w : w - best;
        for (k = 1; k <= ns; k++) {
            int32_t d = (k < ns ? sc[k] : sc[0] + 12) * ENG_ONE, dd = w - d < 0 ? d - w : w - d;
            if (dd < bd) {
                bd = dd;
                best = d;
            }
        }
        out[i] = (oct * OCT_Q16 + best + root * ENG_ONE) / 12;
    }
}

static void m_pulse(const node_t *nd, inst_t *it, uint32_t n)
{
    const esig_t *trig = it->in[PULSE_I_TRIG];
    esig_t *out = it->out[0];
    int32_t len = (int32_t)((((uint64_t)(uint32_t)EF(it, PULSE_P_TIME) * ENG_SR) + 32768u) >> 16), rem = it->s.pls.rem, t1 = it->s.pls.t1;
    uint32_t i;
    if (len < 1)
        len = 1;
    for (i = 0; i < n; i++) {
        if (trig[i] >= 32768 && t1 < 32768)
            rem = len;
        t1 = trig[i];
        out[i] = rem > 0 ? ENG_ONE : 0;
        if (rem > 0)
            rem--;
    }
    it->s.pls.rem = rem;
    it->s.pls.t1 = t1;
}

/* equal-power pan: (p + 1) / 8 of a turn, r = sin, l = cos */
static void m_pan(const node_t *nd, inst_t *it, uint32_t n)
{
    const esig_t *in = it->in[PAN_I_IN], *pos = it->in[PAN_I_POS];
    esig_t *l = it->out[PAN_O_L], *r = it->out[PAN_O_R];
    int32_t base = EF(it, PAN_P_PAN);
    uint32_t i;
    for (i = 0; i < n; i++) {
        int32_t p = clampi(base + pos[i], -ENG_ONE, ENG_ONE);
        uint32_t turn = (uint32_t)(p + ENG_ONE) << 13;
        l[i] = mul16(in[i], sin_turn(turn + 0x40000000u));
        r[i] = mul16(in[i], sin_turn(turn));
    }
}

static void m_xfade(const node_t *nd, inst_t *it, uint32_t n)
{
    const esig_t *a = it->in[XFADE_I_A], *b = it->in[XFADE_I_B], *pos = it->in[XFADE_I_POS];
    esig_t *out = it->out[0];
    int32_t base = EF(it, XFADE_P_MIX);
    uint32_t i;
    for (i = 0; i < n; i++) {
        int32_t m = clampi(base + pos[i], 0, ENG_ONE);
        out[i] = mul16(a[i], ENG_ONE - m) + mul16(b[i], m);
    }
}

/* the formants (Hz) of A E I O U; gains 1, 1/2, 1/4 */
static const int16_t FORMANT_HZ[5][3] = {{730, 1090, 2440}, {530, 1840, 2480}, {390, 1990, 2550}, {570, 840, 2410}, {440, 1020, 2240}};

/* three parallel SVF band passes (normalized band k v1, peak 1) at the formants of vowel + input, set once per block */
static void m_vowel(const node_t *nd, inst_t *it, uint32_t n)
{
    const esig_t *in = it->in[VOWEL_I_IN], *vin = it->in[VOWEL_I_VOWEL];
    esig_t *out = it->out[0];
    int32_t v = clampi(EF(it, VOWEL_P_VOWEL) + vin[0], 0, 4 << 16), vi = v >> 16, t, lvl = EF(it, VOWEL_P_LEVEL);
    int32_t q16 = (2 << 16) + 18 * EF(it, VOWEL_P_RES), k24 = (int32_t)(((int64_t)1 << 40) / q16);
    svf_coef_t c[3];
    uint32_t i, f;
    if (vi > 3)
        vi = 3;
    t = v - (vi << 16);
    for (f = 0; f < 3u; f++) {
        int32_t hz = ((int32_t)FORMANT_HZ[vi][f] << 16) + (int32_t)((int64_t)(FORMANT_HZ[vi + 1][f] - FORMANT_HZ[vi][f]) * t);
        svf_stage(&c[f], svf_g((uint32_t)(((uint64_t)(uint32_t)hz << 16) / ENG_SR)), k24);
    }
    for (i = 0; i < n; i++) {
        int32_t v0 = in[i] << 4, sum = 0;
        for (f = 0; f < 3u; f++) {
            int32_t ic1 = it->s.vow.ic1[f], ic2 = it->s.vow.ic2[f];
            int32_t v3 = v0 - ic2;
            int32_t v1 = mulr(c[f].a1, ic1, 24) + mulr(c[f].a2, v3, 24);
            int32_t v2 = ic2 + mulr(c[f].a2, ic1, 24) + mulr(c[f].a3, v3, 24);
            it->s.vow.ic1[f] = clampi(2 * v1 - ic1, -(1 << 30), 1 << 30);
            it->s.vow.ic2[f] = clampi(2 * v2 - ic2, -(1 << 30), 1 << 30);
            sum += mulr(v1, k24, 24) >> f;
        }
        out[i] = mul16((sum + 8) >> 4, lvl);
    }
}

#define INC_20HZ 1948006u            /* 20 Hz as a phase increment */

/* four first-order allpasses in series with one coefficient a = (g - 1) / (g + 1), g = tan(pi f / sr), f = center *
 * 2^(2 depth tri) from a triangle sweep, once per block; feedback from stage 4 into stage 1 */
static void m_phaser(const node_t *nd, inst_t *it, uint32_t n)
{
    const esig_t *in = it->in[PHASER_I_IN];
    esig_t *out = it->out[0];
    uint32_t dt = (uint32_t)(((uint64_t)(uint32_t)EF(it, PHASER_P_RATE) << 16) / ENG_SR), phase = it->s.phs.phase, i, k;
    int32_t tri = wave(1, phase, dt, 0), oct = mul16(2 * EF(it, PHASER_P_DEPTH), tri);
    uint32_t rinc = exp2_scale((uint32_t)(((uint64_t)(uint32_t)EF(it, PHASER_P_CENTER) << 16) / ENG_SR), oct);
    int32_t g, a, fb = EF(it, PHASER_P_FB), mix = EF(it, PHASER_P_MIX), dry = ENG_ONE - mix, fbv = it->s.phs.fbv, *ap = it->s.phs.ap;
    if (rinc < INC_20HZ)
        rinc = INC_20HZ;
    g = svf_g(rinc);
    a = (int32_t)(((int64_t)(g - (1 << 24)) << 24) / (g + (1 << 24)));
    for (i = 0; i < n; i++) {
        int32_t x0 = in[i], x = clampi(x0 + mul16(fb, fbv), -(8 << 16), 8 << 16);
        for (k = 0; k < 4u; k++) {
            int32_t y = mulq(a, x - ap[2 * k + 1], 24) + ap[2 * k];
            ap[2 * k] = x;
            ap[2 * k + 1] = y;
            x = y;
        }
        fbv = x;
        out[i] = mul16(x0, dry) + mul16(x, mix);
    }
    it->s.phs.fbv = fbv;
    it->s.phs.phase = phase + n * dt;
}

/* 2^bits levels over -1..1 (a step of 2^(17 - bits) in Q16), every taken sample held for `rate` samples */
static void m_crush(const node_t *nd, inst_t *it, uint32_t n)
{
    const esig_t *in = it->in[CRUSH_I_IN];
    esig_t *out = it->out[0];
    int32_t bits = clampi(round_q16(EF(it, CRUSH_P_BITS)), 1, 16), rate = clampi(round_q16(EF(it, CRUSH_P_RATE)), 1, 64);
    int32_t held = it->s.crush.held, cnt = it->s.crush.cnt;
    unsigned sh = (unsigned)(17 - bits);
    uint32_t i;
    for (i = 0; i < n; i++) {
        if (cnt <= 0) {
            held = ((in[i] + (1 << (sh - 1))) >> sh) << sh;
            cnt = rate;
        }
        cnt--;
        out[i] = held;
    }
    it->s.crush.held = held;
    it->s.crush.cnt = cnt;
}

/* ------------------------------------------------------------------ rendering */

/* Block-rate parameter modulation (engine.ts applyCv): the mean of p1 / p2 over the block, times the attenuverter, is
 * added (times the range) to the parameters the matrix assigns that input to; clamped when something was added. */
static void apply_cv(const node_t *nd, inst_t *it, uint32_t n)
{
    const def_t *d = &DEFS[nd->type];
    int32_t mean[2] = {0, 0};
    uint32_t j, i, s, have = 0;
    if (d->cvbase >= 0)
        for (s = 0; s < 2u; s++) {
            const esig_t *cv;
            int64_t sum = 0;
            if (!(nd->conn & (1u << (d->cvbase + s))))
                continue;
            cv = it->in[d->cvbase + s];
            for (i = 0; i < n; i++)
                sum += cv[i];
            mean[s] = mul16((int32_t)(sum / (int64_t)n), nd->att[s]);
            have |= 1u << s;
        }
    for (j = 0; j < d->npar; j++) {
        int32_t v = nd->par[j];
        uint32_t touched = 0;
        int32_t mod = 0;
        for (s = 0; s < 2u; s++)
            if ((have >> s & 1u) && (nd->map[s] >> j & 1u)) {
                mod += mean[s];
                touched = 1;
            }
        if (!touched)
            it->eff[j] = v;
        else if (d->plog && d->plog[j])
            it->eff[j] = value_of(d, j, unit_of(d, j, v) + mod);            /* in octaves */
        else
            it->eff[j] = clampi(v + mul16(mod, d->pmax[j] - d->pmin[j]), d->pmin[j], d->pmax[j]);
    }
}

static void process(const node_t *nd, inst_t *it, uint32_t n)
{
    switch (nd->type) {
    case T_FM1: m_fm1(nd, it, n); break;
    case T_OSC: m_osc(nd, it, n); break;
    case T_LFO: m_lfo(nd, it, n); break;
    case T_NOISE: m_noise(nd, it, n); break;
    case T_CONST: m_const(nd, it, n); break;
    case T_SCALE: m_scale(nd, it, n); break;
    case T_ADSR: m_adsr(nd, it, n); break;
    case T_VCA: m_vca(nd, it, n); break;
    case T_FILTER: m_filter(nd, it, n); break;
    case T_MIXER: m_mixer(nd, it, n); break;
    case T_DELAY: m_delay(nd, it, n); break;
    case T_REVERB: m_reverb(nd, it, n); break;
    case T_GLIDE: m_glide(nd, it, n); break;
    case T_SHAPE: m_shape(nd, it, n); break;
    case T_ENV: m_env(nd, it, n); break;
    case T_STRING: m_string(nd, it, n); break;
    case T_WAVETABLE: m_wavetable(nd, it, n); break;
    case T_CHORUS: m_chorus(nd, it, n); break;
    case T_SEQ: m_seq(nd, it, n); break;
    case T_CLKDIV: m_clkdiv(nd, it, n); break;
    case T_SH: m_sh(nd, it, n); break;
    case T_QUANT: m_quant(nd, it, n); break;
    case T_PULSE: m_pulse(nd, it, n); break;
    case T_PAN: m_pan(nd, it, n); break;
    case T_XFADE: m_xfade(nd, it, n); break;
    case T_VOWEL: m_vowel(nd, it, n); break;
    case T_PHASER: m_phaser(nd, it, n); break;
    case T_LADDER: m_ladder(nd, it, n); break;
    case T_DYN: m_dyn(nd, it, n); break;
    case T_MATH: m_math(nd, it, n); break;
    case T_LOGIC: m_logic(nd, it, n); break;
    case T_CRUSH: m_crush(nd, it, n); break;
    default: break;                      /* output: read by eng_render */
    }
}

static void render_voice(int32_t *left, int32_t *right, uint32_t total)   /* the selected voice alone, clamped */
{
    uint32_t off, i, k, s, v;
    for (i = 0; i < total; i++)
        left[i] = right[i] = 0;
    if (!E.loaded)
        return;
    for (off = 0; off < total; off += ENG_BLOCK) {
        uint32_t n = total - off < ENG_BLOCK ? total - off : ENG_BLOCK;
        for (k = 0; k < E.norder; k++) {
            const node_t *nd = &E.node[E.order[k]];
            for (v = 0; v < nd->ninst; v++) {           /* every voice of a per-voice module, once for a shared one */
                inst_t *it = &inst_pool[nd->inst0 + v];
                cur_v = v;
                for (s = it->sum0; s < (uint32_t)it->sum0 + it->nsum; s++) {
                    const sum_t *sm = &E.sum[s];
                    uint32_t q;
                    for (i = 0; i < n; i++)
                        sm->dst[i] = 0;
                    for (q = 0; q < sm->n; q++) {
                        const esig_t *src = E.sum_src[sm->first + q];
                        for (i = 0; i < n; i++)
                            sm->dst[i] += src[i];
                    }
                }
                apply_cv(nd, it, n);
                process(nd, it, n);
            }
        }
        for (k = 0; k < E.nout; k++) {
            const node_t *o = &E.node[E.outputs[k]];
            const inst_t *it = &inst_pool[o->inst0];
            int32_t lvl = it->eff[OUTPUT_P_LEVEL];
            const esig_t *l = it->in[OUTPUT_I_L], *r = (o->conn & (1u << OUTPUT_I_R)) ? it->in[OUTPUT_I_R] : it->in[OUTPUT_I_L];
            for (i = 0; i < n; i++) {
                left[off + i] += mul16(l[i], lvl);
                right[off + i] += mul16(r[i], lvl);
            }
        }
    }
    for (i = 0; i < total; i++) {
        left[i] = clampi(left[i], -ENG_ONE, ENG_ONE);
        right[i] = clampi(right[i], -ENG_ONE, ENG_ONE);
    }
}

void eng_voice_select(uint32_t v)
{
    if (v < ENG_VOICES)
        eng_p = &EV[v];
}

uint32_t eng_voice(void) { return VOICE_NO; }

static volatile int32_t vgain[ENG_VOICES] = ENG_VOICE_INIT(ENG_ONE, ENG_ONE, ENG_ONE, ENG_ONE);   /* the mixer: each voice's level, Q16 (0 = muted) */

void eng_voice_gain(uint32_t v, int32_t q16)
{
    if (v < ENG_VOICES)
        vgain[v] = q16 < 0 ? 0 : q16 > ENG_ONE ? ENG_ONE : q16;
}

/* the voices of the patch, mixed: voice 1 into left / right, the others added, then clamped */
void eng_render(int32_t *left, int32_t *right, uint32_t total)
{
    eng_t *keep = eng_p;                /* the audio ISR may run in the middle of a panel call: give the pointer back */
    uint32_t v, off, i;
    int32_t tl[ENG_BLOCK], tr[ENG_BLOCK];
    eng_p = &EV[0];
    render_voice(left, right, total);
    if (vgain[0] != ENG_ONE)
        for (i = 0; i < total; i++) {
            left[i] = mul16(left[i], vgain[0]);
            right[i] = mul16(right[i], vgain[0]);
        }
    for (v = 1; v < ENG_VOICES; v++) {
        eng_p = &EV[v];
        if (!E.loaded)
            continue;
        for (off = 0; off < total; off += ENG_BLOCK) {
            uint32_t n = total - off < ENG_BLOCK ? total - off : ENG_BLOCK;
            render_voice(tl, tr, n);
            for (i = 0; i < n; i++) {
                left[off + i] = clampi(left[off + i] + mul16(tl[i], vgain[v]), -ENG_ONE, ENG_ONE);
                right[off + i] = clampi(right[off + i] + mul16(tr[i], vgain[v]), -ENG_ONE, ENG_ONE);
            }
        }
    }
    eng_p = keep;
}

void eng_note_on_v(uint32_t v, uint32_t note, int32_t vel_q16)     /* a note on one voice, whichever the panel has selected */
{
    eng_t *keep = eng_p;
    eng_voice_select(v);
    eng_note_on(note, vel_q16);
    eng_p = keep;
}

void eng_note_off_v(uint32_t v, uint32_t note)
{
    eng_t *keep = eng_p;
    eng_voice_select(v);
    eng_note_off(note);
    eng_p = keep;
}

void eng_all_notes_off_v(uint32_t v)
{
    eng_t *keep = eng_p;
    eng_voice_select(v);
    eng_all_notes_off();
    eng_p = keep;
}
