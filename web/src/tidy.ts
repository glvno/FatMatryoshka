// SPDX-License-Identifier: GPL-3.0-only
// "Tidy up": line the canvas up in columns, the way a desktop's Clean Up does, keeping the user's arrangement (which
// column a card is in and its order down the column). Expanded assemblies are tidied inside first and then move as one
// block. Pure model code: the editor passes the cards' sizes.
import { assembliesOf, childrenOf, moveAssembly, parentOf, type AssemblyInst, type Rect } from './assembly';
import type { Patch } from './patch';

/** space between cards, and between the canvas edge and the first column / row */
export const TIDY_GAP = 20;

export interface TidySizes {
  /** a module card's size (0 when unknown: the caller's default is used) */
  module(id: number): { w: number; h: number };
  /** a collapsed assembly card's size */
  container(id: number): { w: number; h: number };
  /** an expanded assembly's frame around its content: padding, header height (with a poly strip) and least width */
  frame(a: AssemblyInst): { pad: number; head: number; minW: number };
}

type Item = { r: Rect; move: (dx: number, dy: number) => void };

/** the items' new places: columns from their left edges, each column stacked from `y0`, the columns side by side from `x0` */
function arrange(items: Item[], x0: number, y0: number): void {
  const cols: Item[][] = [];
  for (const it of [...items].sort((a, b) => a.r.x - b.r.x || a.r.y - b.r.y)) {
    const col = cols[cols.length - 1];
    // a card joins the column while its left edge is within the first half of the column's first card
    if (col && it.r.x < col[0].r.x + col[0].r.w / 2) col.push(it);
    else cols.push([it]);
  }
  let x = x0;
  for (const col of cols) {
    col.sort((a, b) => a.r.y - b.r.y || a.r.x - b.r.x);
    let y = y0;
    for (const it of col) {
      it.move(x - it.r.x, y - it.r.y);
      it.r.x = x;
      it.r.y = y;
      y += it.r.h + TIDY_GAP;
    }
    x += Math.max(...col.map((it) => it.r.w)) + TIDY_GAP;
  }
}

/**
 * Tidy the whole canvas. `skip` = module ids that are not on the canvas (the docked Main panel). Expanded assemblies
 * lose a size the user gave their frame, so the frame fits its tidied content. Returns nothing; positions change in `p`.
 */
export function tidy(p: Patch, sizes: TidySizes, skip: Set<number> = new Set()): void {
  const inAsm = new Set(assembliesOf(p).flatMap((a) => a.modules));
  const moduleItem = (id: number): Item | null => {
    const m = p.modules.find((x) => x.id === id);
    if (!m || skip.has(id)) return null;
    const s = sizes.module(id);
    return { r: { x: m.x, y: m.y, w: s.w, h: s.h }, move: (dx, dy) => { m.x += dx; m.y += dy; } };
  };
  // an assembly as one item: a collapsed card, or an expanded frame whose content is tidied first
  const asmItem = (a: AssemblyInst): Item | null => {
    if (!a.open) {
      const s = sizes.container(a.id);
      return { r: { x: a.x, y: a.y, w: s.w, h: s.h }, move: (dx, dy) => moveAssembly(p, a, dx, dy) };
    }
    const inner = [...a.modules.map(moduleItem), ...childrenOf(p, a).map(asmItem)].filter((x): x is Item => !!x);
    if (!inner.length) return null;
    const { pad, head, minW } = sizes.frame(a);
    const left = Math.min(...inner.map((it) => it.r.x));
    const top = Math.min(...inner.map((it) => it.r.y));
    arrange(inner, left, top);
    delete a.frameSize;
    const right = Math.max(...inner.map((it) => it.r.x + it.r.w));
    const bottom = Math.max(...inner.map((it) => it.r.y + it.r.h));
    const r = { x: left - pad, y: top - pad - head, w: Math.max(right - left + 2 * pad, minW), h: bottom - top + 2 * pad + head };
    return { r, move: (dx, dy) => moveAssembly(p, a, dx, dy) };
  };
  const top = [
    ...p.modules.filter((m) => !inAsm.has(m.id)).map((m) => moduleItem(m.id)),
    ...assembliesOf(p).filter((a) => !parentOf(p, a.id)).map(asmItem),
  ].filter((x): x is Item => !!x);
  arrange(top, TIDY_GAP, TIDY_GAP);
}
