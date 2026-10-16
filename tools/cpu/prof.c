/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 morgulbrut */
/* The engine built for rv32im, run by tools/cpu/rv32.mjs: counts instructions per module for the CPU estimate.
 * Host calls (ecall, a7 = call number): 1 read the patch into a buffer (a0 buf, a1 max -> length), 2 a profiling mark
 * (a0 stage, a1 node, a2 part, see ENG_PROF in engine.c), 3 the next event (-> 0 none, else (kind << 16) | note: kind 1
 * on, 2 off, 3 render a block), 93 exit (a0 code). Built by tools/cpu/build.sh. */
#include <stdint.h>

static inline long host(long n, long a, long b, long c)
{
    register long a0 __asm__("a0") = a, a1 __asm__("a1") = b, a2 __asm__("a2") = c, a7 __asm__("a7") = n;
    __asm__ volatile("ecall" : "+r"(a0) : "r"(a1), "r"(a2), "r"(a7) : "memory");
    return a0;
}

#ifndef NO_PROF                                         /* NO_PROF: the plain engine, for the totals */
#define ENG_PROF(stage, node, part) host(2, (stage), (long)(node), (long)(part))
#endif
#include "engine.c"
#ifdef OLD_PRESET                                       /* an old engine checked out of git with its factory patch 0 */
#include "presets.h"
#endif

void *memset(void *d, int c, unsigned long n)
{
    uint8_t *p = d;
    while (n--) *p++ = (uint8_t)c;
    return d;
}

void *memcpy(void *d, const void *s, unsigned long n)
{
    uint8_t *p = d;
    const uint8_t *q = s;
    while (n--) *p++ = *q++;
    return d;
}

/* 64-bit division, as compiler-rt does it on a core without a 64-bit divider (the firmware links libcompiler-rt.a) */
uint64_t __udivmoddi4(uint64_t a, uint64_t b, uint64_t *rem)
{
    uint64_t q = 0;
    int s;
    if (b == 0 || a < b) {
        if (rem) *rem = b ? a : 0;
        return 0;
    }
    s = __builtin_clzll(b) - __builtin_clzll(a);
    b <<= s;
    for (; s >= 0; s--, b >>= 1) {
        q <<= 1;
        if (a >= b) {
            a -= b;
            q |= 1;
        }
    }
    if (rem) *rem = a;
    return q;
}
uint64_t __udivdi3(uint64_t a, uint64_t b) { return __udivmoddi4(a, b, 0); }
uint64_t __umoddi3(uint64_t a, uint64_t b) { uint64_t r; __udivmoddi4(a, b, &r); return r; }
int64_t __divdi3(int64_t a, int64_t b)
{
    uint64_t q = __udivmoddi4(a < 0 ? -(uint64_t)a : (uint64_t)a, b < 0 ? -(uint64_t)b : (uint64_t)b, 0);
    return (a < 0) != (b < 0) ? -(int64_t)q : (int64_t)q;
}
int64_t __moddi3(int64_t a, int64_t b)
{
    uint64_t r;
    __udivmoddi4(a < 0 ? -(uint64_t)a : (uint64_t)a, b < 0 ? -(uint64_t)b : (uint64_t)b, &r);
    return a < 0 ? -(int64_t)r : (int64_t)r;
}

static uint8_t patch[4096];
static int32_t l[128], r[128], out[256];

int main(void)
{
#ifdef OLD_PRESET
    long len = (long)PRESET_LIST[0].len, ev, j;
    for (j = 0; j < len; j++)
        patch[j] = PRESET_LIST[0].data[j];
#else
    long len = host(1, (long)patch, sizeof patch, 0), ev;
#endif
    int32_t m = 2048;
    uint32_t i;
    if (len <= 0 || eng_load(patch, (uint32_t)len))
        return 1;
    while ((ev = host(3, 0, 0, 0)) != 0) {
        uint32_t kind = (uint32_t)ev >> 16, note = (uint32_t)ev & 0xffff;
        if (kind == 1)
            eng_note_on(note, 0xC000);
        else if (kind == 2)
            eng_note_off(note);
        else {
            host(2, 6, 0, 0);
            eng_render(l, r, 128);
            for (i = 0; i < 128; i++) {                 /* the audio ISR's output loop (audio.c) */
                out[2 * i] = ((l[i] * m) >> 12) << 6;
                out[2 * i + 1] = ((r[i] * m) >> 12) << 6;
            }
            host(2, 7, 0, 0);
        }
    }
    return 0;
}

__attribute__((naked, section(".text.start"))) void _start(void)
{
    __asm__ volatile("li sp, 0x00f00000\n call main\n li a7, 93\n ecall\n");
}
