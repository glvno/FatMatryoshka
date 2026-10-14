// SPDX-License-Identifier: GPL-3.0-only
// Patch editor: module cards on a canvas, SVG cables, drag-to-connect, a selection, assemblies and undo.
import { resizeHandle } from './resize-handle';
import { DEFS } from './modules';
import { parameterInputs, connectParameter, setInputRoute } from './parameter-routing';
import { parameterMenu } from './parameter-menu';
import { sliderJack } from './slider-jack';
import type { ParameterValues } from './engine';
import { deviceBudget, DEVICE } from './patchbin';
import {
  addModule,
  fromUnit,
  toUnit,
  connect,
  disconnect,
  removeModule,
  sameEnd,
  type Cable,
  type Endpoint,
  type ModuleDef,
  type ModuleInst,
  type Patch,
  type PortDef,
  type ParamDef,
  MAX_VOICES,
  voiceSplit,
  voicesOf,
  sameStructure,
  setMorphTarget,
  clearMorph,
  hasMorph,
} from './patch';
import { ARP_DEFAULT, ARP_MODES, ARP_RATES, ARP_SCALES, ARP_MAX_STEPS, fixArp, noteName, type ArpCfg } from './arp';
import { EXCLUDED_TYPES,
  addChild,
  addMember,
  allModules,
  assembliesOf,
  assemblyOf,
  childrenOf,
  deleteAssembly,
  demote,
  depthOf,
  descendants,
  exposePort,
  findRef,
  fixAssemblies,
  freeSpot,
  hiddenAssemblies,
  hiddenModules,
  hidePort,
  insertAssembly,
  isExposed,
  isPromoted,
  makeAssembly,
  mergePorts,
  moveAssembly,
  overlapping,
  parentOf,
  promote,
  reconcileAll,
  removeChild,
  removeMember,
  targetsOf,
  tileMembers,
  toDef,
  ungroup,
  unmergePort,
  type AssemblyDef,
  type AssemblyInst,
  type PortRef,
  type Rect,
  type Target, bypassAssembly } from './assembly';

const SVGNS = 'http://www.w3.org/2000/svg';
const HISTORY = 40;
/** a logarithmic slider's value rounded to the parameter's step (a glide time to the ms, a cutoff to the Hz), not to a whole number */
function snapTo(pd: ParamDef, v: number): number {
  const step = pd.step ?? 0;
  const x = step > 0 ? Math.round(v / step) * step : v;
  return Math.min(pd.max, Math.max(pd.min, Number(x.toFixed(6))));
}

/** the frame around an expanded assembly: padding around its cards and the height of its header */
const FRAME_PAD = 12;
const FRAME_HEAD = 30;

export interface EditorEvents {
  /** structure changed (modules or cables): the engine needs the whole patch */
  onStructure(p: Patch): void;
  /** a knob moved: cheap update */
  onParam(id: number, name: string, value: number): void;
  /** an attenuverter of a parameter input moved (index 0 = p1, 1 = p2) */
  onAtt(id: number, index: number, value: number): void;
  /** a module's bypass switch (the structure is unchanged: the engine keeps its state) */
  onBypass(id: number, on: boolean): void;
  /** a macro range of p1 / p2 (index 0 / 1) on a parameter changed or was removed (null) */
  onRange(id: number, index: number, name: string, range: [number, number] | null): void;
  /** the arpeggiator's settings changed (they are part of the patch: Patch.arp) */
  onArp(cfg: ArpCfg): void;
  /** the arpeggiator's transport (editor state, not saved) */
  onArpPlay(on: boolean): void;
  /** a scope probe on an output was set or removed (key = probeKey) */
  onProbe(key: string, id: number, port: string, kind: PortDef['kind'], label: string, on: boolean): void;
  /** cards were moved: positions changed, nothing the engine needs */
  onLayout(p: Patch): void;
  /** a message for the status line */
  onError(msg: string): void;
  /** "save" on an assembly: put this definition into the library */
  onSaveAssembly(def: AssemblyDef): void;
  /** the patches the morph picker on the Main card offers as the B side (those of the same structure are listed) */
  morphCandidates?(): { name: string; patch: Patch }[];
}

/** the key of a scope probe on an output */
export const probeKey = (id: number, port: string): string => `${id}:${port}`;
type Pt = { x: number; y: number };
/** the footprint of a new card for the free-spot search: a grid cell less its gutters */
const CARD_W = 250;
const CARD_H = 540;
/** a drop is judged by the card's header (where it is held), this far below its top */
const HEAD_Y = 15;

export class Editor {
  patch: Patch;
  /** the selected modules (shift-click or a rubber band); "Make assembly" groups them, dragging one moves all */
  readonly selected = new Set<number>();
  private modulesEl: HTMLElement;
  private svg: SVGSVGElement;
  private preview: SVGSVGElement;
  private world: HTMLElement;
  private space: HTMLElement;
  private ports = new Map<string, HTMLElement>();
  private cards = new Map<number, HTMLElement>();
  private frames = new Map<number, HTMLElement>();
  /** the collapsed assembly cards on the canvas */
  private containers = new Map<number, HTMLElement>();
  private drag: { path: SVGPathElement; cancel: () => void } | null = null;
  private sliderPorts: { m: ModuleInst; pd: ParamDef; jack: HTMLElement }[] = [];
  private cablePaths: { path: SVGPathElement; from: HTMLElement; to: HTMLElement; origin: HTMLElement }[] = [];
  private stack: string[] = [];
  private routingOpen = new Set<string>();
  private history: string[] = [];
  private future: string[] = [];
  private parameterDisplays: { id: number; update: (values: Record<string, number> | null) => void }[] = [];

  /** Display only: never write telemetry into the patch, undo history, or parameter callbacks. */
  showParameterValues(values: ParameterValues | null): void {
    if (values && (this.drag || this.armed)) return; // Keep drop targets still while patching.
    const byId = new Map(values?.map((m) => [m.id, m.params]));
    for (const display of this.parameterDisplays) display.update(byId.get(display.id) ?? null);
    this.positionCables();
  }

  constructor(private canvas: HTMLElement, patch: Patch, private ev: EditorEvents) {
    this.patch = patch;
    this.modulesEl = canvas.querySelector('#modules')!;
    this.svg = canvas.querySelector('#cables')! as unknown as SVGSVGElement;
    this.preview = canvas.querySelector('#patch-preview')! as unknown as SVGSVGElement;
    this.world = canvas.querySelector('#patch-world')!;
    this.space = canvas.querySelector('#canvas-space')!;
    this.report(fixAssemblies(this.patch, DEFS));
    new ResizeObserver(() => { this.sizeCanvas(); this.positionCables(); }).observe(canvas);
    document.fonts.addEventListener('loadingdone', () => {
      this.layoutFrames(); this.sizeCanvas(); this.positionCables();
    });
    canvas.addEventListener('pointerdown', (e) => this.rubberBand(e));
    this.touchGestures();
    const raise = (event: Event): void => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const card = target.closest<HTMLElement>('.module, .frame');
      if (card) this.raiseCard(card);
    };
    canvas.addEventListener('pointerdown', raise, true);
    canvas.addEventListener('focusin', raise);
    window.addEventListener('keydown', (e) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return;
      if (!this.canvas.checkVisibility() || document.querySelector('dialog[open], [popover]:popover-open')) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') && (t as HTMLInputElement).type !== 'range') return;
      e.preventDefault();
      if (e.shiftKey) this.redo();
      else this.undo();
    });
    this.rebuild();
  }

  setPatch(p: Patch): void {
    this.patch = p;
    this.report(fixAssemblies(this.patch, DEFS));
    this.history = [];
    this.future = [];
    this.routingOpen.clear();
    this.stack = [];
    this.selected.clear();
    this.rebuild();
    this.ev.onStructure(p);
  }

  private report(msgs: string[]): void {
    if (msgs.length) this.ev.onError(msgs.join('; '));
  }

  /** where the next card goes: the first grid cell that no visible card, container or frame touches */
  private slot(): Pt {
    const rect = (el: HTMLElement): Rect => ({ x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight });
    const occupied = [...this.cards.values(), ...this.containers.values(), ...this.frames.values()].map(rect);
    // before the first layout the elements have no size: fall back to the model's positions
    if (occupied.some((r) => !r.w)) {
      const hidden = hiddenModules(this.patch);
      const hiddenAsm = hiddenAssemblies(this.patch);
      occupied.length = 0;
      for (const m of this.patch.modules) if (!hidden.has(m.id)) occupied.push({ x: m.x, y: m.y, w: CARD_W, h: CARD_H });
      for (const a of assembliesOf(this.patch)) if (!a.open && !hiddenAsm.has(a.id)) occupied.push({ x: a.x, y: a.y, w: CARD_W, h: CARD_H });
    }
    return freeSpot(occupied, CARD_W, CARD_H);
  }

  add(type: string): void {
    const at = this.slot();
    this.change(() => {
      addModule(this.patch, DEFS[type], at.x, at.y);
    });
  }

  /** put a saved assembly into the patch */
  insert(def: AssemblyDef): void {
    const at = this.slot();
    if (this.change(() => insertAssembly(this.patch, DEFS, def, at.x, at.y))) this.ev.onError(`"${def.name}" inserted. Knob assignments (K1..K4) are not kept: tick them in the patch.`);
  }

  /** group the selected modules into a new assembly */
  makeAssembly(): void {
    if (!this.selected.size) return this.ev.onError('select the modules first: shift-click them, or drag a box on the canvas');
    // a patch's own modules never go into a building block: they stay outside, the rest is grouped
    const ids = [...this.selected].filter((id) => !EXCLUDED_TYPES.has(this.patch.modules.find((m) => m.id === id)?.type ?? ''));
    if (!ids.length) return this.ev.onError('the Main panel and the Output stay outside an assembly: select other modules');
    const name = window.prompt('Name of the assembly', 'assembly')?.trim();
    if (!name) return;
    if (this.change(() => makeAssembly(this.patch, ids, name))) {
      this.selected.clear();
      if (ids.length < this.selected.size + ids.length) this.ev.onError('Main and Output stay outside');
    }
  }

  // ---- undo

  undo(): void {
    const s = this.history.pop();
    if (s === undefined) return this.ev.onError('nothing to undo');
    this.future.push(JSON.stringify(this.patch));
    this.restore(s);
  }

  redo(): void {
    const s = this.future.pop();
    if (s === undefined) return this.ev.onError('nothing to redo');
    this.history.push(JSON.stringify(this.patch));
    this.restore(s);
  }

  private restore(s: string): void {
    this.patch = JSON.parse(s) as Patch;
    this.selected.clear();
    this.rebuild();
    this.ev.onStructure(this.patch);
  }

  /**
   * A structural change: run it, keep the assemblies consistent, remember the previous state for undo, redraw and tell
   * the host. An error undoes the change and goes to the status line. Returns whether something changed.
   */
  private change(fn: () => unknown): boolean {
    const before = JSON.stringify(this.patch);
    try {
      fn();
    } catch (e) {
      this.patch = JSON.parse(before) as Patch;
      this.rebuild();
      this.ev.onError(String((e as Error).message ?? e));
      return false;
    }
    this.report(reconcileAll(this.patch, DEFS).map((l) => `assembly "${l}" is empty and was removed`));
    if (JSON.stringify(this.patch) === before) return false;
    this.history.push(before);
    if (this.history.length > HISTORY) this.history.shift();
    this.future = [];
    this.rebuild();
    this.ev.onStructure(this.patch);
    return true;
  }

  private key(id: number, port: string, dir: 'out' | 'in'): string {
    return `${id}:${dir}:${port}`;
  }

  // ---- building the canvas

  rebuild(): void {
    this.cancelArm();
    this.parameterDisplays = [];
    this.sliderPorts = [];
    this.cablePaths = [];
    this.drag?.cancel();
    this.svg.replaceChildren();
    this.preview.replaceChildren();
    this.modulesEl.replaceChildren();
    this.ports.clear();
    this.cards.clear();
    this.frames.clear();
    this.containers.clear();
    const poly = voiceSplit(this.patch);
    const hidden = hiddenModules(this.patch);
    const hiddenAsm = hiddenAssemblies(this.patch);
    const perVoice = (a: AssemblyInst): boolean => allModules(this.patch, a).some((id) => poly.has(id));
    for (const id of this.selected) if (!this.patch.modules.some((m) => m.id === id) || hidden.has(id)) this.selected.delete(id);
    // frames of the outer assemblies first: a nested frame is drawn on top of its parent's
    const visible = assembliesOf(this.patch).filter((a) => !hiddenAsm.has(a.id));
    for (const a of [...visible].sort((u, v) => depthOf(this.patch, u) - depthOf(this.patch, v))) if (a.open) this.modulesEl.append(this.frame(a, perVoice(a)));
    for (const m of this.patch.modules) {
      if (hidden.has(m.id)) continue;
      const a = assemblyOf(this.patch, m.id);
      this.modulesEl.append(this.card(m, DEFS[m.type], poly.has(m.id), a));
    }
    for (const a of visible) if (!a.open) this.modulesEl.append(this.container(a, perVoice(a), parentOf(this.patch, a.id)));
    this.applyStack();
    this.sizeCanvas();
    requestAnimationFrame(() => {
      this.layoutFrames();
      this.sizeCanvas();
      this.drawCables();
    });
  }

  private layerKey(el: HTMLElement): string { return el.dataset.asm ? `a${el.dataset.asm}` : `m${el.dataset.id}`; }

  private applyStack(): void {
    const elements = [...this.frames.values(), ...this.cards.values(), ...this.containers.values()];
    const keys = elements.map((el) => this.layerKey(el));
    this.stack = this.stack.filter((key) => keys.includes(key));
    this.stack = [...keys.filter((key) => !this.stack.includes(key)), ...this.stack];
    for (const el of elements) el.style.zIndex = String(2 + this.stack.indexOf(this.layerKey(el)));
  }

  private raiseCard(el: HTMLElement): void {
    let raised = [this.layerKey(el)];
    if (el.classList.contains('frame')) {
      const a = assembliesOf(this.patch).find((a) => a.id === Number(el.dataset.asm));
      if (a) raised = [raised[0], ...descendants(this.patch, a).map((child) => `a${child.id}`), ...allModules(this.patch, a).map((id) => `m${id}`)];
    }
    this.stack = [...this.stack.filter((key) => !raised.includes(key)), ...raised];
    this.applyStack();
  }

  private resizeAssembly(el: HTMLElement, a: AssemblyInst): void {
    let before = '';
    el.append(resizeHandle(`Resize ${a.label}`, () => this.zoom, {
      start: () => { before = JSON.stringify(this.patch); this.raiseCard(el); },
      size: () => ({ width: el.offsetWidth, height: el.offsetHeight }),
      resize: (width, height) => {
        a.frameSize = { width: Math.min(4000, Math.max(236, width)), height: Math.min(4000, Math.max(80, height)) };
        this.layoutFrames(); this.sizeCanvas(); this.positionCables();
      },
      end: () => {
        if (before !== JSON.stringify(this.patch)) {
          this.history.push(before); if (this.history.length > HISTORY) this.history.shift(); this.future = [];
          this.ev.onLayout(this.patch);
        }
      },
    }));
  }

  private sizeCanvas(): void {
    const elements = [...this.cards.values(), ...this.containers.values(), ...this.frames.values()];
    const w = Math.max(this.canvas.clientWidth / this.zoom, ...elements.map((el) => el.offsetLeft + el.offsetWidth + 32));
    const h = Math.max(this.canvas.clientHeight / this.zoom, ...elements.map((el) => el.offsetTop + el.offsetHeight + 32));
    this.world.style.width = `${w}px`;
    this.world.style.height = `${h}px`;
    this.space.style.width = `${Math.ceil(w * this.zoom)}px`;
    this.space.style.height = `${Math.ceil(h * this.zoom)}px`;
  }

  private badge(): HTMLElement {
    const badge = document.createElement('span');
    badge.className = 'voices';
    badge.textContent = `×${voicesOf(this.patch)}`;
    badge.title = `runs once per voice (${voicesOf(this.patch)} voices)`;
    return badge;
  }

  private button(text: string, title: string, onclick: () => void, cls = 'sm'): HTMLButtonElement {
    const b = document.createElement('button');
    b.className = cls;
    b.textContent = text;
    b.title = title;
    b.setAttribute('aria-label', title);
    b.onclick = (e) => {
      e.stopPropagation();
      e.preventDefault();
      onclick();
    };
    return b;
  }

  /** a module card; inside an expanded assembly its ports and parameters get the expose / pin toggles */
  private card(m: ModuleInst, def: ModuleDef, perVoice: boolean, open?: AssemblyInst): HTMLElement {
    const el = document.createElement('div');
    el.className = 'module' + (this.selected.has(m.id) ? ' selected' : '') + (open ? ' member' : '');
    el.style.left = `${m.x}px`;
    el.style.top = `${m.y}px`;
    el.dataset.id = String(m.id);
    this.cards.set(m.id, el);

    const head = document.createElement('div');
    head.className = 'mhead';
    const title = document.createElement('span');
    title.textContent = def.label;
    if (perVoice) title.append(' ', this.badge());
    const del = this.button('×', `Remove ${def.label}`, () => this.change(() => removeModule(this.patch, m.id)), 'x');
    const tools = document.createElement('span');
    tools.className = 'tools';
    if (def.type !== 'fm1' && def.type !== 'output') tools.append(this.bypassButton(m, def, el));
    tools.append(del);
    head.append(title, tools);
    el.classList.toggle('off', !!m.bypass);
    this.moduleDrag(head, m);

    const body = document.createElement('div');
    body.className = 'mbody';
    const ins = document.createElement('div');
    ins.className = 'ports in';
    for (const p of def.inputs) if (!p.pin) ins.append(this.port(m, p, 'in', { open }));
    const outs = document.createElement('div');
    outs.className = 'ports out';
    for (const p of def.outputs) outs.append(this.port(m, p, 'out', { open }));
    const io = document.createElement('div');
    io.className = 'io';
    io.append(ins, outs);

    const params = document.createElement('div');
    params.className = 'params';
    for (const pd of def.params) params.append(this.paramRow(m, def, pd, { open }));
    body.append(io);
    if (def.paramInputs) body.append(this.pins(m, def, open));
    if (def.type === 'fm1') params.append(this.voicesRow(), this.morphRow(), this.arpPanel());
    body.append(params);
    el.append(head, body);
    return el;
  }

  /** the power button of a card: bypass on / off (the through input, or silence, replaces the module's outputs) */
  private bypassButton(m: ModuleInst, def: ModuleDef, card: HTMLElement): HTMLButtonElement {
    const b = this.button('⏻', `${def.label} on / off (bypass)`, () => {
      this.history.push(JSON.stringify(this.patch));
      if (this.history.length > HISTORY) this.history.shift();
      this.future = [];
      m.bypass = !m.bypass;
      if (!m.bypass) delete m.bypass;
      card.classList.toggle('off', !!m.bypass);
      b.classList.toggle('on', !m.bypass);
      this.ev.onBypass(m.id, !!m.bypass);
    }, 'pw');
    b.classList.toggle('on', !m.bypass);
    b.setAttribute('aria-pressed', String(!m.bypass));
    return b;
  }

  /** one parameter slider (or check box); `label` overrides the name (a promoted parameter on an assembly card) */
  /** redraws the value of a parameter row (the synced delay shows its time as a note length) */
  private refreshers = new WeakMap<HTMLElement, () => void>();

  private paramRow(m: ModuleInst, def: ModuleDef, pd: ParamDef, o: { open?: AssemblyInst; label?: string; rename?: () => void } = {}): HTMLElement {
    const row = document.createElement('div');
    row.className = 'param';
    const name = document.createElement('span');
    name.textContent = o.label ?? pd.name;
    if (o.open) {
      const a = o.open;
      const on = isPromoted(a, m.id, pd.name);
      name.prepend(
        this.button(on ? '●' : '○', on ? `${pd.name} is on the "${a.label}" card: click to take it off` : `show ${pd.name} on the "${a.label}" card`, () =>
          this.change(() => (on ? demote(a, m.id, pd.name) : promote(a, m.id, pd.name))),
        'tog'),
        ' ',
      );
    }
    if (o.rename) {
      name.title = 'click to rename';
      name.classList.add('rename');
      name.onclick = (e) => {
        e.preventDefault();
        o.rename!();
      };
    }
    const val = document.createElement('output');
    const fmt = (v: number, params = m.params): string =>
      pd.altText && params[pd.altText.when] >= 0.5 ? pd.altText.text(v) : pd.choices ? pd.choices[Math.round(v)] : `${Number(v.toFixed(3))}${pd.unit ? ' ' + pd.unit : ''}`;
    val.textContent = fmt(m.params[pd.name]);
    this.refreshers.set(row, () => (val.textContent = fmt(m.params[pd.name])));
    const input = document.createElement('input');
    input.type = 'range';
    if (pd.log) {
      // a logarithmic parameter: the slider position is the fraction of the octaves
      input.min = '0';
      input.max = '1000';
      input.step = '1';
      input.value = String(Math.round(toUnit(pd, m.params[pd.name]) * 1000));
    } else {
      input.min = String(pd.min);
      input.max = String(pd.max);
      input.step = String(pd.step ?? (pd.max - pd.min) / 200);
      input.value = String(m.params[pd.name]);
    }
    input.setAttribute('aria-label', `${def.label} ${o.label ?? pd.name}`);
    // Pointer capture also releases the edit lock when a drag ends outside the card.
    let editing = false;
    input.onpointerdown = (e) => {
      if (e.altKey && (pd.input || def.paramInputs) && !pd.toggle) return;
      editing = true;
      input.setPointerCapture(e.pointerId);
    };
    input.onpointerup = input.onpointercancel = input.onlostpointercapture = () => { editing = false; };
    input.onkeydown = (e) => {
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown', ' '].includes(e.key)) editing = true;
    };
    input.onkeyup = input.onblur = () => { editing = false; };
    input.oninput = () => {
      const v = pd.log ? snapTo(pd, fromUnit(pd, Number(input.value) / 1000)) : Number(input.value);
      m.params[pd.name] = v;
      val.textContent = fmt(v);
      this.ev.onParam(m.id, pd.name, v);
    };
    if (pd.toggle) {
      input.type = 'checkbox';
      input.checked = m.params[pd.name] >= 0.5;
      input.oninput = () => {
        const v = input.checked ? 1 : 0;
        m.params[pd.name] = v;
        val.textContent = fmt(v);
        for (const el of row.parentElement?.children ?? []) this.refreshers.get(el as HTMLElement)?.(); // a toggle can change how its siblings show (altText)
        this.ev.onParam(m.id, pd.name, v);
      };
    }
    const canPatch = def.inputs.length > 0;
    const thumb = canPatch && !pd.toggle ? sliderJack(input, (e, jack) => this.beginDrag(e, jack)) : null;
    const gesture = thumb ? 'Drag to adjust; Alt-drag to patch. Drop a cable on the thumb to connect.' : '';
    input.title = gesture;
    if (thumb) {
      thumb.jack.dataset.mod = String(m.id);
      thumb.jack.dataset.param = pd.name;
      thumb.jack.dataset.dir = 'in';
      thumb.jack.title = `${def.label} ${pd.name}: ${parameterInputs(m, pd).join(' / ') || 'parameter input'}. ${gesture}`;
      this.sliderPorts.push({ m, pd, jack: thumb.jack });
      input.addEventListener('input', () => this.positionCables());
    }
    this.parameterDisplays.push({ id: m.id, update: (values) => {
      if (editing) return;
      const base = m.params[pd.name];
      const v = values?.[pd.name] ?? base;
      if (!Number.isFinite(v)) return;
      const position = String(pd.log ? Math.round(toUnit(pd, v) * 1000) : v);
      if (pd.toggle) input.checked = v >= 0.5;
      else if (input.value !== position) input.value = position;
      thumb?.update();
      const text = fmt(v, values ?? m.params);
      if (val.textContent !== text) val.textContent = text;
      input.setAttribute('aria-valuetext', text);
      const automated = Math.abs(v - base) > 1e-6;
      row.classList.toggle('automated', automated);
      input.title = automated ? `Live: ${text}. Base: ${fmt(base)}. ${gesture || 'Drag to edit the base value.'}` : gesture;
    } });
    row.append(name, val);
    if (canPatch) {
      const key = `${m.id}:${pd.name}`;
      row.append(parameterMenu(m, def, pd, { ...this.ev, change: (fn) => this.change(fn) }, this.routingOpen.has(key), (on) => {
        if (on) {
          this.routingOpen.clear();
          this.routingOpen.add(key);
          for (const other of this.modulesEl.querySelectorAll<HTMLDetailsElement>('.parameter-routing[open]'))
            if (other.parentElement !== row) other.open = false;
        } else this.routingOpen.delete(key);
        this.drawCables();
      }));
    }
    row.append(thumb?.element ?? input);
    return row;
  }

  /** the patch's voice count, on the Main card: 1 is the mono engine, more runs every module that hears pitch / gate / vel once per voice */
  private voicesRow(): HTMLElement {
    const row = document.createElement('label');
    row.className = 'param voices-row';
    const name = document.createElement('span');
    name.textContent = 'voices';
    const val = document.createElement('output');
    const sel = document.createElement('select');
    sel.setAttribute('aria-label', 'Voices');
    for (let n = 1; n <= MAX_VOICES; n++) sel.append(new Option(n === 1 ? 'mono' : String(n), String(n)));
    const show = (): void => {
      const n = voicesOf(this.patch);
      const b = deviceBudget(this.patch);
      sel.value = String(n);
      val.textContent = n === 1 ? '' : b.fits ? `${b.buffers}/${DEVICE.buffers} buf` : 'too big for FM-1';
      sel.classList.toggle('over', !b.fits);
      row.title = `Voices. With more than one, every module that hears pitch, gate or vel (×N on its card) runs once per voice; delay, reverb and output stay single and sum the voices. On the FM-1 this patch takes ${b.buffers} of ${DEVICE.buffers} signal buffers and ${b.instances} of ${DEVICE.instances} module instances${b.fits ? '.' : ': too many, the FM-1 will refuse it.'}`;
    };
    show();
    sel.onchange = () => {
      const n = Number(sel.value);
      this.change(() => {
        if (n > 1) this.patch.voices = n;
        else delete this.patch.voices;
      });
    };
    row.append(name, val, sel);
    return row;
  }

  /** the morph picker: the B side of the patch (another patch of the same structure); the `morph` slider above fades every parameter A -> B */
  private morphRow(): HTMLElement {
    const row = document.createElement('label');
    row.className = 'param morph-row';
    const name = document.createElement('span');
    name.textContent = 'B side';
    const val = document.createElement('output');
    const sel = document.createElement('select');
    sel.setAttribute('aria-label', 'Morph B side');
    const cands = (this.ev.morphCandidates?.() ?? []).filter((c) => sameStructure(this.patch, c.patch));
    sel.append(new Option('none', ''), ...cands.map((c, i) => new Option(c.name, String(i))));
    const show = (): void => {
      const has = hasMorph(this.patch);
      val.textContent = has ? (this.patch.morphName ?? 'set') : '';
      sel.value = '';
      row.title = has
        ? `The morph slider fades every parameter from this patch (A) to "${this.patch.morphName ?? 'B'}" (B): in octaves for a logarithmic one, a choice or switch flips at 0.5. The Main module's morph input adds to the slider (an LFO morphs the patch). Choose "none" to drop the B side.`
        : cands.length
          ? 'Pick a patch with the same modules and cables as the B side; the morph slider then fades every parameter from this patch to it.'
          : 'No stored patch has the same modules and cables as this one. Save this patch under another name, change its sounds, and pick that copy here.';
    };
    show();
    sel.onchange = () => {
      const v = sel.value;
      this.change(() => {
        if (v === '') clearMorph(this.patch);
        else setMorphTarget(this.patch, cands[Number(v)].patch, DEFS);
      });
    };
    row.append(name, val, sel);
    return row;
  }

  /** the arpeggiator's transport (editor state) */
  arpPlay = false;

  // ---- zoom and touch: the cards and cables are scaled by `zoom`; offsets stay in layout pixels, pointer deltas are divided by it

  zoom = 1;
  onZoom: (z: number) => void = () => {};

  setZoom(z: number): void {
    this.zoom = Math.min(2, Math.max(0.3, Math.round(z * 100) / 100));
    this.world.style.transform = this.zoom === 1 ? '' : `scale(${this.zoom})`;
    this.sizeCanvas();
    this.drawCables();
    this.onZoom(this.zoom);
  }

  /** every card in view: the zoom that fits the whole patch into the canvas */
  zoomToFit(): void {
    const elements = [...this.cards.values(), ...this.containers.values(), ...this.frames.values()];
    if (!elements.length) return;
    const w = Math.max(...elements.map((el) => el.offsetLeft + el.offsetWidth + 24));
    const h = Math.max(...elements.map((el) => el.offsetTop + el.offsetHeight + 24));
    this.setZoom(Math.min(1.5, (this.canvas.clientWidth - 16) / w, (this.canvas.clientHeight - 16) / h));
    this.canvas.scrollTo(0, 0);
  }

  /** pinch to zoom and one-finger pan on the empty canvas (touch), Ctrl / Cmd + wheel to zoom (trackpads) */
  private touchGestures(): void {
    const pts = new Map<number, Pt>();
    let pinch: { d: number; z: number } | null = null;
    this.canvas.addEventListener('wheel', (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      this.setZoom(this.zoom * Math.exp(-e.deltaY / 400));
    }, { passive: false });
    this.canvas.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch') return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), z: this.zoom };
      }
    });
    const end = (e: PointerEvent): void => {
      pts.delete(e.pointerId);
      if (pts.size < 2) pinch = null;
    };
    this.canvas.addEventListener('pointerup', end);
    this.canvas.addEventListener('pointercancel', end);
    this.canvas.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'touch' || !pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && pts.size === 2) {
        const [a, b] = [...pts.values()];
        this.setZoom(pinch.z * (Math.hypot(a.x - b.x, a.y - b.y) / pinch.d));
        e.preventDefault();
      }
    });
  }

  /** a long press on a card header (touch): the context actions */
  private contextMenu(m: ModuleInst, def: ModuleDef, at: Pt): void {
    document.querySelector('.ctx')?.remove();
    const menu = document.createElement('div');
    menu.className = 'ctx';
    const item = (text: string, run: () => void): void => {
      const b = document.createElement('button');
      b.textContent = text;
      b.onclick = (e) => {
        e.stopPropagation();
        menu.remove();
        run();
      };
      menu.append(b);
    };
    if (def.type !== 'fm1' && def.type !== 'output') item(m.bypass ? 'turn on' : 'bypass', () => {
      this.selected.clear();
      this.selected.add(m.id);
      this.bypassSelected();
    });
    item('duplicate', () => {
      this.selected.clear();
      this.selected.add(m.id);
      this.duplicateSelected();
    });
    item('select', () => {
      this.selected.add(m.id);
      this.showSelection();
    });
    item('remove', () => this.change(() => removeModule(this.patch, m.id)));
    item('cancel', () => {});
    Object.assign(menu.style, { left: `${at.x}px`, top: `${at.y}px` });
    this.modulesEl.append(menu);
    const away = (e: Event): void => {
      if (!menu.contains(e.target as Node)) {
        menu.remove();
        window.removeEventListener('pointerdown', away, true);
      }
    };
    setTimeout(() => window.addEventListener('pointerdown', away, true));
  }

  // ---- keyboard actions (main.ts shortcuts): the selection

  /** remove the selected modules (and their cables) */
  removeSelected(): boolean {
    const ids = [...this.selected];
    if (!ids.length) return false;
    return this.change(() => {
      for (const id of ids) removeModule(this.patch, id);
    });
  }

  /** flip the bypass of the selected modules (all on if any was off) */
  bypassSelected(): boolean {
    const ms = this.patch.modules.filter((m) => this.selected.has(m.id) && m.type !== 'fm1' && m.type !== 'output');
    if (!ms.length) return false;
    const on = ms.some((m) => !m.bypass);
    this.history.push(JSON.stringify(this.patch));
    if (this.history.length > HISTORY) this.history.shift();
    this.future = [];
    for (const m of ms) {
      if (on) m.bypass = true;
      else delete m.bypass;
      this.ev.onBypass(m.id, on);
    }
    this.rebuild();
    this.ev.onLayout(this.patch);
    return true;
  }

  /** move the selected cards by (dx, dy) pixels */
  nudgeSelected(dx: number, dy: number): boolean {
    const ms = this.patch.modules.filter((m) => this.selected.has(m.id));
    if (!ms.length) return false;
    for (const m of ms) {
      m.x = Math.max(0, m.x + dx);
      m.y = Math.max(0, m.y + dy);
    }
    this.rebuild();
    this.ev.onLayout(this.patch);
    return true;
  }

  /** copies of the selected modules with their parameters, matrix and the cables among them, placed below the originals and selected */
  duplicateSelected(): boolean {
    const ids = [...this.selected].filter((id) => this.patch.modules.some((m) => m.id === id && m.type !== 'fm1'));
    if (!ids.length) return false;
    return this.change(() => {
      const map = new Map<number, number>();
      for (const id of ids) {
        const m = this.patch.modules.find((x) => x.id === id)!;
        const copy = addModule(this.patch, DEFS[m.type], m.x, m.y + CARD_H / 2);
        copy.params = { ...m.params };
        if (m.att) copy.att = [m.att[0], m.att[1]];
        if (m.map) copy.map = JSON.parse(JSON.stringify(m.map));
        if (m.range) copy.range = JSON.parse(JSON.stringify(m.range));
        if (m.bypass) copy.bypass = true;
        if (m.disabledInputs) copy.disabledInputs = [...m.disabledInputs];
        if (m.inputMap) copy.inputMap = structuredClone(m.inputMap);
        map.set(id, copy.id);
      }
      for (const c of [...this.patch.cables]) if (map.has(c.from.module) && map.has(c.to.module)) connect(this.patch, DEFS, { module: map.get(c.from.module)!, port: c.from.port }, { module: map.get(c.to.module)!, port: c.to.port });
      this.selected.clear();
      for (const id of map.values()) this.selected.add(id);
    });
  }

  // ---- click-to-connect: a click on a jack arms it, a click on a jack of the other direction connects; Esc cancels

  private armed: HTMLElement | null = null;

  cancelArm(): void {
    this.armed?.classList.remove('armed');
    this.armed = null;
    this.canvas.classList.remove('patching');
    this.drag?.cancel();
  }

  // ---- A / B: two snapshots; the toggle swaps them, as a parameter-only update when the structure matches

  readonly snapshots: { A: string | null; B: string | null } = { A: null, B: null };
  side: 'A' | 'B' = 'A';

  /** keep the current patch as snapshot A or B */
  takeSnapshot(which: 'A' | 'B'): void {
    this.snapshots[which] = JSON.stringify(this.patch);
    this.side = which;
  }

  /** go to the other snapshot (false when it is empty) */
  toggleAB(): boolean {
    const other = this.side === 'A' ? 'B' : 'A';
    const s = this.snapshots[other];
    if (s === null) return false;
    this.snapshots[this.side] = JSON.stringify(this.patch); // the side we leave keeps what we did to it
    this.side = other;
    this.applyLive(JSON.parse(s) as Patch);
    return true;
  }

  /** switch to `target`: with the same structure only the values move (onParam / onAtt / onBypass / onRange, no reload, the voices keep sounding), else a full load */
  applyLive(target: Patch): void {
    if (!sameStructure(this.patch, target) || this.patch.modules.some((m, i) => m.id !== target.modules[i].id)) {
      this.history.push(JSON.stringify(this.patch));
      this.patch = target;
      this.selected.clear();
      this.rebuild();
      this.ev.onStructure(this.patch);
      return;
    }
    this.history.push(JSON.stringify(this.patch));
    if (this.history.length > HISTORY) this.history.shift();
    this.future = [];
    target.modules.forEach((t, i) => {
      const m = this.patch.modules[i];
      for (const pd of DEFS[m.type].params) if ((m.params[pd.name] ?? pd.default) !== (t.params[pd.name] ?? pd.default)) this.ev.onParam(m.id, pd.name, t.params[pd.name] ?? pd.default);
      if (m.att && t.att) for (const k of [0, 1] as const) if (m.att[k] !== t.att[k]) this.ev.onAtt(m.id, k, t.att[k]);
      if (!!m.bypass !== !!t.bypass) this.ev.onBypass(m.id, !!t.bypass);
      for (const s of ['p1', 'p2'] as const) {
        const names = new Set([...Object.keys(m.range?.[s] ?? {}), ...Object.keys(t.range?.[s] ?? {})]);
        for (const name of names) {
          const r = t.range?.[s]?.[name] ?? null;
          if (JSON.stringify(r) !== JSON.stringify(m.range?.[s]?.[name] ?? null)) this.ev.onRange(m.id, s === 'p1' ? 0 : 1, name, r);
        }
      }
    });
    const keepLayout = this.patch.modules.map((m) => [m.x, m.y]);
    this.patch = target;
    this.patch.modules.forEach((m, i) => ([m.x, m.y] = keepLayout[i]));
    if (target.arp) this.ev.onArp(target.arp);
    this.rebuild();
    this.ev.onLayout(this.patch);
  }
  /** the outputs with a scope probe (probeKey) */
  readonly probes = new Set<string>();

  /** the arpeggiator on the Main card: the rows of the FM-1's MELODY / RHYTHM / CHAOS pages, saved with the patch (Patch.arp) */
  private arpPanel(): HTMLElement {
    const box = document.createElement('details');
    box.className = 'arp';
    box.open = !!this.patch.arp || this.arpPlay;
    const sum = document.createElement('summary');
    sum.textContent = 'Arpeggiator';
    box.append(sum);
    const cfg = (): ArpCfg => this.patch.arp ?? { ...ARP_DEFAULT };
    const set = (f: keyof ArpCfg, v: number): void => {
      const c = fixArp({ ...cfg(), [f]: v });
      this.patch.arp = c;
      this.ev.onArp(c);
      refresh();
    };
    const rows: (() => void)[] = [];
    const row = (label: string, el: HTMLElement, show: () => string): void => {
      const r = document.createElement('label');
      r.className = 'param';
      const name = document.createElement('span');
      name.textContent = label;
      const val = document.createElement('output');
      r.append(name, val, el);
      rows.push(() => (val.textContent = show()));
      box.append(r);
    };
    const refresh = (): void => rows.forEach((f) => f());
    const choice = (label: string, f: keyof ArpCfg, names: string[]): void => {
      const sel = document.createElement('select');
      sel.setAttribute('aria-label', `arpeggiator ${label}`);
      sel.append(...names.map((n, i) => new Option(n, String(i))));
      sel.onchange = () => set(f, Number(sel.value));
      row(label, sel, () => ((sel.value = String(cfg()[f])), ''));
    };
    const num = (label: string, f: keyof ArpCfg, lo: number, hi: () => number, show: (v: number) => string = String): void => {
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(lo);
      input.step = '1';
      input.setAttribute('aria-label', `arpeggiator ${label}`);
      input.oninput = () => set(f, Number(input.value));
      row(label, input, () => {
        input.max = String(hi());
        input.value = String(cfg()[f]);
        return show(cfg()[f]);
      });
    };
    // transport
    const play = document.createElement('label');
    play.className = 'param';
    const pname = document.createElement('span');
    pname.textContent = 'enable';
    const pbox = document.createElement('input');
    pbox.type = 'checkbox';
    pbox.checked = this.arpPlay;
    pbox.setAttribute('aria-label', 'arpeggiator enable');
    pbox.oninput = () => {
      this.arpPlay = pbox.checked;
      if (this.arpPlay && !this.patch.arp) {
        this.patch.arp = { ...ARP_DEFAULT };
        this.ev.onArp(this.patch.arp);
      }
      this.ev.onArpPlay(this.arpPlay);
    };
    const pval = document.createElement('output');
    pval.textContent = 'Hold keys to play';
    play.append(pname, pval, pbox);
    box.append(play);
    choice('mode', 'mode', ARP_MODES);
    num('bpm', 'bpm', 40, () => 300);
    choice('rate', 'rate', ARP_RATES);
    num('steps', 'steps', 1, () => ARP_MAX_STEPS);
    num('pulses', 'pulses', 0, () => cfg().steps);
    num('rotation', 'rot', 0, () => Math.max(0, cfg().steps - 1));
    num('octaves', 'octaves', 1, () => 3);
    num('melody chaos', 'chaos', 0, () => 100, (v) => `${v} %`);
    num('velocity chaos', 'vchaos', 0, () => 100, (v) => `${v} %`);
    num('rhythm chaos', 'rchaos', 0, () => 100, (v) => `${v} %`);
    const foot = document.createElement('div');
    foot.className = 'hint';
    foot.textContent = this.patch.arp ? 'saved with the patch; sent to the FM-1 with it' : 'the FM-1 defaults: change a row to save the groove with the patch';
    box.append(foot);
    refresh();
    return box;
  }

  /** Keep physical parameter jacks available; depth and ranges live beside each destination. */
  private pins(m: ModuleInst, def: ModuleDef, open?: AssemblyInst): HTMLElement {
    const box = document.createElement('div');
    box.className = 'pins';
    for (const p of def.inputs) if (p.pin) box.append(this.port(m, p, 'in', { open }));
    return box;
  }

  /**
   * A port row. On a member card of an expanded assembly it gets the expose toggle; on an assembly card (`label`) the dot
   * still belongs to the inner module, so cables and drags work the same, and the label renames on click.
   */
  private port(m: ModuleInst, p: PortDef, dir: 'out' | 'in', o: { open?: AssemblyInst; label?: string; rename?: () => void; also?: Target[] } = {}): HTMLElement {
    const row = document.createElement('div');
    row.className = `port ${dir}`;
    const dot = document.createElement('span');
    dot.className = `dot ${p.kind}`;
    dot.dataset.mod = String(m.id);
    dot.dataset.port = p.name;
    dot.dataset.dir = dir;
    dot.title = o.label ? `${o.label}: ${DEFS[m.type].label} ${p.name} (${p.kind})` : `${p.name} (${p.kind})`;
    const label = document.createElement('span');
    label.textContent = o.label ?? p.name;
    if (o.rename) {
      label.classList.add('rename');
      label.title = 'click to rename';
      label.onclick = o.rename;
    }
    const parts: HTMLElement[] = dir === 'in' ? [dot, label] : [label, dot];
    if (o.open) {
      const a = o.open;
      const on = isExposed(a, dir, m.id, p.name);
      const ref = findRef(a, dir, m.id, p.name);
      const t = this.button(on ? '●' : '○', on ? `${ref!.label} is on the "${a.label}" card: click to hide it` : `show ${p.name} on the "${a.label}" card`, () =>
        this.change(() => (on ? hidePort(this.patch, a, dir, m.id, p.name) : exposePort(a, dir, m.id, p.name, o.also))),
      'tog');
      if (dir === 'in') parts.push(t, ...this.mergeTools(a, m, p, ref));
      else parts.unshift(t);
    }
    if (dir === 'out') {
      // a scope probe on this output
      const key = probeKey(m.id, p.name);
      const on = this.probes.has(key);
      const b = this.button('◎', on ? `remove the scope probe on ${p.name}` : `watch ${p.name} on the scope`, () => {
        const now = !this.probes.has(key);
        if (now) this.probes.add(key);
        else this.probes.delete(key);
        b.classList.toggle('on', now);
        b.title = now ? `remove the scope probe on ${p.name}` : `watch ${p.name} on the scope`;
        dot.classList.toggle('probed', now);
        this.ev.onProbe(key, m.id, p.name, p.kind, `${o.label ?? DEFS[m.type].label} ${p.name}`, now);
      }, 'prb');
      b.dataset.key = key;
      b.classList.toggle('on', on);
      dot.classList.toggle('probed', on);
      parts.unshift(b);
    }
    if (o.also?.length) dot.dataset.also = JSON.stringify(o.also);
    if (o.also?.length && !o.open) {
      const n = document.createElement('span');
      n.className = 'merged';
      n.textContent = `×${o.also.length + 1}`;
      n.title = `one jack for ${o.also.length + 1} inputs: ${[{ module: m.id, port: p.name }, ...o.also].map((t) => `${DEFS[this.patch.modules.find((x) => x.id === t.module)!.type].label} ${t.port}`).join(', ')}`;
      parts.splice(dir === 'in' ? 2 : 1, 0, n);
    }
    row.append(...parts);
    dot.addEventListener('pointerdown', (e) => this.beginDrag(e, dot));
    this.ports.set(this.key(m.id, p.name, dir), dot);
    return row;
  }

  /**
   * On an exposed input inside an expanded assembly: a "merge into…" list of the other exposed inputs of the same kind, a
   * badge with the count on a merged jack and a button to split it again.
   */
  private mergeTools(a: AssemblyInst, m: ModuleInst, p: PortDef, ref: PortRef | undefined): HTMLElement[] {
    if (!ref) return [];
    const out: HTMLElement[] = [];
    const me: Target = { module: m.id, port: p.name };
    const primary = ref.module === m.id && ref.port === p.name;
    if (ref.also?.length) {
      const n = document.createElement('span');
      n.className = 'merged';
      n.textContent = primary ? `×${ref.also.length + 1}` : `→ ${ref.label}`;
      n.title = primary ? `"${ref.label}" is one jack for ${ref.also.length + 1} inputs` : `fed by the "${ref.label}" jack`;
      out.push(n);
      if (primary) out.push(this.button('split', `Split "${ref.label}": one jack per input again`, () => this.change(() => unmergePort(a, m.id, p.name))));
    }
    const kindOf = (t: Target): string => DEFS[this.patch.modules.find((x) => x.id === t.module)!.type].inputs.find((q) => q.name === t.port)!.kind;
    const others = a.inputs.filter((r) => r !== ref && kindOf(r) === p.kind);
    if (!others.length) return out;
    const sel = document.createElement('select');
    sel.className = 'merge';
    sel.title = `Merge "${ref.label}" into another jack of the "${a.label}" card: one jack feeds both`;
    sel.setAttribute('aria-label', `merge ${ref.label} into`);
    sel.append(new Option('merge…', ''));
    for (const r of others) sel.append(new Option(r.label, `${r.module}:${r.port}`));
    sel.onchange = () => {
      const [mod, port] = sel.value.split(':');
      if (!mod) return;
      this.change(() => mergePorts(this.patch, a, DEFS, { module: Number(mod), port }, me));
    };
    sel.onpointerdown = (e) => e.stopPropagation();
    out.push(sel);
    return out;
  }

  // ---- assemblies on the canvas

  private rename(a: AssemblyInst): void {
    const v = window.prompt('Label of this assembly', a.label)?.trim();
    if (v && v !== a.label) this.change(() => (a.label = v));
  }

  private saveAssembly(a: AssemblyInst): void {
    const name = window.prompt('Save the assembly to the library as', a.name)?.trim();
    if (!name) return;
    if (name !== a.name) this.change(() => (a.name = name));
    this.ev.onSaveAssembly(toDef(this.patch, a));
  }

  private assemblyButtons(a: AssemblyInst): HTMLElement[] {
    const pw = this.button('⏻', `${a.label} on / off (bypass every module inside)`, () => {
      this.history.push(JSON.stringify(this.patch));
      if (this.history.length > HISTORY) this.history.shift();
      this.future = [];
      const changed = bypassAssembly(this.patch, a, !a.bypass);
      for (const id of changed) this.ev.onBypass(id, !!this.patch.modules.find((m) => m.id === id)?.bypass);
      this.rebuild();
      this.ev.onLayout(this.patch);
    }, 'pw');
    pw.classList.toggle('on', !a.bypass);
    pw.setAttribute('aria-pressed', String(!a.bypass));
    return [
      pw,
      this.button(a.open ? 'collapse' : 'expand', a.open ? 'Collapse to one card' : 'Expand: show and edit the modules inside', () =>
        this.change(() => {
          a.open = !a.open;
          if (a.open && overlapping(this.patch, a)) tileMembers(this.patch, a); // stacked cards (an old file, members added at one spot) spread out
        }),
      ),
      this.button('save', 'Save to the assembly library', () => this.saveAssembly(a)),
      this.button('ungroup', 'Dissolve: the modules stay as plain modules', () => this.change(() => ungroup(this.patch, a.id))),
      this.button('×', `Remove "${a.label}" with its modules`, () => this.change(() => deleteAssembly(this.patch, a.id)), 'x'),
    ];
  }

  private titleOf(a: AssemblyInst, perVoice: boolean): HTMLElement {
    const title = document.createElement('span');
    title.className = 'rename';
    title.textContent = a.label;
    title.title = `${a.name}: double-click to rename`;
    title.ondblclick = () => this.rename(a);
    if (perVoice) title.append(' ', this.badge());
    return title;
  }

  /**
   * The collapsed assembly: one card with the exposed ports and the promoted parameters. Inside an expanded parent (`open`)
   * its rows get the parent's expose / pin toggles, like a member card's.
   */
  private container(a: AssemblyInst, perVoice: boolean, open?: AssemblyInst): HTMLElement {
    const el = document.createElement('div');
    el.className = 'module assembly' + (open ? ' member' : '') + (a.bypass ? ' off' : '');
    el.style.left = `${a.x}px`;
    el.style.top = `${a.y}px`;
    el.dataset.asm = String(a.id);
    this.containers.set(a.id, el);
    const head = document.createElement('div');
    head.className = 'mhead';
    const tools = document.createElement('span');
    tools.className = 'tools';
    tools.append(...this.assemblyButtons(a));
    head.append(this.titleOf(a, perVoice), tools);
    this.assemblyDrag(el, head, a);

    const body = document.createElement('div');
    body.className = 'mbody';
    const mod = (id: number): ModuleInst => this.patch.modules.find((m) => m.id === id)!;
    const ins = document.createElement('div');
    ins.className = 'ports in';
    for (const r of a.inputs) {
      const m = mod(r.module);
      const pd = DEFS[m.type].inputs.find((q) => q.name === r.port)!;
      ins.append(this.port(m, pd, 'in', { label: r.label, rename: () => this.renameRef(r, 'input'), also: r.also, open }));
    }
    const outs = document.createElement('div');
    outs.className = 'ports out';
    for (const r of a.outputs) {
      const m = mod(r.module);
      const pd = DEFS[m.type].outputs.find((q) => q.name === r.port)!;
      outs.append(this.port(m, pd, 'out', { label: r.label, rename: () => this.renameRef(r, 'output'), open }));
    }
    const io = document.createElement('div');
    io.className = 'io';
    io.append(ins, outs);
    body.append(io);
    if (a.params.length) {
      const params = document.createElement('div');
      params.className = 'params';
      for (const r of a.params) {
        const m = mod(r.module);
        const def = DEFS[m.type];
        params.append(this.paramRow(m, def, def.params.find((q) => q.name === r.param)!, { label: r.label, rename: () => this.renameRef(r, 'parameter'), open }));
      }
      body.append(params);
    }
    if (!a.inputs.length && !a.outputs.length && !a.params.length) {
      const hint = document.createElement('p');
      hint.className = 'muted empty';
      hint.textContent = 'nothing exposed: open it and mark ports and parameters';
      body.append(hint);
    }
    el.append(head, body);
    return el;
  }

  private renameRef(r: { label: string }, what: string): void {
    const v = window.prompt(`Label of this ${what}`, r.label)?.trim();
    if (v && v !== r.label) this.change(() => (r.label = v));
  }

  /** the frame around an expanded assembly's cards, with its header; placed by layoutFrames() once the cards have a size */
  private frame(a: AssemblyInst, perVoice: boolean): HTMLElement {
    const el = document.createElement('div');
    el.className = 'frame' + (a.bypass ? ' off' : '');
    el.dataset.asm = String(a.id);
    const head = document.createElement('div');
    head.className = 'fhead';
    const tools = document.createElement('span');
    tools.className = 'tools';
    tools.append(...this.assemblyButtons(a));
    head.append(this.titleOf(a, perVoice), tools);
    el.append(head);
    this.frames.set(a.id, el);
    this.frameDrag(head, a);
    this.resizeAssembly(el, a);
    return el;
  }

  /**
   * The box around what an expanded assembly shows: its member cards, its children's cards (collapsed) or frames (expanded), in
   * canvas coordinates; `exclude` leaves cards out and `excludeAsm` children (while they are dragged)
   */
  private frameRect(a: AssemblyInst, exclude?: Set<number>, excludeAsm?: number): Rect | null {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    const take = (r: Rect): void => {
      x0 = Math.min(x0, r.x);
      y0 = Math.min(y0, r.y);
      x1 = Math.max(x1, r.x + r.w);
      y1 = Math.max(y1, r.y + r.h);
    };
    const box = (c: HTMLElement): Rect => ({ x: c.offsetLeft, y: c.offsetTop, w: c.offsetWidth, h: c.offsetHeight });
    for (const id of a.modules) {
      if (exclude?.has(id)) continue;
      const c = this.cards.get(id);
      if (c) take(box(c));
    }
    for (const ch of childrenOf(this.patch, a)) {
      if (ch.id === excludeAsm) continue;
      const c = this.containers.get(ch.id);
      if (c) take(box(c));
      else if (ch.open) {
        const r = this.frameRect(ch, exclude, excludeAsm);
        if (r) take(r);
      }
    }
    if (x0 === Infinity) return null;
    return { x: x0 - FRAME_PAD, y: y0 - FRAME_PAD - FRAME_HEAD, w: Math.max(x1 - x0 + 2 * FRAME_PAD, a.frameSize?.width ?? 0), h: Math.max(y1 - y0 + 2 * FRAME_PAD + FRAME_HEAD, a.frameSize?.height ?? 0) };
  }

  private layoutFrames(exclude?: Set<number>, excludeAsm?: number): void {
    for (const a of assembliesOf(this.patch)) {
      const el = this.frames.get(a.id);
      if (!el) continue;
      const r = this.frameRect(a, exclude, excludeAsm) ?? this.frameRect(a);
      if (!r) continue;
      el.style.left = `${Math.max(0, r.x)}px`;
      el.style.top = `${Math.max(0, r.y)}px`;
      el.style.width = `${r.w}px`;
      el.style.height = `${r.h}px`;
    }
  }

  // ---- dragging and selection

  /** pointer drag on a handle: `move` gets the delta since the previous event, `up` runs at the end */
  private dragOn(handle: HTMLElement, start: (e: PointerEvent) => boolean, move: (dx: number, dy: number) => void, up: () => void): void {
    handle.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('button')) return;
      if (!start(e)) return;
      e.preventDefault();
      let lx = e.clientX;
      let ly = e.clientY;
      // a long press (touch, no movement) opens the context menu instead of dragging
      const card = handle.closest('.module') as HTMLElement | null;
      const sx = e.clientX, sy = e.clientY;
      let press = 0;
      if (e.pointerType === 'touch' && card?.dataset.id) {
        press = window.setTimeout(() => {
          press = 0;
          onUp();
          const m = this.patch.modules.find((x) => x.id === Number(card.dataset.id));
          if (m) this.contextMenu(m, DEFS[m.type], { x: m.x + 20, y: m.y + 30 });
        }, 500);
      }
      const onMove = (ev: PointerEvent): void => {
        if (press && Math.hypot(ev.clientX - sx, ev.clientY - sy) > 8) {
          clearTimeout(press);
          press = 0;
        }
        move((ev.clientX - lx) / this.zoom, (ev.clientY - ly) / this.zoom);
        lx = ev.clientX;
        ly = ev.clientY;
      };
      const onUp = (): void => {
        if (press) clearTimeout(press);
        press = 0;
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        up();
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    });
  }

  private place(m: ModuleInst, dx: number, dy: number): void {
    m.x = Math.max(0, m.x + dx);
    m.y = Math.max(0, m.y + dy);
    const el = this.cards.get(m.id);
    if (el) {
      el.style.left = `${m.x}px`;
      el.style.top = `${m.y}px`;
    }
  }

  private moduleDrag(handle: HTMLElement, m: ModuleInst): void {
    let group: ModuleInst[] = [];
    this.dragOn(
      handle,
      (e) => {
        if (e.shiftKey) {
          this.toggleSelect(m.id);
          return false;
        }
        if (!this.selected.has(m.id)) this.select([m.id]);
        group = this.patch.modules.filter((x) => this.selected.has(x.id));
        return true;
      },
      (dx, dy) => {
        for (const x of group) this.place(x, dx, dy);
        this.layoutFrames(new Set(group.map((x) => x.id)));
        this.drawCables();
      },
      () => {
        this.sizeCanvas();
        this.ev.onLayout(this.patch);
        this.membership(group);
      },
    );
  }

  /** after a drag: cards dropped into an expanded assembly's frame join it, members dragged out of theirs leave it */
  private membership(moved: ModuleInst[]): void {
    const movedIds = new Set(moved.map((m) => m.id));
    const inside = (c: HTMLElement, r: Rect): boolean => {
      const cx = c.offsetLeft + c.offsetWidth / 2;
      const cy = c.offsetTop + HEAD_Y;
      return cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h;
    };
    const ops: (() => void)[] = [];
    for (const m of moved) {
      const c = this.cards.get(m.id)!;
      const mine = assemblyOf(this.patch, m.id);
      if (mine) {
        if (!mine.open) continue;
        const r = this.frameRect(mine, movedIds);
        if (r && !inside(c, r)) ops.push(() => removeMember(this.patch, mine, m.id));
      } else {
        let target: AssemblyInst | undefined;
        for (const a of assembliesOf(this.patch)) {
          if (!a.open || !this.frames.has(a.id)) continue;
          const r = this.frameRect(a, movedIds);
          if (r && inside(c, r) && (!target || depthOf(this.patch, a) > depthOf(this.patch, target))) target = a;
        }
        if (target) ops.push(() => addMember(this.patch, target!, m.id));
      }
    }
    if (!ops.length) {
      this.layoutFrames();
      return;
    }
    const keep = [...this.selected];
    if (this.change(() => ops.forEach((op) => op()))) this.select(keep);
  }

  /** move an assembly with everything inside it, model and elements */
  private moveTree(a: AssemblyInst, dx: number, dy: number): void {
    moveAssembly(this.patch, a, dx, dy);
    const asms = [a, ...descendants(this.patch, a)];
    const ids = new Set(asms.flatMap((x) => x.modules));
    for (const m of this.patch.modules) {
      const el = this.cards.get(m.id);
      if (!ids.has(m.id) || !el) continue;
      el.style.left = `${m.x}px`;
      el.style.top = `${m.y}px`;
    }
    for (const x of asms) {
      const el = this.containers.get(x.id);
      if (!el) continue;
      el.style.left = `${x.x}px`;
      el.style.top = `${x.y}px`;
    }
    this.layoutFrames(undefined, a.id);
    this.drawCables();
  }

  private assemblyDrag(el: HTMLElement, handle: HTMLElement, a: AssemblyInst): void {
    this.dragOn(
      handle,
      () => true,
      (dx, dy) => this.moveTree(a, dx, dy),
      () => {
        this.sizeCanvas();
        this.ev.onLayout(this.patch);
        this.nesting(a, el);
      },
    );
  }

  /** after a container drag: dropped into an expanded frame it becomes a child of that assembly; dragged out of its parent's frame it leaves */
  private nesting(a: AssemblyInst, el: HTMLElement): void {
    const cx = el.offsetLeft + el.offsetWidth / 2;
    const cy = el.offsetTop + HEAD_Y; // where the hand is: the card's header, not its middle (cards are tall)
    const inside = (r: Rect): boolean => cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h;
    const parent = parentOf(this.patch, a.id);
    const below = new Set(descendants(this.patch, a).map((d) => d.id));
    // the innermost expanded frame under the card that is not the assembly itself or one of its own
    let target: AssemblyInst | undefined;
    for (const b of assembliesOf(this.patch)) {
      if (!b.open || b.id === a.id || below.has(b.id) || !this.frames.has(b.id)) continue;
      const r = this.frameRect(b, undefined, a.id);
      if (r && inside(r) && (!target || depthOf(this.patch, b) > depthOf(this.patch, target))) target = b;
    }
    if (target && target !== parent) this.change(() => addChild(this.patch, target!, a.id));
    else if (!target && parent) this.change(() => removeChild(this.patch, parent, a.id));
    else this.layoutFrames();
  }

  private frameDrag(handle: HTMLElement, a: AssemblyInst): void {
    this.dragOn(
      handle,
      () => true,
      (dx, dy) => this.moveTree(a, dx, dy),
      () => {
        this.sizeCanvas();
        this.ev.onLayout(this.patch);
      },
    );
  }

  private select(ids: number[]): void {
    this.selected.clear();
    for (const id of ids) this.selected.add(id);
    this.showSelection();
  }

  private toggleSelect(id: number): void {
    if (this.selected.has(id)) this.selected.delete(id);
    else this.selected.add(id);
    this.showSelection();
  }

  private showSelection(): void {
    for (const [id, el] of this.cards) el.classList.toggle('selected', this.selected.has(id));
  }

  /** a drag on empty canvas selects the cards it touches; a click on empty canvas clears the selection */
  private rubberBand(e: PointerEvent): void {
    const t = e.target as HTMLElement;
    if (e.button !== 0 || t.closest('.module, .fhead, .dot, button, input, select, .ctx')) return;
    e.preventDefault();
    if (e.pointerType === 'touch') {
      // one finger on the empty canvas pans it (a rubber band needs a mouse or shift)
      let lx = e.clientX, ly = e.clientY;
      const pan = (ev: PointerEvent): void => {
        if (ev.pointerId !== e.pointerId) return;
        this.canvas.scrollBy(lx - ev.clientX, ly - ev.clientY);
        lx = ev.clientX;
        ly = ev.clientY;
      };
      const stop = (): void => {
        window.removeEventListener('pointermove', pan);
        window.removeEventListener('pointerup', stop);
        window.removeEventListener('pointercancel', stop);
      };
      window.addEventListener('pointermove', pan);
      window.addEventListener('pointerup', stop);
      window.addEventListener('pointercancel', stop);
      return;
    }
    const base = this.canvas.getBoundingClientRect();
    const at = (ev: PointerEvent): Pt => ({ x: (ev.clientX - base.left) / this.zoom + this.canvas.scrollLeft / this.zoom, y: (ev.clientY - base.top) / this.zoom + this.canvas.scrollTop / this.zoom });
    const o = at(e);
    const box = document.createElement('div');
    box.className = 'rubber';
    this.modulesEl.append(box);
    let r: Rect = { x: o.x, y: o.y, w: 0, h: 0 };
    const move = (ev: PointerEvent): void => {
      const p = at(ev);
      r = { x: Math.min(o.x, p.x), y: Math.min(o.y, p.y), w: Math.abs(p.x - o.x), h: Math.abs(p.y - o.y) };
      Object.assign(box.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
    };
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      box.remove();
      const hit: number[] = [];
      if (r.w > 4 || r.h > 4)
        for (const [id, c] of this.cards) {
          const cx = c.offsetLeft;
          const cy = c.offsetTop;
          if (cx < r.x + r.w && cx + c.offsetWidth > r.x && cy < r.y + r.h && cy + c.offsetHeight > r.y) hit.push(id);
        }
      if (e.shiftKey) hit.forEach((id) => this.selected.add(id));
      else this.select(hit);
      this.showSelection();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  // ---- cables

  private center(el: HTMLElement, origin = this.world): Pt {
    const r = el.getBoundingClientRect();
    const c = origin.getBoundingClientRect();
    return { x: (r.left - c.left + r.width / 2) / this.zoom - origin.clientLeft, y: (r.top - c.top + r.height / 2) / this.zoom - origin.clientTop };
  }

  private curve(a: Pt, b: Pt): string {
    const dx = Math.max(40, Math.abs(b.x - a.x) / 2);
    return `M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`;
  }

  /** Cable paths are retained so animation only moves their endpoints. */
  private positionCables(): void {
    for (const { path, from, to, origin } of this.cablePaths) path.setAttribute('d', this.curve(this.center(from, origin), this.center(to, origin)));
  }

  private inputJack(to: Endpoint): HTMLElement | undefined {
    return this.ports.get(this.key(to.module, to.port, 'in')) ?? [...this.ports.values()].find((dot) =>
      dot.dataset.also && (JSON.parse(dot.dataset.also) as Target[]).some((t) => sameEnd(t, to)));
  }

  /** Outside cables end at side jacks; internal branches are editable input-to-parameter routes. */
  drawCables(): void {
    for (const { path } of this.cablePaths) path.remove();
    this.cablePaths = [];
    for (const svg of this.modulesEl.querySelectorAll('.internal-cables')) svg.remove();
    const internalLayers = new Map<HTMLElement, SVGSVGElement>();
    for (const dot of [...this.ports.values(), ...this.sliderPorts.map((p) => p.jack)]) dot.classList.remove('connected');
    const add = (from: HTMLElement, to: HTMLElement, kind: string, remove: () => void, title: string, internal = false): void => {
      const path = document.createElementNS(SVGNS, 'path');
      path.setAttribute('class', `cable ${kind}${internal ? ' alias' : ''}`);
      path.setAttribute('role', 'button');
      path.setAttribute('tabindex', '0');
      path.setAttribute('aria-label', title);
      path.addEventListener('pointerdown', (e) => e.stopPropagation());
      path.addEventListener('click', (e) => { e.stopPropagation(); remove(); });
      path.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); remove(); }
      });
      const hint = document.createElementNS(SVGNS, 'title'); hint.textContent = title; path.append(hint);
      let layer = this.svg;
      let origin = this.world;
      if (internal) {
        const card = to.closest<HTMLElement>('.module');
        if (card && from.closest('.module') === card) {
          origin = card;
          let local = internalLayers.get(card);
          if (!local) {
            local = document.createElementNS(SVGNS, 'svg');
            local.setAttribute('class', 'cables internal-cables');
            card.append(local); internalLayers.set(card, local);
          }
          layer = local;
        }
      }
      layer.prepend(path);
      this.cablePaths.push({ path, from, to, origin });
    };
    // Show the assignment even without an upstream cable, so it can be edited before patching a source.
    for (const { m, pd, jack } of this.sliderPorts) for (const port of parameterInputs(m, pd)) {
      const side = this.inputJack({ module: m.id, port });
      if (!side) continue;
      add(side, jack, 'control', () => this.change(() => {
        setInputRoute(m, DEFS[m.type], port, pd.name, false);
      }), `Disconnect ${DEFS[m.type].label} ${port} → ${pd.name}`, true);
    }
    const physicalCables = new Set<string>();
    for (const c of this.patch.cables) {
      const a = this.ports.get(this.key(c.from.module, c.from.port, 'out'));
      const b = this.inputJack(c.to);
      const thumbs = this.sliderPorts.filter(({ m, pd }) => m.id === c.to.module && parameterInputs(m, pd).includes(c.to.port));
      a?.classList.add('connected'); b?.classList.add('connected');
      for (const { jack } of thumbs) jack.classList.add('connected');
      if (!a) continue;
      const kind = DEFS[this.patch.modules.find((m) => m.id === c.from.module)!.type].outputs.find((o) => o.name === c.from.port)!.kind;
      if (b) {
        const key = `${c.from.module}:${c.from.port}:${b.dataset.mod}:${b.dataset.port}`;
        if (!physicalCables.has(key)) add(a, b, kind, () => this.removeCable(c), 'Disconnect cable');
        physicalCables.add(key);
      } else for (const { jack } of thumbs) add(a, jack, kind, () => this.removeCable(c), 'Disconnect cable');
    }
    this.positionCables();
  }

  /** remove a cable; one drawn to a merged jack whose other inputs are hidden takes their cables (from the same output) with it */
  private removeCable(c: Cable): void {
    const hidden = hiddenModules(this.patch);
    const more: Endpoint[] = [];
    for (const a of assembliesOf(this.patch)) {
      const ref = findRef(a, 'in', c.to.module, c.to.port);
      if (!ref?.also?.length) continue;
      for (const t of targetsOf(ref)) if (hidden.has(t.module) && !sameEnd(t, c.to) && !more.some((x) => sameEnd(x, t))) more.push(t);
    }
    this.change(() => {
      disconnect(this.patch, c);
      for (const t of more) disconnect(this.patch, { from: c.from, to: t });
    });
  }

  private internalPair(a: HTMLElement, b: HTMLElement): [HTMLElement, HTMLElement] | null {
    if (a.dataset.dir !== 'in' || b.dataset.dir !== 'in' || !!a.dataset.param === !!b.dataset.param) return null;
    return a.dataset.param ? [b, a] : [a, b]; // side jack, parameter thumb
  }

  private connectJacks(a: HTMLElement, b: HTMLElement): void {
    const internal = this.internalPair(a, b);
    if (internal) {
      const [side, thumb] = internal;
      this.change(() => {
        const m = this.patch.modules.find((m) => m.id === Number(thumb.dataset.mod))!;
        const pd = DEFS[m.type].params.find((pd) => pd.name === thumb.dataset.param)!;
        const targets: Target[] = [{ module: Number(side.dataset.mod), port: side.dataset.port! },
          ...(side.dataset.also ? JSON.parse(side.dataset.also) as Target[] : [])];
        const target = targets.find((t) => t.module === m.id);
        if (!target) throw new Error('Use a side input belonging to this parameter’s module.');
        setInputRoute(m, DEFS[m.type], target.port, pd.name, true);
      });
      return;
    }
    if (a.dataset.dir === b.dataset.dir) return this.ev.onError('connect an output to an input');
    const [out, input] = a.dataset.dir === 'out' ? [a, b] : [b, a];
    const from = { module: Number(out.dataset.mod), port: out.dataset.port! };
    this.change(() => {
      let to: Endpoint;
      if (input.dataset.param) {
        to = connectParameter(this.patch, DEFS, from, Number(input.dataset.mod), input.dataset.param);
      } else {
        to = { module: Number(input.dataset.mod), port: input.dataset.port! };
        if (!this.patch.cables.some((c) => sameEnd(c.from, from) && sameEnd(c.to, to)) && !connect(this.patch, DEFS, from, to))
          throw new Error('cannot connect these ports');
      }
      // A thumb alias of a merged assembly jack feeds the same group of inputs.
      const physical = this.inputJack(to);
      const also = input.dataset.also ?? physical?.dataset.also;
      if (also) {
        if (physical) connect(this.patch, DEFS, from, { module: Number(physical.dataset.mod), port: physical.dataset.port! });
        for (const target of JSON.parse(also) as Target[]) connect(this.patch, DEFS, from, target);
      }
    });
  }

  private beginDrag(e: PointerEvent, start: HTMLElement): void {
    e.preventDefault();
    e.stopPropagation();
    const armed = this.armed;
    this.cancelArm();
    if (armed && (armed.dataset.dir !== start.dataset.dir || this.internalPair(armed, start))) {
      this.connectJacks(armed, start);
      return;
    }
    const kind = start.dataset.dir;
    const path = document.createElementNS(SVGNS, 'path');
    path.setAttribute('class', 'cable pending');
    this.preview.append(path);
    this.canvas.classList.add('patching');
    const move = (ev: PointerEvent): void => {
      const c = this.world.getBoundingClientRect();
      const p = { x: (ev.clientX - c.left) / this.zoom, y: (ev.clientY - c.top) / this.zoom };
      const s = this.center(start);
      path.setAttribute('d', kind === 'out' ? this.curve(s, p) : this.curve(p, s));
    };
    const cancel = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      path.remove();
      this.drag = null;
      this.canvas.classList.remove('patching');
    };
    const up = (ev: PointerEvent): void => {
      const t = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
      const dot = t?.closest('.dot') as HTMLElement | null;
      cancel();
      if (dot === start) {
        this.armed = start;
        start.classList.add('armed');
        this.canvas.classList.add('patching');
      } else if (dot?.dataset.mod) this.connectJacks(start, dot);
    };
    this.drag = { path, cancel };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    move(e);
  }
}
