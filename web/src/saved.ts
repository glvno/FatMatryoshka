// SPDX-License-Identifier: GPL-3.0-only
// The user's own patches, kept in the browser (localStorage), as many as they like, whatever the FM-1 budget.
// Saving under an existing name replaces that patch. Separate from the FM-1 bank (bank.ts), which is the list to upload.
import { DEFS } from './modules';
import { validatePatch, type Patch } from './patch';

const STORE = 'matryoshka.patches';

export interface SavedPatch {
  name: string;
  patch: Patch;
  /** ms since the epoch, of the last save */
  saved: number;
}

const listeners = new Set<() => void>();
/** called after every save or removal (the examples picker and the Library list rebuild) */
export const onSavedChange = (fn: () => void): void => void listeners.add(fn);

function write(list: SavedPatch[]): boolean {
  try {
    localStorage.setItem(STORE, JSON.stringify(list));
  } catch {
    return false;
  }
  for (const fn of listeners) fn();
  return true;
}

/** the saved patches, most recently saved first */
export function savedPatches(): SavedPatch[] {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE) ?? '[]') as SavedPatch[];
    if (!Array.isArray(raw)) return [];
    const out: SavedPatch[] = [];
    for (const e of raw) {
      if (typeof e?.name !== 'string' || !e.patch) continue;
      try {
        out.push({ name: e.name, patch: validatePatch(e.patch, DEFS), saved: Number(e.saved) || 0 });
      } catch {
        /* a patch this version cannot read: skipped, left in storage */
      }
    }
    return out.sort((a, b) => b.saved - a.saved);
  } catch {
    return [];
  }
}

function rawList(): SavedPatch[] {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE) ?? '[]') as SavedPatch[];
    return Array.isArray(raw) ? raw.filter((e) => typeof e?.name === 'string') : [];
  } catch {
    return [];
  }
}

/** keep a copy of `p` under its name (replacing one of that name); returns a status line */
export function savePatch(p: Patch): string {
  const name = p.name.trim() || 'Untitled';
  const list = rawList();
  const i = list.findIndex((e) => e.name === name);
  const entry = { name, patch: JSON.parse(JSON.stringify({ ...p, name })) as Patch, saved: Date.now() };
  if (i >= 0) list[i] = entry;
  else list.push(entry);
  if (!write(list)) return `"${name}" was not saved: the browser refused the storage`;
  return `"${name}" ${i >= 0 ? 'saved (replaced the earlier copy)' : 'saved'} in Your patches`;
}

export function removeSaved(name: string): void {
  write(rawList().filter((e) => e.name !== name));
}

export const isSaved = (name: string): boolean => rawList().some((e) => e.name === name);
