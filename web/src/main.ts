// SPDX-License-Identifier: GPL-3.0-only
import { AudioHost } from './audio';
import type { HostMsg } from './worklet';
import { DeviceLink } from './device';
import { Editor } from './editor';
import { bankPatches, buildBankTab } from './bank';
import { buildAssembliesTab, storeAssembly } from './assemblies';
import { buildFlashTab } from './flasher';
import { attachKeyboard, attachMidi } from './input';
import { DEFS } from './modules';
import { emptyPatch, validatePatch, voicesOf, type Patch } from './patch';
import { ARP_DEFAULT } from './arp';
import { Scope } from './scope';
import { diffCount, diffLines, diffPatches } from './diff';
import { FACTORY, loadLibrary } from './assemblies';
import type { AssemblyDef } from './assembly';
import { PRESETS } from './presets';
import { deviceBudget, DEVICE } from './patchbin';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const STORE = 'modular-1.patch';

function loadSaved(): Patch | null {
  try {
    const s = localStorage.getItem(STORE);
    return s ? validatePatch(JSON.parse(s), DEFS) : null;
  } catch {
    return null;
  }
}

function save(p: Patch): void {
  try {
    localStorage.setItem(STORE, JSON.stringify(p));
  } catch {
    /* private mode or storage blocked: the patch just isn't remembered */
  }
}

const host = new AudioHost();
const status = $('audio-status');
host.onError = (m) => (status.textContent = `engine: ${m}`);

let currentTab = 'patch';
let saveTimer = 0;
const queueSave = (p: Patch): void => {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => save(p), 300);
};

const device = new DeviceLink();
const live = (): boolean => device.connected && $<HTMLInputElement>('dev-live').checked;
let uploadTimer = 0;
let uploading = false;
let dirty = false;
const devStatus = (s: string): void => {
  $('dev-status').textContent = s;
};
device.onStatus = devStatus;
/** upload the current patch; changes made meanwhile cause one more upload */
async function sendPatch(): Promise<void> {
  if (uploading) {
    dirty = true;
    return;
  }
  uploading = true;
  try {
    do {
      dirty = false;
      devStatus('sending patch…');
      await device.upload(editor.patch);
      baseline = JSON.stringify(editor.patch);
      devStatus('patch on the FM-1');
    } while (dirty);
  } catch (e) {
    devStatus(`${(e as Error).message}`);
  } finally {
    uploading = false;
  }
}
const queueUpload = (): void => {
  clearTimeout(uploadTimer);
  uploadTimer = window.setTimeout(() => void sendPatch(), 150);
};
/** notes go to the browser engine and, with Live on, to the FM-1 */
const sink = {
  send(msg: HostMsg): void {
    host.send(msg);
    if (live()) device.note(msg as { t: string; note?: number; vel?: number });
  },
};

let refreshAssemblies: () => void = () => {};
/** the factory patches and the Patches page's own copies (the morph picker keeps those of the same structure; the palette loads any) */
const patchCandidates = (): { name: string; patch: Patch }[] => {
  const seen = new Set<string>();
  const out: { name: string; patch: Patch }[] = [];
  for (const c of [...bankPatches(), ...Object.entries(PRESETS).map(([name, make]) => ({ name, patch: make() }))])
    if (!seen.has(c.name)) {
      seen.add(c.name);
      out.push(c);
    }
  return out;
};
const scope = new Scope($('scope'));
scope.onRemove = (key) => {
  scope.remove(key);
  host.send({ t: 'unprobe', key });
  editor.dropProbe(key);
};
host.onProbe = (key, data, sr) => scope.feed(key, data, sr);
const editor = new Editor($('canvas'), loadSaved() ?? PRESETS['Subtractive saw'](), {
  onStructure(p) {
    host.setPatch(p);
    queueSave(p);
    if (live()) queueUpload();
    if (voicesOf(p) > 1) showVoices();
  },
  onAtt(id, index, value) {
    host.send({ t: 'att', id, index, value });
    queueSave(editor.patch);
    if (live() && !uploading) device.att(editor.patch, id, index, value);
    else if (live()) dirty = true;
  },
  onParam(id, name, value) {
    host.send({ t: 'param', id, name, value });
    queueSave(editor.patch);
    if (live() && !uploading) device.param(editor.patch, id, name, value);
    else if (live()) dirty = true;
  },
  onBypass(id, on) {
    host.send({ t: 'bypass', id, on });
    queueSave(editor.patch);
    if (live() && !uploading) device.bypass(editor.patch, id, on);
    else if (live()) dirty = true;
  },
  onRange(id, index, name, range) {
    host.send({ t: 'range', id, index, name, range });
    queueSave(editor.patch);
    if (live() && !uploading) device.range(editor.patch, id, index, name, range);
    else if (live()) dirty = true;
  },
  onArp(cfg) {
    host.send({ t: 'arp', cfg });
    queueSave(editor.patch);
    if (live() && !uploading) device.arp(cfg, null);
    else if (live()) dirty = true;
  },
  onArpPlay(on) {
    host.send({ t: 'arpplay', on });
    if (live()) device.arp(editor.patch.arp ?? ARP_DEFAULT, on);
  },
  onProbe(key, id, port, kind, label, on) {
    if (on) {
      scope.add(key, label, kind);
      host.send({ t: 'probe', key, id, port });
    } else {
      scope.remove(key);
      host.send({ t: 'unprobe', key });
    }
  },
  onLayout(p) {
    queueSave(p);
  },
  onError(msg) {
    status.textContent = msg;
  },
  onSaveAssembly(def) {
    const r = storeAssembly(def);
    status.textContent = r === 'cancelled' ? 'not saved' : `"${def.name}" ${r === 'replaced' ? 'replaced in' : 'saved to'} the assembly library`;
    refreshAssemblies();
  },
  morphCandidates: patchCandidates,
});
host.setPatch(editor.patch);

// toolbar
const presetSel = $<HTMLSelectElement>('preset');
presetSel.append(new Option('Load patch…', ''), ...Object.keys(PRESETS).map((n) => new Option(n, n)), new Option('Empty patch', '__empty'));
presetSel.onchange = () => {
  const v = presetSel.value;
  if (v) editor.setPatch(v === '__empty' ? emptyPatch() : PRESETS[v]());
  setBaseline();
  presetSel.value = '';
  $<HTMLInputElement>('patch-name').value = editor.patch.name;
};
const nameInput = $<HTMLInputElement>('patch-name');
nameInput.value = editor.patch.name;
nameInput.oninput = () => {
  editor.patch.name = nameInput.value;
  queueSave(editor.patch);
};
/** the voice count is set on the Main module's card (editor.ts); here only the FM-1 budget warning */
const showVoices = (): void => {
  const b = deviceBudget(editor.patch);
  if (!b.fits) status.textContent = `too big for the FM-1: ${b.buffers} of ${DEVICE.buffers} signal buffers, ${b.instances} of ${DEVICE.instances} instances (fewer voices or modules)`;
};
const typeSel = $<HTMLSelectElement>('add-type');
typeSel.append(...Object.values(DEFS).map((d) => new Option(d.label, d.type)));
$('add-btn').onclick = () => editor.add(typeSel.value);
$('asm-btn').onclick = () => editor.makeAssembly();
$('undo-btn').onclick = () => editor.undo();
$('redo-btn').onclick = () => editor.redo();

// ---- diff against the baseline (the patch as last loaded, uploaded or stored) and A / B
let baseline = JSON.stringify(editor.patch);
const setBaseline = (): void => {
  baseline = JSON.stringify(editor.patch);
};
const diffPanel = $('diff');
const showDiff = (): void => {
  const d = diffPatches(JSON.parse(baseline) as Patch, editor.patch, DEFS);
  const lines = diffLines(d);
  diffPanel.replaceChildren();
  const h = document.createElement('h3');
  h.textContent = lines.length ? `${lines.length} change${lines.length === 1 ? '' : 's'} since the last load / upload` : 'no changes since the last load / upload';
  const x = document.createElement('button');
  x.textContent = '×';
  x.onclick = () => (diffPanel.hidden = true);
  h.append(x);
  const ul = document.createElement('ul');
  const cls = (s: string): string => (s.startsWith('+') ? 'add' : s.startsWith('−') ? 'rm' : s.includes(' → ') && !s.includes(':') ? 'o' : 'p');
  for (const s of lines) {
    const li = document.createElement('li');
    li.className = cls(s);
    li.textContent = s;
    ul.append(li);
  }
  diffPanel.append(h, ul);
  diffPanel.hidden = false;
};
$('diff-btn').onclick = () => (diffPanel.hidden ? showDiff() : (diffPanel.hidden = true));
const abToggle = $<HTMLButtonElement>('ab-toggle');
const showAB = (): void => {
  abToggle.textContent = editor.side;
  abToggle.classList.toggle('b', editor.side === 'B');
  abToggle.disabled = !(editor.snapshots.A && editor.snapshots.B);
  abToggle.title = abToggle.disabled ? 'set A and B first' : `flip to ${editor.side === 'A' ? 'B' : 'A'} (Tab)`;
};
$('ab-a').onclick = () => {
  editor.takeSnapshot('A');
  status.textContent = 'A = this patch';
  showAB();
};
$('ab-b').onclick = () => {
  editor.takeSnapshot('B');
  status.textContent = 'B = this patch';
  showAB();
};
const flipAB = (): void => {
  if (editor.toggleAB()) {
    status.textContent = `${editor.side}${diffCount(diffPatches(JSON.parse(editor.snapshots[editor.side === 'A' ? 'B' : 'A']!) as Patch, editor.patch, DEFS)) ? '' : ' (same as the other side)'}`;
    queueSave(editor.patch);
  } else status.textContent = 'set A and B first';
  showAB();
};
abToggle.onclick = flipAB;

// ---- the command palette: modules, assemblies, patches
const palette = $<HTMLDialogElement>('palette');
const palInput = $<HTMLInputElement>('palette-input');
const palList = $('palette-list');
interface Cmd {
  kind: string;
  label: string;
  run: () => void;
}
const commands = (): Cmd[] => {
  const seen = new Set<string>();
  const asms: AssemblyDef[] = [...loadLibrary(), ...FACTORY].filter((d) => (seen.has(d.name) ? false : (seen.add(d.name), true)));
  return [
    ...Object.values(DEFS).map((d) => ({ kind: 'add module', label: d.label, run: () => editor.add(d.type) })),
    ...asms.map((d) => ({ kind: 'insert', label: d.name, run: () => editor.insert(d) })),
    ...patchCandidates().map((c) => ({ kind: 'load patch', label: c.name, run: () => loadNamed(c.patch) })),
    { kind: 'command', label: 'Empty patch', run: () => loadNamed(emptyPatch()) },
    { kind: 'command', label: 'Diff since the last load / upload', run: showDiff },
    { kind: 'command', label: 'Make assembly from the selection', run: () => editor.makeAssembly() },
  ];
};
const loadNamed = (p: Patch): void => {
  editor.setPatch(p);
  setBaseline();
  nameInput.value = editor.patch.name;
};
/** fuzzy: every character of the query in order; a run of adjacent matches and a match at a word start score higher */
const score = (q: string, s: string): number => {
  s = s.toLowerCase();
  let i = 0, sc = 0, last = -2;
  for (const ch of q) {
    const j = s.indexOf(ch, i);
    if (j < 0) return -1;
    sc += j === last + 1 ? 3 : j === 0 || s[j - 1] === ' ' ? 2 : 1;
    last = j;
    i = j + 1;
  }
  return sc;
};
let palSel = 0;
let palItems: Cmd[] = [];
const palRender = (): void => {
  const q = palInput.value.trim().toLowerCase();
  palItems = commands()
    .map((c) => ({ c, s: q ? score(q, c.label) : 0 }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 12)
    .map((x) => x.c);
  palSel = Math.min(palSel, Math.max(0, palItems.length - 1));
  palList.replaceChildren(
    ...palItems.map((c, i) => {
      const li = document.createElement('li');
      li.className = i === palSel ? 'sel' : '';
      const k = document.createElement('span');
      k.className = 'k';
      k.textContent = c.kind;
      li.append(k, c.label);
      li.onclick = () => palRun(c);
      return li;
    }),
  );
};
const palRun = (c: Cmd): void => {
  palette.close();
  c.run();
};
const openPalette = (): void => {
  palInput.value = '';
  palSel = 0;
  palRender();
  palette.showModal();
  palInput.focus();
};
palInput.oninput = () => {
  palSel = 0;
  palRender();
};
palInput.onkeydown = (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    palSel = (palSel + (e.key === 'ArrowDown' ? 1 : palItems.length - 1)) % Math.max(1, palItems.length);
    palRender();
    e.preventDefault();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (palItems[palSel]) palRun(palItems[palSel]);
  }
  e.stopPropagation();
};
$('palette-btn').onclick = openPalette;
const help = $<HTMLDialogElement>('help');
$('help-btn').onclick = () => help.showModal();

// ---- keyboard shortcuts (off while typing in a field; the note keyboard in input.ts gets what is left)
window.addEventListener('keydown', (e) => {
  if (currentTab !== 'patch') return;
  const t = e.target as HTMLElement | null;
  const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') && (t as HTMLInputElement).type !== 'range' && (t as HTMLInputElement).type !== 'checkbox';
  if (palette.open || help.open || typing) return;
  const mod = e.metaKey || e.ctrlKey;
  const k = e.key;
  let done = false;
  if (k === '/' || (mod && k.toLowerCase() === 'k')) (openPalette(), (done = true));
  else if (k === '?') (help.showModal(), (done = true));
  else if (k === 'Escape') (editor.cancelArm(), (diffPanel.hidden = true), (done = true));
  else if (k === 'Delete' || k === 'Backspace') done = editor.removeSelected();
  else if (mod && k.toLowerCase() === 'd') done = editor.duplicateSelected();
  else if (!mod && k.toLowerCase() === 'b') done = editor.bypassSelected();
  else if (!mod && k.toLowerCase() === 'g' && editor.selected.size) (editor.makeAssembly(), (done = true));
  else if (k === 'Tab') (flipAB(), (done = true));
  else if (k === ' ') {
    editor.arpPlay = !editor.arpPlay;
    host.send({ t: 'arpplay', on: editor.arpPlay });
    if (live()) device.arp(editor.patch.arp ?? ARP_DEFAULT, editor.arpPlay);
    status.textContent = editor.arpPlay ? 'arpeggiator playing' : 'arpeggiator stopped';
    editor.rebuild();
    done = true;
  } else if (k.startsWith('Arrow')) {
    const d = e.shiftKey ? 100 : 10;
    done = editor.nudgeSelected(k === 'ArrowLeft' ? -d : k === 'ArrowRight' ? d : 0, k === 'ArrowUp' ? -d : k === 'ArrowDown' ? d : 0);
  }
  if (done) {
    e.preventDefault();
    e.stopImmediatePropagation();
  }
}, true);
$('panic-btn').onclick = () => sink.send({ t: 'panic' });

// FM-1 link
$('dev-btn').onclick = async () => {
  try {
    const info = await device.connect();
    devStatus(`FM-1 connected (protocol ${info.version}, up to ${info.maxModules} modules, flash ${info.flashOk ? 'ok' : 'not available'})`);
    for (const id of ['dev-live', 'dev-send', 'dev-store']) $<HTMLInputElement>(id).disabled = false;
    $('dev-btn').textContent = 'Reconnect';
  } catch (e) {
    devStatus((e as Error).message);
  }
};
$('dev-send').onclick = () => void sendPatch();
$('dev-live').onchange = () => {
  if ($<HTMLInputElement>('dev-live').checked) void sendPatch();
};
$('dev-store').onclick = async () => {
  try {
    await sendPatch();
    await device.store();
    setBaseline();
    devStatus('stored: the FM-1 starts with this patch');
  } catch (e) {
    devStatus((e as Error).message);
  }
};

$('save-btn').onclick = () => {
  const blob = new Blob([JSON.stringify(editor.patch, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${editor.patch.name.replace(/[^\w.-]+/g, '_') || 'patch'}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
};
$<HTMLInputElement>('load-file').onchange = async (e) => {
  const input = e.target as HTMLInputElement;
  const f = input.files?.[0];
  input.value = '';
  if (!f) return;
  try {
    editor.setPatch(validatePatch(JSON.parse(await f.text()), DEFS));
    setBaseline();
    nameInput.value = editor.patch.name;
  } catch (err) {
    status.textContent = `load failed: ${(err as Error).message}`;
  }
};

// audio + input
$('audio-btn').onclick = async () => {
  try {
    await host.start();
    status.textContent = 'audio running';
    $('audio-btn').textContent = 'Audio on';
  } catch (e) {
    status.textContent = `audio failed: ${e}`;
  }
};
attachKeyboard(sink, () => currentTab === 'patch');
// Web MIDI is only asked for on request: while a page holds MIDI access, Chromium's ALSA backend tracks every MIDI port on the
// system and aborts the whole browser (SIGILL in midi::MidiManager::SetInputPortState) when the ports change, for example when
// the FM-1 re-enumerates after a reset or a firmware update.
$('midi-btn').onclick = () => {
  $('midi-btn').setAttribute('disabled', '');
  void attachMidi(sink, (s) => {
    if (!host.running) status.textContent = s;
  });
};
$('dev-release').onclick = () => {
  save(editor.patch); // the patch is remembered; reloading the page is what drops the MIDI access
  location.reload();
};

// tabs
buildBankTab($('tab-presets'), device, () => editor.patch, (msg) => {
  devStatus(msg);
  for (const id of ['dev-live', 'dev-send', 'dev-store']) $<HTMLInputElement>(id).disabled = false;
});
refreshAssemblies = buildAssembliesTab($('tab-assemblies'), {
  insert(def) {
    document.querySelector<HTMLButtonElement>('#tabs button[data-tab="patch"]')?.click();
    editor.insert(def);
  },
  status(msg) {
    status.textContent = msg;
  },
});
buildFlashTab($('tab-flash'));
$('tab-about').innerHTML = `
  <div class="card"><h2>Modular-1</h2>
  <p>A patchable modular synth for the M-VAVE FM-1, with a browser editor. The module engine runs in your browser here and on the FM-1 itself.</p>
  <p class="muted">GPL-3.0-only. The flasher, loader and hardware layer are derived from <a href="https://github.com/hugelton/Felucca">Felucca</a> by Leo Kuroshita / Hügelton Instruments. Not affiliated with M-VAVE or Clavia.</p></div>`;
for (const b of document.querySelectorAll<HTMLButtonElement>('#tabs button')) {
  b.onclick = () => {
    currentTab = b.dataset.tab!;
    for (const x of document.querySelectorAll<HTMLButtonElement>('#tabs button')) x.setAttribute('aria-selected', String(x === b));
    for (const t of document.querySelectorAll<HTMLElement>('.tab')) t.hidden = t.id !== `tab-${currentTab}`;
    if (currentTab === 'patch') editor.drawCables();
  };
}

// open the tab named in the address (#presets, #flash, #about)
document.querySelector<HTMLButtonElement>(`#tabs button[data-tab="${location.hash.slice(1)}"]`)?.click();
