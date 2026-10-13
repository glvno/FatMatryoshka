// SPDX-License-Identifier: GPL-3.0-only
// What changed between two versions of a patch (the diff view): parameters by module id, modules and cables added or
// removed, and the rest (attenuverters, matrix, bypass, macro ranges, voices, arpeggiator, morph) as one line each.
import type { ModuleDef, Patch } from './patch';
import { ARP_FIELDS } from './arp';

export interface PatchDiff {
  params: { module: number; label: string; name: string; from: number; to: number }[];
  added: string[];
  removed: string[];
  cablesAdded: string[];
  cablesRemoved: string[];
  other: string[];
}

const fmt = (v: number): string => String(Number(v.toFixed(4)));

export function diffPatches(a: Patch, b: Patch, defs: Record<string, ModuleDef>): PatchDiff {
  const d: PatchDiff = { params: [], added: [], removed: [], cablesAdded: [], cablesRemoved: [], other: [] };
  const labelOf = (p: Patch, id: number): string => {
    const m = p.modules.find((x) => x.id === id);
    return m ? `${defs[m.type]?.label ?? m.type} #${id}` : `#${id}`;
  };
  const am = new Map(a.modules.map((m) => [m.id, m]));
  const bm = new Map(b.modules.map((m) => [m.id, m]));
  for (const m of b.modules) if (!am.has(m.id)) d.added.push(labelOf(b, m.id));
  for (const m of a.modules) if (!bm.has(m.id)) d.removed.push(labelOf(a, m.id));
  for (const m of b.modules) {
    const o = am.get(m.id);
    if (!o) continue;
    if (o.type !== m.type) {
      d.removed.push(labelOf(a, m.id));
      d.added.push(labelOf(b, m.id));
      continue;
    }
    const label = labelOf(b, m.id);
    for (const pd of defs[m.type]?.params ?? []) {
      const from = o.params[pd.name] ?? pd.default, to = m.params[pd.name] ?? pd.default;
      if (Math.abs(from - to) > 1e-9) d.params.push({ module: m.id, label, name: pd.name, from, to });
    }
    if (!!o.bypass !== !!m.bypass) d.other.push(`${label}: ${m.bypass ? 'bypassed' : 'on'}`);
    const att = (x: typeof m): string => (x.att ?? [1, 1]).map(fmt).join('/');
    if (att(o) !== att(m)) d.other.push(`${label}: attenuverters ${att(o)} → ${att(m)}`);
    if (JSON.stringify(o.map ?? null) !== JSON.stringify(m.map ?? null)) d.other.push(`${label}: parameter routing changed`);
    if (JSON.stringify(o.disabledInputs ?? []) !== JSON.stringify(m.disabledInputs ?? [])) d.other.push(`${label}: fixed input routing changed`);
    if (JSON.stringify(o.range ?? null) !== JSON.stringify(m.range ?? null)) d.other.push(`${label}: macro ranges changed`);
    if (JSON.stringify(o.paramsB ?? null) !== JSON.stringify(m.paramsB ?? null)) d.other.push(`${label}: morph B side changed`);
  }
  const key = (p: Patch, c: Patch['cables'][number]): string => `${labelOf(p, c.from.module)} ${c.from.port} → ${labelOf(p, c.to.module)} ${c.to.port}`;
  const ac = new Set(a.cables.map((c) => key(a, c)));
  const bc = new Set(b.cables.map((c) => key(b, c)));
  for (const k of bc) if (!ac.has(k)) d.cablesAdded.push(k);
  for (const k of ac) if (!bc.has(k)) d.cablesRemoved.push(k);
  if ((a.voices ?? 1) !== (b.voices ?? 1)) d.other.push(`voices ${a.voices ?? 1} → ${b.voices ?? 1}`);
  if (JSON.stringify(a.arp ?? null) !== JSON.stringify(b.arp ?? null)) {
    const changed = a.arp && b.arp ? ARP_FIELDS.filter((f) => a.arp![f] !== b.arp![f]).map((f) => `${f} ${a.arp![f]} → ${b.arp![f]}`) : [];
    d.other.push(`arpeggiator ${changed.length ? changed.join(', ') : b.arp ? 'set' : 'removed'}`);
  }
  if ((a.morphName ?? '') !== (b.morphName ?? '')) d.other.push(`morph B side: ${b.morphName ?? 'none'}`);
  if (a.name !== b.name) d.other.push(`name "${a.name}" → "${b.name}"`);
  return d;
}

export const diffCount = (d: PatchDiff): number => d.params.length + d.added.length + d.removed.length + d.cablesAdded.length + d.cablesRemoved.length + d.other.length;

/** the diff as lines of text (the panel, the status line) */
export function diffLines(d: PatchDiff): string[] {
  return [
    ...d.params.map((p) => `${p.label} ${p.name}: ${fmt(p.from)} → ${fmt(p.to)}`),
    ...d.added.map((s) => `+ ${s}`),
    ...d.removed.map((s) => `− ${s}`),
    ...d.cablesAdded.map((s) => `+ cable ${s}`),
    ...d.cablesRemoved.map((s) => `− cable ${s}`),
    ...d.other,
  ];
}
