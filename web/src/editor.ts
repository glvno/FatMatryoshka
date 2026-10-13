// SPDX-License-Identifier: GPL-3.0-only
// Patch editor: module cards on a canvas, SVG cables, drag-to-connect, a selection, assemblies and undo.
import { DEFS } from './modules';
import { deviceBudget, DEVICE } from './patchbin';
import {
  addModule,
  fromUnit,
  toUnit,
  SOURCES,
  type Source,
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
} from './patch';
import {
  addMember,
  assembliesOf,
  assemblyOf,
  deleteAssembly,
  demote,
  exposePort,
  fixAssemblies,
  hiddenModules,
  hidePort,
  insertAssembly,
  isExposed,
  isPromoted,
  makeAssembly,
  moveAssembly,
  overlapping,
  promote,
  reconcileAll,
  removeMember,
  tileMembers,
  toDef,
  ungroup,
  type AssemblyDef,
  type AssemblyInst,
} from './assembly';

const SVGNS = 'http://www.w3.org/2000/svg';
const HISTORY = 40;
/** the frame around an open assembly: padding around its cards and the height of its header */
const FRAME_PAD = 12;
const FRAME_HEAD = 30;

export interface EditorEvents {
  /** structure changed (modules or cables): the engine needs the whole patch */
  onStructure(p: Patch): void;
  /** a knob moved: cheap update */
  onParam(id: number, name: string, value: number): void;
  /** an attenuverter of a parameter input moved (index 0 = p1, 1 = p2) */
  onAtt(id: number, index: number, value: number): void;
  /** cards were moved: positions changed, nothing the engine needs */
  onLayout(p: Patch): void;
  /** a message for the status line */
  onError(msg: string): void;
  /** "save" on an assembly: put this definition into the library */
  onSaveAssembly(def: AssemblyDef): void;
}

type Pt = { x: number; y: number };
type Rect = { x: number; y: number; w: number; h: number };

export class Editor {
  patch: Patch;
  /** the selected modules (shift-click or a rubber band); "Make assembly" groups them, dragging one moves all */
  readonly selected = new Set<number>();
  private modulesEl: HTMLElement;
  private svg: SVGSVGElement;
  private ports = new Map<string, HTMLElement>();
  private cards = new Map<number, HTMLElement>();
  private frames = new Map<number, HTMLElement>();
  private drag: { from: Endpoint; kind: 'out' | 'in'; path: SVGPathElement } | null = null;
  private history: string[] = [];
  private future: string[] = [];

  constructor(private canvas: HTMLElement, patch: Patch, private ev: EditorEvents) {
    this.patch = patch;
    this.modulesEl = canvas.querySelector('#modules')!;
    this.svg = canvas.querySelector('#cables')! as unknown as SVGSVGElement;
    this.report(fixAssemblies(this.patch, DEFS));
    window.addEventListener('resize', () => this.drawCables());
    canvas.addEventListener('pointerdown', (e) => this.rubberBand(e));
    window.addEventListener('keydown', (e) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return;
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
    this.selected.clear();
    this.rebuild();
    this.ev.onStructure(p);
  }

  private report(msgs: string[]): void {
    if (msgs.length) this.ev.onError(msgs.join('; '));
  }

  /** where the next card goes: a grid by the number of cards */
  private slot(): Pt {
    const n = this.patch.modules.length - hiddenModules(this.patch).size + assembliesOf(this.patch).filter((a) => !a.open).length;
    return { x: 20 + (n % 4) * 270, y: 20 + Math.floor(n / 4) * 560 };
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
    const name = window.prompt('Name of the assembly', 'assembly')?.trim();
    if (!name) return;
    const ids = [...this.selected];
    if (this.change(() => makeAssembly(this.patch, ids, name))) this.selected.clear();
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
    this.modulesEl.replaceChildren();
    this.ports.clear();
    this.cards.clear();
    this.frames.clear();
    const poly = voiceSplit(this.patch);
    const hidden = hiddenModules(this.patch);
    for (const id of this.selected) if (!this.patch.modules.some((m) => m.id === id) || hidden.has(id)) this.selected.delete(id);
    for (const a of assembliesOf(this.patch)) if (a.open) this.modulesEl.append(this.frame(a, a.modules.some((id) => poly.has(id))));
    for (const m of this.patch.modules) {
      if (hidden.has(m.id)) continue;
      const a = assemblyOf(this.patch, m.id);
      this.modulesEl.append(this.card(m, DEFS[m.type], poly.has(m.id), a));
    }
    for (const a of assembliesOf(this.patch)) if (!a.open) this.modulesEl.append(this.container(a, a.modules.some((id) => poly.has(id))));
    this.sizeCanvas();
    requestAnimationFrame(() => {
      this.layoutFrames();
      this.drawCables();
    });
  }

  private sizeCanvas(): void {
    const xs = [...this.patch.modules.map((m) => m.x), ...assembliesOf(this.patch).map((a) => a.x)];
    const ys = [...this.patch.modules.map((m) => m.y), ...assembliesOf(this.patch).map((a) => a.y)];
    this.canvas.style.minWidth = `${Math.max(900, ...xs.map((x) => x + 270))}px`;
    this.canvas.style.minHeight = `${Math.max(520, ...ys.map((y) => y + 560))}px`;
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

  /** a module card; inside an open assembly its ports and parameters get the expose / pin toggles */
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
    head.append(title, del);
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
    if (def.paramInputs) body.append(this.pins(m, def, open), this.matrix(m, def));
    if (def.type === 'fm1') params.append(this.voicesRow());
    body.append(params);
    el.append(head, body);
    return el;
  }

  /** one parameter slider (or check box); `label` overrides the name (a promoted parameter on an assembly card) */
  private paramRow(m: ModuleInst, def: ModuleDef, pd: ParamDef, o: { open?: AssemblyInst; label?: string; rename?: () => void } = {}): HTMLElement {
    const row = document.createElement('label');
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
    const fmt = (v: number): string => (pd.choices ? pd.choices[Math.round(v)] : `${Number(v.toFixed(3))}${pd.unit ? ' ' + pd.unit : ''}`);
    val.textContent = fmt(m.params[pd.name]);
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
    input.oninput = () => {
      const v = pd.log ? Math.round(fromUnit(pd, Number(input.value) / 1000)) : Number(input.value);
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
        this.ev.onParam(m.id, pd.name, v);
      };
    }
    row.append(name, val, input);
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

  /** the two parameter inputs, each with an attenuverter (-1..1: scale and invert) */
  private pins(m: ModuleInst, def: ModuleDef, open?: AssemblyInst): HTMLElement {
    const box = document.createElement('div');
    box.className = 'pins';
    def.inputs
      .filter((p) => p.pin)
      .forEach((p, i) => {
        const row = document.createElement('div');
        row.className = 'pin';
        const jack = this.port(m, p, 'in', { open });
        const val = document.createElement('output');
        const att = m.att ?? [1, 1];
        val.textContent = att[i].toFixed(2);
        const input = document.createElement('input');
        input.type = 'range';
        input.min = '-1';
        input.max = '1';
        input.step = '0.01';
        input.value = String(att[i]);
        input.title = `${p.name} attenuverter: -1 inverts, 0 mutes`;
        input.setAttribute('aria-label', `${def.label} ${p.name} attenuverter`);
        input.oninput = () => {
          const v = Number(input.value);
          m.att![i] = v;
          val.textContent = v.toFixed(2);
          this.ev.onAtt(m.id, i, v);
        };
        row.append(jack, input, val);
        box.append(row);
      });
    return box;
  }

  /** which parameter each source controls: columns p1 p2 and the knobs k1..k4, one row per parameter */
  private matrix(m: ModuleInst, def: ModuleDef): HTMLElement {
    const t = document.createElement('table');
    t.className = 'matrix';
    t.title = 'p1 / p2: the parameter inputs. k1..k4: the FM-1 knobs, which change these parameters while the module is selected on the device.';
    const head = t.createTHead().insertRow();
    head.insertCell();
    for (const s of SOURCES) {
      const th = document.createElement('th');
      th.textContent = s;
      head.append(th);
    }
    const body = t.createTBody();
    for (const pd of def.params) {
      const row = body.insertRow();
      const name = row.insertCell();
      name.textContent = pd.name;
      for (const s of SOURCES as Source[]) {
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = m.map![s].includes(pd.name);
        box.setAttribute('aria-label', `${def.label}: ${s} controls ${pd.name}`);
        box.onchange = () => {
          this.change(() => {
            const list = m.map![s].filter((n) => n !== pd.name);
            if (box.checked) list.push(pd.name);
            m.map![s] = list;
          });
        };
        row.insertCell().append(box);
      }
    }
    return t;
  }

  /**
   * A port row. On a member card of an open assembly it gets the expose toggle; on an assembly card (`label`) the dot
   * still belongs to the inner module, so cables and drags work the same, and the label renames on click.
   */
  private port(m: ModuleInst, p: PortDef, dir: 'out' | 'in', o: { open?: AssemblyInst; label?: string; rename?: () => void } = {}): HTMLElement {
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
      const t = this.button(on ? '●' : '○', on ? `${p.name} is on the "${a.label}" card: click to hide it` : `show ${p.name} on the "${a.label}" card`, () =>
        this.change(() => (on ? hidePort(this.patch, a, dir, m.id, p.name) : exposePort(a, dir, m.id, p.name))),
      'tog');
      if (dir === 'in') parts.push(t);
      else parts.unshift(t);
    }
    row.append(...parts);
    dot.addEventListener('pointerdown', (e) => this.beginDrag(e, { module: m.id, port: p.name }, dir));
    this.ports.set(this.key(m.id, p.name, dir), dot);
    return row;
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
    return [
      this.button(a.open ? 'close' : 'open', a.open ? 'Collapse to one card' : 'Open: show and edit the modules inside', () =>
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

  /** the collapsed assembly: one card with the exposed ports and the promoted parameters */
  private container(a: AssemblyInst, perVoice: boolean): HTMLElement {
    const el = document.createElement('div');
    el.className = 'module assembly';
    el.style.left = `${a.x}px`;
    el.style.top = `${a.y}px`;
    el.dataset.asm = String(a.id);
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
      ins.append(this.port(m, pd, 'in', { label: r.label, rename: () => this.renameRef(r, 'input') }));
    }
    const outs = document.createElement('div');
    outs.className = 'ports out';
    for (const r of a.outputs) {
      const m = mod(r.module);
      const pd = DEFS[m.type].outputs.find((q) => q.name === r.port)!;
      outs.append(this.port(m, pd, 'out', { label: r.label, rename: () => this.renameRef(r, 'output') }));
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
        params.append(this.paramRow(m, def, def.params.find((q) => q.name === r.param)!, { label: r.label, rename: () => this.renameRef(r, 'parameter') }));
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

  /** the frame around an open assembly's cards, with its header; placed by layoutFrames() once the cards have a size */
  private frame(a: AssemblyInst, perVoice: boolean): HTMLElement {
    const el = document.createElement('div');
    el.className = 'frame';
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
    return el;
  }

  /** the box around the member cards of an open assembly, in canvas coordinates; `exclude` leaves cards out (while they are dragged) */
  private frameRect(a: AssemblyInst, exclude?: Set<number>): Rect | null {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const id of a.modules) {
      if (exclude?.has(id)) continue;
      const c = this.cards.get(id);
      if (!c) continue;
      x0 = Math.min(x0, c.offsetLeft);
      y0 = Math.min(y0, c.offsetTop);
      x1 = Math.max(x1, c.offsetLeft + c.offsetWidth);
      y1 = Math.max(y1, c.offsetTop + c.offsetHeight);
    }
    if (x0 === Infinity) return null;
    return { x: x0 - FRAME_PAD, y: y0 - FRAME_PAD - FRAME_HEAD, w: x1 - x0 + 2 * FRAME_PAD, h: y1 - y0 + 2 * FRAME_PAD + FRAME_HEAD };
  }

  private layoutFrames(exclude?: Set<number>): void {
    for (const a of assembliesOf(this.patch)) {
      const el = this.frames.get(a.id);
      if (!el) continue;
      const r = this.frameRect(a, exclude) ?? this.frameRect(a);
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
      const onMove = (ev: PointerEvent): void => {
        move(ev.clientX - lx, ev.clientY - ly);
        lx = ev.clientX;
        ly = ev.clientY;
      };
      const onUp = (): void => {
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

  /** after a drag: cards dropped into an open assembly's frame join it, members dragged out of theirs leave it */
  private membership(moved: ModuleInst[]): void {
    const movedIds = new Set(moved.map((m) => m.id));
    const inside = (c: HTMLElement, r: Rect): boolean => {
      const cx = c.offsetLeft + c.offsetWidth / 2;
      const cy = c.offsetTop + c.offsetHeight / 2;
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
        for (const a of assembliesOf(this.patch)) {
          if (!a.open) continue;
          const r = this.frameRect(a, movedIds);
          if (r && inside(c, r)) {
            ops.push(() => addMember(this.patch, a, m.id));
            break;
          }
        }
      }
    }
    if (!ops.length) {
      this.layoutFrames();
      return;
    }
    const keep = [...this.selected];
    if (this.change(() => ops.forEach((op) => op()))) this.select(keep);
  }

  private assemblyDrag(el: HTMLElement, handle: HTMLElement, a: AssemblyInst): void {
    this.dragOn(
      handle,
      () => true,
      (dx, dy) => {
        moveAssembly(this.patch, a, dx, dy);
        el.style.left = `${a.x}px`;
        el.style.top = `${a.y}px`;
        this.drawCables();
      },
      () => {
        this.sizeCanvas();
        this.ev.onLayout(this.patch);
      },
    );
  }

  private frameDrag(handle: HTMLElement, a: AssemblyInst): void {
    this.dragOn(
      handle,
      () => true,
      (dx, dy) => {
        a.x = Math.max(0, a.x + dx);
        a.y = Math.max(0, a.y + dy);
        for (const m of this.patch.modules) if (a.modules.includes(m.id)) this.place(m, dx, dy);
        this.layoutFrames();
        this.drawCables();
      },
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
    if (e.button !== 0 || t.closest('.module, .fhead, .dot, button, input, select')) return;
    e.preventDefault();
    const base = this.canvas.getBoundingClientRect();
    const at = (ev: PointerEvent): Pt => ({ x: ev.clientX - base.left + this.canvas.scrollLeft, y: ev.clientY - base.top + this.canvas.scrollTop });
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

  private center(el: HTMLElement): Pt {
    const r = el.getBoundingClientRect();
    const c = this.canvas.getBoundingClientRect();
    return { x: r.left - c.left + r.width / 2, y: r.top - c.top + r.height / 2 };
  }

  private curve(a: Pt, b: Pt): string {
    const dx = Math.max(40, Math.abs(b.x - a.x) / 2);
    return `M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`;
  }

  /** cables between visible ports; a cable inside a collapsed assembly has no dots and is not drawn */
  drawCables(): void {
    this.svg.replaceChildren();
    for (const c of this.patch.cables) {
      const a = this.ports.get(this.key(c.from.module, c.from.port, 'out'));
      const b = this.ports.get(this.key(c.to.module, c.to.port, 'in'));
      if (!a || !b) continue;
      const path = document.createElementNS(SVGNS, 'path');
      path.setAttribute('d', this.curve(this.center(a), this.center(b)));
      const kind = DEFS[this.patch.modules.find((m) => m.id === c.from.module)!.type].outputs.find((o) => o.name === c.from.port)!.kind;
      path.setAttribute('class', `cable ${kind}`);
      path.addEventListener('click', () => this.removeCable(c));
      const title = document.createElementNS(SVGNS, 'title');
      title.textContent = 'Click to remove';
      path.append(title);
      this.svg.append(path);
    }
  }

  private removeCable(c: Cable): void {
    this.change(() => disconnect(this.patch, c));
  }

  private beginDrag(e: PointerEvent, from: Endpoint, kind: 'out' | 'in'): void {
    e.preventDefault();
    e.stopPropagation();
    const start = this.ports.get(this.key(from.module, from.port, kind))!;
    const path = document.createElementNS(SVGNS, 'path');
    path.setAttribute('class', 'cable pending');
    this.svg.append(path);
    this.drag = { from, kind, path };
    const move = (ev: PointerEvent): void => {
      const c = this.canvas.getBoundingClientRect();
      const p = { x: ev.clientX - c.left, y: ev.clientY - c.top };
      const s = this.center(start);
      path.setAttribute('d', kind === 'out' ? this.curve(s, p) : this.curve(p, s));
    };
    const up = (ev: PointerEvent): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      path.remove();
      this.drag = null;
      const t = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
      const dot = t?.closest?.('.dot') as HTMLElement | null;
      if (!dot || !dot.dataset.mod) return;
      const other: Endpoint = { module: Number(dot.dataset.mod), port: dot.dataset.port! };
      const otherDir = dot.dataset.dir as 'out' | 'in';
      if (otherDir === kind) return this.ev.onError('connect an output to an input');
      const [o, i] = kind === 'out' ? [from, other] : [other, from];
      if (this.patch.cables.some((c) => sameEnd(c.from, o) && sameEnd(c.to, i))) return;
      this.change(() => {
        if (!connect(this.patch, DEFS, o, i)) throw new Error('cannot connect these ports');
      });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    move(e);
  }
}
