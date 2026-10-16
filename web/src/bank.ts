// SPDX-License-Identifier: GPL-3.0-only
// The Patches page: choose up to 32 patches and put them into the FM-1's patch bank (flash). The PRESET knob of the
// FM-1 steps through the bank; with an empty bank it steps through the factory patches built into the firmware.
// Patches over the FM-1's budget (patchbin.ts deviceBudget) are kept apart, in an uncapped browser-only list.
import type { DeviceLink } from './device';
import { DEFS } from './modules';
import { validatePatch, type Patch } from './patch';
import { deviceBudget } from './patchbin';
import { PRESETS } from './presets';
import { SLOTS } from './protocol';
import { decodeShare, shareCodeOf } from './share';

interface Entry {
  name: string;
  /** a patch of the editor, kept as a copy; factory patches are rebuilt from PRESETS */
  patch?: Patch;
}

const STORE = 'modular-1.bank';
/** the editor's patches that do not fit the FM-1: played in the browser only, never uploaded */
const STORE_OVER = 'matryoshka.bank-over';

const fits = (p: Patch): boolean => deviceBudget(p).fits;

function loadOver(): Entry[] {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_OVER) ?? '[]') as Entry[];
    if (Array.isArray(raw)) return raw.filter((e) => typeof e?.name === 'string' && e.patch).map((e) => ({ name: e.name, patch: validatePatch(e.patch, DEFS) }));
  } catch {
    /* fall through: none */
  }
  return [];
}

function saveOver(list: Entry[]): void {
  try {
    localStorage.setItem(STORE_OVER, JSON.stringify(list));
  } catch {
    /* storage blocked: the list is not remembered */
  }
}

function load(): Entry[] {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE) ?? 'null') as Entry[] | null;
    if (Array.isArray(raw)) {
      const ok = raw
        .filter((e) => typeof e?.name === 'string' && (e.patch ? true : e.name in PRESETS))
        .map((e) => (e.patch ? { name: e.name, patch: validatePatch(e.patch, DEFS) } : { name: e.name }))
        .slice(0, SLOTS);
      return ok;
    }
  } catch {
    /* fall through to the default */
  }
  return Object.keys(PRESETS).slice(0, SLOTS).map((name) => ({ name }));
}

function save(list: Entry[]): void {
  try {
    localStorage.setItem(STORE, JSON.stringify(list));
  } catch {
    /* storage blocked: the list is not remembered */
  }
}

const patchOf = (e: Entry): Patch => (e.patch ? e.patch : PRESETS[e.name]());

/**
 * Put a patch into the bank under its name (replacing one of that name); a factory patch of that name is left alone.
 * A patch over the FM-1's budget goes to the over-budget list instead (and leaves the bank), one that fits leaves that list.
 */
export function addToBank(p: Patch): string {
  const list = load();
  const i = list.findIndex((e) => e.name === p.name);
  if (i >= 0 && !list[i].patch) return `"${p.name}" is a factory patch: rename it to keep a copy`;
  const copy = { name: p.name, patch: validatePatch(JSON.parse(JSON.stringify(p)), DEFS) };
  const over = loadOver();
  const j = over.findIndex((e) => e.name === p.name);
  if (!fits(copy.patch)) {
    if (i >= 0) save(list.filter((_, k) => k !== i));
    if (j >= 0) over[j] = copy;
    else over.push(copy);
    saveOver(over);
    return `"${p.name}" is over the FM-1 budget: kept under "Over budget" in the Library (browser only)`;
  }
  if (j >= 0) saveOver(over.filter((_, k) => k !== j));
  if (i >= 0) list[i] = copy;
  else if (list.length >= SLOTS) return `the bank is full (${SLOTS} slots): "${p.name}" was not kept`;
  else list.push(copy);
  save(list);
  return `"${p.name}" ${i >= 0 ? 'updated in' : 'kept in'} the bank`;
}

/** the patches the Patches page holds (the editor's own copies; factory patches are rebuilt), for the morph picker */
export const bankPatches = (): { name: string; patch: Patch }[] => [...load(), ...loadOver()].map((e) => ({ name: e.name, patch: patchOf(e) }));

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  const { class: cls, ...rest } = props as Record<string, unknown>;
  if (cls) e.className = String(cls);
  Object.assign(e, rest);
  e.append(...kids);
  return e;
}

/** builds the page; returns a refresh that rereads both lists (another part of the app may have saved to them) */
export function buildBankTab(root: HTMLElement, device: DeviceLink, currentPatch: () => Patch, onConnected: (msg: string) => void, open: (p: Patch) => void): () => void {
  let list = load();
  let over = loadOver();
  // an editor copy that no longer fits (saved before the budget, or a larger factory build) moves to the over-budget list
  const reread = (): void => {
    list = load();
    over = loadOver();
    const misfit = list.filter((e) => e.patch && !fits(e.patch));
    if (!misfit.length) return;
    list = list.filter((e) => !misfit.includes(e));
    over = [...over.filter((e) => !misfit.some((m) => m.name === e.name)), ...misfit];
    save(list);
    saveOver(over);
  };
  reread();
  const overEl = el('div', { class: 'bank-list' });
  const libEl = el('div', { class: 'bank-list' });
  const bankEl = el('div', { class: 'bank-list' });
  const countEl = el('span', { class: 'muted' });
  const status = el('p', { class: 'muted', textContent: 'Not connected.' });
  const bar = el('progress', { max: 100, value: 0 });
  const onDevice = el('pre', { class: 'log', textContent: '' });
  const connect = el('button', { textContent: 'Connect FM-1' });
  const upload = el('button', { class: 'primary', textContent: 'Upload bank to FM-1', disabled: true });
  const read = el('button', { textContent: 'Read FM-1 bank', disabled: true });
  const clear = el('button', { textContent: 'Empty the FM-1 bank', disabled: true });
  let busy = false;

  const refresh = (): void => {
    const full = list.length >= SLOTS;
    libEl.replaceChildren(
      ...Object.keys(PRESETS).map((name) => {
        const used = list.some((e) => !e.patch && e.name === name);
        return el('div', { class: 'bank-row' }, el('span', { textContent: name }), el('button', { textContent: '+', title: used ? 'already in the bank' : 'add to the bank', disabled: full, onclick: () => { list.push({ name }); changed(); } }));
      }),
    );
    bankEl.replaceChildren(
      ...list.map((e, i) =>
        el(
          'div',
          { class: 'bank-row' },
          el('span', { class: 'slot', textContent: String(i + 1).padStart(2, '0') }),
          el('span', { class: 'grow', textContent: e.patch ? `${e.name} (editor)` : e.name }),
          el('button', { textContent: '▲', title: 'move up', disabled: i === 0, onclick: () => { [list[i - 1], list[i]] = [list[i], list[i - 1]]; changed(); } }),
          el('button', { textContent: '▼', title: 'move down', disabled: i === list.length - 1, onclick: () => { [list[i + 1], list[i]] = [list[i], list[i + 1]]; changed(); } }),
          el('button', { textContent: '×', title: 'remove', onclick: () => { list.splice(i, 1); changed(); } }),
        ),
      ),
    );
    overEl.replaceChildren(
      ...(over.length ? over.map((e, i) => el('div', { class: 'bank-row' },
        el('span', { class: 'grow', textContent: e.name }),
        el('button', { textContent: 'Open', title: 'open in the editor', onclick: () => open(JSON.parse(JSON.stringify(e.patch)) as Patch) }),
        el('button', { textContent: '×', title: 'remove', onclick: () => { over.splice(i, 1); saveOver(over); refresh(); } }),
      )) : [el('p', { class: 'muted', textContent: 'None. A patch saved while it is over the FM-1 budget lands here.' })]),
    );
    countEl.textContent = `${list.length} of ${SLOTS} slots`;
    const ready = device.connected && !busy;
    upload.disabled = !ready || list.length === 0;
    read.disabled = !ready;
    clear.disabled = !ready;
  };
  const changed = (): void => {
    save(list);
    refresh();
  };

  const run = async (what: string, fn: () => Promise<void>): Promise<void> => {
    if (busy) return;
    busy = true;
    refresh();
    try {
      await fn();
    } catch (e) {
      status.textContent = `${what} failed: ${(e as Error).message}`;
    } finally {
      busy = false;
      refresh();
    }
  };

  connect.onclick = () =>
    void run('connect', async () => {
      const info = await device.connect();
      status.textContent = `FM-1 connected (flash ${info.flashOk ? 'ok' : 'not available: the bank cannot be stored'}).`;
      onConnected(status.textContent);
    });

  upload.onclick = () =>
    void run('upload', async () => {
      const total = list.length;
      status.textContent = 'Reading the bank on the FM-1…';
      const have = await device.readBank();
      for (let i = 0; i < total; i++) {
        status.textContent = `Uploading ${i + 1} of ${total}: ${list[i].name}`;
        bar.value = (100 * i) / total;
        await device.uploadSlot(i, list[i].name.toUpperCase(), patchOf(list[i]));
      }
      for (let i = total; i < SLOTS; i++)
        if (have[i].used) {
          status.textContent = `Emptying slot ${i + 1}`;
          await device.eraseSlot(i);
        }
      bar.value = 100;
      status.textContent = `${total} patches are on the FM-1. Turn its PRESET knob to step through them.`;
    });

  read.onclick = () =>
    void run('read', async () => {
      status.textContent = 'Reading the bank on the FM-1…';
      const slots = await device.readBank();
      const used = slots.filter((s) => s.used);
      onDevice.textContent = used.length ? used.map((s) => `${String(s.slot + 1).padStart(2, '0')}  ${s.name}  (${s.length} bytes)`).join('\n') : 'The bank is empty: the PRESET knob steps through the factory patches built into the firmware.';
      status.textContent = `${used.length} of ${SLOTS} slots are used on the FM-1.`;
    });

  clear.onclick = () =>
    void run('clear', async () => {
      const slots = await device.readBank();
      for (const s of slots) if (s.used) await device.eraseSlot(s.slot);
      onDevice.textContent = 'The bank is empty: the PRESET knob steps through the factory patches built into the firmware.';
      status.textContent = 'The FM-1 bank is empty.';
    });

  const addCurrent = el('button', {
    textContent: 'Add the patch from the editor',
    onclick: () => {
      const p = JSON.parse(JSON.stringify(currentPatch())) as Patch;
      if (!fits(p)) {
        status.textContent = addToBank({ ...p, name: p.name || 'PATCH' });
        reread();
        return refresh();
      }
      if (list.length >= SLOTS) return;
      list.push({ name: p.name || 'PATCH', patch: p });
      changed();
    },
  });
  const linkIn = el('input', { type: 'text', placeholder: 'paste a patch link (…#p=…)' });
  const importLink = el('button', {
    textContent: 'Import link',
    onclick: async () => {
      const code = shareCodeOf(linkIn.value.trim()) ?? (/^[A-Za-z0-9_-]{16,}$/.test(linkIn.value.trim()) ? linkIn.value.trim() : null);
      if (!code) return void (status.textContent = 'that is not a patch link');
      try {
        const p = await decodeShare(code, DEFS);
        if (!fits(p)) {
          status.textContent = addToBank({ ...p, name: p.name || 'PATCH' });
          linkIn.value = '';
          reread();
          return refresh();
        }
        if (list.length >= SLOTS) return void (status.textContent = 'the list is full');
        list.push({ name: p.name || 'PATCH', patch: p });
        linkIn.value = '';
        changed();
        status.textContent = `"${p.name}" added to the list from the link.`;
      } catch (e) {
        status.textContent = `the link holds no patch: ${(e as Error).message}`;
      }
    },
  });
  const reset = el('button', { textContent: 'All 32 factory patches', title: 'Replace the list with the factory patches', onclick: () => { list = Object.keys(PRESETS).slice(0, SLOTS).map((name) => ({ name })); changed(); } });
  const empty = el('button', { textContent: 'Empty the list', onclick: () => { list = []; changed(); } });

  root.append(
    el('div', { class: 'card' }, el('h2', {}, el('span', { class: 'mtag util', textContent: 'FM-1' }), 'Patch bank'), el('p', { textContent: 'Choose up to 32 patches and send them to the FM-1. They are written to its flash: the PRESET knob steps through them, a program change selects one, and they stay when the power is off. Uploading replaces the whole bank.' }), el('div', { class: 'toolbar' }, connect, upload, read, clear), bar, status),
    el(
      'div',
      { class: 'bank-cols' },
      el('div', { class: 'card' }, el('h2', {}, el('span', { class: 'mtag src', textContent: 'PATCHES' }), 'Factory patches'), el('div', { class: 'toolbar' }, addCurrent), el('div', { class: 'toolbar' }, linkIn, importLink), libEl),
      el('div', { class: 'card' }, el('h2', {}, el('span', { class: 'mtag shp', textContent: 'BANK' }), 'Bank to upload ', countEl), el('div', { class: 'toolbar' }, reset, empty), bankEl),
    ),
    el('div', { class: 'card' }, el('h2', {}, el('span', { class: 'mtag fx', textContent: 'OVER' }), 'Over budget (browser only)'), el('p', { class: 'muted', textContent: 'Patches too big for the FM-1. They play in the browser; they are never uploaded. One that fits again moves to the bank when you save it.' }), overEl),
    el('div', { class: 'card' }, el('h2', {}, el('span', { class: 'mtag util', textContent: 'FM-1' }), 'On the FM-1'), onDevice),
  );
  refresh();
  return () => {
    reread();
    refresh();
  };
}
