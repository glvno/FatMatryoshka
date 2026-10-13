#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
# Stand-in estimate of the firmware's .pool use without the JieLi toolchain (macOS / any clang): compile modular.c for
# riscv32 to assembly and sum the .size of the symbols placed in the .pool section.
#   tools/pool_sizes.sh [extra cflags, e.g. -DENG_VOICES=4]
# It overestimated the real build (tools/build.py) by about 7 KB in the past; build.py wants >= 8 KB of headroom.
set -e
cd "$(dirname "$0")/../firmware/src"
mkdir -p ../../build
out=../../build/pool_sizes.s
clang --target=riscv32-unknown-elf -march=rv32im -fno-integrated-as -Os -ffunction-sections -fno-builtin -Wall \
  -Wno-unused-function -I../hal -I. -DFELUCCA_ID='"FM-1_800"' "$@" -S modular.c -o "$out"
python3 - "$out" <<'PY'
import re, sys
sec = None; pool = 0; items = []
for line in open(sys.argv[1]):
    m = re.match(r'\s*\.section\s+([^,\s]+)', line)
    if m:
        sec = m.group(1); continue
    if re.match(r'\s*\.(text|data|bss)\b', line):
        sec = line.split()[0][1:]; continue
    m = re.match(r'\s*\.size\s+(\S+),\s*(\d+)', line)
    if m and sec == '.pool':
        items.append((int(m.group(2)), m.group(1))); pool += int(m.group(2))
for n, name in sorted(items, reverse=True)[:14]:
    print(f"{n:8d}  {name}")
total = 417792                       # firmware/app.ld POOL
print(f"pool {pool} B of {total} ({total - pool} B free)")
PY
