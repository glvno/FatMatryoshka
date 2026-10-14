// SPDX-License-Identifier: GPL-3.0-only
import { setupPopoverPositioning } from './popover';
import { AudioHost } from './audio';
import type { HostMsg } from './worklet';
import { DeviceLink } from './device';
import { Editor } from './editor';
import { bankPatches, buildBankTab } from './bank';
import { buildAssembliesTab, storeAssembly } from './assemblies';
import { AssemblyBrowser } from './browser';
import { searchCommands, type Command } from './commands';
import { buildFlashTab } from './flasher';
import { attachKeyboard, attachMidi, isTextEntry } from './input';
import { DEFS } from './modules';
import { newPatch, validatePatch, voicesOf, type Patch } from './patch';
import { ARP_DEFAULT } from './arp';
import { Scope } from './scope';
import { diffCount, diffLines, diffPatches } from './diff';
import { FACTORY, loadLibrary, categoryOf, USER_SHELF, summary } from './assemblies';
import type { AssemblyDef } from './assembly';
import { decodeShare, encodeShare, shareCodeOf, shareLink } from './share';
import { starterPatch } from './starter';
import { PatchTour } from './tour';
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
/** set while a patch from a link is loaded: it must not replace the remembered patch until the user acts */
let suppressSave = false;
let touring = false;
const queueSave = (p: Patch): void => {
  if (suppressSave || touring) return;
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
host.onProbe = (key, data, sr) => scope.feed(key, data, sr);
const editor = new Editor($('canvas'), loadSaved() ?? starterPatch(), {
  onStructure(p) {
    $<HTMLInputElement>('patch-name').value = p.name;
    scope.clearSamples();
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
host.onValues = (values) => {
  editor.showParameterValues(values);
  if (!host.running) scope.clearSamples();
};

// Sidebar
setupPopoverPositioning();
const presetSel = $<HTMLSelectElement>('preset');
presetSel.append(new Option('Choose an example…', ''), ...Object.keys(PRESETS).map((n) => new Option(n, n)));
presetSel.onchange = () => {
  const v = presetSel.value;
  if (v) { editor.setPatch(PRESETS[v]()); closeSidebar(); }
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
  status.textContent = `${side} = this patch`;
};
const flipAB = (): void => {
  if (editor.toggleAB()) {
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
    { kind: 'command', label: 'Save patch as .json', keywords: 'export download file', run: savePatch },
    { kind: 'command', label: 'Load patch from .json', keywords: 'import open file', run: () => $('load-file').click() },
    { kind: 'command', label: 'Share patch link', keywords: 'copy url clipboard', run: () => void sharePatch() },
    { kind: 'command', label: 'Tour: how a patch works', keywords: 'learn help starter tutorial', run: () => { switchTab('patch'); tour.start(); } },
    { kind: 'command', label: 'New patch', run: () => loadNamed(newPatch(DEFS)) },
    { kind: 'command', label: 'Undo', detail: 'Ctrl/Cmd+Z', run: inPatch(() => editor.undo()) },
    { kind: 'command', label: 'Redo', detail: 'Shift+Ctrl/Cmd+Z', run: inPatch(() => editor.redo()) },
    { kind: 'command', label: 'Make assembly from the selection', detail: 'G', run: inPatch(() => editor.makeAssembly()) },
    { kind: 'command', label: 'Browse assembly library', run: () => browser.open() },
    { kind: 'command', label: 'Duplicate selection', detail: 'Ctrl/Cmd+D', run: inPatch(() => editor.duplicateSelected()) },
    { kind: 'command', label: 'Delete selection', detail: 'Delete', run: inPatch(() => editor.removeSelected()) },
    { kind: 'command', label: 'Bypass selection', detail: 'B', run: inPatch(() => editor.bypassSelected()) },
    { kind: 'command', label: 'Show changes since last load / upload', keywords: 'diff', run: inPatch(showDiff) },
    { kind: 'command', label: 'Set snapshot A', keywords: 'compare ab', run: () => takeSnapshot('A') },
    { kind: 'command', label: 'Set snapshot B', keywords: 'compare ab', run: () => takeSnapshot('B') },
    { kind: 'command', label: 'Switch A / B snapshots', detail: 'Alt+B', run: inPatch(flipAB) },
    { kind: 'command', label: 'Start audio', keywords: 'sound browser', run: () => void startAudio() },
    { kind: 'command', label: 'Panic: stop all notes', keywords: 'silence stuck', run: () => sink.send({ t: 'panic' }) },
    { kind: 'command', label: 'FM-1 & MIDI settings', keywords: 'connect send store sync hardware keyboard release', run: () => $<HTMLDialogElement>('device-bar').showModal() },
    { kind: 'command', label: 'Flash firmware', keywords: 'install update hardware', run: () => switchTab('flash') },
    { kind: 'command', label: 'About Matryoshka', keywords: 'credits', run: () => switchTab('about') },
    { kind: 'command', label: 'Keyboard shortcuts', keywords: 'help', detail: '?', run: () => help.showModal() },
    { kind: 'command', label: scope.visible ? 'Hide oscilloscope' : 'Show oscilloscope', keywords: 'scope window waveform', run: inPatch(() => scope.setVisible(!scope.visible)) },
    { kind: 'command', label: 'Scope: waveform', keywords: 'oscilloscope time', run: inPatch(() => scope.setMode('time')) },
    { kind: 'command', label: 'Scope: spectrum', keywords: 'oscilloscope frequency fft', run: inPatch(() => scope.setMode('spectrum')) },
    { kind: 'command', label: 'Fit patch to screen', keywords: 'zoom view', run: inPatch(() => editor.zoomToFit()) },
    { kind: 'command', label: 'Reset canvas scale', keywords: 'zoom 100%', run: inPatch(() => editor.setZoom(1)) },
    ...Object.values(DEFS).map((d) => ({ kind: 'add module', tags: ['module'], label: d.label, run: () => editor.add(d.type) })),
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
$('new-patch-btn').onclick = () => { loadNamed(newPatch(DEFS)); closeSidebar(); };
$('add-btn').onclick = () => openPalette('module');
$('add-assembly-btn').onclick = () => openPalette('assembly');
$('tour-btn').onclick = () => { switchTab('patch'); tour.start(); };
$('mobile-commands').onclick = () => openPalette();
$('palette-close').onclick = () => palette.close();
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-query]')) button.onclick = () => {
  palInput.value = button.dataset.query!;
  palSel = 0;
  palRender();
  palInput.focus();
};
const help = $<HTMLDialogElement>('help');

// ---- keyboard shortcuts (off while typing in a field; the note keyboard in input.ts gets what is left)
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && sidebar.classList.contains('open') && !document.querySelector('dialog[open]')) {
    closeSidebar(); e.preventDefault(); e.stopImmediatePropagation(); return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k' && !document.querySelector('dialog[open]')) {
    e.preventDefault(); e.stopImmediatePropagation(); openPalette(); return;
  }
  if (currentTab !== 'patch') return;
  const t = e.target as HTMLElement | null;
  const typing = isTextEntry(t) || t?.tagName === 'SELECT';
  if (document.querySelector('dialog[open], [popover]:popover-open') || typing) return;
  const control = t?.closest('button, summary, [role=tab], input, select');
  if (control && [' ', 'Enter', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
  const mod = e.metaKey || e.ctrlKey;
  const k = e.key;
  let done = false;
  if (k === '/' || (mod && k.toLowerCase() === 'k')) (openPalette(), (done = true));
  else if (k === '?') (help.showModal(), (done = true));
  else if (k === 'Escape') (editor.cancelArm(), (diffPanel.hidden = true), (done = true));
  else if (k === 'Delete' || k === 'Backspace') done = editor.removeSelected();
  else if (mod && k.toLowerCase() === 'd') done = editor.duplicateSelected();
  else if (e.altKey && k.toLowerCase() === 'b') (flipAB(), (done = true));
  else if (!mod && k.toLowerCase() === 'b') done = editor.bypassSelected();
  else if (!mod && k.toLowerCase() === 'g' && editor.selected.size) (editor.makeAssembly(), (done = true));
  else if (k === ' ') {
    editor.arpPlay = !editor.arpPlay;
    host.send({ t: 'arpplay', on: editor.arpPlay });
    if (live()) device.arp(editor.patch.arp ?? ARP_DEFAULT, editor.arpPlay);
    status.textContent = editor.arpPlay ? 'arpeggiator enabled · hold keys' : 'arpeggiator disabled';
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

const sharePatch = async (): Promise<void> => {
  try {
    const { code, full } = await encodeShare(editor.patch);
    const link = shareLink(code);
    await navigator.clipboard.writeText(link);
    status.textContent = `link copied (${link.length} characters${full ? '' : '; too long with the layout: the cards open on a grid'})`;
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
    $('audio-btn').textContent = 'Audio on';
  } catch (e) {
    status.textContent = `audio failed: ${e}`;
  }
};
$('audio-btn').onclick = startAudio;
attachKeyboard(sink, () => currentTab === 'patch' && !document.querySelector('dialog[open], [popover]:popover-open'));
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
buildBankTab($('tab-library'), device, () => editor.patch, (msg) => {
  devStatus(msg);
  for (const id of ['dev-live', 'dev-send', 'dev-store']) $<HTMLInputElement>(id).disabled = false;
});
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
  if (name === 'patch') requestAnimationFrame(() => editor.drawCables());
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


const tour = new PatchTour({
  getPatch: () => editor.patch,
  load: p => { sink.send({ t: 'panic' }); loadNamed(p); },
  active: on => { if (on && !suppressSave) save(editor.patch); touring = on; clearTimeout(saveTimer); },
  fit: () => { if ($('canvas').clientWidth < 700) editor.setZoom(1); else requestAnimationFrame(() => editor.zoomToFit()); },
  note: on => sink.send(on ? { t: 'on', note: 60, vel: .8 } : { t: 'off', note: 60 }),
});
if (currentTab === 'patch' && !shareCodeOf(location.href)) tour.welcome();
// Audio is enabled by default. A fresh browser may require a trusted gesture to resume it.
const unlockAudio = (): void => { if (!host.running) void startAudio(); };
window.addEventListener('pointerdown', unlockAudio, { capture: true });
window.addEventListener('keydown', unlockAudio, { capture: true });
void startAudio();
