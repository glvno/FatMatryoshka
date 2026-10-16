// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { makeAssembly, overlaps } from './assembly';
import { DEFS } from './modules';
import { addModule, emptyPatch, type Patch } from './patch';
import { TIDY_GAP, tidy, tidyAssembly, type TidySizes } from './tidy';

const W = 250;
const H = 300;
const sizes: TidySizes = { module: () => ({ w: W, h: H }), container: () => ({ w: W, h: 200 }), frame: () => ({ pad: 12, head: 30, minW: 0 }) };
const at = (p: Patch, id: number) => { const m = p.modules.find((x) => x.id === id)!; return [m.x, m.y]; };

describe('tidy up', () => {
  it('snaps cards into columns, keeping which column they are in and their order down it', () => {
    const p = emptyPatch();
    const a = addModule(p, DEFS.osc, 33, 400);
    const b = addModule(p, DEFS.lfo, 60, 10);
    const c = addModule(p, DEFS.vca, 700, 250);
    tidy(p, sizes);
    expect(at(p, b.id)).toEqual([TIDY_GAP, TIDY_GAP]);
    expect(at(p, a.id)).toEqual([TIDY_GAP, TIDY_GAP + H + TIDY_GAP]);
    expect(at(p, c.id)).toEqual([TIDY_GAP + W + TIDY_GAP, TIDY_GAP]);
  });

  it('moves an expanded assembly as one block, tidied inside, with nothing overlapping its frame', () => {
    const p = emptyPatch();
    const x = addModule(p, DEFS.osc, 500, 500);
    const y = addModule(p, DEFS.adsr, 530, 700);
    const free = addModule(p, DEFS.noise, 40, 40);
    const asm = makeAssembly(p, [x.id, y.id], 'v');
    asm.open = true;
    asm.frameSize = { width: 2000, height: 2000 };
    tidy(p, sizes);
    expect(asm.frameSize).toBeUndefined();
    // the frame starts right of the free card's column, its content one header and padding lower
    const fx = TIDY_GAP + W + TIDY_GAP;
    expect(at(p, x.id)).toEqual([fx + 12, TIDY_GAP + 12 + 30]);
    expect(at(p, y.id)).toEqual([fx + 12, TIDY_GAP + 12 + 30 + H + TIDY_GAP]);
    const frame = { x: fx, y: TIDY_GAP, w: W + 24, h: 2 * H + TIDY_GAP + 24 + 30 };
    const [fx0, fy0] = at(p, free.id);
    expect(overlaps(frame, { x: fx0, y: fy0, w: W, h: H })).toBe(false);
  });

  it('leaves skipped modules (the docked Main) where they are, and is idempotent', () => {
    const p = emptyPatch();
    const kb = addModule(p, DEFS.fm1, 900, 900);
    addModule(p, DEFS.osc, 300, 300);
    tidy(p, sizes, new Set([kb.id]));
    const once = JSON.stringify(p);
    tidy(p, sizes, new Set([kb.id]));
    expect(JSON.stringify(p)).toBe(once);
    expect(at(p, kb.id)).toEqual([900, 900]);
  });

  it('tidies one assembly inside from its top left, leaving the rest of the canvas alone', () => {
    const p = emptyPatch();
    const x = addModule(p, DEFS.osc, 500, 500);
    const y = addModule(p, DEFS.adsr, 500, 500); // stacked on x, as an old file leaves them
    const free = addModule(p, DEFS.noise, 900, 40);
    const asm = makeAssembly(p, [x.id, y.id], 'v');
    asm.open = true;
    tidyAssembly(p, asm, sizes);
    expect(at(p, x.id)).toEqual([500, 500]);
    expect(at(p, y.id)).toEqual([500, 500 + H + TIDY_GAP]);
    expect(at(p, free.id)).toEqual([900, 40]);
  });
});
