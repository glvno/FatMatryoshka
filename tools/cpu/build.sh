#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
# Build the rv32im programs that tools/cpu/rv32.mjs counts (any clang with the RISC-V target and ld.lld; runs on macOS):
#   build/cpu/prof.elf   the engine with the ENG_PROF hooks (per module costs)
#   build/cpu/plain.elf  the engine without them (totals)
#   build/cpu/old.elf    the engine of M1-0.2 (b907693) with its 303 Acid: the patch whose CPU load was measured on the FM-1
#   build/cpu/bench.elf  the fixed-point kernels of firmware/src/bench.c, also measured on the FM-1
# The flags follow tools/build.py (-Os).
set -e
cd "$(dirname "$0")/../.."
OUT=build/cpu
mkdir -p "$OUT/old"
CC="clang --target=riscv32-unknown-elf -march=rv32im -mabi=ilp32 -Os -ffunction-sections -fno-builtin -ffreestanding -nostdlib -Wall -Wno-unused-function -fuse-ld=lld -Wl,-T,tools/cpu/link.ld"
$CC -Ifirmware/src -o "$OUT/prof.elf" tools/cpu/prof.c
$CC -Ifirmware/src -DNO_PROF -o "$OUT/plain.elf" tools/cpu/prof.c
for f in engine.c engine.h defs.h dsp_tables.h presets.h; do git show "b907693:firmware/src/$f" > "$OUT/old/$f"; done
$CC -I"$OUT/old" -DNO_PROF -DOLD_PRESET -w -o "$OUT/old.elf" tools/cpu/prof.c
$CC -o "$OUT/bench.elf" tools/cpu/bench.c
