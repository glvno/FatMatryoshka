// SPDX-License-Identifier: GPL-3.0-only
import { CPU, CPU_WARN } from './cpu';
import { setupPopoverPositioning } from './popover';
import { AudioHost } from './audio';
import type { HostMsg } from './worklet';
import { DeviceLink } from './device';
import { Editor, probeKey, ZOOM_MAX, ZOOM_MIN } from './editor';
import { addToBank, bankPatches, buildBankTab } from './bank';
import { onSavedChange, savedPatches, savePatch as keepPatch } from './saved';
import { buildAssembliesTab, storeAssembly, storeTutorialAssembly } from './assemblies';
import { AssemblyBrowser } from './browser';
import { searchCommands, type Command } from './commands';
import { buildFlashTab } from './flasher';
import { attachKeyboard, attachMidi, isTextEntry } from './input';
import { Piano } from './piano';
import { sliderJack } from './slider-jack';
import { isKnob } from './knob-rest';
import { longName, moduleName } from './labels';
import { DeckControls } from './deck';
import { releaseFocusAfterPointer } from './focus';
import { DEFS } from './modules';
import { newPatch, validatePatch, type Patch, type SideKey } from './patch';
import { ARP_DEFAULT } from './arp';
import { Scope } from './scope';
import { diffCount, diffLines, diffPatches } from './diff';
import { FACTORY, loadLibrary, categoryOf, USER_SHELF, summary } from './assemblies';
import type { AssemblyDef } from './assembly';
import { decodeShare, encodeShare, shareCodeOf, shareLink } from './share';
import { starterPatch } from './starter';
import { Tutorial } from './tutorial/tutorial';
import { synthLink } from './tutorial/link';
import { CHAPTERS, LISTED, chapterEnd } from './tutorial/chapters';
import { PRESETS } from './presets';
import { deviceBudget } from './patchbin';
import { ALLOC } from './poly';

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
/** set while a patch from a link is loaded: it must not replace the remembered patch until the user acts */
let suppressSave = false;
const queueSave = (p: Patch): void => {
  if (suppressSave) return;
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => save(p), 300);
};

const device = new DeviceLink();
/** the patch fits the FM-1 (deviceBudget); one that does not plays only in the browser and is never sent */
let fitsDevice = true;
const live = (): boolean => device.connected && $<HTMLInputElement>('dev-live').checked && fitsDevice;
let uploadTimer = 0;
let uploading = false;
let dirty = false;
const devStatus = (s: string): void => {
  $('dev-status').textContent = s;
};
device.onStatus = devStatus;
/** upload the current patch; changes made meanwhile cause one more upload */
async function sendPatch(): Promise<boolean> {
  if (!fitsDevice) {
    devStatus('over the FM-1 budget: not sent (the FM-1 budget right of the arpeggiator says what is over)');
    return false;
  }
  if (uploading) {
    dirty = true; // the upload under way sends it
    return true;
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
    return false;
  } finally {
    uploading = false;
  }
  return true;
}
const queueUpload = (): void => {
  clearTimeout(uploadTimer);
  uploadTimer = window.setTimeout(() => void sendPatch(), 150);
};
/** the on-screen keyboard plays through the sink like the letter keys; Z / X and its buttons share the octave */
const piano = new Piano($('piano'), {
  on: (note, vel) => sink.send({ t: 'on', note, vel }),
  off: (note) => sink.send({ t: 'off', note }),
  shift: (d) => noteKeys.shift(d),
});
/** the wheels: pitch bend and CC 1, shown in the dock under Main's bend and modulation jacks (the editor places them) */
const hands = new DeckControls(document.createElement('div'), {
  bend: (v) => sink.send({ t: 'bend', v }),
  mod: (v) => sink.send({ t: 'cc', n: 1, v: v * 127 }),
});
/** notes go to the browser engine and, with Live on, to the FM-1 */
const sink = {
  send(msg: HostMsg): void {
    if (msg.t === 'on') host.mute(false);
    host.send(msg);
    piano.track(msg);
    hands.track(msg);
    if (msg.t === 'on') tutorial.noteOn();
    if (live()) {
      device.note(msg as { t: string; note?: number; vel?: number });
      if (msg.t === 'bend') device.bend(msg.v);
      else if (msg.t === 'cc') device.cc(msg.n, msg.v);
    }
  },
};

let refreshAssemblies: () => void = () => {};
/** the factory patches and the Patches page's own copies (the morph picker keeps those of the same structure; the palette loads any) */
let snapshotCandidates: () => { name: string; patch: Patch }[] = () => [];
const patchCandidates = (): { name: string; patch: Patch }[] => {
  const seen = new Set<string>();
  const out: { name: string; patch: Patch }[] = [];
  for (const c of [...snapshotCandidates(), ...savedPatches(), ...bankPatches(), ...Object.entries(PRESETS).map(([name, make]) => ({ name, patch: make() }))])
    if (!seen.has(c.name)) {
      seen.add(c.name);
      out.push(c);
    }
  return out;
};
const scope = new Scope($('scope'));
host.onProbe = (key, data, sr) => scope.feed(key, data, sr);
/** the sidebar's sliders whose thumbs are jacks (cable slack, zoom): see sideSlider below; filled once the editor exists */
const sides = new Map<SideKey, SideSlider>();
/** the zoom slider's setting (the user's zoom; a source adds to it) */
let zoomBase = 1;
const editor = new Editor($('canvas'), loadSaved() ?? starterPatch(), {
  onStructure(p) {
    $<HTMLInputElement>('patch-name').value = p.name;
    syncSides();
    scope.clearSamples();
    host.setPatch(p);
    queueSave(p);
    showBudget();
    if (live()) queueUpload();
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
    if (editor.patch.modules.find((m) => m.id === id)?.type === ALLOC) {
      // a Voice allocator's setting changes the poly groups: the FM-1 takes the whole patch again
      showBudget();
      if (live()) queueUpload();
      return;
    }
    if (live() && !uploading) device.param(editor.patch, id, name, value);
    else if (live()) dirty = true;
  },
  onBypass(id, on) {
    host.send({ t: 'bypass', id, on });
    tutorial.bypassed();
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
    syncArpBtn();
  },
  onProbe(key, id, port, kind, _label, on) {
    if (on) {
      scope.add(key, kind);
      host.send({ t: 'probe', key, id, port });
    } else {
      scope.remove(key);
      host.send({ t: 'unprobe', key });
    }
  },
  onLayout(p) {
    queueSave(p);
    syncSides();
  },
  onError(msg) {
    status.textContent = msg;
  },
  onSaveAssembly(def) {
    const r = storeAssembly(def);
    status.textContent = r === 'cancelled' ? 'not saved' : `"${def.name}" ${r === 'replaced' ? 'replaced in' : 'saved to'} the assembly library`;
    refreshAssemblies();
    if (r !== 'cancelled') tutorial.saved(def);
    tutorial.refresh();
  },
  onHistory(kind) {
    if (kind === 'undo') tutorial.undone();
    else tutorial.redone();
  },
  morphCandidates: patchCandidates,
}, $('dock'));
// the wheels stand beside the keyboard, each under its output's jack; the octave buttons under the dock's outputs
editor.wheelHost = $('wheels');
editor.dockWheels = hands.wheels;
editor.dockOctave = piano.octaveControls;
// the arpeggiator's play switch, beside its settings in Main's arpeggiator column (kept across redraws)
const arpBtn = document.createElement('button');
arpBtn.id = 'arp-btn';
arpBtn.type = 'button';
arpBtn.textContent = 'Play';
arpBtn.title = 'Arpeggiator: plays while keys are held (Space)';
arpBtn.setAttribute('aria-label', 'Arpeggiator play');
arpBtn.setAttribute('aria-pressed', 'false');
editor.dockArp = arpBtn;
editor.dockBudget = $('budget');
editor.rebuild();
showBudget();
snapshotCandidates = () => editor.snapshots.B ? [{ name: 'Snapshot B', patch: { ...JSON.parse(editor.snapshots.B) as Patch, name: 'Snapshot B' } }] : [];
host.setPatch(editor.patch);
const tutorial = new Tutorial({
  editor,
  audioOn: () => host.running && !host.muted,
  mute: (on) => host.mute(on),
  startAudio: () => startAudio(),
  preview: (p) => host.setPatch(p ?? editor.patch),
  load: (p) => { sink.send({ t: 'panic' }); loadNamed(p); },
  note: (on, note = 60, vel = 0.8) => sink.send(on ? { t: 'on', note, vel } : { t: 'off', note }),
  library: loadLibrary,
  saveAssembly: (def) => {
    storeTutorialAssembly(def);
    refreshAssemblies();
    status.textContent = `"${def.name}" saved to the assembly library`;
  },
  snapshot: (side) => takeSnapshot(side),
  flipAB: () => flipAB(),
  share: () => sharePatch(),
  arpPlay: (on) => setArpPlay(on),
  probe: (id, port) => { const key = probeKey(id, port); if (editor.probes.has(key)) return; editor.probes.add(key); const def = DEFS[editor.patch.modules.find((m) => m.id === id)?.type ?? '']; const kind = def?.outputs.find((o) => o.name === port)?.kind ?? 'audio'; scope.add(key, kind); host.send({ t: 'probe', key, id, port }); editor.rebuild(); },
  bypass: (id, on) => { const m = editor.patch.modules.find((m) => m.id === id); if (!m) return; if (on) m.bypass = true; else delete m.bypass; host.send({ t: 'bypass', id, on }); tutorial.bypassed(); editor.rebuild(); queueSave(editor.patch); },
  bankSave: addToBank,
  rename: (name) => { editor.patch.name = name; nameInput.value = name; queueSave(editor.patch); },
  status: (msg) => { status.textContent = msg; },
});
editor.onZoom = (z, live) => {
  if (live) return;
  zoomBase = z;          // the user's zoom is the zoom slider's setting
  tutorial.zoomed();
  showSide('zoomFrom');
};
host.onValues = (values) => {
  editor.showParameterValues(values);
  if (!host.running) scope.clearSamples();
};

// Sidebar
setupPopoverPositioning();
const presetSel = $<HTMLSelectElement>('preset');
/** the Open picker: the user's saved patches (rebuilt on every save), the examples, the tutorial chapters' ends */
const fillPicker = (): void => {
  const group = (label: string, opts: HTMLOptionElement[]): HTMLOptGroupElement => {
    const g = document.createElement('optgroup');
    g.label = label;
    g.append(...opts);
    return g;
  };
  const mine = savedPatches();
  presetSel.replaceChildren(
    new Option('Open a patch…', ''),
    ...(mine.length ? [group('Your patches', mine.map((e) => new Option(e.name, `saved:${e.name}`)))] : []),
    group('Examples', Object.keys(PRESETS).map((n) => new Option(n, n))),
    group('Tutorial', LISTED.map((i, n) => new Option(`${n + 1}. ${CHAPTERS[i].title}${CHAPTERS[i].published ? '' : ' (unpublished)'}`, `tutorial:${i}`))),
  );
};
fillPicker();
onSavedChange(fillPicker);
presetSel.onchange = () => {
  const v = presetSel.value;
  const mine = v.startsWith('saved:') ? savedPatches().find((e) => e.name === v.slice(6)) : undefined;
  if (mine) { editor.setPatch(mine.patch); closeSidebar(); }
  else if (v.startsWith('tutorial:')) { editor.setPatch(chapterEnd(Number(v.slice(9)))); closeSidebar(); }
  else if (v && PRESETS[v]) { editor.setPatch(PRESETS[v]()); closeSidebar(); }
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
const saveBtn = $<HTMLButtonElement>('save-patch-btn');
/** keep the open patch in Your patches (saved.ts) under its name */
const saveCurrent = (): void => {
  if (!editor.patch.name.trim()) {
    nameInput.focus();
    status.textContent = 'name the patch first, then save';
    return;
  }
  status.textContent = keepPatch(editor.patch);
  saveBtn.classList.add('saved');
  setTimeout(() => saveBtn.classList.remove('saved'), 900);
};
saveBtn.onclick = saveCurrent;
/** the FM-1 budget meter in the Main dock: memory (the fullest limit) and CPU as bars; open, a card above the deck with every limit and the costliest modules */
/** a meter row: name, bar, percent; `near` / `over` colour it */
function meterRow(row: Element, name: string, frac: number, text: string): void {
  row.classList.toggle('over', frac > 1);
  row.classList.toggle('near', frac <= 1 && frac > CPU_WARN);
  row.querySelector('.budget-name')!.textContent = name;
  (row.querySelector('.budget-bar > span') as HTMLElement).style.width = `${Math.min(100, Math.round(frac * 100))}%`;
  row.querySelector('.budget-pct')!.textContent = text;
}

/** a line of the open meter: name, a small bar, the figure; `warn`: colour it when nearly full (not a one-slot line: the patch's one
 * delay fills it, which is fine) */
function budgetLine(name: string, frac: number, figure: string, title = '', warn = true): HTMLElement {
  const row = document.createElement('div');
  row.className = 'budget-item' + (frac > 1 ? ' over' : warn && frac > CPU_WARN ? ' near' : '');
  row.title = title;
  const n = document.createElement('span');
  n.textContent = name;
  const bar = document.createElement('span');
  bar.className = 'budget-mini';
  const fill = document.createElement('span');
  fill.style.width = `${Math.min(100, Math.round(frac * 100))}%`;
  bar.append(fill);
  const f = document.createElement('span');
  f.textContent = figure;
  row.append(n, bar, f);
  return row;
}

function showBudget(): void {
  const b = deviceBudget(editor.patch);
  const was = fitsDevice;
  fitsDevice = b.fits;
  const el = $('budget');
  el.classList.toggle('over', !b.fits);
  const memOver = b.over.filter((i) => i.key !== 'cpu');
  const fullest = memOver[0] ?? b.fullest;
  const [mem, cpu] = el.querySelectorAll('.budget-row');
  meterRow(mem, 'MEM', memOver.length ? 1.01 : b.memory, memOver.length ? 'over' : `${Math.round(b.memory * 100)} %`);
  meterRow(cpu, 'CPU', b.cpu.use, `${Math.round(b.cpu.use * 100)} %`);
  el.querySelector('summary')!.title = b.fits
    ? `Fits the FM-1. Memory: the fullest limit (${fullest?.label ?? 'none'}) is ${Math.round(b.memory * 100)} % used. CPU: about ${Math.round(b.cpu.use * 100)} % of the audio time, an estimate. Open for the details.`
    : `Over the FM-1 budget (${b.over.map((i) => i.label).join(', ')}): it plays here in the browser, the FM-1 cannot ${b.over.some((i) => i.key === 'cpu') ? 'keep up with' : 'load'} it.`;
  const list = el.querySelector('.budget-list')!;
  const head = (text: string): HTMLElement => {
    const h = document.createElement('div');
    h.className = 'budget-head';
    h.textContent = text;
    return h;
  };
  const block = CPU.cyclesPerUs * CPU.blockUs;
  const costly = b.cpu.modules.slice(0, 6).map((m) => {
    const mod = editor.patch.modules.find((x) => x.id === m.id)!;
    const name = moduleName(m.type, DEFS[m.type].label) + (m.copies > 1 ? ` ×${m.copies}` : '');
    const line = budgetLine(name, m.cycles / block, `${(100 * m.cycles / block).toFixed(1)} %`, 'Select it');
    line.classList.add('pick');
    line.addEventListener('click', () => editor.reveal(mod.id));
    return line;
  });
  list.replaceChildren(
    head('Memory'),
    ...b.items.filter((i) => i.used > 0).map((i) => budgetLine(i.label, i.used / i.max, `${i.used} / ${i.max}`, '', i.max > 1)),
    head('CPU, estimated'),
    ...costly,
  );
  const note = document.createElement('p');
  note.className = 'muted';
  note.textContent = b.fits
    ? 'The CPU figure is an estimate: the engine counted on a model of the processor, scaled by one load measured on the FM-1. Treat anything above 80 % as tight.'
    : 'Plays in the browser. The FM-1 cannot run it: Send, Store and Live stay off, and the Library keeps it under "Over budget".';
  list.append(note);
  if (was && !b.fits && device.connected) devStatus('over the FM-1 budget: Live paused until the patch fits');
  requestAnimationFrame(placeBudget);
}
// the open budget is a card above the deck, centred on the meter (fixed: the dock scrolls sideways and would clip it); a
// click elsewhere or Escape closes it
const budgetEl = $('budget') as HTMLDetailsElement;
function placeBudget(): void {
  const budgetEl = $('budget') as HTMLDetailsElement;
  if (!budgetEl.open) return;
  const list = budgetEl.querySelector<HTMLElement>('.budget-list')!;
  const r = budgetEl.getBoundingClientRect();
  list.style.left = `${Math.max(8, Math.min(innerWidth - list.offsetWidth - 8, r.left + r.width / 2 - list.offsetWidth / 2))}px`;
}
budgetEl.addEventListener('toggle', placeBudget);
addEventListener('resize', placeBudget);
document.addEventListener('pointerdown', (e) => {
  if (budgetEl.open && !budgetEl.contains(e.target as Node)) budgetEl.open = false;
});
addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && budgetEl.open) budgetEl.open = false;
}, true);
const browser = new AssemblyBrowser((d) => { switchTab('patch'); editor.insert(d); });

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
const takeSnapshot = (side: 'A' | 'B'): void => {
  editor.takeSnapshot(side);
  editor.rebuild();
  status.textContent = `${side} = this patch`;
};
const flipAB = (): void => {
  if (editor.toggleAB()) {
    tutorial.flipped();
    status.textContent = `${editor.side}${diffCount(diffPatches(JSON.parse(editor.snapshots[editor.side === 'A' ? 'B' : 'A']!) as Patch, editor.patch, DEFS)) ? '' : ' (same as the other side)'}`;
    queueSave(editor.patch);
  } else status.textContent = 'set A and B first';
};

// ---- the command palette: modules, assemblies, patches
const palette = $<HTMLDialogElement>('palette');
const palInput = $<HTMLInputElement>('palette-input');
const palList = $('palette-list');
const inPatch = (run: () => void): (() => void) => () => { switchTab('patch'); run(); };
const commands = (): Command[] => {
  const assembly = (d: AssemblyDef, shelf: string): Command => ({
    kind: 'assembly', tags: ['assembly', shelf], label: d.name, detail: shelf, keywords: `insert ${summary(d)}`,
    run: () => editor.insert(d),
  });
  return [
    { kind: 'command', label: 'Save patch', keywords: 'keep store your patches', run: saveCurrent },
    { kind: 'command', label: 'Save patch as .json', keywords: 'export download file', run: savePatch },
    { kind: 'command', label: 'Load patch from .json', keywords: 'import open file', run: () => $('load-file').click() },
    { kind: 'command', label: 'Share patch link', keywords: 'copy url clipboard', run: () => void sharePatch() },
    { kind: 'command', label: 'Tutorial', keywords: 'learn help starter tour chapters course', run: () => { switchTab('patch'); tutorial.open(); } },
    { kind: 'command', label: 'New patch', run: () => { loadNamed(newPatch(DEFS)); tutorial.newPatchPressed(); } },
    { kind: 'command', label: 'Undo', detail: 'Ctrl/Cmd+Z', run: inPatch(() => editor.undo()) },
    { kind: 'command', label: 'Redo', detail: 'Shift+Ctrl/Cmd+Z', run: inPatch(() => editor.redo()) },
    { kind: 'command', label: 'Make assembly from the selection', detail: 'Ctrl/Cmd+G', run: inPatch(() => editor.makeAssembly()) },
    { kind: 'command', label: 'Browse assembly library', run: () => browser.open() },
    { kind: 'command', label: 'Select all', detail: 'Ctrl/Cmd+A', keywords: 'everything modules assemblies', run: inPatch(() => editor.selectAll()) },
    { kind: 'command', label: 'Duplicate selection', detail: 'Ctrl/Cmd+D', run: inPatch(() => editor.duplicateSelected()) },
    { kind: 'command', label: 'Delete selection', detail: 'Delete', run: inPatch(() => editor.removeSelected()) },
    { kind: 'command', label: 'Bypass selection', detail: 'B', run: inPatch(() => editor.bypassSelected()) },
    { kind: 'command', label: 'Show changes since last load / upload', keywords: 'diff', run: inPatch(showDiff) },
    { kind: 'command', label: 'Set snapshot A', keywords: 'compare ab', run: () => takeSnapshot('A') },
    { kind: 'command', label: 'Set snapshot B', keywords: 'compare ab', run: () => takeSnapshot('B') },
    { kind: 'command', label: 'Switch A / B snapshots', detail: 'Alt+B', run: inPatch(flipAB) },
    { kind: 'command', label: 'Start audio', keywords: 'sound browser', run: () => void startAudio() },
    { kind: 'command', label: 'Panic: stop all notes', keywords: 'silence stuck', run: panic },
    { kind: 'command', label: 'FM-1 & MIDI settings', keywords: 'connect send store sync hardware keyboard release', run: () => $<HTMLDialogElement>('device-bar').showModal() },
    { kind: 'command', label: 'Flash firmware', keywords: 'install update hardware', run: () => switchTab('flash') },
    { kind: 'command', label: 'About Matryoshka', keywords: 'credits', run: () => switchTab('about') },
    { kind: 'command', label: 'Keyboard shortcuts', keywords: 'help', detail: '?', run: () => help.showModal() },
    { kind: 'command', label: scope.visible ? 'Hide oscilloscope' : 'Show oscilloscope', keywords: 'scope window waveform', run: inPatch(() => scope.setVisible(!scope.visible)) },
    { kind: 'command', label: 'Scope: waveform', keywords: 'oscilloscope time', run: inPatch(() => scope.setMode('time')) },
    { kind: 'command', label: 'Scope: spectrum', keywords: 'oscilloscope frequency fft', run: inPatch(() => scope.setMode('spectrum')) },
    { kind: 'command', label: 'Tidy up the canvas', keywords: 'clean up arrange align layout grid', run: inPatch(() => editor.tidyUp()) },
    { kind: 'command', label: 'Cable slack: none', keywords: 'slack sag tight straight', run: inPatch(() => setSlack(0)) },
    { kind: 'command', label: 'Cable slack: half', keywords: 'slack sag droop hang loose', run: inPatch(() => setSlack(0.5)) },
    { kind: 'command', label: 'Cable slack: full', keywords: 'slack sag droop hang heavy', run: inPatch(() => setSlack(1)) },
    ...(editor.patch.slackFrom ? [{ kind: 'command' as const, label: 'Cable slack: unplug its input', keywords: 'slack sway modulate', run: inPatch(() => editor.setSideSource('slackFrom', null)) }] : []),
    ...(editor.patch.zoomFrom ? [{ kind: 'command' as const, label: 'Zoom: unplug its input', keywords: 'zoom modulate', run: inPatch(() => editor.setSideSource('zoomFrom', null)) }] : []),
    { kind: 'command', label: 'Fit patch to screen', keywords: 'zoom view', run: inPatch(() => editor.zoomToFit()) },
    { kind: 'command', label: 'Reset canvas scale', keywords: 'zoom 100%', run: inPatch(() => editor.setZoom(1)) },
    ...Object.values(DEFS).filter((d) => d.type !== 'fm1' && d.type !== 'part').map((d) => ({ kind: 'add module', tags: ['module'], label: moduleName(d.type, d.label), keywords: d.label, run: () => editor.add(d.type) })),
    ...loadLibrary().map((d) => assembly(d, USER_SHELF)),
    ...FACTORY.map((d) => assembly(d, categoryOf(d))),
    ...patchCandidates().map((c) => ({ kind: 'load patch', label: c.name, run: () => loadNamed(c.patch) })),
  ];
};
const loadNamed = (p: Patch): void => {
  switchTab('patch');
  editor.setPatch(p);
  setBaseline();
  nameInput.value = editor.patch.name;
};
let palSel = 0;
let palItems: Command[] = [];
const palRender = (): void => {
  const q = palInput.value.trim().toLowerCase();
  palItems = q ? searchCommands(commands(), q) : commands().filter((c) => c.kind === 'command');
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-query]')) button.setAttribute('aria-pressed', String(button.dataset.query === q));
  palSel = Math.min(palSel, Math.max(0, palItems.length - 1));
  palList.replaceChildren(
    ...palItems.map((c, i) => {
      const li = document.createElement('li');
      li.className = i === palSel ? 'sel' : '';
      li.id = `command-${i}`;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(i === palSel));
      const k = document.createElement('span');
      k.className = 'k';
      k.textContent = c.kind;
      if (c.kind !== 'command') li.append(k);
      li.append(c.label);
      if (c.detail) {
        const detail = document.createElement('span');
        detail.className = 'detail';
        detail.textContent = c.detail;
        li.append(detail);
      }
      li.onclick = () => palRun(c);
      return li;
    }),
  );
  if (!palItems.length) {
    const empty = document.createElement('li');
    empty.className = 'muted';
    empty.textContent = 'No matches. Try a module name or an action like “save”.';
    palList.append(empty);
  }
  if (palItems.length) palInput.setAttribute('aria-activedescendant', `command-${palSel}`);
  else palInput.removeAttribute('aria-activedescendant');
  palList.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
};
const palRun = (c: Command): void => {
  palette.close();
  if (c.kind !== 'command') switchTab('patch');
  c.run();
};
const openPalette = (query = ''): void => {
  palInput.value = query;
  palSel = 0;
  palRender();
  closeSidebar();
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
$('palette-btn').onclick = () => openPalette();
$('new-patch-btn').onclick = () => { loadNamed(newPatch(DEFS)); tutorial.newPatchPressed(); closeSidebar(); };
$('add-btn').onclick = () => openPalette('module');
$('add-assembly-btn').onclick = () => openPalette('assembly');
$('tidy-btn').onclick = () => editor.tidyUp();
$('fit-btn').onclick = () => editor.zoomToFit();
$('tour-btn').onclick = () => { switchTab('patch'); tutorial.open(); };
$('mobile-commands').onclick = () => openPalette();
$('palette-close').onclick = () => palette.close();
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-query]')) button.onclick = () => {
  palInput.value = button.dataset.query!;
  palSel = 0;
  palRender();
  palInput.focus();
};
const help = $<HTMLDialogElement>('help');

// A pointer interaction gives focus back to the page, so Space / arrows / Delete reach the shortcuts below, not the control.
releaseFocusAfterPointer();
// ---- keyboard shortcuts (off while typing in a field; the note keyboard in input.ts gets what is left)
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && sidebar.classList.contains('open') && !document.querySelector('dialog[open]')) {
    closeSidebar(); e.preventDefault(); e.stopImmediatePropagation(); return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k' && !document.querySelector('dialog[open]')) {
    e.preventDefault(); e.stopImmediatePropagation(); openPalette(); return;
  }
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's' && currentTab === 'patch' && !document.querySelector('dialog[open]')) {
    e.preventDefault(); e.stopImmediatePropagation(); saveCurrent(); return;
  }
  if (currentTab !== 'patch') return;
  const t = e.target as HTMLElement | null;
  const typing = isTextEntry(t) || t?.tagName === 'SELECT';
  if (document.querySelector('dialog[open], [popover]:popover-open') || typing) return;
  const control = t?.closest('button, summary, [role=tab], [role=slider], input, select');
  if (control && [' ', 'Enter', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
  const mod = e.metaKey || e.ctrlKey;
  const k = e.key;
  let done = false;
  if (k === '/' || (mod && k.toLowerCase() === 'k')) (openPalette(), (done = true));
  else if (k === '?') (help.showModal(), (done = true));
  else if (k === 'Escape') (editor.cancelArm(), editor.endPick(), (diffPanel.hidden = true), (done = true));
  else if (k === 'Delete' || k === 'Backspace') done = editor.removeSelected();
  else if (mod && k.toLowerCase() === 'a') (editor.selectAll(), (done = true));
  else if (mod && k.toLowerCase() === 'd') done = editor.duplicateSelected();
  else if (e.altKey && k.toLowerCase() === 'b') (flipAB(), (done = true));
  else if (!mod && k.toLowerCase() === 'b') done = editor.bypassSelected();
  else if (mod && k.toLowerCase() === 'g') (editor.makeAssembly(), (done = true)); // plain G is a note key
  else if (k === ' ') {
    toggleArp();
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
// The sidebar's cable slack and zoom sliders: a card's value bar (sliderJack) each, and (the easter egg) their thumbs are
// jacks. An output dropped on one (Editor.setSideSource: Patch.slackFrom / zoomFrom) moves it: the worklet sends that
// output's mean (watch), which adds to the slider's setting in its unit (0..1). As on a card the thumb and value show the
// live position, a tick the setting, a knob's tick where that knob rests it; a drag moves the setting by the thumb's travel.
// A right-click on the bar or a click on its cable unplugs it.
interface SideSlider {
  bar: ReturnType<typeof sliderJack>;
  row: HTMLElement;
  /** the source's latest value, and whether the thumb is being dragged (it shows the pointer then, not the live value) */
  live: number;
  dragging: boolean;
  watching: string;
  /** the setting in the slider's unit, 0..1, and setting it */
  base(): number;
  setBase(u: number): void;
  /** apply the live position (setting + source) */
  apply(u: number, modulated: boolean): void;
  text(u: number): string;
  name: string;
}
const SLACK = 'matryoshka.cable-slack';
const clamp01 = (u: number): number => Math.min(1, Math.max(0, u));
// zoom in the slider's unit: octaves of its range, like the wheel and pinch
const zoomUnit = (z: number): number => Math.log(z / ZOOM_MIN) / Math.log(ZOOM_MAX / ZOOM_MIN);
const unitZoom = (u: number): number => ZOOM_MIN * Math.pow(ZOOM_MAX / ZOOM_MIN, clamp01(u));
zoomBase = editor.zoom;
function setSlack(v: number): void {
  editor.setSlack(v);
  showSide('slackFrom');
  try {
    localStorage.setItem(SLACK, String(editor.slack));
  } catch {
    /* storage blocked: the slack lasts until the page is reloaded */
  }
}
function sideSlider(key: SideKey, rowId: string, s: Omit<SideSlider, 'bar' | 'row' | 'live' | 'dragging' | 'watching'>): void {
  const row = $(rowId);
  const input = row.querySelector('input')!;
  const bar = sliderJack(input, () => {});
  row.append(bar.element);
  row.dataset.side = key;
  editor.sideThumbs.set(key, bar.jack);
  const side: SideSlider = { ...s, bar, row, live: 0, dragging: false, watching: '' };
  sides.set(key, side);
  input.addEventListener('input', () => {
    side.setBase(clamp01(Number(input.value) - (editor.patch[key] ? side.live : 0)));
    showSide(key);
  });
  // click-to-connect: with an output armed (a click on it), a press on the slider patches it instead of dragging
  row.addEventListener('pointerdown', (e) => {
    if (!editor.connectArmedToSide(key)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }, true);
  row.addEventListener('pointerdown', () => (side.dragging = true), true);
  input.addEventListener('change', () => {
    side.dragging = false;
    showSide(key);
  });
  row.addEventListener('contextmenu', (e) => {
    if (!editor.patch[key]) return;
    e.preventDefault();
    editor.setSideSource(key, null);
  });
}
function showSide(key: SideKey): void {
  const side = sides.get(key);
  if (!side) return;
  const input = side.row.querySelector('input')!;
  const from = editor.patch[key];
  const m = from && editor.patch.modules.find((x) => x.id === from.module);
  const base = side.base();
  const u = clamp01(base + (m ? side.live : 0));
  if (!side.dragging) input.value = String(u);
  side.bar.update();
  side.bar.setBase(m ? base : null);
  side.bar.setKnobTicks(m && m.type === 'fm1' && isKnob(from!.port) ? [{ knob: from!.port, unit: clamp01(base + (m.params[from!.port] ?? 0)) }] : []);
  side.bar.jack.classList.toggle('connected', !!m);
  side.row.classList.toggle('automated', !!m);
  side.row.querySelector('output')!.textContent = side.text(u);
  side.row.title = m
    ? `${side.name}: moved by ${moduleName(m.type, DEFS[m.type].label)} ${longName(m.type, from!.port)}. Right-click (or click its cable) to unplug.`
    : `${side.name}. Its thumb is a jack: drop a cable from any output on it and that signal moves it.`;
}
/** watch the patched outputs (and stop watching unplugged ones) */
function syncSides(): void {
  for (const [key, side] of sides) {
    const from = editor.patch[key];
    const want = from ? `${from.module}:${from.port}` : '';
    if (want !== side.watching) {
      side.watching = want;
      side.live = 0;
      side.apply(side.base(), false);
      host.send(from ? { t: 'watch', key, id: from.module, port: from.port } : { t: 'unwatch', key });
    }
    showSide(key);
  }
}
// the worklet reports a watched output every 256 samples; the sliders and what they move follow once per frame
let watchFrame = 0;
const watchDirty = new Set<SideKey>();
host.onWatch = (key, v) => {
  const side = sides.get(key as SideKey);
  if (!side || !editor.patch[key as SideKey]) return;
  side.live = v;
  watchDirty.add(key as SideKey);
  watchFrame ||= requestAnimationFrame(() => {
    watchFrame = 0;
    for (const k of watchDirty) {
      const s = sides.get(k);
      if (!s || !editor.patch[k]) continue;
      s.apply(clamp01(s.base() + s.live), true);
      showSide(k);
    }
    watchDirty.clear();
  });
};
sideSlider('slackFrom', 'slack-bar', {
  name: 'Cable slack',
  base: () => editor.slack,
  setBase: (u) => setSlack(u),
  // the editor adds the source to the setting itself (Editor.sway)
  apply: (_u, modulated) => editor.modulateSlack(modulated ? sides.get('slackFrom')!.live : 0),
  text: (u) => `${Math.round(u * 100)} %`,
});
sideSlider('zoomFrom', 'zoom-bar', {
  name: 'Zoom',
  base: () => zoomUnit(zoomBase),
  setBase: (u) => {
    zoomBase = unitZoom(u);
    if (!editor.patch.zoomFrom) editor.zoomAround(zoomBase);
  },
  apply: (u, modulated) => editor.zoomAround(modulated ? unitZoom(u) : zoomBase, modulated),
  text: (u) => `${Math.round(unitZoom(u) * 100)} %`,
});
// the sidebar scrolls and the window resizes under the source cables (they are drawn over the whole window)
$('workspace-sidebar').addEventListener('scroll', () => editor.positionSideCables(), { passive: true });
addEventListener('resize', () => editor.positionSideCables());
syncSides();
try {
  const v = Number(localStorage.getItem(SLACK) ?? 0);
  if (v > 0) setSlack(v);
} catch {
  /* storage blocked: no slack */
}
function panic(): void {
  tutorial.stop();
  host.mute(true);
  sink.send({ t: 'panic' });
}
// the Arp button in Main's arpeggiator column, Space and the arpeggiator's enable box are one switch
function syncArpBtn(): void {
  arpBtn.setAttribute('aria-pressed', String(editor.arpPlay));
}
function setArpPlay(on: boolean): void {
  if (on) host.mute(false);
  editor.arpPlay = on;
  host.send({ t: 'arpplay', on });
  if (live()) device.arp(editor.patch.arp ?? ARP_DEFAULT, on);
  editor.rebuild();
  syncArpBtn();
}
function toggleArp(): void {
  setArpPlay(!editor.arpPlay);
  status.textContent = editor.arpPlay ? 'arpeggiator enabled · hold keys' : 'arpeggiator disabled';
}
arpBtn.onclick = toggleArp;

// the keyboard folds away, leaving the deck's buttons; remembered per browser
const KEYS_HIDDEN = 'matryoshka.keys-hidden';
const deck = $('deck');
const keysBtn = $('keys-btn');
const showKeys = (on: boolean): void => {
  deck.classList.toggle('folded', !on);
  keysBtn.setAttribute('aria-expanded', String(on));
  try {
    if (on) localStorage.removeItem(KEYS_HIDDEN);
    else localStorage.setItem(KEYS_HIDDEN, '1');
  } catch {
    /* storage blocked: the choice lasts until the page is reloaded */
  }
};
keysBtn.onclick = () => showKeys(deck.classList.contains('folded'));
// the panels that dock above the deck (tutorial, diff) keep clear of it and the Main panel at whatever height they have
{
  const dockEl = $('dock');
  const fit = new ResizeObserver(() => document.documentElement.style.setProperty('--piano-h', `${deck.offsetHeight + dockEl.offsetHeight}px`));
  fit.observe(deck);
  fit.observe(dockEl);
}
try {
  if (localStorage.getItem(KEYS_HIDDEN)) showKeys(false);
} catch {
  /* storage blocked: the keyboard starts shown */
}

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
    if (!(await sendPatch())) return;
    await device.store();
    setBaseline();
    devStatus('stored: the FM-1 starts with this patch');
  } catch (e) {
    devStatus((e as Error).message);
  }
};

const sharePatch = async (): Promise<void> => {
  try {
    const { code, full } = await encodeShare(editor.patch);
    const link = shareLink(code);
    await navigator.clipboard.writeText(link);
    status.textContent = `link copied (${link.length} characters${full ? '' : '; too long with the layout: the cards open on a grid'})`;
    tutorial.shared();
  } catch (e) {
    status.textContent = `share failed: ${(e as Error).message}`;
  }
};
// a link with a patch in its fragment: load it (it is not saved over the remembered patch until something is changed)
const loadFromHash = (): void => {
  const shared = shareCodeOf(location.href);
  if (!shared) return;
  void decodeShare(shared, DEFS)
    .then((p) => {
      suppressSave = true;
      editor.setPatch(p);
      suppressSave = false;
      setBaseline();
      nameInput.value = p.name;
      status.textContent = `patch "${p.name}" from the link`;
      history.replaceState(null, '', location.pathname + location.search);
    })
    .catch((e: Error) => (status.textContent = `the link holds no patch: ${e.message}`));
};
loadFromHash();
window.addEventListener('hashchange', loadFromHash);

const savePatch = (): void => {
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
    loadNamed(validatePatch(JSON.parse(await f.text()), DEFS));
  } catch (err) {
    status.textContent = `load failed: ${(err as Error).message}`;
  }
};

// audio + input
const startAudio = async (): Promise<void> => {
  try {
    await host.start();
    status.textContent = 'audio running';
  } catch (e) {
    status.textContent = `audio failed: ${e}`;
  }
};
// one button: Audio on while the audio is off (not started or silenced by a panic), Panic while it plays
const audioBtn = $('audio-btn');
const syncAudioBtn = (): void => {
  const on = host.running && !host.muted;
  audioBtn.textContent = on ? 'Panic' : 'Audio on';
  audioBtn.title = on ? 'Stop all playing notes and silence the audio' : 'Start the audio';
  audioBtn.classList.toggle('on', on);
};
host.onState = syncAudioBtn;
syncAudioBtn();
audioBtn.onclick = () => (host.running && !host.muted ? panic() : void startAudio());
const noteKeys = attachKeyboard(sink, () => currentTab === 'patch' && !document.querySelector('dialog[open], [popover]:popover-open'), (o) => piano.setOctave(o));
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

// The compact workspace drawer leaves the whole patch usable on small screens.
const sidebar = $('workspace-sidebar');
const sidebarToggle = $('sidebar-toggle');
const sidebarDismiss = document.querySelector<HTMLButtonElement>('.sidebar-dismiss')!;
const workspaceMain = document.querySelector<HTMLElement>('main')!;
const compactWorkspace = window.matchMedia('(max-width: 700px)');
const setSidebarOpen = (open: boolean): void => {
  if (!open && sidebar.contains(document.activeElement) && compactWorkspace.matches) sidebarToggle.focus();
  sidebar.classList.toggle('open', open);
  sidebarToggle.setAttribute('aria-expanded', String(open));
  sidebarDismiss.hidden = !open;
  workspaceMain.inert = open && compactWorkspace.matches;
};
const closeSidebar = (): void => setSidebarOpen(false);
sidebarToggle.onclick = () => setSidebarOpen(!sidebar.classList.contains('open'));
sidebarDismiss.onclick = closeSidebar;
compactWorkspace.addEventListener('change', closeSidebar);

// tabs
const refreshBank = buildBankTab($('tab-library'), device, () => editor.patch, (msg) => {
  devStatus(msg);
  for (const id of ['dev-live', 'dev-send', 'dev-store']) $<HTMLInputElement>(id).disabled = false;
}, (p) => loadNamed(p));
refreshAssemblies = buildAssembliesTab($('tab-library'), {
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
  <div class="card about-brand">
  <img src="./brand/matryoshka.png" width="160" height="160" alt="Coral and yellow parent dolls with two teal siblings, connected by matching cable arms" />
  <h2><img class="brand-mark" src="./brand/wordmark.svg" alt="Matryoshka" /></h2>
  <p>A patchable modular synth for the M-VAVE FM-1, with a browser editor. Build sounds from modules, wrap them into assemblies, and nest those assemblies inside bigger instruments. The module engine runs in your browser here and on the FM-1 itself.</p></div>
  <div class="card credits"><h2>We stand on the shoulders of giants.</h2>
  <p><a href="https://github.com/hugelton/Felucca">Felucca</a>, by <a href="https://github.com/kurogedelic">Leo Kuroshita (@kurogedelic)</a> / <a href="https://github.com/hugelton">Hügelton Instruments</a>, provides the foundation for the flasher, loader and hardware support.</p>
  <p><a href="https://github.com/WiggisModular/Modular-1">Modular-1</a>, by <a href="https://github.com/morgulbrut">@morgulbrut</a> / <a href="https://github.com/WiggisModular">WiggisModular</a>, is the modular synthesizer this project grew from.</p>
  <p class="muted">GPL-3.0-only. Not affiliated with M-VAVE or Clavia.</p></div>`;
const switchTab = (name: string): void => {
  currentTab = name;
  closeSidebar();
  for (const button of document.querySelectorAll<HTMLButtonElement>('#tabs button')) {
    const active = button.dataset.tab === name;
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active || (name !== 'patch' && name !== 'library' && button.dataset.tab === 'patch') ? 0 : -1;
  }
  for (const tab of document.querySelectorAll<HTMLElement>('.tab')) tab.hidden = tab.id !== `tab-${name}`;
  document.querySelector<HTMLElement>('.patch-controls')!.hidden = name !== 'patch';
  editor.positionSideCables();
  if (name === 'patch') requestAnimationFrame(() => editor.drawCables());
  if (name === 'library') refreshBank();
};
for (const b of document.querySelectorAll<HTMLButtonElement>('#tabs button')) {
  b.onkeydown = (e) => {
    if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const tabs = [...document.querySelectorAll<HTMLButtonElement>('#tabs button')];
    const index = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (tabs.indexOf(b) + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length;
    tabs[index].click(); tabs[index].focus();
  };
  b.onclick = () => switchTab(b.dataset.tab!);
}

// open the tab named in the address (#library, #flash, #about; the old #presets and #assemblies open the Library)
{
  const h = location.hash.slice(1);
  const tab = h === 'presets' || h === 'assemblies' ? 'library' : h;
  if (['patch', 'library', 'flash', 'about'].includes(tab)) switchTab(tab);
}


if (currentTab === 'patch' && !shareCodeOf(location.href)) tutorial.welcome();
// Audio is enabled by default. A fresh browser may require a trusted gesture to resume it.
const unlockAudio = (): void => { if (!host.running) void startAudio(); };
window.addEventListener('pointerdown', unlockAudio, { capture: true });
window.addEventListener('keydown', unlockAudio, { capture: true });
void startAudio();

// This link and the editor's server route exist only during local development.
if (import.meta.env.DEV) {
  import.meta.hot?.on('lesson-course-saved', () => location.reload());
  // the lesson editor's live link: it checks steps against this synth and loads patches into it
  tutorial.observer = synthLink(() => ({
    patch: editor.patch, probes: [...editor.probes], selected: [...editor.selected], arpPlay: editor.arpPlay, audio: host.running && !host.muted,
    snapshots: { A: !!editor.snapshots.A, B: !!editor.snapshots.B }, zoom: editor.zoom, library: loadLibrary(),
  }), (p) => { sink.send({ t: 'panic' }); loadNamed(p); });
  const link = document.createElement('a');
  link.href = '/lesson-editor'; link.target = '_blank'; link.rel = 'noopener';
  link.textContent = 'Edit lessons';
  document.querySelector('.sidebar-bottom')?.append(link);
}
