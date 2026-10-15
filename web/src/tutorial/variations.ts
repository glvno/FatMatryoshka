// SPDX-License-Identifier: GPL-3.0-only
// Tutorial sketches are independent of the finite hardware upload bank.
import { validatePatch, type Patch } from '../patch';
import { DEFS } from '../modules';
export interface Variation { id: string; saved: string; chapter: string | null; patch: Patch }
const STORE = 'matryoshka.tutorial.variations';
export function variations(storage: Pick<Storage, 'getItem'> = localStorage): Variation[] {
  const raw: unknown = JSON.parse(storage.getItem(STORE) ?? '[]');
  if (!Array.isArray(raw)) throw new Error('The saved variations could not be read');
  return raw.map((x) => ({ id: String(x.id), saved: String(x.saved), chapter: x.chapter, patch: validatePatch(x.patch, DEFS) }));
}
/** No eviction or name-based replacement: a failed write must leave the open patch alone. */
export function keepVariation(patch: Patch, chapter: string | null, storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage): Variation {
  const list = variations(storage);
  const copy = validatePatch(JSON.parse(JSON.stringify(patch)), DEFS);
  const last = list[list.length - 1];
  if (last && JSON.stringify(last.patch) === JSON.stringify(copy)) return last;
  const entry = { id: crypto.randomUUID(), saved: new Date().toISOString(), chapter, patch: copy };
  storage.setItem(STORE, JSON.stringify([...list, entry]));
  return entry;
}
