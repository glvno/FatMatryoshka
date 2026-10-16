/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 morgulbrut */
/* The fixed-point kernels of firmware/src/bench.c (measured on the FM-1, docs/ARCHITECTURE.md), counted by rv32.mjs: a
 * second check of the cycles-per-microsecond scale. Each kernel is one profiling block of 16 runs. */
#include <stdint.h>

static inline long host(long n, long a, long b, long c)
{
    register long a0 __asm__("a0") = a, a1 __asm__("a1") = b, a2 __asm__("a2") = c, a7 __asm__("a7") = n;
    __asm__ volatile("ecall" : "+r"(a0) : "r"(a1), "r"(a2), "r"(a7) : "memory");
    return a0;
}

#define BENCH_N 128u
static volatile int32_t bench_sink_i;

static void k_mul_q(void)
{
    uint32_t i;
    int32_t a = 12345, b = 23456, c = 0;
    for (i = 0; i < BENCH_N; i++) {
        c = (c * a >> 15) + b;
        c = (c * a >> 15) + b;
        c = (c * a >> 15) + b;
        c = (c * a >> 15) + b;
        c &= 0x7FFF;
    }
    bench_sink_i = c;
}

static void k_svf_q(void)
{
    uint32_t i;
    int32_t low = 0, band = 0, f = 6000, q = 20000, in = 10000;
    for (i = 0; i < BENCH_N; i++) {
        int32_t high;
        low += (f * band) >> 15;
        high = in - low - ((q * band) >> 15);
        band += (f * high) >> 15;
        in = -in;
    }
    bench_sink_i = low + band;
}

static void (*volatile const K[])(void) = {k_mul_q, k_svf_q};

int main(void)
{
    uint32_t k, r;
    for (k = 0; k < 2; k++) {
        host(2, 6, 0, 0);
        for (r = 0; r < 16; r++)
            K[k]();
        host(2, 7, 0, 0);
    }
    return 0;
}

__attribute__((naked, section(".text.start"))) void _start(void)
{
    __asm__ volatile("li sp, 0x00f00000\n call main\n li a7, 93\n ecall\n");
}
