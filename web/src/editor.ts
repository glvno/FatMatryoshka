// SPDX-License-Identifier: GPL-3.0-only
// Patch editor: module cards on a canvas, SVG cables, drag-to-connect, a selection, assemblies and undo.
import { resizeHandle } from './resize-handle';
import { tidy, tidyAssembly } from './tidy';
import { DEFS } from './modules';
import { parameterInputs, connectParameter, setInputRoute } from './parameter-routing';
import { parameterMenu } from './parameter-menu';
import { sliderJack } from './slider-jack';
import { isKnob, knobRests } from './knob-rest';
import type { ParameterValues } from './engine';
import { deviceBudget, DEVICE } from './patchbin';
import { choiceName, formatValue, longName, moduleName, moduleTag } from './labels';
import { picker } from './picker';
import { copiesOf, makeRoom, polyOfModule, setPoly } from './poly';
import { ASSIGN_MODES, LEGATO_MODES, PRIORITIES } from './modules';
import { dragControl } from './deck';
import { isPin, PinsInUse, removeRoute } from './parameter-routing';
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
  type SideKey,
  type ModuleDef,
  type ModuleInst,
  type Patch,
  type PortDef,
  type ParamDef,
  EDITOR_MAX_PARTS,
  MAX_UNIT,
  type PolyCfg,
  sameStructure,
  setMorphTarget,
  clearMorph,
  hasMorph,
  ensureMain,
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
/** a poly assembly's frame: the settings strip under the header, and the width it needs */
const POLY_STRIP = 50;
const POLY_MIN_W = 640;

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
  /** undo or redo happened (the tutorial counts them) */
  onHistory?(kind: 'undo' | 'redo'): void;
  /** the patches the morph picker on the Main card offers as the B side (those of the same structure are listed) */
  morphCandidates?(): { name: string; patch: Patch }[];
}

/** an SVG path through a cubic Bézier's four points */
/** how a cable leaves a jack: sideways, up (a docked jack) or down (a jack under a card's bottom edge) */
type CableEnd = 'side' | 'up' | 'down';
/** the straight run of a cable out of its jack at full slack, px */
const CABLE_STUB = 20;
/** the zoom's range (the wheel, pinch, fit and the sidebar's zoom slider) */
export const ZOOM_MIN = 0.3;
export const ZOOM_MAX = 2;
/** a chain of cubic Béziers: a start point, then three points per segment */
const pathOf = ([a, ...rest]: { x: number; y: number }[]): string => {
  let d = `M${a.x},${a.y}`;
  for (let i = 0; i + 2 < rest.length; i += 3) d += ` C${rest[i].x},${rest[i].y} ${rest[i + 1].x},${rest[i + 1].y} ${rest[i + 2].x},${rest[i + 2].y}`;
  return d;
};

/** how far (px) beyond the jack's sides the strip a docked cable is drawn in over the panel reaches: none, so a cable
 * that bends away (to a module below the canvas's view) shows only its straight stub above the jack */
const CLIP_HALF = 0;
const SCOPE_HINT = '\nShift-click: show on the scope';

/** the key of a scope probe on an output */
export const probeKey = (id: number, port: string): string => `${id}:${port}`;
type Pt = { x: number; y: number };
/** the footprint of a new card for the free-spot search: a grid cell less its gutters */
const CARD_W = 300;
const CARD_H = 540;
/** jacks on each side edge of a card; the rest hang off its bottom edge */
const EDGE_JACKS = 4;
/** an input for a card's edge layout: its row element and which port it is (a parameter's dedicated input joins its row) */
type EdgePort = { el: HTMLElement; module: number; port: string };
/** an entry of a card's menu: `key` is the shortcut shown at the right, `rule` a line above it */
type MenuItem = { text: string; run: () => void; key?: string; danger?: boolean; rule?: boolean };
/** a drop is judged by the card's header (where it is held), this far below its top */
const HEAD_Y = 15;

export class Editor {
  patch: Patch;
  /** the selected modules (shift-click or a rubber band); "Make assembly" groups them, dragging one moves all */
  readonly selected = new Set<number>();
  /** the selected assemblies (collapsed cards and expanded frames): they move, duplicate and delete with the modules */
  readonly selectedAsm = new Set<number>();
  /** assemblies expanded in this session: the first expansion tidies the inside (#37) */
  private expandedOnce = new Set<number>();
  /** how far cables sag, 0 (taut, the default) .. 1: the sidebar's setting */
  slack = 0;
  /** the sidebar sliders whose thumbs are jacks (cable slack, zoom): Patch.slackFrom / zoomFrom; set by the host */
  readonly sideThumbs = new Map<SideKey, HTMLElement>();
  /** the cables from their sources to those thumbs: in their own layer over the whole window, so they cross the sidebar */
  private sideLayer: SVGSVGElement | null = null;
  /** the patch's slack source (Patch.slackFrom) as it plays: added to `slack` */
  private slackMod = 0;
  private slackFrame = 0;
  /** the sag the cables are drawn with: the setting plus the source's signal, 0 .. 1.5 */
  private get sway(): number {
    return Math.min(1.5, Math.max(0, this.slack + this.slackMod));
  }
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
  private sliderPorts: { m: ModuleInst; pd: ParamDef; jack: HTMLElement; ticks: (t: { knob: string; unit: number }[]) => void }[] = [];
  private cablePaths: { path: SVGPathElement; from: HTMLElement; to: HTMLElement; origin: HTMLElement; cable?: Cable }[] = [];
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

  /**
   * `dock`: where the Main module lives (the panel above the keyboard) instead of a card. Every patch has one Main there;
   * it cannot be removed. Cables from its jacks run off the bottom of the canvas to the panel.
   */
  constructor(private canvas: HTMLElement, patch: Patch, private ev: EditorEvents, private dock: HTMLElement | null = null) {
    this.patch = patch;
    if (dock) ensureMain(this.patch, DEFS);
    this.modulesEl = canvas.querySelector('#modules')!;
    this.svg = canvas.querySelector('#cables')! as unknown as SVGSVGElement;
    this.preview = canvas.querySelector('#patch-preview')! as unknown as SVGSVGElement;
    this.world = canvas.querySelector('#patch-world')!;
    this.space = canvas.querySelector('#canvas-space')!;
    this.report(fixAssemblies(this.patch, DEFS));
    new ResizeObserver(() => { this.sizeCanvas(); this.positionCables(); }).observe(canvas);
    if (dock) {
      // the docked jacks stay put while the canvas scrolls under them
      canvas.addEventListener('scroll', () => this.positionCables(), { passive: true });
      dock.addEventListener('scroll', () => this.positionCables(), { passive: true, capture: true });
      new ResizeObserver(() => this.positionCables()).observe(dock);
    }
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
    if (this.dock) ensureMain(this.patch, DEFS);
    this.report(fixAssemblies(this.patch, DEFS));
    this.history = [];
    this.future = [];
    this.routingOpen.clear();
    this.stack = [];
    this.selected.clear();
    this.selectedAsm.clear();
    this.expandedOnce.clear();
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
    const set = this.dragSet();
    if (!set.mods.length && !set.asms.length) return this.ev.onError('select the modules first: shift-click them, or drag a box on the canvas');
    // a patch's own modules never go into a building block: they stay outside, the rest is grouped
    const ids = set.mods.filter((m) => !EXCLUDED_TYPES.has(m.type)).map((m) => m.id);
    if (!ids.length) return this.ev.onError(set.asms.length ? 'select at least one module with the assemblies: they go inside the new one' : 'the Main panel and the Output stay outside an assembly: select other modules');
    const name = window.prompt('Name of the assembly', 'assembly')?.trim();
    if (!name) return;
    const kept = ids.length < set.mods.length;
    // selected assemblies become children of the new one
    if (this.change(() => {
      const made = makeAssembly(this.patch, ids, name);
      for (const a of set.asms) addChild(this.patch, made, a.id);
    })) {
      this.selected.clear();
      this.selectedAsm.clear();
      if (kept) this.ev.onError('Main and Output stay outside');
    }
  }

  // ---- undo

  undo(): void {
    const s = this.history.pop();
    if (s === undefined) return this.ev.onError('nothing to undo');
    this.future.push(JSON.stringify(this.patch));
    this.restore(s);
    this.ev.onHistory?.('undo');
  }

  redo(): void {
    const s = this.future.pop();
    if (s === undefined) return this.ev.onError('nothing to redo');
    this.history.push(JSON.stringify(this.patch));
    this.restore(s);
    this.ev.onHistory?.('redo');
  }

  /** a structural change from outside (the tutorial's "do it for me"): undoable like the editor's own */
  transact(fn: () => unknown): boolean {
    return this.change(fn);
  }

  /** select a module where it shows: itself, or the outermost collapsed assembly that hides it */
  reveal(id: number): void {
    let hidden: AssemblyInst | undefined;
    for (let a = assemblyOf(this.patch, id); a; a = parentOf(this.patch, a.id)) if (!a.open) hidden = a;
    if (!hidden) return this.selectOnly([id]);
    this.selected.clear();
    this.selectedAsm.clear();
    this.selectedAsm.add(hidden.id);
    this.rebuild();
  }

  /** select exactly these modules */
  selectOnly(ids: number[]): void {
    this.selected.clear();
    this.selectedAsm.clear();
    for (const id of ids) this.selected.add(id);
    this.rebuild();
  }

  private restore(s: string): void {
    this.patch = JSON.parse(s) as Patch;
    this.selected.clear();
    this.selectedAsm.clear();
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
      if (e instanceof PinsInUse) this.flash(e.cables);
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
    const copies = copiesOf(this.patch);
    const hidden = hiddenModules(this.patch);
    const hiddenAsm = hiddenAssemblies(this.patch);
    if (this.pickAsm !== null && !assembliesOf(this.patch).some((a) => a.id === this.pickAsm && a.open && !hiddenAsm.has(a.id))) this.pickAsm = null;
    // an assembly's badge: the part count of the poly assembly it is (or is inside), else none
    const perVoice = (a: AssemblyInst): number => {
      const first = allModules(this.patch, a)[0];
      const root = first === undefined ? undefined : polyOfModule(this.patch, first);
      return root ? root.poly!.parts : 0;
    };
    for (const id of this.selected) if (!this.patch.modules.some((m) => m.id === id) || hidden.has(id)) this.selected.delete(id);
    for (const id of this.selectedAsm) if (!assembliesOf(this.patch).some((a) => a.id === id) || hiddenAsm.has(id)) this.selectedAsm.delete(id);
    // frames of the outer assemblies first: a nested frame is drawn on top of its parent's
    const visible = assembliesOf(this.patch).filter((a) => !hiddenAsm.has(a.id));
    for (const a of [...visible].sort((u, v) => depthOf(this.patch, u) - depthOf(this.patch, v))) if (a.open) this.modulesEl.append(this.frame(a, perVoice(a)));
    const docked = this.docked();
    this.wheelHost?.replaceChildren();
    this.dock?.replaceChildren(...(docked ? [this.dockPanel(docked)] : []));
    for (const m of this.patch.modules) {
      if (hidden.has(m.id) || m === docked) continue;
      const a = assemblyOf(this.patch, m.id);
      this.modulesEl.append(this.card(m, DEFS[m.type], copies.get(m.id) ?? 0, a));
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

  /** ×N on a card or assembly that runs once per part of its poly assembly */
  private badge(n: number): HTMLElement {
    const badge = document.createElement('span');
    badge.className = 'voices';
    badge.textContent = `×${n}`;
    badge.title = `runs once per part (${n} parts)`;
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
  /** the Main module shown in the dock (the first one; a second Main, from an old patch, stays a card) */
  private dockArpOpen = false;
  /** the deck's bend and modulation wheels, placed in the dock under Main's jacks (set by the host, then rebuild) */
  dockWheels: { bend: HTMLElement; mod: HTMLElement } | null = null;
  /** the column beside the keyboard, as tall as the dock and the keyboard together, that holds the wheels (set by the host) */
  wheelHost: HTMLElement | null = null;
  /** the keyboard's octave buttons, shown under Main's output strip (set by the host, then rebuild) */
  dockOctave: HTMLElement | null = null;
  /** the FM-1 budget meter, shown in its own column right of the arpeggiator (set by the host, then rebuild) */
  dockBudget: HTMLElement | null = null;

  private docked(): ModuleInst | undefined {
    return this.dock ? this.patch.modules.find((m) => m.type === 'fm1') : undefined;
  }

  /**
   * The Main module as the panel above the keyboard: its jacks along the top edge (towards the canvas), the knobs
   * K1..K4 with their outputs' jacks in the middle (in place of their sliders and output rows), then its settings.
   */
  private dockPanel(m: ModuleInst): HTMLElement {
    const def = DEFS[m.type];
    const el = document.createElement('div');
    el.className = 'dock-main';
    el.dataset.id = String(m.id);
    const title = document.createElement('span');
    title.className = 'dock-title';
    title.textContent = def.label;
    // a column: its jacks along the top (where the cables come down), the rest centred in the height that is left
    const col = (cls: string, top: HTMLElement | null, ...items: HTMLElement[]): HTMLElement => {
      const c = document.createElement('div');
      c.className = `dock-col ${cls}`;
      const body = document.createElement('div');
      body.className = 'dock-body';
      body.append(...items);
      c.append(...(top ? [top] : []), body);
      return c;
    };
    const jacks = (names: string[]): HTMLElement => {
      const row = document.createElement('div');
      row.className = 'dock-jacks';
      for (const p of def.outputs) if (names.includes(p.name)) row.append(this.port(m, p, 'out'));
      return row;
    };
    const param = (name: string): HTMLElement => this.paramRow(m, def, def.params.find((pd) => pd.name === name)!);
    // outputs with a home next to the control or setting that makes them; the rest in the strip
    const wheels = this.dockWheels;
    const WHEELS = wheels && this.wheelHost ? ['bend', 'mod'] : [], ARP = ['clock'];
    const homed = [...WHEELS, ...ARP];
    const strip = jacks(def.outputs.map((p) => p.name).filter((n) => !isKnob(n) && !homed.includes(n)));
    const knobs = document.createElement('div');
    knobs.className = 'deck-knobs';
    for (const k of ['k1', 'k2', 'k3', 'k4']) knobs.append(this.dockKnob(m, def, k));
    const morph = param('morph');
    // the morph slider's thumb is the morph input (Main has no p1 / p2): its cables are drawn to the thumb
    for (const pd of def.params) if (pd.input) {
      const jack = this.sliderPorts.find((s) => s.m === m && s.pd === pd)?.jack;
      if (jack) this.ports.set(this.key(m.id, pd.input, 'in'), jack);
    }
    // the arpeggiator opens as a panel over the canvas: it stays as the user left it across redraws
    const arp = this.arpPanel();
    arp.open = this.dockArpOpen;
    arp.ontoggle = () => (this.dockArpOpen = arp.open);
    // the bend and modulation wheels (the deck's, kept across redraws) each under its output's jack, in the column beside the keyboard
    if (wheels && this.wheelHost)
      this.wheelHost.replaceChildren(...(['bend', 'mod'] as const).map((n) => {
        const box = document.createElement('div');
        box.className = 'dock-wheel';
        // the wheel's own caption names it: the jack goes without a label (its tooltip still has the name)
        const row = jacks([n]);
        row.querySelectorAll('.port > span:not(.dot)').forEach((s) => s.remove());
        box.append(row, wheels[n]);
        return box;
      }));
    el.append(title,
      col('dock-outputs', strip, ...(this.dockOctave ? [this.dockOctave] : [])),
      col('dock-knobs', null, knobs),
      col('dock-morph', null, morph, this.morphRow()),
      col('dock-arp', jacks(ARP), arp),
      ...(this.dockBudget ? [col('dock-budget', null, this.dockBudget)] : []));
    return el;
  }


  private card(m: ModuleInst, def: ModuleDef, perVoice: number, open?: AssemblyInst): HTMLElement {
    const el = document.createElement('div');
    el.className = 'module' + (this.selected.has(m.id) ? ' selected' : '') + (open ? ' member' : '') + (this.picking(open) ? ' picking' : '');
    el.style.left = `${m.x}px`;
    el.style.top = `${m.y}px`;
    el.dataset.id = String(m.id);
    this.cards.set(m.id, el);

    const head = document.createElement('div');
    head.className = 'mhead';
    const title = document.createElement('span');
    title.append(this.tag(def.type), moduleName(def.type, def.label));
    if (perVoice) title.append(this.badge(perVoice));
    const tools = document.createElement('span');
    tools.className = 'tools';
    if (open) tools.append(this.outButton(open, () => this.takeOutModule(open, m)));
    if (def.type !== 'fm1' && def.type !== 'output') tools.append(this.bypassButton(m, def, el));
    const menu = (at: Pt): void => this.contextMenu(m, def, at);
    tools.append(this.moreButton(menu));
    head.append(title, tools);
    this.headMenu(head, menu);
    el.classList.toggle('off', !!m.bypass);
    this.moduleDrag(head, m);

    const body = document.createElement('div');
    body.className = 'mbody';
    const ins: EdgePort[] = [];
    for (const p of def.inputs) {
      if (!isPin(p.name)) ins.push({ el: this.port(m, p, 'in', { open, short: true }), module: m.id, port: p.name });
      else if (this.unrouted(m, p.name)) ins.push({ el: this.unroutedPort(m, p), module: m.id, port: p.name });
    }
    const outs = def.outputs.map((p) => this.port(m, p, 'out', { open, short: true }));
    const params = def.params.map((pd) => ({ el: this.paramRow(m, def, pd, { open }), input: pd.input ? { module: m.id, port: pd.input } : undefined }));
    // a second Main card (from an old patch) keeps its B side and arpeggiator under the rows
    const extra = def.type === 'fm1' ? [this.morphRow(), this.arpPanel()] : [];
    body.append(...this.edgeLayout(ins, outs, params, extra));
    el.append(head, body);
    return el;
  }

  /** the tag before a card's title (VCO, VCF, ENV ...), coloured by the module's family */
  private tag(type: string | null): HTMLElement {
    const t = document.createElement('span');
    const { tag, family } = type ? moduleTag(type) : { tag: 'ASM', family: 'asm' };
    t.className = `mtag ${family}`;
    t.textContent = tag;
    return t;
  }

  /**
   * A card's body: rows of [input jack | parameter | output jack]. A parameter's dedicated input (ParamDef.input) sits on
   * its row; at most EDGE_JACKS jacks hang on each side edge (the outputs from the top, the other inputs in the free rows),
   * the rest hang off the bottom edge with their labels above them. `extra` goes under the rows, across the card.
   */
  private edgeLayout(ins: EdgePort[], outs: HTMLElement[], params: { el: HTMLElement; input?: Target }[], extra: HTMLElement[] = []): HTMLElement[] {
    type Row = { l: HTMLElement | null; m: HTMLElement | null; r: HTMLElement | null };
    const rows: Row[] = params.map((p) => ({ l: null, m: p.el, r: null }));
    const free = [...ins];
    let fixed = 0;
    params.forEach((p, i) => {
      const k = p.input ? free.findIndex((x) => x.module === p.input!.module && x.port === p.input!.port) : -1;
      if (k < 0) return;
      rows[i].l = free.splice(k, 1)[0].el;
      fixed++;
    });
    const sideIns = free.splice(0, Math.max(0, EDGE_JACKS - fixed));
    const sideOuts = outs.slice(0, EDGE_JACKS);
    while (rows.length < sideOuts.length) rows.push({ l: null, m: null, r: null });
    for (const x of sideIns) {
      let r = rows.find((y) => !y.l);
      if (!r) rows.push((r = { l: null, m: null, r: null }));
      r.l = x.el;
    }
    sideOuts.forEach((el, i) => (rows[i].r = el));
    const cell = (cls: string, child: HTMLElement | null): HTMLElement => {
      const c = document.createElement('div');
      c.className = cls;
      if (child) c.append(child);
      return c;
    };
    const grid = document.createElement('div');
    grid.className = 'erows';
    for (const r of rows) {
      const row = document.createElement('div');
      row.className = 'erow';
      row.append(cell('el', r.l), cell('em', r.m), cell('er', r.r));
      grid.append(row);
    }
    const out: HTMLElement[] = rows.length ? [grid] : [];
    out.push(...extra);
    const bottomIns = free.map((x) => x.el), bottomOuts = outs.slice(EDGE_JACKS);
    if (bottomIns.length || bottomOuts.length) {
      const foot = document.createElement('div');
      foot.className = 'mfoot';
      const group = (els: HTMLElement[]): HTMLElement => {
        const g = document.createElement('div');
        for (const el of els) {
          el.classList.add('bottom');
          const dot = el.querySelector<HTMLElement>('.dot');
          if (dot) dot.dataset.edge = 'bottom'; // its cables leave downwards
        }
        g.append(...els);
        return g;
      };
      foot.append(group(bottomIns), group(bottomOuts));
      out.push(foot);
    }
    return out;
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
    row.className = 'param bar';
    const knob = def.type === 'fm1' && isKnob(pd.name) ? pd.name : null;
    if (knob) {
      row.classList.add('knob');
      row.style.setProperty('--knob', `var(--${knob})`);
    }
    const name = document.createElement('span');
    name.textContent = o.label ?? longName(def.type, pd.name);
    // an enum parameter is a picker (◀ saw ▶) with its jack above it, the two outlined together
    const choice = !!pd.choices && !pd.toggle;
    // a switch has no thumb either: its jack stands the same way, above the check box
    const jacked = choice || !!pd.toggle;
    if (jacked) row.classList.add('choice');
    if (pd.toggle) row.classList.add('toggle');
    let pickBox: HTMLElement | null = null; // pick mode's check box, last in the row (the name stays its first child)
    if (o.open) {
      const a = o.open;
      const on = isPromoted(a, m.id, pd.name);
      row.classList.toggle('shown', on);
      this.promoteClick(row, a, () => (on ? demote(a, m.id, pd.name) : promote(a, m.id, pd.name)));
      if (this.picking(a)) pickBox = this.pickBox(on);
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
    // the number and its unit apart: the unit is drawn smaller (labels.ts formatValue)
    const parts = (v: number, params = m.params): { num: string; unit: string } =>
      pd.altText && params[pd.altText.when] >= 0.5 ? { num: pd.altText.text(v), unit: '' }
        : pd.choices ? { num: choiceName(def.type, pd.name, pd.choices[Math.round(v)] ?? ''), unit: '' }
        : formatValue(v, pd.unit, pd.min < 0);
    const fmt = (v: number, params = m.params): string => { const p = parts(v, params); return p.unit ? `${p.num} ${p.unit}` : p.num; };
    let shown = '';
    const show = (v: number, params = m.params): void => {
      const text = fmt(v, params);
      if (text === shown) return;
      shown = text;
      const p = parts(v, params);
      if (!p.unit) { val.textContent = p.num; return; }
      const unit = document.createElement('span');
      unit.className = 'unit';
      unit.textContent = p.unit;
      val.replaceChildren(p.num, unit);
    };
    show(m.params[pd.name]);
    this.refreshers.set(row, () => show(m.params[pd.name]));
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
    // The thumb shows the live (modulated) value; a tick on the track marks the base. A drag moves the base by the
    // thumb's travel, so the live value stays under the pointer: `offset` = thumb - base at the start of the edit, in
    // slider units. Pointer capture also releases the edit lock when a drag ends outside the card.
    let editing = false;
    let offset = 0;
    const posOf = (v: number): number => (pd.log ? Math.round(toUnit(pd, v) * 1000) : v);
    const begin = (): void => {
      if (!editing) offset = Number(input.value) - posOf(m.params[pd.name]);
      editing = true;
    };
    input.onpointerdown = (e) => {
      if (e.altKey && (pd.input || def.paramInputs) && !pd.toggle) return;
      begin();
      input.setPointerCapture(e.pointerId);
    };
    input.onpointerup = input.onpointercancel = input.onlostpointercapture = () => { editing = false; };
    input.onkeydown = (e) => {
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown', ' '].includes(e.key)) begin();
    };
    input.onkeyup = input.onblur = () => { editing = false; };
    input.oninput = () => {
      const pos = Math.min(Number(input.max), Math.max(Number(input.min), Number(input.value) - offset));
      const v = pd.log ? snapTo(pd, fromUnit(pd, pos / 1000)) : Number(pos.toFixed(6));
      m.params[pd.name] = v;
      if (!offset) show(v); // else the live text keeps coming from the engine
      thumb?.setBase(offset ? toUnit(pd, v) : null);
      this.ev.onParam(m.id, pd.name, v);
      this.refreshKnobTicks(); // a knob moved, or a base a knob rests on
    };
    if (pd.toggle) {
      input.type = 'checkbox';
      input.checked = m.params[pd.name] >= 0.5;
      input.oninput = () => {
        const v = input.checked ? 1 : 0;
        m.params[pd.name] = v;
        show(v);
        for (const el of row.parentElement?.children ?? []) this.refreshers.get(el as HTMLElement)?.(); // a toggle can change how its siblings show (altText)
        this.ev.onParam(m.id, pd.name, v);
        this.refreshKnobTicks();
      };
    }
    // a thumb or a picker is a jack only where a cable dropped on it has somewhere to go: the module's parameter inputs,
    // the parameter's dedicated input, or a side input already routed to it
    const canPatch = !!def.paramInputs || !!pd.input || parameterInputs(m, pd).length > 0;
    const thumb = canPatch && !pd.toggle && !choice ? sliderJack(input, (e, jack) => this.beginDrag(e, jack)) : null;
    // a slider with nothing to patch keeps the bar and a plain thumb (not a jack: no cable lands on it)
    const plain = !thumb && !pd.toggle && !choice ? sliderJack(input, () => {}) : null;
    plain?.jack.classList.replace('slider-port', 'slider-thumb');
    // a picker's jack: the same role as a slider's thumb (routes and cables end on it), standing above the picker
    const pickJack = canPatch && jacked ? document.createElement('span') : null;
    row.classList.toggle('jacked', !!pickJack); // the outline ties the jack to its picker
    if (pickJack) {
      pickJack.className = 'dot control slider-port picker-jack';
      pickJack.dataset.mod = String(m.id);
      pickJack.dataset.param = pd.name;
      pickJack.dataset.dir = 'in';
      pickJack.title = `${def.label} ${longName(def.type, pd.name)}: drop a cable here to modulate it (depth in the ⋯ menu).`;
      pickJack.addEventListener('pointerdown', (e) => this.beginDrag(e, pickJack));
      this.sliderPorts.push({ m, pd, jack: pickJack, ticks: () => {} });
    }
    const gesture = thumb ? 'Drag to adjust; Alt-drag to patch. Drop a cable on the thumb to connect.' : '';
    input.title = gesture;
    if (thumb) {
      thumb.jack.dataset.mod = String(m.id);
      thumb.jack.dataset.param = pd.name;
      thumb.jack.dataset.dir = 'in';
      thumb.jack.title = `${def.label} ${longName(def.type, pd.name)}: ${gesture}`;
      this.sliderPorts.push({ m, pd, jack: thumb.jack, ticks: thumb.setKnobTicks });
      input.addEventListener('input', () => this.positionCables());
    }
    this.parameterDisplays.push({ id: m.id, update: (values) => {
      const base = m.params[pd.name];
      const v = values?.[pd.name] ?? base;
      if (!Number.isFinite(v)) return;
      const automated = Math.abs(v - base) > 1e-6;
      const text = fmt(v, values ?? m.params);
      if (!editing) {
        const position = String(posOf(v));
        if (pd.toggle) input.checked = v >= 0.5;
        else if (input.value !== position) input.value = position;
        thumb?.update();
        thumb?.setBase(automated ? toUnit(pd, base) : null);
        input.title = automated ? `Live: ${text}. Base: ${fmt(base)}. ${gesture || 'Drag to edit the base value.'}` : gesture;
      }
      if (!editing || automated) {
        show(v, values ?? m.params);
        input.setAttribute('aria-valuetext', text);
      }
      row.classList.toggle('automated', automated);
    } });
    row.append(name, jacked ? (pickJack ?? document.createElement('span')) : val);
    if (canPatch) {
      const key = `${m.id}:${pd.name}`;
      row.append(parameterMenu(m, def, pd, { ...this.ev, patch: () => this.patch, change: (fn) => this.change(fn) }, this.routingOpen.has(key), (on) => {
        if (on) {
          this.routingOpen.clear();
          this.routingOpen.add(key);
          for (const other of this.modulesEl.querySelectorAll<HTMLDetailsElement>('.parameter-routing[open]'))
            if (other.parentElement !== row) other.open = false;
        } else this.routingOpen.delete(key);
        this.drawCables();
      }));
    }
    if (choice) {
      // the arrows move the base value through the hidden range input, so editing, undo and Live work as for a slider
      row.append(picker({
        label: longName(def.type, pd.name),
        value: val,
        count: () => pd.choices!.length,
        get: () => Math.round(m.params[pd.name]),
        set: (i) => {
          input.value = String(i);
          input.dispatchEvent(new Event('input'));
        },
      }));
    } else if (pd.toggle) {
      const line = document.createElement('label');
      line.className = 'toggle-line';
      line.append(input, val);
      row.append(line);
    } else row.append(thumb?.element ?? plain?.element ?? input);
    if (plain) this.parameterDisplays.push({ id: m.id, update: () => { if (!editing) plain.update(); } });
    if (pickBox) row.append(pickBox);
    return row;
  }

  /**
   * A poly assembly's settings: parts (with the FM-1's budget), how notes are assigned, legato, priority and unit. Every
   * change goes through change() (undo, engine reload). `row`: one line (a frame's header strip), else a two-column grid.
   */
  private polySettings(a: AssemblyInst, row: boolean): HTMLElement {
    const el = document.createElement('div');
    el.className = 'poly-set' + (row ? ' row' : '');
    const item = (label: string, names: (i: number) => string, count: number, key: keyof PolyCfg, title: string, lo = 0): HTMLElement => {
      const box = document.createElement('div');
      box.className = 'poly-item';
      box.title = title;
      box.dataset.asm = String(a.id);
      box.dataset.setting = key;
      const name = document.createElement('span');
      name.textContent = label;
      const shown = document.createElement('span');
      const cfg = (): PolyCfg => a.poly!;
      shown.textContent = names(cfg()[key]);
      const pick = picker({ label: `${a.label} ${label}`, value: shown, count: () => count, get: () => cfg()[key] - lo, set: (i) => this.change(() => (a.poly![key] = i + lo)) });
      box.append(name, pick);
      return box;
    };
    const b = deviceBudget(this.patch);
    const parts = item('parts', String, EDITOR_MAX_PARTS, 'parts', `How many copies of the modules inside run: one per note that can sound at once. ${b.fits ? `On the FM-1 this patch takes ${b.buffers} of ${DEVICE.buffers} signal buffers, ${b.instances} of ${DEVICE.instances} module instances and about ${Math.round(b.cpu.use * 100)} % of the processor (an estimate).` : `Too big for the FM-1: ${b.over.map((i) => `${i.label} ${i.used} of ${i.max}`).join(', ')}.`}`, 1);
    parts.querySelector('.picker')!.classList.toggle('over', !b.fits);
    el.append(
      parts,
      item('assign', (i) => ASSIGN_MODES[i], ASSIGN_MODES.length, 'assign', "Which free part a new note takes: rotate (the next in turn, like a polysynth's voice cards), lowest (the lowest-numbered), reuse (a free part whose last note was that key, else the one free the longest)."),
      item('legato', (i) => LEGATO_MODES[i], LEGATO_MODES.length, 'legato', 'auto: with one part, a new key while one is held only changes the pitch; a taken-over part restarts its envelopes. off: always restart. on: never.'),
      item('priority', (i) => PRIORITIES[i], PRIORITIES.length, 'priority', 'With more keys held than parts: which notes sound (the last played, the lowest or the highest).'),
      item('unit', String, MAX_UNIT + 1, 'unit', 'Which instrument of the model: every Random module inside gets a different set of values (tolerances, drift).'),
    );
    return el;
  }

  /** the morph picker: the B side of the patch (another patch of the same structure); the `morph` slider above fades every parameter A -> B */
  private morphRow(): HTMLElement {
    const row = document.createElement('div');
    row.className = 'param bar morph-row';
    const name = document.createElement('span');
    name.textContent = 'B side';
    const val = document.createElement('output');
    const shown = document.createElement('output');
    const cands = (this.ev.morphCandidates?.() ?? []).filter((c) => sameStructure(this.patch, c.patch));
    // index 0 = none, then the candidates; the current B side is matched by name (it is a copy of a candidate's values)
    const current = (): number => (hasMorph(this.patch) ? cands.findIndex((c) => c.name === this.patch.morphName) + 1 : 0);
    const sel = picker({
      label: 'B side', value: shown, count: () => cands.length + 1, get: current,
      set: (i) => this.change(() => {
        if (i === 0) clearMorph(this.patch);
        else setMorphTarget(this.patch, cands[i - 1].patch, DEFS);
      }),
    });
    const show = (): void => {
      const has = hasMorph(this.patch);
      shown.textContent = has ? (this.patch.morphName ?? 'set') : 'none';
      val.textContent = '';
      row.title = has
        ? `The morph slider fades every parameter from this patch (A) to "${this.patch.morphName ?? 'B'}" (B): in octaves for a logarithmic one, a choice or switch flips at 0.5. The Main module's morph input adds to the slider (an LFO morphs the patch). Choose "none" to drop the B side.`
        : cands.length
          ? 'Pick a patch with the same modules and cables as the B side; the morph slider then fades every parameter from this patch to it.'
          : 'No stored patch has the same modules and cables as this one. Save this patch under another name, change its sounds, and pick that copy here.';
    };
    show();
    row.append(name, val, sel);
    return row;
  }

  /** the arpeggiator's transport (editor state) */
  arpPlay = false;

  // ---- zoom and touch: the cards and cables are scaled by `zoom`; offsets stay in layout pixels, pointer deltas are divided by it

  zoom = 1;
  /** `live`: the zoom slider's source moved it, not the user */
  onZoom: (z: number, live: boolean) => void = () => {};

  setZoom(z: number, live = false): void {
    const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 100) / 100));
    if (live && next === this.zoom) return;
    this.zoom = next;
    this.world.style.transform = this.zoom === 1 ? '' : `scale(${this.zoom})`;
    this.sizeCanvas();
    this.drawCables();
    this.onZoom(this.zoom, live);
  }

  /** Tidy up: line the cards up in columns, keeping their arrangement (tidy.ts); one undo step */
  tidyUp(): void {
    const before = JSON.stringify(this.patch);
    const docked = this.docked();
    tidy(this.patch, this.tidySizes(), new Set(docked ? [docked.id] : []));
    if (JSON.stringify(this.patch) === before) return this.ev.onError('already tidy');
    this.history.push(before);
    if (this.history.length > HISTORY) this.history.shift();
    this.future = [];
    this.rebuild();
    this.canvas.scrollTo(0, 0);
    this.ev.onLayout(this.patch);
  }

  /** how far the cables sag (0..1): redraws them */
  setSlack(v: number): void {
    this.slack = Math.min(1, Math.max(0, v));
    this.positionCables();
  }

  /** the slack source's latest value (the host's watch of Patch.slackFrom): redraws the cables once per frame */
  modulateSlack(v: number): void {
    this.slackMod = this.patch.slackFrom ? v : 0;
    if (this.slackFrame) return;
    this.slackFrame = requestAnimationFrame(() => {
      this.slackFrame = 0;
      this.positionCables();
    });
  }

  /** patch an output into a sidebar slider (null: unplug it); an undo step, no engine reload */
  setSideSource(key: SideKey, from: Endpoint | null): void {
    const before = JSON.stringify(this.patch);
    if (from) this.patch[key] = { ...from };
    else delete this.patch[key];
    if (JSON.stringify(this.patch) === before) return;
    this.history.push(before);
    if (this.history.length > HISTORY) this.history.shift();
    this.future = [];
    if (key === 'slackFrom' && !from) this.slackMod = 0;
    this.rebuild();
    this.ev.onLayout(this.patch);
  }

  /** the zoom, holding the canvas's centre in place (the zoom slider and its source); `live`: a modulation, not the user's */
  zoomAround(z: number, live = false): void {
    const c = this.canvas;
    const cx = (c.scrollLeft + c.clientWidth / 2) / this.zoom, cy = (c.scrollTop + c.clientHeight / 2) / this.zoom;
    const was = this.zoom;
    this.setZoom(z, live);
    if (this.zoom === was) return;
    c.scrollLeft = cx * this.zoom - c.clientWidth / 2;
    c.scrollTop = cy * this.zoom - c.clientHeight / 2;
  }

  /** every card in view: the zoom that fits the cards' extent into the canvas, scrolled to its top left */
  zoomToFit(): void {
    const elements = [...this.cards.values(), ...this.containers.values(), ...this.frames.values()];
    if (!elements.length) return;
    const PAD = 24;
    const x0 = Math.max(0, Math.min(...elements.map((el) => el.offsetLeft)) - PAD);
    const y0 = Math.max(0, Math.min(...elements.map((el) => el.offsetTop)) - PAD);
    const w = Math.max(...elements.map((el) => el.offsetLeft + el.offsetWidth)) + PAD - x0;
    const h = Math.max(...elements.map((el) => el.offsetTop + el.offsetHeight)) + PAD - y0;
    this.setZoom(Math.min(1.5, this.canvas.clientWidth / w, this.canvas.clientHeight / h));
    this.canvas.scrollTo(x0 * this.zoom, y0 * this.zoom);
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
    const items: MenuItem[] = [];
    if (def.type !== 'fm1' && def.type !== 'output') items.push({ text: m.bypass ? 'Turn on' : 'Bypass', key: 'B', run: () => {
      this.selected.clear();
      this.selected.add(m.id);
      this.bypassSelected();
    } });
    items.push({ text: 'Duplicate', key: '⌘D', run: () => {
      this.selected.clear();
      this.selected.add(m.id);
      this.duplicateSelected();
    } });
    items.push({ text: 'Select', run: () => {
      this.selected.add(m.id);
      this.showSelection();
    } });
    items.push({ text: 'Delete', key: 'Del', danger: true, rule: true, run: () => this.change(() => removeModule(this.patch, m.id)) });
    this.popMenu(items, at);
  }

  /** an assembly's menu (its header's ⋯, a right-click on its header) */
  private assemblyMenu(a: AssemblyInst, at: Pt): void {
    this.popMenu([
      { text: a.open ? 'Collapse' : 'Expand', key: a.open ? '▾' : '▸', run: () => this.toggleOpen(a) },
      { text: 'Choose what the card shows', run: () => {
        if (!a.open) this.toggleOpen(a);
        this.pickAsm = a.id;
        this.rebuild();
      } },
      { text: 'Rename', key: 'dbl-click', run: () => this.rename(a) },
      { text: 'Save to library', rule: true, run: () => this.saveAssembly(a) },
      { text: 'Ungroup', run: () => this.change(() => ungroup(this.patch, a.id)) },
      { text: 'Delete with its modules', danger: true, rule: true, run: () => this.change(() => deleteAssembly(this.patch, a.id)) },
    ], at);
  }

  /** the sizes Tidy up works with: the cards as drawn, a grid cell when one is not drawn */
  private tidySizes(): Parameters<typeof tidy>[1] {
    const size = (el: HTMLElement | undefined): { w: number; h: number } => ({ w: el?.offsetWidth || CARD_W, h: el?.offsetHeight || CARD_H });
    return {
      module: (id) => size(this.cards.get(id)),
      container: (id) => size(this.containers.get(id)),
      frame: (a) => ({ pad: FRAME_PAD, head: FRAME_HEAD + (a.poly ? POLY_STRIP : 0), minW: a.poly ? POLY_MIN_W : 0 }),
    };
  }

  /** expand or collapse an assembly; its first expansion in a session tidies the inside once the cards have a size */
  private toggleOpen(a: AssemblyInst): void {
    const first = !a.open && !this.expandedOnce.has(a.id);
    const opened = this.change(() => {
      a.open = !a.open;
      if (a.open && overlapping(this.patch, a)) tileMembers(this.patch, a); // stacked cards (an old file, members added at one spot) spread out
      if (a.open && a.poly) makeRoom(this.patch, a);
      // the frame's header goes above the members: move them down when it would stick out of the canvas's top
      if (a.open) {
        const ys = allModules(this.patch, a).map((id) => this.patch.modules.find((m) => m.id === id)?.y ?? Infinity);
        const room = FRAME_PAD + FRAME_HEAD + (a.poly ? POLY_STRIP : 0) + 8;
        if (Math.min(...ys) < room) moveAssembly(this.patch, a, 0, room - Math.min(...ys));
      }
    });
    if (!opened || !a.open) return;
    for (const x of [a, ...descendants(this.patch, a)]) this.expandedOnce.add(x.id);
    if (!first) return;
    // after rebuild's own frame (the cards are drawn then): part of the expansion's undo step, not one of its own
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const now = assembliesOf(this.patch).find((x) => x.id === a.id);
      if (!now?.open) return;
      const before = JSON.stringify(this.patch);
      tidyAssembly(this.patch, now, this.tidySizes());
      if (JSON.stringify(this.patch) === before) return;
      this.rebuild();
      this.ev.onLayout(this.patch);
    }));
  }

  /** a header's ⋯: opens the card's menu under it */
  private moreButton(open: (at: Pt) => void): HTMLButtonElement {
    const b = this.button('⋯', 'Menu (also right-click the header)', () => {
      const r = b.getBoundingClientRect();
      const w = this.world.getBoundingClientRect();
      open({ x: (r.right - w.left) / this.zoom - 190, y: (r.bottom - w.top) / this.zoom + 4 });
    }, 'more');
    return b;
  }

  /** right-click on a header opens its menu at the pointer */
  private headMenu(head: HTMLElement, open: (at: Pt) => void): void {
    head.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const w = this.world.getBoundingClientRect();
      open({ x: (e.clientX - w.left) / this.zoom, y: (e.clientY - w.top) / this.zoom });
    });
  }

  /** a small menu at a canvas point; a press anywhere else closes it */
  private popMenu(items: MenuItem[], at: Pt): void {
    document.querySelector('.ctx')?.remove();
    const menu = document.createElement('div');
    menu.className = 'ctx';
    menu.setAttribute('role', 'menu');
    for (const it of items) {
      const b = document.createElement('button');
      b.setAttribute('role', 'menuitem');
      b.className = (it.danger ? 'danger' : '') + (it.rule ? ' rule' : '');
      const label = document.createElement('span');
      label.textContent = it.text;
      b.append(label);
      if (it.key) {
        const k = document.createElement('kbd');
        k.textContent = it.key;
        b.append(k);
      }
      b.onclick = (e) => {
        e.stopPropagation();
        menu.remove();
        it.run();
      };
      menu.append(b);
    }
    Object.assign(menu.style, { left: `${Math.max(0, at.x)}px`, top: `${Math.max(0, at.y)}px` });
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
    const { mods, asms } = this.dragSet();
    if (!mods.length && !asms.length) return false;
    return this.change(() => {
      for (const a of asms) deleteAssembly(this.patch, a.id);
      for (const m of mods) if (this.patch.modules.includes(m)) removeModule(this.patch, m.id);
    });
  }

  /** flip the bypass of the selected modules (all on if any was off) */
  bypassSelected(): boolean {
    const { mods, asms } = this.dragSet();
    const inside = new Set(asms.flatMap((a) => allModules(this.patch, a)));
    const ms = this.patch.modules.filter((m) => (mods.includes(m) || inside.has(m.id)) && m.type !== 'fm1' && m.type !== 'output');
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
    const set = this.dragSet();
    if (!set.mods.length && !set.asms.length) return false;
    for (const m of set.mods) {
      m.x = Math.max(0, m.x + dx);
      m.y = Math.max(0, m.y + dy);
    }
    for (const a of set.asms) moveAssembly(this.patch, a, dx, dy);
    this.rebuild();
    this.ev.onLayout(this.patch);
    return true;
  }

  /** copies of the selected modules with their parameters, matrix and the cables among them, placed below the originals and selected */
  duplicateSelected(): boolean {
    const set = this.dragSet();
    const ids = set.mods.filter((m) => m.type !== 'fm1').map((m) => m.id);
    if (!ids.length && !set.asms.length) return false;
    return this.change(() => {
      // a selected assembly is copied through its definition, collapsed, below where it is
      const asmCopies = set.asms.map((a) => {
        const box = a.open ? this.frameRect(a) : { x: a.x, y: a.y, h: this.containers.get(a.id)?.offsetHeight ?? CARD_H / 2 };
        return insertAssembly(this.patch, DEFS, toDef(this.patch, a), box?.x ?? a.x, (box?.y ?? a.y) + Math.min(CARD_H / 2, (box?.h ?? 0) + 24)).id;
      });
      const map = new Map<number, number>();
      for (const id of ids) {
        const m = this.patch.modules.find((x) => x.id === id)!;
        const copy = addModule(this.patch, DEFS[m.type], m.x, m.y + CARD_H / 2);
        copy.params = { ...m.params };
        if (m.att) copy.att = [m.att[0], m.att[1]];
        if (m.map) copy.map = JSON.parse(JSON.stringify(m.map));
        if (m.range) copy.range = JSON.parse(JSON.stringify(m.range));
        if (m.bypass) copy.bypass = true;
        if (m.inputMap) copy.inputMap = structuredClone(m.inputMap);
        map.set(id, copy.id);
      }
      for (const c of [...this.patch.cables]) if (map.has(c.from.module) && map.has(c.to.module)) connect(this.patch, DEFS, { module: map.get(c.from.module)!, port: c.from.port }, { module: map.get(c.to.module)!, port: c.to.port });
      this.selected.clear();
      for (const id of map.values()) this.selected.add(id);
      this.selectedAsm.clear();
      for (const id of asmCopies) this.selectedAsm.add(id);
    });
  }

  // ---- click-to-connect: a click on a jack arms it, a click on a jack of the other direction connects; Esc cancels

  private armed: HTMLElement | null = null;

  cancelArm(): void {
    this.armed?.classList.remove('armed');
    this.armed = null;
    this.setPatching(false);
    this.drag?.cancel();
  }

  /** the canvas is patching (a cable being dragged or a jack armed); the page knows too, so the sidebar's jack thumbs show it */
  private setPatching(on: boolean): void {
    this.canvas.classList.toggle('patching', on);
    document.documentElement.classList.toggle('patching-any', on);
  }

  /** click-to-connect onto a sidebar slider's thumb: with an output armed, patch it there. Whether it did */
  connectArmedToSide(key: SideKey): boolean {
    const armed = this.armed;
    if (!armed || armed.dataset.dir !== 'out' || !armed.dataset.mod) return false;
    this.cancelArm();
    this.setSideSource(key, { module: Number(armed.dataset.mod), port: armed.dataset.port! });
    return true;
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
  private arpPanel(): HTMLDetailsElement {
    const box = document.createElement('details');
    box.className = 'arp';
    box.open = !!this.patch.arp || this.arpPlay;
    const sum = document.createElement('summary');
    sum.textContent = 'Arpeggiator';
    const rowsEl = document.createElement('div');
    rowsEl.className = 'arp-rows';
    box.append(sum, rowsEl);
    const cfg = (): ArpCfg => this.patch.arp ?? { ...ARP_DEFAULT };
    const set = (f: keyof ArpCfg, v: number): void => {
      const c = fixArp({ ...cfg(), [f]: v });
      this.patch.arp = c;
      this.ev.onArp(c);
      refresh();
    };
    const rows: (() => void)[] = [];
    // the rows look like a card's: a bar with the name at the left and the value at the right (paramRow)
    const row = (label: string, cls: string, kids: HTMLElement[], show: () => void): void => {
      const r = document.createElement('div');
      r.className = `param bar ${cls}`;
      const name = document.createElement('span');
      name.textContent = label;
      r.append(name, ...kids);
      rows.push(show);
      rowsEl.append(r);
    };
    const refresh = (): void => rows.forEach((f) => f());
    const choice = (label: string, f: keyof ArpCfg, names: string[]): void => {
      const value = document.createElement('span');
      const pick = picker({ label: `arpeggiator ${label}`, value, count: () => names.length, get: () => cfg()[f], set: (i) => set(f, i) });
      row(label, 'choice', [document.createElement('span'), pick], () => (value.textContent = names[cfg()[f]] ?? ''));
    };
    const num = (label: string, f: keyof ArpCfg, lo: number, hi: () => number, show: (v: number) => string = String): void => {
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(lo);
      input.step = '1';
      input.setAttribute('aria-label', `arpeggiator ${label}`);
      input.oninput = () => set(f, Number(input.value));
      const bar = sliderJack(input, () => {});
      bar.jack.classList.replace('slider-port', 'slider-thumb');
      const val = document.createElement('output');
      row(label, '', [val, bar.element], () => {
        input.max = String(hi());
        input.value = String(cfg()[f]);
        val.textContent = show(cfg()[f]);
        bar.update();
      });
    };
    // transport
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
    pval.textContent = 'hold keys to play';
    const line = document.createElement('label');
    line.className = 'toggle-line';
    line.append(pbox, pval);
    row('enable', 'toggle', [document.createElement('span'), line], () => {});
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
    rowsEl.append(foot);
    refresh();
    return box;
  }

  /**
   * A port row. On a member card of an expanded assembly it gets the expose toggle; on an assembly card (`label`) the dot
   * still belongs to the inner module, so cables and drags work the same, and the label renames on click.
   */
  private port(m: ModuleInst, p: PortDef, dir: 'out' | 'in', o: { open?: AssemblyInst; label?: string; rename?: () => void; also?: Target[]; short?: boolean } = {}): HTMLElement {
    const row = document.createElement('div');
    row.className = `port ${dir}`;
    const dot = this.jack(m, p, dir);
    const long = longName(m.type, p.name);
    dot.title = (o.label ? `${o.label}: ${DEFS[m.type].label} ${long} (${p.kind})` : `${long} (${p.kind})`) + SCOPE_HINT;
    const label = document.createElement('span');
    // a card's edge has little room: a long name gives way to the short one (the jack's tooltip has the long one)
    label.textContent = o.label ?? (o.short && long.length > 6 ? p.name : long);
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
      row.classList.toggle('shown', on);
      this.promoteClick(row, a, () => (on ? hidePort(this.patch, a, dir, m.id, p.name) : exposePort(a, dir, m.id, p.name, o.also)));
      // pick mode: the check box between the label and the jack
      if (this.picking(a)) parts.splice(1, 0, this.pickBox(on));
      if (dir === 'in') parts.push(...this.mergeTools(a, m, p, ref, this.picking(a)));
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
    return row;
  }

  /**
   * Shift-click on a jack puts it on the scope or takes it off: an output itself, an input the output that feeds it (its
   * first cable). The tutorial and the palette see it through `onProbe` like any other probe.
   */
  private toggleProbe(m: ModuleInst, p: PortDef, dir: 'out' | 'in'): void {
    let src = m, port = p;
    if (dir === 'in') {
      const c = this.patch.cables.find((c) => c.to.module === m.id && c.to.port === p.name);
      const from = c && this.patch.modules.find((x) => x.id === c.from.module);
      const out = from && DEFS[from.type].outputs.find((o) => o.name === c.from.port);
      if (!from || !out) return;
      src = from; port = out;
    }
    const key = probeKey(src.id, port.name);
    const now = !this.probes.has(key);
    if (now) this.probes.add(key);
    else this.probes.delete(key);
    this.ports.get(this.key(src.id, port.name, 'out'))?.classList.toggle('probed', now);
    this.ev.onProbe(key, src.id, port.name, port.kind, `${moduleName(src.type, DEFS[src.type].label)} ${longName(src.type, port.name)}`, now);
  }

  /** briefly highlight the drawn cables of these model cables (the two sources holding a module's pins) */
  private flash(cables: Cable[]): void {
    const hit = (c?: Cable): boolean => !!c && cables.some((x) => sameEnd(x.from, c.from) && sameEnd(x.to, c.to));
    // after the redraw that follows the failed change
    setTimeout(() => {
      const paths = this.cablePaths.filter((e) => hit(e.cable)).map((e) => e.path);
      for (const path of paths) path.classList.add('flash');
      setTimeout(() => paths.forEach((path) => path.classList.remove('flash')), 1600);
    }, 60);
  }

  /** a pin with a cable that routes to no parameter (from an old patch): it gets a jack so the cable can be seen and removed */
  private unrouted(m: ModuleInst, pin: string): boolean {
    return isPin(pin) && !!m.map && !m.map[pin].length && this.patch.cables.some((c) => c.to.module === m.id && c.to.port === pin);
  }

  private unroutedPort(m: ModuleInst, p: PortDef): HTMLElement {
    const row = this.port(m, p, 'in', { label: 'unrouted' });
    row.classList.add('unrouted');
    row.title = 'This cable reaches no parameter (an old patch routed it nowhere). Click the cable to remove it, or patch to a thumb instead.';
    return row;
  }

  /** a port's jack: cables are drawn to it and dragged from it */
  private jack(m: ModuleInst, p: PortDef, dir: 'out' | 'in'): HTMLElement {
    const dot = document.createElement('span');
    dot.className = `dot ${p.kind}`;
    dot.dataset.mod = String(m.id);
    dot.dataset.port = p.name;
    dot.dataset.dir = dir;
    if (m.type === 'fm1' && dir === 'out' && isKnob(p.name)) dot.dataset.knob = p.name;
    dot.title = `${longName(m.type, p.name)} (${p.kind})${SCOPE_HINT}`;
    if (dir === 'out') dot.classList.toggle('probed', this.probes.has(probeKey(m.id, p.name)));
    dot.addEventListener('pointerdown', (e) => {
      if (!e.shiftKey) return this.beginDrag(e, dot);
      e.preventDefault();
      e.stopPropagation();
      this.toggleProbe(m, p, dir);
    });
    this.ports.set(this.key(m.id, p.name, dir), dot);
    return dot;
  }

  /** one of Main's knobs K1..K4 on the dock: its output's jack above it (towards the canvas), the name on the cap */
  private dockKnob(m: ModuleInst, def: ModuleDef, k: string): HTMLElement {
    const box = document.createElement('div');
    box.className = 'deck-knob';
    box.dataset.param = k;
    box.style.setProperty('--knob', `var(--${k})`);
    const out = def.outputs.find((o) => o.name === k);
    if (out) {
      const dot = this.jack(m, out, 'out');
      dot.title = `${k.toUpperCase()} output: drag a cable from here${SCOPE_HINT}`;
      box.append(dot);
    }
    const dial = document.createElement('div');
    dial.className = 'dial';
    const name = document.createElement('span');
    name.className = 'dial-name';
    name.textContent = k.toUpperCase();
    dial.append(name);
    box.append(dial);
    const c = dragControl(dial, `Knob ${k.toUpperCase()}`, 0, 1, m.params[k] ?? 0.5, (v) => this.setParam(m.id, k, Number(v.toFixed(3))), {
      reset: 0.5,
      text: (v) => `${Math.round(v * 100)} %`,
      draw: (v) => dial.style.setProperty('--v', String(v)),
    });
    // MIDI CC 16..19 move the knobs in the engine: follow its live value
    this.parameterDisplays.push({ id: m.id, update: (values) => c.set(values?.[k] ?? m.params[k] ?? 0.5) });
    return box;
  }

  /**
   * On an exposed input inside an expanded assembly: a "merge into…" list of the other exposed inputs of the same kind, a
   * badge with the count on a merged jack and a button to split it again.
   */
  private mergeTools(a: AssemblyInst, m: ModuleInst, p: PortDef, ref: PortRef | undefined, tools: boolean): HTMLElement[] {
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
      if (primary && tools) out.push(this.button('split', `Split "${ref.label}": one jack per input again`, () => this.change(() => unmergePort(a, m.id, p.name))));
    }
    const kindOf = (t: Target): string => DEFS[this.patch.modules.find((x) => x.id === t.module)!.type].inputs.find((q) => q.name === t.port)!.kind;
    const others = a.inputs.filter((r) => r !== ref && kindOf(r) === p.kind);
    if (!others.length || !tools) return out; // merging is part of choosing the card: pick mode only
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

  /** the expanded assembly whose collapsed card is being chosen (its frame's card button), else null */
  private pickAsm: number | null = null;

  /** leave pick mode (Esc); false when it was not on */
  endPick(): boolean {
    if (this.pickAsm === null) return false;
    this.pickAsm = null;
    this.rebuild();
    return true;
  }

  private picking(a: AssemblyInst | undefined): boolean {
    return !!a && this.pickAsm === a.id;
  }

  /**
   * A row of a member card that can go on the assembly's collapsed card: a click adds it or takes it off in pick mode,
   * a Cmd / Ctrl-click any time. In pick mode a jack still patches (a plain press on it).
   */
  private promoteClick(el: HTMLElement, a: AssemblyInst, toggle: () => void): void {
    const mod = (e: MouseEvent): boolean => e.metaKey || e.ctrlKey;
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !(this.picking(a) || mod(e))) return;
      const t = e.target as HTMLElement;
      if (t.closest('select, button.sm')) return;
      if (!mod(e) && t.closest('.dot:not(.slider-port)')) return;
      e.preventDefault();
      e.stopPropagation();
      this.change(toggle);
    }, true);
    // macOS: Ctrl-click is also a right click; it toggled already, so no context menu
    el.addEventListener('contextmenu', (e) => { if (e.ctrlKey) { e.preventDefault(); e.stopPropagation(); } });
    el.title = this.picking(a) ? `Click: show on the "${a.label}" card or take it off` : `Cmd / Ctrl-click: show on the "${a.label}" card or take it off`;
  }

  /** pick mode's check box: on = shown on the assembly card */
  private pickBox(on: boolean): HTMLElement {
    const box = document.createElement('span');
    box.className = 'pickbox' + (on ? ' on' : '');
    box.textContent = on ? '✓' : '';
    box.setAttribute('aria-hidden', 'true');
    return box;
  }

  /** the frame's card button: pick mode on / off, with how many jacks and parameters the collapsed card has */
  private pickButton(a: AssemblyInst): HTMLButtonElement {
    const on = this.picking(a);
    const n = a.inputs.length + a.outputs.length + a.params.length;
    const b = this.button(on ? 'done' : `card · ${n}`, on
      ? 'Done choosing (Esc)'
      : `Choose what the collapsed "${a.label}" card shows: click jacks and parameters to add or remove them (Cmd / Ctrl-click does it any time)`,
    () => { this.pickAsm = on ? null : a.id; this.rebuild(); }, 'sm pick-btn');
    b.setAttribute('aria-pressed', String(on));
    b.dataset.asm = String(a.id);
    return b;
  }

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
    return [this.polyButton(a), pw, this.moreButton((at) => this.assemblyMenu(a, at))];
  }

  /** ▸ / ▾ before an assembly's title: expand or collapse */
  private chevron(a: AssemblyInst): HTMLButtonElement {
    const b = this.button(a.open ? '▾' : '▸', a.open ? 'Collapse to one card' : 'Expand: show and edit the modules inside', () => this.toggleOpen(a), 'chev');
    b.setAttribute('aria-expanded', String(!!a.open));
    b.dataset.asm = String(a.id);
    return b;
  }

  /** the Poly switch: the modules inside run once per part, with their own allocator (poly.ts setPoly) */
  private polyButton(a: AssemblyInst): HTMLButtonElement {
    const b = this.button('poly', a.poly
      ? 'Poly is on: the modules inside run once per part. Click to turn it off (one copy, played by the shared keyboard).'
      : 'Make it a poly assembly: the modules inside run once per part, each part playing its own note (a Part module inside gives each part its note).',
    () => this.change(() => setPoly(this.patch, DEFS, a, !a.poly)), 'sm poly-btn');
    b.setAttribute('aria-pressed', String(!!a.poly));
    b.dataset.asm = String(a.id);
    return b;
  }

  private titleOf(a: AssemblyInst, perVoice: number): HTMLElement {
    const title = document.createElement('span');
    title.className = 'rename';
    title.textContent = a.label;
    title.title = `${a.name}: double-click to rename`;
    title.ondblclick = () => this.rename(a);
    if (perVoice) title.append(this.badge(perVoice));
    return title;
  }

  /**
   * The collapsed assembly: one card with the exposed ports and the promoted parameters. Inside an expanded parent (`open`)
   * its rows get the parent's expose / pin toggles, like a member card's.
   */
  private container(a: AssemblyInst, perVoice: number, open?: AssemblyInst): HTMLElement {
    const el = document.createElement('div');
    el.className = 'module assembly' + (open ? ' member' : '') + (a.bypass ? ' off' : '') + (this.picking(open) ? ' picking' : '') + (this.selectedAsm.has(a.id) ? ' selected' : '');
    el.style.left = `${a.x}px`;
    el.style.top = `${a.y}px`;
    el.dataset.asm = String(a.id);
    this.containers.set(a.id, el);
    const head = document.createElement('div');
    head.className = 'mhead';
    const tools = document.createElement('span');
    tools.className = 'tools';
    if (open) tools.append(this.outButton(open, () => this.takeOutAssembly(open, a)));
    tools.append(...this.assemblyButtons(a));
    const title = this.titleOf(a, perVoice);
    title.prepend(this.tag(null));
    head.append(this.chevron(a), title, tools);
    this.headMenu(head, (at) => this.assemblyMenu(a, at));
    this.assemblyDrag(el, head, a);

    const body = document.createElement('div');
    body.className = 'mbody';
    if (a.poly) body.append(this.polySettings(a, false));
    const mod = (id: number): ModuleInst => this.patch.modules.find((m) => m.id === id)!;
    const ins: EdgePort[] = [];
    for (const r of a.inputs) {
      const m = mod(r.module);
      const pd = DEFS[m.type].inputs.find((q) => q.name === r.port)!;
      if (isPin(pd.name) && !this.unrouted(m, pd.name)) continue; // routed pins are shown as promoted parameters
      ins.push({ el: this.port(m, pd, 'in', { label: r.label, rename: () => this.renameRef(r, 'input'), also: r.also, open }), module: m.id, port: pd.name });
    }
    const outs = a.outputs.map((r) => {
      const m = mod(r.module);
      const pd = DEFS[m.type].outputs.find((q) => q.name === r.port)!;
      return this.port(m, pd, 'out', { label: r.label, rename: () => this.renameRef(r, 'output'), open });
    });
    const params = a.params.map((r) => {
      const m = mod(r.module);
      const def = DEFS[m.type];
      const pd = def.params.find((q) => q.name === r.param)!;
      return { el: this.paramRow(m, def, pd, { label: r.label, rename: () => this.renameRef(r, 'parameter'), open }), input: pd.input ? { module: m.id, port: pd.input } : undefined };
    });
    body.append(...this.edgeLayout(ins, outs, params));
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
  private frame(a: AssemblyInst, perVoice: number): HTMLElement {
    const el = document.createElement('div');
    el.className = 'frame' + (a.bypass ? ' off' : '') + (this.selectedAsm.has(a.id) ? ' selected' : '');
    el.dataset.asm = String(a.id);
    const head = document.createElement('div');
    head.className = 'fhead';
    const tools = document.createElement('span');
    tools.className = 'tools';
    tools.append(this.pickButton(a), ...this.assemblyButtons(a));
    el.classList.toggle('picking', this.picking(a));
    const title = this.titleOf(a, perVoice);
    title.prepend(this.tag(null));
    head.append(this.chevron(a), title, tools);
    this.headMenu(head, (at) => this.assemblyMenu(a, at));
    el.append(head);
    if (a.poly) {
      const strip = this.polySettings(a, true);
      strip.classList.add('fpoly');
      el.append(strip);
    }
    this.frames.set(a.id, el);
    const parent = parentOf(this.patch, a.id);
    if (parent) tools.prepend(this.outButton(parent, () => this.takeOutAssembly(parent, a)));
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
    const head = FRAME_HEAD + (a.poly ? POLY_STRIP : 0);
    const minW = a.poly ? POLY_MIN_W : 0;
    return { x: x0 - FRAME_PAD, y: y0 - FRAME_PAD - head, w: Math.max(x1 - x0 + 2 * FRAME_PAD, a.frameSize?.width ?? 0, minW), h: Math.max(y1 - y0 + 2 * FRAME_PAD + head, a.frameSize?.height ?? 0) };
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

  /**
   * What a drag of the selection moves: the selected assemblies that are not inside another selected one (each with
   * everything inside it) and the selected modules that none of those holds.
   */
  private dragSet(): { mods: ModuleInst[]; asms: AssemblyInst[] } {
    const sel = assembliesOf(this.patch).filter((a) => this.selectedAsm.has(a.id));
    const asms = sel.filter((a) => !sel.some((b) => b !== a && descendants(this.patch, b).some((d) => d.id === a.id)));
    const covered = new Set(asms.flatMap((a) => allModules(this.patch, a)));
    const mods = this.patch.modules.filter((m) => this.selected.has(m.id) && !covered.has(m.id));
    return { mods, asms };
  }

  /** move a drag set by (dx, dy): model and elements; the frames follow (a member pushes its frame's edge out) */
  private moveSet(set: { mods: ModuleInst[]; asms: AssemblyInst[] }, dx: number, dy: number): void {
    for (const m of set.mods) this.place(m, dx, dy);
    for (const a of set.asms) this.moveTree(a, dx, dy, false);
    this.layoutFrames();
    this.drawCables();
  }

  /** a press on a card's or frame's handle: shift toggles the item in the selection, else the drag takes the selection with it */
  private groupDrag(handle: HTMLElement, item: { module?: ModuleInst; asm?: AssemblyInst }, drop: (set: { mods: ModuleInst[]; asms: AssemblyInst[] }) => void): void {
    let set: { mods: ModuleInst[]; asms: AssemblyInst[] } = { mods: [], asms: [] };
    this.dragOn(
      handle,
      (e) => {
        const on = item.module ? this.selected.has(item.module.id) : this.selectedAsm.has(item.asm!.id);
        if (e.shiftKey) {
          if (item.module) this.toggleSelect(item.module.id);
          else this.toggleSelectAsm(item.asm!.id);
          return false;
        }
        if (!on) this.select(item.module ? [item.module.id] : [], item.asm ? [item.asm.id] : []);
        set = this.dragSet();
        return true;
      },
      (dx, dy) => this.moveSet(set, dx, dy),
      () => {
        this.sizeCanvas();
        this.ev.onLayout(this.patch);
        drop(set);
      },
    );
  }

  private moduleDrag(handle: HTMLElement, m: ModuleInst): void {
    this.groupDrag(handle, { module: m }, (set) => this.dropped(set, true));
  }

  /**
   * After a drag: modules and collapsed assemblies that belong to no assembly join the innermost expanded frame they are
   * dropped into. A member never leaves its assembly by a drag (its frame grows to hold it): the ⇱ button takes it out.
   */
  private dropped(set: { mods: ModuleInst[]; asms: AssemblyInst[] }, nest: boolean): void {
    const movedIds = new Set(set.mods.map((m) => m.id));
    const moving = new Set(set.asms.flatMap((a) => [a.id, ...descendants(this.patch, a).map((d) => d.id)]));
    const ops: (() => void)[] = [];
    const innermost = (el: HTMLElement, skip: (b: AssemblyInst) => boolean): AssemblyInst | undefined => {
      const cx = el.offsetLeft + el.offsetWidth / 2;
      const cy = el.offsetTop + HEAD_Y; // where the hand is: the card's header, not its middle (cards are tall)
      let target: AssemblyInst | undefined;
      for (const b of assembliesOf(this.patch)) {
        if (!b.open || skip(b) || !this.frames.has(b.id)) continue;
        const r = this.frameRect(b, movedIds);
        if (r && cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h && (!target || depthOf(this.patch, b) > depthOf(this.patch, target))) target = b;
      }
      return target;
    };
    for (const m of set.mods) {
      if (assemblyOf(this.patch, m.id)) continue;
      const c = this.cards.get(m.id);
      const target = c && innermost(c, (b) => moving.has(b.id));
      if (target) ops.push(() => addMember(this.patch, target, m.id));
    }
    if (nest)
      for (const a of set.asms) {
        const el = this.containers.get(a.id);
        if (!el || parentOf(this.patch, a.id)) continue;
        const target = innermost(el, (b) => moving.has(b.id));
        if (target) ops.push(() => addChild(this.patch, target, a.id));
      }
    if (!ops.length) {
      this.layoutFrames();
      return;
    }
    const keep = [...this.selected], keepAsm = [...this.selectedAsm];
    if (this.change(() => ops.forEach((op) => op()))) this.select(keep, keepAsm);
  }

  /** the ⇱ on a member's header: take it out of its assembly (one level up), placed beside the frame */
  private outButton(a: AssemblyInst, run: () => void): HTMLButtonElement {
    return this.button('⇱', `Take out of "${a.label}"`, run, 'sm out');
  }

  private takeOutModule(a: AssemblyInst, m: ModuleInst): void {
    const r = this.frameRect(a, new Set([m.id]));
    const up = parentOf(this.patch, a.id);
    this.change(() => {
      removeMember(this.patch, a, m.id);
      if (up && assembliesOf(this.patch).includes(up)) addMember(this.patch, up, m.id);
      if (r) { m.x = Math.max(0, r.x + r.w + 24); m.y = Math.max(0, r.y); }
    });
  }

  private takeOutAssembly(parent: AssemblyInst, a: AssemblyInst): void {
    const r = this.frameRect(parent, undefined, a.id);
    const up = parentOf(this.patch, parent.id);
    this.change(() => {
      removeChild(this.patch, parent, a.id);
      if (up && assembliesOf(this.patch).includes(up)) addChild(this.patch, up, a.id);
      if (r) {
        const box = a.open ? this.frameRect(a) : { x: a.x, y: a.y };
        if (box) moveAssembly(this.patch, a, Math.max(0, r.x + r.w + 24) - box.x, Math.max(0, r.y) - box.y);
      }
    });
  }

  /** move an assembly with everything inside it, model and elements; `layout` = redraw the frames and cables too */
  private moveTree(a: AssemblyInst, dx: number, dy: number, layout = true): void {
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
    if (!layout) return;
    this.layoutFrames();
    this.drawCables();
  }

  private assemblyDrag(_el: HTMLElement, handle: HTMLElement, a: AssemblyInst): void {
    this.groupDrag(handle, { asm: a }, (set) => this.dropped(set, true));
  }

  private frameDrag(handle: HTMLElement, a: AssemblyInst): void {
    this.groupDrag(handle, { asm: a }, (set) => this.dropped({ mods: set.mods, asms: [] }, false));
  }

  private select(ids: number[], asms: number[] = []): void {
    this.selected.clear();
    this.selectedAsm.clear();
    for (const id of ids) this.selected.add(id);
    for (const id of asms) this.selectedAsm.add(id);
    this.showSelection();
  }

  /** Ctrl / Cmd+A: every module and assembly at the top of the canvas (the docked Main is not a card) */
  selectAll(): boolean {
    const docked = this.docked();
    const inAsm = new Set(assembliesOf(this.patch).flatMap((a) => a.modules));
    const mods = this.patch.modules.filter((m) => m !== docked && !inAsm.has(m.id)).map((m) => m.id);
    const asms = assembliesOf(this.patch).filter((a) => !parentOf(this.patch, a.id)).map((a) => a.id);
    if (!mods.length && !asms.length) return false;
    this.select(mods, asms);
    return true;
  }

  private toggleSelect(id: number): void {
    if (this.selected.has(id)) this.selected.delete(id);
    else this.selected.add(id);
    this.showSelection();
  }

  private toggleSelectAsm(id: number): void {
    if (this.selectedAsm.has(id)) this.selectedAsm.delete(id);
    else this.selectedAsm.add(id);
    this.showSelection();
  }

  private showSelection(): void {
    for (const [id, el] of this.cards) el.classList.toggle('selected', this.selected.has(id));
    for (const [id, el] of [...this.containers, ...this.frames]) el.classList.toggle('selected', this.selectedAsm.has(id));
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
      const hitAsm: number[] = [];
      if (r.w > 4 || r.h > 4) {
        const touches = (c: HTMLElement): boolean => c.offsetLeft < r.x + r.w && c.offsetLeft + c.offsetWidth > r.x && c.offsetTop < r.y + r.h && c.offsetTop + c.offsetHeight > r.y;
        const holds = (c: HTMLElement): boolean => c.offsetLeft >= r.x && c.offsetLeft + c.offsetWidth <= r.x + r.w && c.offsetTop >= r.y && c.offsetTop + c.offsetHeight <= r.y + r.h;
        // a frame is taken when the band holds all of it (a band inside a frame picks cards in it), a collapsed card when touched
        for (const [id, f] of this.frames) if (holds(f)) hitAsm.push(id);
        for (const [id, c] of this.containers) if (touches(c)) hitAsm.push(id);
        const taken = assembliesOf(this.patch).filter((a) => hitAsm.includes(a.id));
        const coveredMods = new Set(taken.flatMap((a) => allModules(this.patch, a)));
        const coveredAsm = new Set(taken.flatMap((a) => descendants(this.patch, a).map((d) => d.id)));
        for (const id of [...hitAsm]) if (coveredAsm.has(id)) hitAsm.splice(hitAsm.indexOf(id), 1);
        for (const [id, c] of this.cards) if (!coveredMods.has(id) && touches(c)) hit.push(id);
      }
      if (e.shiftKey) {
        hit.forEach((id) => this.selected.add(id));
        hitAsm.forEach((id) => this.selectedAsm.add(id));
      } else this.select(hit, hitAsm);
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

  /**
   * A cable's Bézier points from a to b. An end leaves its jack sideways (out to the right, in from the left), upwards on
   * a docked jack (the dock is below the canvas) and downwards on a jack under a card's bottom edge. Taut, it is one curve
   * (split in two at its middle). Slack drops only the middle and puts a short straight stub at each end (`CABLE_STUB` at
   * full slack): a plug holds the cable straight and it bends most where it hangs free, so a drooping cable still leaves
   * its jack square, and one from a docked jack to a module just below the view still rises out of the dock before it falls.
   */
  private curvePts(a: Pt, b: Pt, dirA: CableEnd = 'side', dirB: CableEnd = 'side'): Pt[] {
    const stub = this.sway * CABLE_STUB;
    if (stub <= 0) return this.spanPts(a, b, dirA, dirB);
    const away = (p: Pt, dir: CableEnd, sx: number, t: number): Pt =>
      dir === 'up' ? { x: p.x, y: p.y - t } : dir === 'down' ? { x: p.x, y: p.y + t } : { x: p.x + sx * t, y: p.y };
    const sa = (t: number): Pt => away(a, dirA, 1, t);
    const sb = (t: number): Pt => away(b, dirB, -1, t);
    return [a, sa(stub / 3), sa((2 * stub) / 3), ...this.spanPts(sa(stub), sb(stub), dirA, dirB), sb((2 * stub) / 3), sb(stub / 3), b];
  }

  /** the curve between the stubs: two cubic segments joined in the middle; slack drops the middle, the ends stay square */
  private spanPts(a: Pt, b: Pt, dirA: CableEnd, dirB: CableEnd): Pt[] {
    const dx = Math.max(40, Math.abs(b.x - a.x) / 2);
    const dy = Math.max(60, Math.abs(b.y - a.y) / 2);
    const handle = (p: Pt, dir: CableEnd, sx: number): Pt => (dir === 'up' ? { x: p.x, y: p.y - dy } : dir === 'down' ? { x: p.x, y: p.y + dy } : { x: p.x + sx, y: p.y });
    const mid = (u: Pt, v: Pt): Pt => ({ x: (u.x + v.x) / 2, y: (u.y + v.y) / 2 });
    const p1 = handle(a, dirA, dx);
    const p2 = handle(b, dirB, -dx);
    // de Casteljau split at t = 1/2
    const q0 = mid(a, p1), q1 = mid(p1, p2), q2 = mid(p2, b);
    const r0 = mid(q0, q1), r1 = mid(q1, q2), m = mid(r0, r1);
    // slack: the middle drops by a share of the cable's length, so a long cable droops more than a short one
    const sag = this.sway * 0.75 * (0.6 * Math.hypot(b.x - a.x, b.y - a.y) + 40);
    if (sag <= 0) return [a, q0, r0, m, r1, q2, b];
    const lead = (p: Pt, q: Pt): Pt => {
      const len = Math.hypot(q.x - p.x, q.y - p.y) || 1;
      // the lead shortens as the slack grows, so the bend comes close to the plug
      const k = (len * (1 - 0.55 * this.sway) + 0.08 * sag) / len;
      return { x: p.x + (q.x - p.x) * k, y: p.y + (q.y - p.y) * k };
    };
    const drop = (p: Pt): Pt => ({ x: p.x, y: p.y + sag });
    return [a, lead(a, q0), drop(r0), drop(m), drop(r1), lead(b, q2), b];
  }

  private curve(a: Pt, b: Pt, dirA: CableEnd = 'side', dirB: CableEnd = 'side'): string {
    return pathOf(this.curvePts(a, b, dirA, dirB));
  }

  /** which way a cable leaves this jack */
  private endOf(el: HTMLElement): CableEnd {
    return this.inDock(el) ? 'up' : el.dataset.edge === 'bottom' ? 'down' : 'side';
  }

  /** the cables' continuation over the dock (see positionCables) */
  private get dockCables(): SVGSVGElement | null {
    return (this.dock?.parentElement?.querySelector('svg.dock-cables') as SVGSVGElement | null) ?? null;
  }
  /** a cable's copy on the dock overlay, clipped to the strip above each docked jack it ends at */
  private overPaths = new Map<SVGPathElement, { copy: SVGPathElement; clips: { rect: SVGRectElement; jack: HTMLElement }[] }>();

  private inDock(el: HTMLElement): boolean {
    return !!this.dock?.contains(el) || !!this.wheelHost?.contains(el);
  }

  /**
   * Cable paths are retained so animation only moves their endpoints. A cable to a docked jack is clipped by the canvas;
   * its copy on the dock's overlay draws the rest (the same curve, mapped from world to overlay space), but only the
   * strip between the jack and the dock's top edge: a cable to a module below the canvas's view stays under the panel.
   */
  /** the sidebar sliders' source cables, over everything up to their thumbs; each hidden while either end is not shown */
  /** the layer over the whole window for the cables into the sidebar sliders and the cable being dragged */
  private sideOverlay(): SVGSVGElement {
    if (!this.sideLayer) {
      this.sideLayer = document.createElementNS(SVGNS, 'svg') as SVGSVGElement;
      this.sideLayer.setAttribute('class', 'cables slack-cable');
      this.sideLayer.setAttribute('aria-hidden', 'true');
      document.body.append(this.sideLayer);
    }
    return this.sideLayer;
  }

  positionSideCables(): void {
    this.sideOverlay();
    const w = this.world.getBoundingClientRect();
    const keep = new Set<SVGPathElement>();
    for (const [key, thumb] of this.sideThumbs) {
      const from = this.patch[key];
      const src = from && this.ports.get(this.key(from.module, from.port, 'out'));
      if (!src || !src.isConnected || this.canvas.offsetParent === null || thumb.offsetParent === null) continue;
      let path = this.sideLayer!.querySelector<SVGPathElement>(`path[data-key="${key}"]`);
      if (!path) {
        path = document.createElementNS(SVGNS, 'path');
        path.dataset.key = key;
        path.addEventListener('click', () => this.setSideSource(key, null));
        this.sideLayer!.append(path);
      }
      keep.add(path);
      const m = this.patch.modules.find((x) => x.id === from!.module)!;
      const kind = DEFS[m.type].outputs.find((o) => o.name === from!.port)?.kind ?? 'control';
      path.setAttribute('class', `cable ${kind}${m.type === 'fm1' && isKnob(from!.port) ? ` knob-${from!.port}` : ''}`);
      path.setAttribute('aria-label', 'A sidebar slider\'s source: click to unplug');
      // into the thumb's centre (it moves with the live value), from above
      const r = thumb.getBoundingClientRect();
      const b = { x: (r.left + r.width / 2 - w.left) / this.zoom, y: (r.top + r.height / 2 - w.top) / this.zoom };
      path.setAttribute('d', this.curve(this.center(src), b, this.endOf(src), 'up'));
      path.setAttribute('transform', `translate(${w.left} ${w.top}) scale(${this.zoom})`);
    }
    for (const p of [...this.sideLayer!.querySelectorAll<SVGPathElement>('path[data-key]')]) if (!keep.has(p)) p.remove();
  }

  private positionCables(): void {
    this.positionSideCables();
    const w = this.world.getBoundingClientRect();
    const o = this.dockCables?.getBoundingClientRect();
    for (const { path, from, to, origin } of this.cablePaths) {
      const pts = this.curvePts(this.center(from, origin), this.center(to, origin), this.endOf(from), this.endOf(to));
      path.setAttribute('d', pathOf(pts));
      const over = this.overPaths.get(path);
      if (!over || !o) continue;
      over.copy.setAttribute('d', pathOf(pts.map((p) => ({ x: p.x * this.zoom + w.left - o.left, y: p.y * this.zoom + w.top - o.top }))));
      for (const { rect, jack } of over.clips) {
        const j = jack.getBoundingClientRect();
        rect.setAttribute('x', String(j.left - o.left - CLIP_HALF));
        rect.setAttribute('width', String(j.width + 2 * CLIP_HALF));
        rect.setAttribute('y', '0');
        rect.setAttribute('height', String(Math.max(0, j.top - o.top + j.height / 2)));
      }
    }
  }

  private inputJack(to: Endpoint): HTMLElement | undefined {
    return this.ports.get(this.key(to.module, to.port, 'in')) ?? [...this.ports.values()].find((dot) =>
      dot.dataset.also && (JSON.parse(dot.dataset.also) as Target[]).some((t) => sameEnd(t, to)));
  }

  /** Outside cables end at side jacks; internal branches are editable input-to-parameter routes. */
  drawCables(): void {
    this.positionSideCables();
    for (const { path } of this.cablePaths) path.remove();
    this.cablePaths = [];
    this.dockCables?.replaceChildren();
    this.overPaths.clear();
    for (const svg of this.modulesEl.querySelectorAll('.internal-cables, .entry-cables')) svg.remove();
    const internalLayers = new Map<HTMLElement, SVGSVGElement>();
    const entryLayers = new Map<HTMLElement, SVGSVGElement>();
    for (const dot of [...this.ports.values(), ...this.sliderPorts.map((p) => p.jack)]) dot.classList.remove('connected');
    const add = (from: HTMLElement, to: HTMLElement, kind: string, remove: (() => void) | null, title: string, internal = false, cable?: Cable): void => {
      const path = document.createElementNS(SVGNS, 'path');
      path.setAttribute('class', `cable ${kind}${internal ? ' alias' : ''}${remove ? '' : ' fixed'}`);
      path.setAttribute('aria-label', title);
      if (remove) {
        path.setAttribute('role', 'button');
        path.setAttribute('tabindex', '0');
        path.addEventListener('pointerdown', (e) => e.stopPropagation());
        path.addEventListener('click', (e) => { e.stopPropagation(); remove(); });
        path.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); remove(); }
        });
      }
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
      this.cablePaths.push({ path, from, to, origin, cable });
      const over = this.dockCables;
      if (over && origin === this.world && (this.inDock(from) || this.inDock(to))) {
        const copy = document.createElementNS(SVGNS, 'path');
        copy.setAttribute('class', path.getAttribute('class')!);
        const clip = document.createElementNS(SVGNS, 'clipPath');
        clip.id = `dock-clip-${this.overPaths.size}`;
        const clips = [from, to].filter((j) => this.inDock(j)).map((jack) => {
          const rect = document.createElementNS(SVGNS, 'rect');
          clip.append(rect);
          return { rect, jack };
        });
        copy.setAttribute('clip-path', `url(#${clip.id})`);
        over.append(clip, copy);
        this.overPaths.set(path, { copy, clips });
      }
      // a cable into a card's interior (to a thumb, a picker's or a switch's jack) runs under the card like every cable;
      // a copy on the card, clipped to it, draws the stretch over the card up to the jack
      const card = !internal && origin === this.world ? to.closest<HTMLElement>('.module') : null;
      if (card && to.classList.contains('slider-port')) {
        let entry = entryLayers.get(card);
        if (!entry) {
          entry = document.createElementNS(SVGNS, 'svg');
          entry.setAttribute('class', 'cables entry-cables');
          card.append(entry); entryLayers.set(card, entry);
        }
        const copy = document.createElementNS(SVGNS, 'path');
        copy.setAttribute('class', path.getAttribute('class')!);
        if (remove) {
          copy.addEventListener('pointerdown', (e) => e.stopPropagation());
          copy.addEventListener('click', (e) => { e.stopPropagation(); remove(); });
          const t = document.createElementNS(SVGNS, 'title'); t.textContent = title; copy.append(t);
        }
        entry.append(copy);
        this.cablePaths.push({ path: copy, from, to, origin: card, cable });
      }
      if (internal && remove) {
        // a thin route is hard to hit: an invisible path 1.5x as wide takes the clicks, above the card's controls
        const hit = document.createElementNS(SVGNS, 'path');
        hit.setAttribute('class', 'cable-hit');
        hit.addEventListener('pointerdown', (e) => e.stopPropagation());
        hit.addEventListener('click', (e) => { e.stopPropagation(); remove(); });
        hit.addEventListener('pointerenter', () => path.classList.add('hover'));
        hit.addEventListener('pointerleave', () => path.classList.remove('hover'));
        layer.append(hit);
        this.cablePaths.push({ path: hit, from, to, origin });
      }
    };
    // Show the assignment even without an upstream cable, so it can be edited before patching a source. A dedicated
    // input's link (ParamDef.input) is built into the module: drawn grey, not editable.
    for (const { m, pd, jack } of this.sliderPorts) for (const port of parameterInputs(m, pd)) {
      const side = this.inputJack({ module: m.id, port });
      if (!side || (this.inDock(side) && this.inDock(jack))) continue; // the dock draws no routes inside itself
      if (port === pd.input) {
        if (side.closest('.erow') && side.closest('.erow') === jack.closest('.erow')) continue; // on its parameter's row: the row shows the link
        add(side, jack, 'control', null, `Built in: ${port} sets ${pd.name}`, true);
      }
      else add(side, jack, 'control', () => this.change(() => {
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
      const src = this.patch.modules.find((m) => m.id === c.from.module)!;
      let kind = DEFS[src.type].outputs.find((o) => o.name === c.from.port)!.kind;
      if (src.type === 'fm1' && isKnob(c.from.port)) kind += ` knob-${c.from.port}`;
      if (b) {
        const key = `${c.from.module}:${c.from.port}:${b.dataset.mod}:${b.dataset.port}`;
        if (!physicalCables.has(key)) add(a, b, kind, () => this.removeCable(c), 'Disconnect cable', false, c);
        physicalCables.add(key);
      } else
        // a pin has no jack: its cable is drawn to every thumb it feeds, and each drawn cable removes just that route
        for (const { jack, pd } of thumbs) add(a, jack, kind, () => this.change(() => removeRoute(this.patch, c, pd.name)), `Disconnect from ${longName(this.patch.modules.find((x) => x.id === c.to.module)!.type, pd.name)}`, false, c);
    }
    this.refreshKnobTicks();
    this.positionCables();
  }

  /** set a parameter from outside the cards (the deck's knobs): as a slider would, the card follows on its next refresh */
  setParam(id: number, name: string, v: number): void {
    const m = this.patch.modules.find((x) => x.id === id);
    if (!m || m.params[name] === v) return;
    m.params[name] = v;
    this.ev.onParam(id, name, v);
    this.refreshKnobTicks();
    for (const d of this.parameterDisplays) if (d.id === id) d.update(null);
  }

  /** the knob ticks under every slider an FM-1 knob reaches: where that knob alone leaves the parameter at rest */
  private refreshKnobTicks(): void {
    const rests = knobRests(this.patch);
    for (const { m, pd, ticks } of this.sliderPorts)
      ticks((rests.get(`${m.id}:${pd.name}`) ?? []).map((r) => ({ knob: r.knob, unit: toUnit(pd, r.value) })));
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
    // the cable being dragged: in the layer over the whole window (not the canvas's), so it shows over the sidebar on its way
    // to a sidebar slider's thumb
    const path = document.createElementNS(SVGNS, 'path');
    path.setAttribute('class', 'cable pending');
    this.sideOverlay().append(path);
    this.setPatching(true);
    const move = (ev: PointerEvent): void => {
      const c = this.world.getBoundingClientRect();
      const p = { x: (ev.clientX - c.left) / this.zoom, y: (ev.clientY - c.top) / this.zoom };
      const s = this.center(start);
      const end = this.endOf(start);
      path.setAttribute('d', kind === 'out' ? this.curve(s, p, end) : this.curve(p, s, 'side', end));
      path.setAttribute('transform', `translate(${c.left} ${c.top}) scale(${this.zoom})`);
    };
    const cancel = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      path.remove();
      this.drag = null;
      this.setPatching(false);
    };
    const up = (ev: PointerEvent): void => {
      const t = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
      const dot = t?.closest('.dot') as HTMLElement | null;
      cancel();
      // an output dropped on the sidebar's cable slack bar sways the cables
      // an output dropped on a sidebar slider whose thumb is a jack (cable slack, zoom) patches it
      const side = kind === 'out' ? (t?.closest('[data-side]') as HTMLElement | null)?.dataset.side as SideKey | undefined : undefined;
      if (side) return this.setSideSource(side, { module: Number(start.dataset.mod), port: start.dataset.port! });
      if (dot === start) {
        this.armed = start;
        start.classList.add('armed');
        this.setPatching(true);
      } else if (dot?.dataset.mod) this.connectJacks(start, dot);
    };
    this.drag = { path, cancel };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    move(e);
  }
}
