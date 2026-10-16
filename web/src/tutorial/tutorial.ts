// SPDX-License-Identifier: GPL-3.0-only
// The tutorial runtime: a draggable step panel, the chapter menu, progress in localStorage, the checks polled against
// the editor and highlighted targets. The course is data (course.json, compiled by ./chapters.ts), the model in
// ./model.ts, the design in docs/TUTORIAL.md.
import { Audition } from './audition';
import { lessonChallenge, lessonProse, tickRequirements } from './markdown';
import { keepVariation, variations } from './variations';
import type { Patch } from '../patch';
import type { AssemblyDef } from '../assembly';
import { assemblyOf, hiddenModules } from '../assembly';
import type { Editor } from '../editor';
import { CHAPTERS, LISTED, TOUR, offered, chapterStart, chapterEnd, stepStart, tutorialDef } from './chapters';
import { noSeen, stepDone, type Chapter, type Seen, type Step, type Target, type TutorialState } from './model';

export interface TutorialHost {
  editor: Editor;
  audioOn(): boolean;
  mute(on: boolean): void;
  startAudio(): Promise<void>;
  preview(p: Patch | null): void;
  /** replace the open patch (the host's loadNamed) */
  load(p: Patch): void;
  note(on: boolean, note?: number, vel?: number): void;
  library(): AssemblyDef[];
  saveAssembly(def: AssemblyDef): void;
  snapshot(side: 'A' | 'B'): void;
  flipAB(): void;
  share(): Promise<void>;
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
  page?: 'intro' | 'steps' | 'done';
  stepId?: string;
}
const STORE = 'matryoshka.tutorial';
/** set by the offer card's "Don't show this again" */
const OFFER_OFF = 'matryoshka.tutorial-offer-off';
const POLL_MS = 400;
/** a done step shows its check mark this long, then the tutorial moves on by itself */
const ADVANCE_MS = 900;

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
  private lastSaved?: AssemblyDef;
  private entry: Patch | null = null;
  private timer = 0;
  private audition: Audition;
  private auditionMode = '';
  private previewing = false;
  private previewTimer = 0;
  private previewTransport = false;
  private previewMuted = false;
  private error = '';
  private followTarget = false;
  /** the chapter page: the intro before the steps, the steps, the end */
  private page: 'intro' | 'steps' | 'done' = 'intro';
  private lastRender = '';
  /** the patch as the learner had it when entering each step of this chapter: Back restarts a step from it */
  private entries = new Map<number, Patch>();
  /** the element the panel sits beside and where it was; a drag pins the panel until the target changes */
  private beside: Element | null = null;
  private besideRect = '';
  private pinned = false;
  /** the pending auto-advance, and whether it is held off (after Back, the step is re-read until Next is pressed) */
  private advanceTimer = 0;
  private hold = false;
  /** the requirements of the checkbox the learner clicked: the highlight points at them while they are unmet */
  private clicked: string[] | null = null;

  constructor(private host: TutorialHost) {
    this.panel.setAttribute('role', 'region');
    this.panel.setAttribute('aria-label', 'Tutorial');
    document.body.append(this.panel, this.menu);
    this.menu.addEventListener('close', () => this.render(true));
    window.addEventListener('blur', () => this.stop());
    this.audition = new Audition((on, note, vel) => this.host.note(on, note, vel), async () => { await this.host.startAudio(); if (!this.host.audioOn()) throw new Error('Audio could not start'); });
    this.progress = this.loadProgress();
    this.page = this.progress.page ?? (this.progress.step > 0 ? 'steps' : 'intro');
    this.entry = structuredClone(this.host.editor.patch);
    window.addEventListener('resize', () => { if (this.active) { this.pinned = false; this.place(this.beside, true); }; this.fit(); });
    // a step's text can grow the panel after it was placed (a longer step, Why opened, an image loading)
    new ResizeObserver(() => this.fit()).observe(this.panel);
  }

  // ---- progress

  private loadProgress(): Progress {
    try {
      const raw = JSON.parse(localStorage.getItem(STORE) ?? 'null') as Partial<Progress> | null;
      if (raw && Array.isArray(raw.done)) {
        // progress in a chapter that is no longer offered (unpublished since) starts from the menu
        const ch = CHAPTERS.find((c, k) => offered(k) && c.id === raw.chapter);
        const named = ch?.steps.findIndex((st) => st.id === raw.stepId) ?? -1;
        const step = named >= 0 ? named : Math.max(0, Math.min(ch ? ch.steps.length - 1 : 0, Math.floor(Number(raw.step) || 0)));
        return { done: raw.done.filter((d) => CHAPTERS.some((c) => c.id === d)), chapter: ch?.id ?? null, step, page: raw.page === 'done' || raw.page === 'steps' ? raw.page : 'intro' };
      }
    } catch { /* storage optional */ }
    return { done: [], chapter: null, step: 0 };
  }
  private saveProgress(): void {
    this.progress.page = this.page;
    this.progress.stepId = this.step?.id;
    try { localStorage.setItem(STORE, JSON.stringify(this.progress)); } catch { /* storage optional */ }
  }

  get active(): boolean { return !this.panel.hidden && this.progress.chapter !== null; }
  private get chapterIndex(): number { return CHAPTERS.findIndex((c) => c.id === this.progress.chapter); }
  private get chapter(): Chapter | null { return CHAPTERS[this.chapterIndex] ?? null; }
  private get step(): Step | null { return this.chapter?.steps[this.progress.step] ?? null; }

  // ---- what the checks see

  private state(): TutorialState {
    const e = this.host.editor;
    return {
      patch: e.patch, entry: this.entry ?? e.patch, zoom: e.zoom, probes: e.probes, arpPlay: e.arpPlay, audio: this.host.audioOn(),
      lastSaved: this.lastSaved, selected: e.selected, library: this.host.library(), snapshots: e.snapshots, seen: this.seen,
    };
  }

  /** also told about every event (the lesson editor's link to this synth, in development) */
  observer?: { event(name: keyof Seen): void; saved(def: AssemblyDef): void };
  private happened(name: keyof Seen): void { this.seen[name]++; this.observer?.event(name); this.refresh(); }

  /** the host reports what happened; the step panel re-checks */
  noteOn(): void { this.happened('notes'); }
  newPatchPressed(): void { this.happened('news'); }
  undone(): void { this.happened('undos'); }
  redone(): void { this.happened('redos'); }
  zoomed(): void { this.happened('zooms'); }
  flipped(): void { this.happened('flips'); }
  saved(def: AssemblyDef): void { this.lastSaved = structuredClone(def); this.seen.saves++; this.observer?.saved(def); this.refresh(); }
  shared(): void { this.happened('shares'); }
  bypassed(): void { this.happened('bypasses'); }
  refresh(): void { if (this.active) this.render(); }

  // ---- entry points

  /** every visit, until "Don't show this again" is ticked: a card in the middle of the screen offering the tutorial (or
   * the chapter the learner is in), and the tour for those who know synths. Ticking the box points at where the tutorial
   * lives from then on. */
  welcome(): void {
    try { if (localStorage.getItem(OFFER_OFF)) return; } catch { /* storage optional: offer anyway */ }
    const ci = this.chapterIndex;
    const resume = this.chapter && offered(ci) ? this.chapter : null;
    const card = el('section', { class: 'tutorial-offer' });
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-labelledby', 'tutorial-offer-title');
    const onKey = (ev: KeyboardEvent): void => { if (ev.key === 'Escape') close(); };
    const close = (): void => { card.remove(); this.clearFocus(); document.removeEventListener('keydown', onKey); };
    const go = (): void => {
      close();
      if (resume) { this.panel.hidden = false; this.render(true); this.schedule(); } else this.start(LISTED[0]);
    };
    // the sidebar folds away on narrow screens: then the way in is its toggle
    const compact = window.matchMedia('(max-width: 700px)').matches;
    const where = el('p', { class: 'tutorial-offer-where', hidden: true },
      'You can start the tutorial any time from ', el('strong', { textContent: compact ? '☰ Workspace → Tutorial ↗' : 'Tutorial ↗' }), compact ? ' (highlighted above).' : ' in the sidebar (highlighted).');
    where.setAttribute('aria-live', 'polite');
    const box = el('input', { type: 'checkbox' });
    box.onchange = () => {
      try { if (box.checked) localStorage.setItem(OFFER_OFF, '1'); else localStorage.removeItem(OFFER_OFF); } catch { /* storage optional */ }
      where.hidden = !box.checked;
      this.clearFocus();
      if (box.checked) document.getElementById(compact ? 'sidebar-toggle' : 'tour-btn')?.classList.add('tour-focus');
    };
    card.append(
      el('h2', { id: 'tutorial-offer-title', textContent: resume ? (resume.tour ? 'Pick up the tour?' : 'Pick up the tutorial?') : 'New here? Take the tutorial' }),
      el('p', { textContent: resume
        ? `You were ${resume.tour ? 'on the tour' : `in chapter ${LISTED.indexOf(ci) + 1}`}, ${resume.title}. Carry on where you left off.`
        : 'Short chapters build synths from modules, one cable at a time, and show the editor on the way. Each chapter starts from a prepared patch.' }),
      el('div', { class: 'tour-actions' },
        this.button(resume ? 'Resume' : 'Start the tutorial', go, true),
        ...(TOUR >= 0 && TOUR !== ci ? [this.button('I know what I’m doing, just show me around', () => { close(); this.start(TOUR); })] : []),
        this.button('Not now', close)),
      el('label', { class: 'tutorial-offer-check' }, box, ' Don’t show this again'),
      where,
    );
    document.body.append(card);
    document.addEventListener('keydown', onKey);
  }

  /** the chapter menu */
  open(): void {
    this.stop();
    this.cancelAdvance();
    // the tour first, unnumbered
    const rows = [...(TOUR >= 0 ? [TOUR] : []), ...LISTED].map((i) => {
      const c = CHAPTERS[i];
      const done = this.progress.done.includes(c.id);
      const current = this.progress.chapter === c.id;
      const row = el('div', { class: 'tutorial-row' + (done ? ' done' : '') + (current ? ' current' : '') + (c.tour ? ' tour' : '') },
        el('span', { class: 'n', textContent: done ? '✓' : c.tour ? '→' : String(LISTED.indexOf(i) + 1) }),
        el('span', { class: 'grow', textContent: c.title }, ...(c.published ? [] : [el('small', { class: 'tutorial-unpublished', textContent: 'unpublished' })])),
        el('button', { textContent: current ? 'Resume' : done ? 'Again' : 'Start', class: current ? 'primary' : '', onclick: () => { this.menu.close(); if (current) { this.panel.hidden = false; this.render(true); this.schedule(); } else this.start(i); } }));
      return row;
    });
    const saved = this.variationList();
    this.menu.replaceChildren(
      el('h2', { textContent: 'Tutorial' }),
      el('p', { class: 'muted', textContent: 'Each chapter builds a patch; later chapters reuse what you saved. Start anywhere: every chapter opens its own patch.' }),
      el('div', { class: 'tutorial-rows' }, ...rows),
      el('details', {}, el('summary', { textContent: 'Your saved variations' }), saved),
      el('div', { class: 'tour-actions' },
        el('button', { textContent: 'Reset progress', onclick: () => { this.close(); this.page = 'intro'; this.progress = { done: [], chapter: null, step: 0 }; this.saveProgress(); this.menu.close(); this.panel.hidden = true; this.host.status('tutorial progress reset'); } }),
        el('form', { method: 'dialog' }, el('button', { textContent: 'Close' }))),
    );
    this.menu.showModal();
  }

  /** begin chapter i: every chapter loads its own canned start (the open patch goes to the bank first unless it is a
   * tutorial patch), so no difference from an earlier chapter can carry over */
  start(i: number): void {
    const ch = CHAPTERS[i];
    if (!ch || !offered(i)) return;
    this.stop();
    this.cancelAdvance();
    if (!this.keepCurrent()) return;
    this.host.arpPlay(false);
    this.host.load(chapterStart(i));
    this.progress.chapter = ch.id;
    this.progress.step = 0;
    this.hold = false;
    clearTimeout(this.advanceTimer); this.advanceTimer = 0;
    this.page = 'intro';
    this.entries.clear();
    this.saveProgress();
    this.enterStep();
    this.panel.hidden = false;
    this.render(true);
    this.schedule();
  }

  private enterStep(): void {
    this.entry = JSON.parse(JSON.stringify(this.host.editor.patch)) as Patch;
    if (this.page === 'steps') this.entries.set(this.progress.step, structuredClone(this.entry));
    this.seen = noSeen();
    this.lastSaved = undefined;
    this.error = '';
    this.clicked = null;
  }

  private schedule(): void {
    clearInterval(this.timer);
    this.timer = window.setInterval(() => { if (this.active) { this.render(); this.refocus(); } else clearInterval(this.timer); }, POLL_MS);
  }

  close(): void {
    this.stop();
    this.cancelAdvance();
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
    handle.onkeydown = (ev) => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home'].includes(ev.key)) return;
      ev.preventDefault(); ev.stopPropagation();
      if (ev.key === 'Home') { this.pinned = false; this.followTarget = false; this.place(null, true); return; }
      const r = this.panel.getBoundingClientRect(); this.pinned = true;
      this.panel.style.left = `${Math.max(0, Math.min(window.innerWidth - r.width, r.left + (ev.key === 'ArrowLeft' ? -20 : ev.key === 'ArrowRight' ? 20 : 0)))}px`;
      this.panel.style.top = `${Math.max(0, Math.min(window.innerHeight - r.height, r.top + (ev.key === 'ArrowUp' ? -20 : ev.key === 'ArrowDown' ? 20 : 0)))}px`;
      this.panel.style.right = this.panel.style.bottom = 'auto';
    };
    const h = el('div', { class: 'tutorial-head' }, handle, this.button(this.followTarget ? 'Dock' : 'Follow', () => { this.followTarget = !this.followTarget; this.pinned = false; this.place(this.beside, true); this.render(true); }), el('h2', { textContent: title }), el('button', { class: 'x', textContent: '×', title: 'Hide the tutorial (the chapter menu brings it back)', onclick: () => this.close() }));
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

  private cancelAdvance(): void { clearTimeout(this.advanceTimer); this.advanceTimer = 0; }

  /** Silence: notes, preview, arpeggiator, and the output muted. The Stop button, a chapter change, closing, leaving the
   * window and the host's Panic command use it; moving between steps does not, so a riff keeps playing through them. */
  stop(): void {
    this.audition.stop(); this.auditionMode = '';
    clearTimeout(this.previewTimer);
    if (this.previewing) {
      this.previewing = false;
      this.host.preview(null);
      this.host.arpPlay(this.previewTransport);
    } else if (this.active) this.host.arpPlay(false);
    if (this.active) this.host.mute(true);
    if (this.active) this.render(true);
  }

  private async play(mode: 'note' | 'riff'): Promise<void> {
    this.auditionMode = mode;
    const p = this.host.editor.patch;
    if (this.chapterIndex === 9 && p.cables.some((c) => c.from.port === 'clock' && p.modules.some((m) => m.id === c.from.module && m.type === 'fm1'))) this.host.arpPlay(true);
    try { await this.audition.play(mode, this.page === 'steps' ? this.step?.riff : undefined); } catch (err) { this.error = String(err); this.auditionMode = ''; }
    if (this.active) this.render(true);
  }

  private auditionControls(): HTMLElement {
    const controls = el('div', { class: 'tour-actions tutorial-audition' });
    controls.setAttribute('aria-label', 'Audition');
    // no Chord: patches are mono unless a poly assembly says otherwise, so a chord would sound as one note
    for (const [mode, label] of [['note', 'Note'], ['riff', 'Riff']] as const) {
      const b = this.button(label, () => { if (this.auditionMode === mode) { this.audition.stop(); this.auditionMode = ''; this.render(true); } else void this.play(mode); });
      b.setAttribute('aria-pressed', String(this.auditionMode === mode)); controls.append(b);
    }
    controls.append(this.button('Release notes', () => { this.audition.stop(); this.auditionMode = ''; this.render(true); }), this.button('Stop', () => this.stop()));
    return controls;
  }

  private endPreview(): void {
    if (!this.previewing) return;
    this.audition.stop(); this.auditionMode = ''; clearTimeout(this.previewTimer);
    this.previewing = false; this.host.preview(null);
    this.host.arpPlay(this.previewTransport); this.host.mute(this.previewMuted); this.render(true);
  }

  private preview(): void {
    if (this.previewing) { this.endPreview(); return; }
    this.previewTransport = this.host.editor.arpPlay;
    this.previewMuted = !this.host.audioOn();
    this.previewing = true;
    this.host.preview(chapterEnd(this.chapterIndex));
    if (this.chapterIndex >= 9) this.host.arpPlay(true);
    void this.play('riff');
    this.previewTimer = window.setTimeout(() => this.endPreview(), 8000);
    this.render(true);
  }

  private keepCurrent(name?: string): boolean {
    try {
      const p = this.host.editor.patch;
      const saved = keepVariation({ ...p, name: name?.trim() || p.name }, this.progress.chapter);
      this.host.status(`Saved “${saved.patch.name}” in Tutorial → Your saved variations`);
      return true;
    } catch (err) {
      this.error = `Could not save your variation: ${String(err)}. Your patch is still open; export it before changing chapters.`;
      this.host.status(this.error); this.render(true); return false;
    }
  }

  private saveControls(): HTMLElement {
    const name = el('input', { value: this.host.editor.patch.name, placeholder: 'Name your variation' });
    name.setAttribute('aria-label', 'Variation name');
    return el('div', { class: 'tour-actions' }, name, this.button('Save variation', () => this.keepCurrent(name.value)));
  }

  private variationList(): HTMLElement {
    const list = el('div');
    try {
      for (const v of variations().reverse()) list.append(el('div', { class: 'tutorial-row' },
        el('span', { class: 'grow', textContent: `${v.patch.name} · ${new Date(v.saved).toLocaleString()}` }),
        this.button('Restore', () => { if (!this.keepCurrent()) return; this.close(); this.menu.close(); this.host.load(JSON.parse(JSON.stringify(v.patch)) as Patch); this.progress.chapter = null; this.saveProgress(); })));
      if (!list.childElementCount) list.append('Your chapter changes and named variations will appear here.');
    } catch (err) { list.textContent = `Variations could not be read: ${String(err)}`; }
    return list;
  }

  /** redraw when something the panel shows changed (or `force`) */
  private render(force = false): void {
    const ch = this.chapter;
    if (!ch) return;
    const i = this.chapterIndex;
    const s = this.state();
    const st = this.step;
    const done = this.page === 'steps' && st ? stepDone(ch, this.progress.step, s) : { met: false, moot: false };
    const ok = done.met || done.moot;
    const broken = this.page === 'steps' ? ch.steps.slice(0, this.progress.step).map((x, k) => (!x.transient && !x.superseded && !x.check(s) ? k : -1)).filter((k) => k >= 0) : [];
    const key = JSON.stringify([i, this.page, this.progress.step, ok, broken, this.error, this.previewing, this.auditionMode, this.page === 'steps' ? st?.met?.(s) : null, this.clicked]);
    if (!force && key === this.lastRender) return;
    this.lastRender = key;
    const count = el('span', { class: 'tour-count', textContent: `${ch.tour ? 'Tour' : `Chapter ${LISTED.indexOf(i) + 1} of ${LISTED.length}`}${ch.published ? '' : ' (unpublished)'} · ${ch.title}` });
    const parts: (Node | string)[] = [this.head(this.page === 'steps' && st ? st.title : this.page === 'done' ? (ch.tour ? 'Tour done' : 'Chapter done') : ch.title), count];
    if (this.error) parts.push(el('p', { class: 'tutorial-warn', textContent: this.error }));
    if (this.page === 'intro') {
      parts.push(lessonProse(ch.intro));
      parts.push(el('p', { textContent: 'Your previous patch was saved in Tutorial → Your saved variations. Each chapter starts from a prepared patch; your own sketches remain recoverable.' }));
      parts.push(this.button(this.previewing ? 'Stop preview' : 'Preview the finished sound', () => this.preview()));
      parts.push(el('div', { class: 'tour-actions' }, this.button('Begin', () => { this.endPreview(); void this.host.startAudio(); this.page = 'steps'; this.enterStep(); this.saveProgress(); this.render(true); }, true), this.button('Chapters', () => this.open())));
    } else if (this.page === 'steps' && st) {
      parts.push(el('span', { class: 'tour-step', textContent: `Step ${this.progress.step + 1} of ${ch.steps.length}${ok ? (this.hold || st.listen ? ' · ✓ ready when you are' : ' · ✓ done, moving on') : ''}` }));
      parts.push(this.checklist(lessonProse(st.text), ok ? null : st.met?.(s) ?? {}));
      if (st.why) parts.push(el('details', { class: 'tutorial-why' }, el('summary', { textContent: 'Why' }), lessonProse(st.why)));
      if (st.playback !== false) parts.push(this.auditionControls());
      if (broken.length) {
        const k = broken[0];
        parts.push(el('p', { class: 'tutorial-warn', textContent: `Step ${k + 1} (${ch.steps[k].title}) no longer holds: put it back, or go Back to redo it.` }));
      }
      const actions = el('div', { class: 'tour-actions' });
      if (this.progress.step > 0) actions.append(this.button('← Back', () => this.back()));
      actions.append(this.button('↺ Start step over', () => this.restartStep()));
      if (st.optional) actions.append(this.button('Skip optional exercise', () => this.advance(true)));
      if (ok && !broken.length && (this.hold || st.listen)) actions.append(this.button(this.progress.step < ch.steps.length - 1 ? 'Continue →' : 'Finish', () => this.advance(), true));
      parts.push(actions);
      parts.push(el('details', {}, el('summary', { textContent: 'Keep a variation' }), this.saveControls()));
      if (ok && !broken.length && !st.listen && !this.hold && !this.menu.open && !this.advanceTimer) this.advanceTimer = window.setTimeout(() => { this.advanceTimer = 0; const d = stepDone(ch, this.progress.step, this.state()); if (this.active && !this.menu.open && this.step === st && (d.met || d.moot)) this.advance(); }, ADVANCE_MS);
      if ((!ok || broken.length || this.menu.open) && this.advanceTimer) { clearTimeout(this.advanceTimer); this.advanceTimer = 0; }
    } else {
      // after the tour, the first chapter
      const next = ch.tour ? LISTED[0] : LISTED[LISTED.indexOf(i) + 1];
      const last = next === undefined;
      parts.push(lessonProse(ch.payoff ?? 'Your instrument is ready to play.'));
      parts.push(lessonChallenge(ch.challenge ?? 'Make it your own.'));
      parts.push(this.auditionControls());
      parts.push(this.saveControls());
      parts.push(el('p', { textContent: last ? 'Keep your performance with Save variation. Find your sketches in Tutorial → Your saved variations, or share this patch from Commands.' : 'The next chapter saves a recoverable copy of this patch before loading its prepared start. Find every copy in Tutorial → Your saved variations.' }));
      parts.push(el('div', { class: 'tour-actions' },
        ...(last ? [] : [this.button(`Chapter ${LISTED.indexOf(next) + 1}: ${CHAPTERS[next].title}`, () => this.start(next), true)]),
        this.button('Save patch to the bank', () => this.host.status(this.host.bankSave(this.host.editor.patch))),
        this.button('Chapters', () => this.open()),
        this.button('Close', () => this.close())));
    }
    this.panel.replaceChildren(...parts);
    this.focus(this.targetsOf(st, s), this.wanting(st, s));
  }

  /** restart the previous step from the patch it began with (the learner's own, else the canned one); the current patch is
   * kept as a variation first */
  private back(): void {
    const ch = this.chapter;
    if (!ch || this.progress.step === 0) return;
    this.cancelAdvance();
    if (!this.keepCurrent()) return;
    const k = this.progress.step - 1;
    const start = this.entries.get(k) ?? stepStart(this.chapterIndex, k);
    this.host.load(structuredClone(start));
    this.progress.step = k;
    this.hold = true;
    this.saveProgress();
    this.enterStep();
    this.render(true);
  }

  /** put the patch back as it was when this step began (the learner's own, else the canned one); undoable, so the
   * editor's Undo brings the discarded work back */
  private restartStep(): void {
    if (!this.chapter || this.page !== 'steps') return;
    this.cancelAdvance();
    const start = structuredClone(this.entries.get(this.progress.step) ?? stepStart(this.chapterIndex, this.progress.step));
    const e = this.host.editor;
    const target = e.patch as unknown as Record<string, unknown>;
    e.transact(() => { for (const k of Object.keys(target)) delete target[k]; Object.assign(target, start); });
    this.hold = false;
    this.enterStep();
    this.host.status('Step started over. Undo brings your changes back.');
    this.render(true);
  }

  private advance(optional = false): void {
    const ch = this.chapter;
    if (!ch || this.page !== 'steps') return;
    const s = this.state();
    if (!(optional && this.step?.optional) && !this.step?.check(s)) return;
    if (ch.steps.slice(0, this.progress.step).some((st) => !st.transient && !st.superseded && !st.check(s))) return;
    if (this.host.editor.patch.name === 'init') this.host.rename(ch.patchName); // the user's own New patch
    clearTimeout(this.advanceTimer); this.advanceTimer = 0;
    this.hold = false;
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
      return document.querySelector(`.module[data-id="${id}"], .dock-main[data-id="${id}"]`);
    };
    switch (t.kind) {
      case 'module': return card(t.id);
      case 'asm': return document.querySelector(`.module[data-asm="${t.id}"], .frame[data-asm="${t.id}"]`);
      case 'port': return document.querySelector(`.dot[data-mod="${t.id}"][data-port="${t.port}"][data-dir="${t.dir}"]`) ?? card(t.id);
      case 'param': return document.querySelector(`.slider-port[data-mod="${t.id}"][data-param="${t.param}"]`)?.closest('.param')
        ?? (/^k[1-4]$/.test(t.param) ? document.querySelector(`.deck-knob[data-param="${t.param}"]`) : null) ?? card(t.id); // Main's knobs are on the deck
      // the button, else its output's jack (the output is hidden inside a closed assembly), else the card
      case 'probe': return document.querySelector(`.dot[data-mod="${t.id}"][data-port="${t.port}"][data-dir="out"]`) ?? card(t.id);
      case 'ui': return document.getElementById(t.id);
      case 'poly': return document.querySelector(`.poly-item[data-asm="${t.id}"][data-setting="${t.setting}"]`) ?? document.querySelector(`.poly-btn[data-asm="${t.id}"]`)
        ?? document.querySelector(`.module[data-asm="${t.id}"], .frame[data-asm="${t.id}"]`);
    }
  }

  /** the editor rebuilds its cards on every change: re-apply the highlight and follow the target each tick */
  private refocus(): void {
    const s = this.state();
    this.focus(this.targetsOf(this.step, s), this.wanting(this.step, s));
  }

  /** the text's checkboxes: ticked when their requirements are met (all of them when `met` is null: the step is done),
   * the first unticked one marked as next; clicking one points the highlight at its controls */
  private checklist(prose: HTMLElement, met: Record<string, boolean> | null): HTMLElement {
    for (const box of tickRequirements(prose, met, this.clicked?.join() ?? null)) {
      box.addEventListener('click', (e) => {
        if ((e.target as Element).closest('a')) return;
        this.clicked = box.classList.contains('done') ? null : (box.dataset.req ?? '').split(',');
        this.render(true); this.refocus();
      });
    }
    return prose;
  }

  /** what the current step points at: the clicked checkbox's or else the first unmet part's elements, else the step's
   * fallback target */
  private targetsOf(st: Step | null, s: TutorialState): Target[] {
    if (this.page !== 'steps' || !st) return [];
    const pin = this.clicked;
    if (pin && pin.some((id) => !st.met?.(s)[id])) { const t = st.targetsOf?.(pin, s) ?? []; if (t.length) return t; }
    const f = st.focus?.(s) ?? [];
    return f.length ? f : st.target?.(s) ?? [];
  }

  /** whether the current step still asks for something: a task step until its requirements are met, a Continue step's
   * pointer always */
  private wanting(st: Step | null, s: TutorialState): boolean {
    const ch = this.chapter;
    if (!ch || !st || this.page !== 'steps') return false;
    if (st.kind === 'continue') return true;
    const d = stepDone(ch, this.progress.step, s);
    return !(d.met || d.moot);
  }

  /** highlight the targets (unless `highlight` is off: the step is done, the panel stays anchored beside them) */
  private focus(targets: Target[], highlight = true): void {
    this.clearFocus();
    const els = targets.map((t) => this.resolve(t)).filter((x): x is Element => !!x);
    if (highlight) for (const x of els) x.classList.add('tour-focus');
    const outside = els.filter((x) => !this.panel.contains(x));
    const first = outside[0] ?? null;
    if (this.followTarget && first && first !== this.beside && first.closest('#canvas')) first.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (first || !els.length) this.place(first, false, outside);
  }

  /**
   * Put the panel beside the element the step points at (right, left, below or above it, whichever fits the viewport without
   * covering it), so the eye does not travel between the text and the highlight. Repositions when the target or its place
   * changes, not while the user has dragged the panel; without a target the panel returns to the bottom right corner.
   */
  /**
   * A panel placed by its top edge (Follow, a drag, the middle of the screen) keeps its bottom on screen: as it grows it
   * moves up until it reaches the top margin, and only then scrolls. The docked panel grows up from the bottom corner by
   * CSS and needs nothing here.
   */
  private fit(): void {
    const s = this.panel.style;
    if (this.panel.hidden || !s.top || s.top === 'auto') { s.removeProperty('max-height'); return; }
    const margin = 12, H = window.innerHeight;
    s.maxHeight = `${H - 2 * margin}px`;
    const top = parseFloat(s.top), h = this.panel.offsetHeight;
    if (top + h > H - margin) s.top = `${Math.max(margin, H - margin - h)}px`;
  }

  private place(el: Element | null, force = false, avoid: Element[] = []): void {
    if (window.innerWidth <= 650 || (!this.followTarget && !this.pinned)) {
      this.panel.style.removeProperty('left'); this.panel.style.removeProperty('top');
      this.panel.style.removeProperty('right'); this.panel.style.removeProperty('bottom');
      this.fit(); this.beside = el; return;
    }
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
      this.fit();
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
    this.fit();
  }
}

/** the user's saved tutorial assembly or the bundled copy, for the host's Examples list and tests */
export { tutorialDef };
