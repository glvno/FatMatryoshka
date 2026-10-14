// SPDX-License-Identifier: GPL-3.0-only
// The tutorial runtime: a draggable step panel, the chapter menu, progress in localStorage, the checks polled against
// the editor, highlighted targets, and the Actions adapter "do it for me" uses. Chapters are in ./chapters.ts, the
// model in ./model.ts, the design in docs/TUTORIAL.md.
import type { Patch } from '../patch';
import type { AssemblyDef } from '../assembly';
import { assemblyOf, hiddenModules } from '../assembly';
import type { Editor } from '../editor';
import { CHAPTERS, chapterStart, tutorialDef } from './chapters';
import { completes, noSeen, type Actions, type Chapter, type Seen, type Step, type Target, type TutorialState } from './model';

export interface TutorialHost {
  editor: Editor;
  audioOn(): boolean;
  startAudio(): void;
  /** replace the open patch (the host's loadNamed) */
  load(p: Patch): void;
  note(on: boolean): void;
  library(): AssemblyDef[];
  saveAssembly(def: AssemblyDef): void;
  snapshot(side: 'A' | 'B'): void;
  flipAB(): void;
  share(): void;
  arpPlay(on: boolean): void;
  probe(id: number, port: string): void;
  bypass(id: number, on: boolean): void;
  /** keep a patch in the bank; returns a status line */
  bankSave(p: Patch): string;
  /** rename the open patch */
  rename(name: string): void;
  status(msg: string): void;
}

interface Progress {
  done: string[];
  chapter: string | null;
  step: number;
}
const STORE = 'matryoshka.tutorial';
const SEEN = 'fatmatryoshka.tour-seen';
const POLL_MS = 400;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  const { class: cls, ...rest } = props as Record<string, unknown>;
  if (cls) e.className = String(cls);
  Object.assign(e, rest);
  e.append(...kids);
  return e;
}

export class Tutorial {
  private panel = el('section', { class: 'tutorial', hidden: true });
  private menu = el('dialog', { class: 'help tutorial-menu' });
  private progress: Progress = { done: [], chapter: null, step: 0 };
  private seen: Seen = noSeen();
  private entry: Patch | null = null;
  private timer = 0;
  private sounding = false;
  /** the chapter page: the intro before the steps, the steps, the end */
  private page: 'intro' | 'steps' | 'done' = 'intro';
  private lastRender = '';
  private actions: Actions;
  /** the element the panel sits beside and where it was; a drag pins the panel until the target changes */
  private beside: Element | null = null;
  private besideRect = '';
  private pinned = false;

  constructor(private host: TutorialHost) {
    this.panel.setAttribute('role', 'region');
    this.panel.setAttribute('aria-label', 'Tutorial');
    document.body.append(this.panel, this.menu);
    this.menu.addEventListener('close', () => this.render(true));
    window.addEventListener('blur', () => this.release());
    this.progress = this.loadProgress();
    this.actions = this.makeActions();
    window.addEventListener('resize', () => { if (this.active && !this.pinned) this.place(this.beside, true); });
  }

  // ---- progress

  private loadProgress(): Progress {
    try {
      const raw = JSON.parse(localStorage.getItem(STORE) ?? 'null') as Partial<Progress> | null;
      if (raw && Array.isArray(raw.done)) return { done: raw.done.filter((d) => typeof d === 'string'), chapter: typeof raw.chapter === 'string' ? raw.chapter : null, step: Number(raw.step) || 0 };
    } catch { /* storage optional */ }
    return { done: [], chapter: null, step: 0 };
  }
  private saveProgress(): void {
    try { localStorage.setItem(STORE, JSON.stringify(this.progress)); } catch { /* storage optional */ }
  }
  private markSeen(): void { try { localStorage.setItem(SEEN, '1'); } catch { /* storage optional */ } }

  get active(): boolean { return !this.panel.hidden && this.progress.chapter !== null; }
  private get chapterIndex(): number { return CHAPTERS.findIndex((c) => c.id === this.progress.chapter); }
  private get chapter(): Chapter | null { return CHAPTERS[this.chapterIndex] ?? null; }
  private get step(): Step | null { return this.chapter?.steps[this.progress.step] ?? null; }

  // ---- what the checks see

  private state(): TutorialState {
    const e = this.host.editor;
    return {
      patch: e.patch, entry: this.entry ?? e.patch, zoom: e.zoom, probes: e.probes, arpPlay: e.arpPlay, audio: this.host.audioOn(),
      selected: e.selected, library: this.host.library(), snapshots: e.snapshots, seen: this.seen,
    };
  }

  /** the host reports what happened; the step panel re-checks */
  noteOn(): void { this.seen.notes++; this.refresh(); }
  undone(): void { this.seen.undos++; this.refresh(); }
  redone(): void { this.seen.redos++; this.refresh(); }
  zoomed(): void { this.seen.zooms++; this.refresh(); }
  flipped(): void { this.seen.flips++; this.refresh(); }
  shared(): void { this.seen.shares++; this.refresh(); }
  bypassed(): void { this.seen.bypasses++; this.refresh(); }
  refresh(): void { if (this.active) this.render(); }

  // ---- do it for me

  private makeActions(): Actions {
    const h = this.host;
    const e = h.editor;
    return {
      patch: () => e.patch,
      edit: (fn) => { if (!e.transact(() => fn(e.patch))) e.rebuild(); },
      load: (p) => h.load(p),
      setZoom: (z) => e.setZoom(z),
      zoomToFit: () => e.zoomToFit(),
      probe: (id, port) => h.probe(id, port),
      arpPlay: (on) => h.arpPlay(on),
      select: (ids) => e.selectOnly(ids),
      undo: () => e.undo(),
      redo: () => e.redo(),
      note: () => { h.note(true); window.setTimeout(() => h.note(false), 400); },
      startAudio: () => h.startAudio(),
      saveAssembly: (def, tag) => h.saveAssembly({ ...def, tutorial: tag }),
      library: () => h.library(),
      snapshot: (side) => h.snapshot(side),
      flipAB: () => h.flipAB(),
      share: () => h.share(),
      bypass: (id, on) => h.bypass(id, on),
    };
  }

  private doStep(i: number): void {
    const ch = this.chapter;
    if (!ch) return;
    const st = ch.steps[i];
    try {
      if (!st.check(this.state())) st.apply(this.actions, this.state());
    } catch (err) {
      this.host.status(`tutorial: ${(err as Error).message}`);
    }
  }

  // ---- entry points

  /** the first visit: offer chapter 1 */
  welcome(): void {
    try { if (localStorage.getItem(SEEN) || localStorage.getItem(STORE)) return; } catch { /* storage optional */ }
    this.panel.hidden = false;
    this.panel.replaceChildren(
      this.head('Tutorial'),
      el('p', { textContent: 'Eleven short chapters build synths from modules, one cable at a time, and show the editor on the way: assemblies, your library, the scope, the arpeggiator. Every step can be done for you.' }),
      el('div', { class: 'tour-actions' },
        this.button('Start chapter 1', () => this.start(0), true),
        this.button('Later', () => { this.markSeen(); this.panel.hidden = true; })),
    );
    this.place(null, true);
  }

  /** the chapter menu */
  open(): void {
    this.markSeen();
    const rows = CHAPTERS.map((c, i) => {
      const done = this.progress.done.includes(c.id);
      const current = this.progress.chapter === c.id;
      const row = el('div', { class: 'tutorial-row' + (done ? ' done' : '') + (current ? ' current' : '') },
        el('span', { class: 'n', textContent: done ? '✓' : String(i + 1) }),
        el('span', { class: 'grow', textContent: c.title }),
        el('button', { textContent: current ? 'Resume' : done ? 'Again' : 'Start', class: current ? 'primary' : '', onclick: () => { this.menu.close(); if (current) { this.panel.hidden = false; this.render(true); } else this.start(i); } }));
      return row;
    });
    this.menu.replaceChildren(
      el('h2', { textContent: 'Tutorial' }),
      el('p', { class: 'muted', textContent: 'Each chapter builds a patch; later chapters reuse what you saved. Start anywhere: a chapter that does not continue your patch opens its own.' }),
      el('div', { class: 'tutorial-rows' }, ...rows),
      el('div', { class: 'tour-actions' },
        el('button', { textContent: 'Reset progress', onclick: () => { this.progress = { done: [], chapter: null, step: 0 }; this.saveProgress(); this.menu.close(); this.panel.hidden = true; this.host.status('tutorial progress reset'); } }),
        el('form', { method: 'dialog' }, el('button', { textContent: 'Close' }))),
    );
    this.menu.showModal();
  }

  /** begin chapter i: continue with the open patch when it finishes chapter i−1, else load the canned start */
  start(i: number): void {
    const ch = CHAPTERS[i];
    if (!ch) return;
    this.markSeen();
    this.release();
    const e = this.host.editor;
    const open = e.patch;
    const tutorialPatch = /^Tutorial\b/.test(open.name);
    if (!tutorialPatch && (open.modules.length > 2 || open.cables.length)) this.host.status(this.host.bankSave(open));
    let note = '';
    if (ch.keep) {
      if (open.modules.length <= 2 && !open.cables.length && !tutorialPatch) this.host.rename(ch.patchName);
    } else {
      const fresh = ch.start();
      if (fresh) this.host.load(fresh);
      else if (i > 0 && completes(CHAPTERS[i - 1], open, this.host.library())) note = 'Continuing with your patch.';
      else {
        this.host.load(chapterStart(i));
        note = i > 0 ? `Your patch does not continue chapter ${i}, so the chapter starts from its own copy.` : '';
      }
    }
    this.progress.chapter = ch.id;
    this.progress.step = 0;
    this.saveProgress();
    this.page = 'intro';
    this.enterStep();
    this.panel.hidden = false;
    this.render(true);
    if (note) this.host.status(note);
    this.schedule();
  }

  private enterStep(): void {
    this.entry = JSON.parse(JSON.stringify(this.host.editor.patch)) as Patch;
    this.seen = noSeen();
  }

  private schedule(): void {
    clearInterval(this.timer);
    this.timer = window.setInterval(() => { if (this.active) { this.render(); this.refocus(); } else clearInterval(this.timer); }, POLL_MS);
  }

  close(): void {
    this.release();
    this.panel.hidden = true;
    clearInterval(this.timer);
    this.clearFocus();
  }

  // ---- the panel

  private button(text: string, action: () => void, primary = false): HTMLButtonElement {
    const b = el('button', { textContent: text });
    b.classList.toggle('primary', primary);
    b.onclick = action;
    return b;
  }

  private head(title: string): HTMLElement {
    const handle = el('button', { class: 'tutorial-handle', textContent: '⋮⋮', title: 'Drag to move' });
    handle.setAttribute('aria-label', 'Move the tutorial panel');
    this.drag(handle);
    const h = el('div', { class: 'tutorial-head' }, handle, el('h2', { textContent: title }), el('button', { class: 'x', textContent: '×', title: 'Hide the tutorial (the chapter menu brings it back)', onclick: () => this.close() }));
    return h;
  }

  private drag(handle: HTMLElement): void {
    handle.onpointerdown = (ev) => {
      ev.preventDefault();
      handle.setPointerCapture(ev.pointerId);
      const r = this.panel.getBoundingClientRect();
      const dx = ev.clientX - r.left;
      const dy = ev.clientY - r.top;
      this.pinned = true;
      this.panel.classList.add('dragging');
      const move = (m: PointerEvent): void => {
        const x = Math.max(0, Math.min(window.innerWidth - r.width, m.clientX - dx));
        const y = Math.max(0, Math.min(window.innerHeight - 40, m.clientY - dy));
        this.panel.style.left = `${x}px`; this.panel.style.top = `${y}px`;
        this.panel.style.right = 'auto'; this.panel.style.bottom = 'auto';
      };
      handle.onpointermove = move;
      handle.onpointerup = handle.onlostpointercapture = () => { handle.onpointermove = null; this.panel.classList.remove('dragging'); };
    };
  }

  private release(): void { if (this.sounding) { this.sounding = false; this.host.note(false); } }

  private noteButton(): HTMLButtonElement {
    const hold = el('button', { class: 'tour-note', id: 'tutorial-note', textContent: 'Hold to play C' });
    const press = (): void => { if (!this.sounding) { this.sounding = true; this.host.note(true); } };
    hold.onpointerdown = (e) => { e.preventDefault(); hold.setPointerCapture(e.pointerId); press(); };
    hold.onpointerup = hold.onlostpointercapture = () => this.release();
    hold.onkeydown = (e) => { if ([' ', 'Enter'].includes(e.key)) { e.preventDefault(); e.stopPropagation(); press(); } };
    hold.onkeyup = (e) => { if ([' ', 'Enter'].includes(e.key)) { e.preventDefault(); e.stopPropagation(); this.release(); } };
    hold.onblur = () => this.release();
    return hold;
  }

  /** redraw when something the panel shows changed (or `force`) */
  private render(force = false): void {
    const ch = this.chapter;
    if (!ch) return;
    const i = this.chapterIndex;
    const s = this.state();
    const st = this.step;
    const ok = this.page === 'steps' && !!st && st.check(s);
    const broken = this.page === 'steps' ? ch.steps.slice(0, this.progress.step).map((x, k) => (!x.transient && !x.superseded && !x.check(s) ? k : -1)).filter((k) => k >= 0) : [];
    const key = JSON.stringify([i, this.page, this.progress.step, ok, broken, s.audio, ok ? [] : st?.todo?.(s) ?? []]);
    if (!force && key === this.lastRender) return;
    this.lastRender = key;
    const count = el('span', { class: 'tour-count', textContent: `Chapter ${i + 1} of ${CHAPTERS.length} · ${ch.title}` });
    const parts: (Node | string)[] = [this.head(this.page === 'steps' && st ? st.title : this.page === 'done' ? 'Chapter done' : ch.title), count];
    if (!s.audio) parts.push(el('p', { class: 'tutorial-hint', textContent: 'Audio is off: click Enable audio in the sidebar to hear the patch.' }));
    if (this.page === 'intro') {
      parts.push(el('p', { textContent: ch.intro }));
      parts.push(el('div', { class: 'tour-actions' }, this.button('Begin', () => { this.page = 'steps'; this.enterStep(); this.render(true); }, true), this.button('Chapters', () => this.open())));
    } else if (this.page === 'steps' && st) {
      parts.push(el('span', { class: 'tour-step', textContent: `Step ${this.progress.step + 1} of ${ch.steps.length}${ok ? ' · ✓ done' : ''}` }));
      parts.push(el('p', { textContent: st.text }));
      if (st.why) parts.push(el('details', { class: 'tutorial-why' }, el('summary', { textContent: 'Why' }), el('p', { textContent: st.why })));
      const todo = ok ? [] : st.todo?.(s) ?? [];
      if (todo.length) parts.push(el('div', { class: 'tutorial-todo' }, el('span', { textContent: 'Still to do' }), el('ul', {}, ...todo.map((t) => el('li', { textContent: t })))));
      if (st.id === 'note' || st.id === 'wave' || st.id === 'shape') parts.push(this.noteButton());
      if (broken.length) {
        const k = broken[0];
        parts.push(el('p', { class: 'tutorial-warn' }, `Step ${k + 1} (${ch.steps[k].title}) no longer holds. `, el('button', { class: 'sm', textContent: 'Restore', onclick: () => { for (let j = k; j < this.progress.step; j++) this.doStep(j); this.render(true); } })));
      }
      const actions = el('div', { class: 'tour-actions' });
      if (this.progress.step > 0) actions.append(this.button('← Back', () => { this.progress.step--; this.saveProgress(); this.enterStep(); this.render(true); }));
      const next = this.button(this.progress.step < ch.steps.length - 1 ? 'Next →' : 'Finish', () => this.advance(), true);
      next.disabled = !ok;
      actions.append(this.button('Do it for me', () => { this.doStep(this.progress.step); this.advance(); }), next);
      parts.push(actions);
    } else {
      const last = i === CHAPTERS.length - 1;
      parts.push(el('p', { textContent: last ? 'You have built eleven patches and five assemblies, and used every sound source Matryoshka has. The Library tab holds what you saved; the Examples menu has every chapter’s result under Tutorial.' : `The patch stays open; chapter ${i + 2} ${CHAPTERS[i + 1].start() ? 'starts a new one' : 'continues it'}.` }));
      parts.push(el('div', { class: 'tour-actions' },
        ...(last ? [] : [this.button(`Chapter ${i + 2}: ${CHAPTERS[i + 1].title}`, () => this.start(i + 1), true)]),
        this.button('Save patch to the bank', () => this.host.status(this.host.bankSave(this.host.editor.patch))),
        this.button('Chapters', () => this.open()),
        this.button('Close', () => this.close())));
    }
    this.panel.replaceChildren(...parts);
    this.focus(this.targetsOf(st, s));
  }

  private advance(): void {
    const ch = this.chapter;
    if (!ch) return;
    this.release();
    if (this.progress.step < ch.steps.length - 1) {
      this.progress.step++;
      this.enterStep();
    } else {
      if (!this.progress.done.includes(ch.id)) this.progress.done.push(ch.id);
      this.page = 'done';
      this.clearFocus();
    }
    this.saveProgress();
    this.render(true);
  }

  // ---- targets

  private clearFocus(): void {
    for (const x of document.querySelectorAll('.tour-focus')) x.classList.remove('tour-focus');
  }

  private resolve(t: Target): Element | null {
    const p = this.host.editor.patch;
    const hidden = hiddenModules(p);
    const card = (id: number): Element | null => {
      if (hidden.has(id)) {
        const a = assemblyOf(p, id);
        return a ? document.querySelector(`.module[data-asm="${a.id}"]`) : null;
      }
      return document.querySelector(`.module[data-id="${id}"]`);
    };
    switch (t.kind) {
      case 'module': return card(t.id);
      case 'asm': return document.querySelector(`.module[data-asm="${t.id}"], .frame[data-asm="${t.id}"]`);
      case 'port': return document.querySelector(`.dot[data-mod="${t.id}"][data-port="${t.port}"][data-dir="${t.dir}"]`) ?? card(t.id);
      case 'param': return document.querySelector(`.slider-port[data-mod="${t.id}"][data-param="${t.param}"]`)?.closest('.param') ?? card(t.id);
      case 'ui': return document.getElementById(t.id);
    }
  }

  /** the editor rebuilds its cards on every change: re-apply the highlight and follow the target each tick */
  private refocus(): void {
    this.focus(this.targetsOf(this.step, this.state()));
  }

  /** what the current step points at: the first unmet part's elements, else the step's fallback target */
  private targetsOf(st: Step | null, s: TutorialState): Target[] {
    if (this.page !== 'steps' || !st) return [];
    const f = st.focus?.(s) ?? [];
    return f.length ? f : st.target?.(s) ?? [];
  }

  private focus(targets: Target[]): void {
    this.clearFocus();
    const els = targets.map((t) => this.resolve(t)).filter((x): x is Element => !!x);
    for (const x of els) x.classList.add('tour-focus');
    const outside = els.filter((x) => !this.panel.contains(x));
    const first = outside[0] ?? null;
    if (first && first !== this.beside && first.closest('#canvas')) first.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (first || !els.length) this.place(first, false, outside);
  }

  /**
   * Put the panel beside the element the step points at (right, left, below or above it, whichever fits the viewport without
   * covering it), so the eye does not travel between the text and the highlight. Repositions when the target or its place
   * changes, not while the user has dragged the panel; without a target the panel returns to the bottom right corner.
   */
  private place(el: Element | null, force = false, avoid: Element[] = []): void {
    if (window.innerWidth <= 650) return; // docked to the bottom edge there
    const rect = el?.getBoundingClientRect();
    const key = rect ? [Math.round(rect.left / 8), Math.round(rect.top / 8), Math.round(rect.width / 8)].join(',') : `none:${this.page}:${this.progress.chapter}:${this.progress.step}`;
    const changed = el !== this.beside;
    if (!force && !changed && key === this.besideRect) return;
    if (changed) this.pinned = false;
    this.beside = el;
    this.besideRect = key;
    if (this.pinned) return;
    const style = this.panel.style;
    if (!rect || (!rect.width && !rect.height)) {
      // nothing to sit beside: the middle of the screen
      style.right = style.bottom = 'auto';
      style.left = `${Math.max(12, Math.round((window.innerWidth - this.panel.offsetWidth) / 2))}px`;
      style.top = `${Math.max(12, Math.round((window.innerHeight - this.panel.offsetHeight) / 2))}px`;
      return;
    }
    const gap = 16;
    const margin = 12;
    const w = this.panel.offsetWidth;
    const h = this.panel.offsetHeight;
    const W = window.innerWidth;
    const H = window.innerHeight;
    const clampY = (y: number): number => Math.max(margin, Math.min(H - h - margin, y));
    const clampX = (x: number): number => Math.max(margin, Math.min(W - w - margin, x));
    const others = avoid.map((x) => x.getBoundingClientRect());
    const clear = (x: number, y: number): boolean => others.every((o) => x >= o.right + 4 || x + w <= o.left - 4 || y >= o.bottom + 4 || y + h <= o.top - 4);
    const spots: { x: number; y: number; fits: boolean }[] = [
      { x: rect.right + gap, y: clampY(rect.top), fits: rect.right + gap + w + margin <= W },
      { x: rect.left - gap - w, y: clampY(rect.top), fits: rect.left - gap - w >= margin },
      { x: clampX(rect.left), y: rect.bottom + gap, fits: rect.bottom + gap + h + margin <= H },
      { x: clampX(rect.left), y: rect.top - gap - h, fits: rect.top - gap - h >= margin },
      // beside the far edge of everything highlighted, when the near spots cover one of them
      { x: Math.max(...others.map((o) => o.right)) + gap, y: clampY(rect.top), fits: Math.max(...others.map((o) => o.right)) + gap + w + margin <= W },
      { x: Math.min(...others.map((o) => o.left)) - gap - w, y: clampY(rect.top), fits: Math.min(...others.map((o) => o.left)) - gap - w >= margin },
      { x: clampX(rect.left), y: Math.max(...others.map((o) => o.bottom)) + gap, fits: Math.max(...others.map((o) => o.bottom)) + gap + h + margin <= H },
    ];
    const spot = spots.find((s) => s.fits && clear(s.x, s.y)) ?? spots.find((s) => s.fits) ?? spots[0];
    style.right = style.bottom = 'auto';
    style.left = `${clampX(spot.x)}px`;
    style.top = `${clampY(spot.y)}px`;
  }
}

/** the user's saved tutorial assembly or the bundled copy, for the host's Examples list and tests */
export { tutorialDef };
