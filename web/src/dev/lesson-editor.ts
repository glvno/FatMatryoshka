// SPDX-License-Identifier: GPL-3.0-only
// The lesson editor (development only, /lesson-editor on the dev server): the whole tutorial course as data. Chapters and
// steps can be added, duplicated, reordered and deleted; a step's requirements are built from parts; roles name the
// assemblies the checks look for. The course is validated on every change (validate.ts) and a save with errors is
// refused. With the synth open in another tab, every requirement shows whether the synth's patch meets it, "Try this step"
// loads the step's beginning state there, and Record / Stop turns what the author does into requirements and the step's
// reference patch (capture.ts). Saves go to src/tutorial/course.json through the dev server.
import '../style.css';
import './lesson-editor.css';
import { DEFS } from '../modules';
import { PRESETS } from '../presets';
import type { Patch } from '../patch';
import { formatCourse, refKey, slugId, validateShape, ASSEMBLY_FACTS, EVENT_NAMES, PART_KINDS, SLIDER_OPS, type AssemblyFact, type ChapterData, type CourseData, type EventName, type Part, type PartKind, type Pointer, type Ref, type RoleDef, type SliderOp, type StartRule, type StepData } from '../tutorial/course-schema';
import { compileStep, stepStart } from '../tutorial/chapters';
import { momentary, partCheck, partLabel, refType } from '../tutorial/parts';
import { CUSTOM, ROLES } from '../tutorial/registry';
import { validateCourse, type Issue, type Report } from '../tutorial/validate';
import { capture, type Proposal } from '../tutorial/capture';
import { editorLink, linkedState, type SynthState } from '../tutorial/link';
import { lessonChallenge, lessonProse } from '../tutorial/markdown';

type Page =
  | { kind: 'chapter'; chapter: string }
  | { kind: 'step'; chapter: string; step: string }
  | { kind: 'roles' }
  | { kind: 'checks' };
type Snapshot = { revision: string; content: CourseData };
const API = '/__lesson-editor/content';
const DRAFT = 'matryoshka.lesson-editor.draft.v2';
const root = document.querySelector<HTMLDivElement>('#lesson-editor')!;

// ---- small DOM helpers

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = '') => {
  const node = document.createElement(tag); node.className = cls; node.textContent = text; return node;
};
const button = (text: string, action: () => void, cls = '', title = '') => {
  const node = el('button', cls, text); node.type = 'button'; node.onclick = action; if (title) node.title = title; return node;
};
const select = (options: [string, string][], value: string, onChange: (v: string) => void, label = ''): HTMLSelectElement => {
  const s = el('select');
  for (const [v, text] of options) s.append(new Option(text, v, false, v === value));
  if (!options.some(([v]) => v === value)) s.append(new Option(value || '—', value, false, true));
  s.onchange = () => onChange(s.value);
  if (label) s.setAttribute('aria-label', label);
  return s;
};
const numberInput = (value: number | undefined, onChange: (v: number | undefined) => void, label: string, step = 'any'): HTMLInputElement => {
  const i = el('input'); i.type = 'number'; i.step = step; i.value = value === undefined ? '' : String(value);
  i.setAttribute('aria-label', label); i.placeholder = label;
  i.oninput = () => onChange(i.value === '' ? undefined : Number(i.value));
  return i;
};
const textInput = (value: string, onChange: (v: string) => void, label: string, placeholder = ''): HTMLInputElement => {
  const i = el('input'); i.value = value; i.placeholder = placeholder || label; i.setAttribute('aria-label', label);
  i.oninput = () => onChange(i.value);
  return i;
};
const check = (text: string, value: boolean, onChange: (v: boolean) => void, hint = ''): HTMLLabelElement => {
  const l = el('label', 'lesson-check'); const c = el('input'); c.type = 'checkbox'; c.checked = value;
  c.onchange = () => onChange(c.checked);
  l.append(c, ` ${text}`);
  if (hint) l.append(el('small', 'muted', ` ${hint}`));
  return l;
};
const labelled = (text: string, ...kids: Node[]): HTMLElement => { const l = el('label', 'lesson-inline'); l.append(el('span', '', text), ...kids); return l; };
const copy = <T>(value: T): T => structuredClone(value);
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const wordCount = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;

const TYPES: [string, string][] = Object.values(DEFS).map((d) => [d.type, d.label] as [string, string]).sort((a, b) => a[1].localeCompare(b[1]));
const ORD = ['1st', '2nd', '3rd', '4th', '5th', '6th'];
const OPS: Record<SliderOp, string> = { le: '≤ at most', ge: '≥ at least', eq: '= exactly', ne: '≠ not', between: 'between', changed: 'moved from its start' };
const KINDS: Record<PartKind, string> = {
  module: 'Module present', cable: 'Cable', noCable: 'Cable removed', slider: 'Slider', routed: 'Routed to a parameter', pinMap: 'Pin map',
  att: 'Attenuverter', macroRange: 'Macro range', assembly: 'Assembly', voices: 'Voices', event: 'Event', sound: 'Sound', custom: 'Custom check',
};
const FACTS: Record<AssemblyFact, string> = { exists: 'exists', open: 'is expanded', collapsed: 'is collapsed', promoted: 'has a promoted slider', exposed: 'has an exposed output', merged: 'has merged inputs', contains: 'contains another assembly', resized: 'was resized', saved: 'was saved to the library' };
const EVENTS: Record<EventName, string> = {
  notes: 'notes played', undos: 'undo', redos: 'redo', zooms: 'zoom', flips: 'A/B flip', shares: 'share link', bypasses: 'bypass presses', news: 'New patch pressed', saves: 'assembly saves',
  audio: 'audio enabled', arpPlay: 'arpeggiator playing', snapshotA: 'snapshot A set', snapshotB: 'snapshot B set', probe: 'scope probe on a jack', selected: 'modules selected', bypassed: 'a module bypassed / on',
};
const UI_IDS = ['add-btn', 'add-assembly-btn', 'palette-btn', 'audio-btn', 'new-patch-btn', 'tour-btn'];

async function request(init?: RequestInit): Promise<Snapshot> {
  const response = await fetch(API, { cache: 'no-store', ...init });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? 'Could not reach the development server.');
  return data;
}

const defaultPart = (kind: PartKind, course: CourseData): Part => {
  const asmRole = Object.keys(course.roles).find((r) => course.roles[r].kind !== 'member') ?? '';
  switch (kind) {
    case 'module': return { kind, type: 'osc' };
    case 'cable': case 'noCable': return { kind, from: { type: 'fm1' }, fromPort: 'pitch', to: { type: 'osc' }, toPort: 'pitch' };
    case 'slider': return { kind, ref: { type: 'osc' }, param: 'wave', op: 'eq', value: 0 };
    case 'routed': return { kind, from: { type: 'lfo' }, fromPort: 'out', to: { type: 'osc' }, param: 'pw' };
    case 'pinMap': return { kind, ref: { type: 'filter' }, pin: 'p1', param: 'cutoff' };
    case 'att': return { kind, ref: { type: 'filter' }, pin: 'p1', op: 'ne', value: 1, tolerance: 0.05 };
    case 'macroRange': return { kind, ref: { type: 'filter' }, pin: 'p1', param: 'cutoff', min: 150, max: 4000 };
    case 'assembly': return { kind, role: asmRole, fact: 'exists' };
    case 'voices': return { kind, min: 2 };
    case 'event': return { kind, event: 'notes' };
    case 'sound': return { kind, mode: 'held' };
    case 'custom': return { kind, name: Object.keys(CUSTOM)[0] };
  }
};

async function mount() {
  const initial = await request();
  let saved = initial.content, draft = copy(saved), revision = initial.revision;
  let busy = false, query = '', recovery = '', draftSafe = true;
  let page: Page = { kind: 'chapter', chapter: saved.chapters[0]?.id ?? '' };
  let report: Report = { errors: [], warnings: [], hints: [] };
  let synth: SynthState | null = null;
  /** the patch the synth was given for the selected step (Try / Record): the checks' entry state */
  let linkEntry: { key: string; patch: Patch } | null = null;
  let recording: { key: string; before: Patch } | null = null;
  try {
    const raw = sessionStorage.getItem(DRAFT) ?? localStorage.getItem(DRAFT);
    if (raw) {
      const stored = JSON.parse(raw) as Snapshot;
      validateShape(stored.content, true);
      if (typeof stored.revision !== 'string') throw new Error('Missing draft revision');
      if (!equal(stored.content, saved)) {
        draft = stored.content; revision = stored.revision;
        recovery = revision === initial.revision ? 'Recovered your unsaved changes from this browser.' : 'Recovered your draft. The course file has changed too; download the draft before reloading the saved course.';
      }
    }
  } catch { recovery = 'A previous draft could not be restored. Browser storage may be unavailable; download your draft as you work.'; draftSafe = false; }

  // ---- frame

  const header = el('header', 'lesson-header');
  const title = el('div'); title.append(el('h1', '', 'Lesson editor'), el('p', 'muted', 'Write, structure and check the course. Preview as you go.'));
  const status = el('span', 'lesson-save-state'); status.setAttribute('role', 'status');
  const linkState = el('span', 'lesson-link-state');
  const save = button('Save all changes', () => { void saveAll(); }, 'primary');
  const app = el('a', '', 'Open synth'); app.href = '/'; app.target = '_blank'; app.rel = 'noopener';
  const actions = el('div', 'lesson-header-actions'); actions.append(linkState, status, save, app);
  header.append(title, actions);
  const message = el('div', 'lesson-message'); message.setAttribute('role', 'status');
  const nav = el('nav', 'lesson-nav'); nav.setAttribute('aria-label', 'Course');
  const search = el('input'); search.type = 'search'; search.placeholder = 'Search all lesson writing'; search.setAttribute('aria-label', 'Search all lesson writing');
  const results = el('div', 'lesson-results');
  search.oninput = () => { query = search.value.trim().toLowerCase(); renderNav(); };
  const navHead = el('div', 'lesson-nav-head'); navHead.append(el('h2', '', 'The course'), search);
  const navTools = el('div', 'lesson-nav-tools');
  nav.append(navHead, navTools, results);
  const workspace = el('main', 'lesson-workspace');
  const heading = el('h2'); heading.tabIndex = -1;
  const context = el('p', 'muted');
  const pageTools = el('div', 'lesson-page-tools');
  const fields = el('div', 'lesson-fields');
  const preview = el('section', 'lesson-preview'); preview.setAttribute('aria-label', 'Lesson card preview');
  const prev = button('Previous page', () => move(-1));
  const next = button('Next page', () => move(1));
  const paging = el('div', 'lesson-paging'); paging.append(prev, next);
  const form = el('section', 'lesson-form'); form.append(heading, context, pageTools, fields, paging);
  const help = el('details', 'lesson-markdown-help');
  help.append(el('summary', '', 'Markdown formatting guide'), el('p', '', 'Use Markdown in every writing field except Title. Web links open in a new tab; footnotes stay in the lesson. HTML is displayed as text.'),
    el('pre', '', '**bold** and *italic*\n~~strikethrough~~ and `control name`\n[link label](https://example.com)\n\n### A section heading\n\n- A bullet\n- Another bullet\n\n1. First action\n2. Second action\n\n> A quotation or listening tip\n\n```\nMain gate → ADSR gate\n```\n\n| Control | Effect |\n| --- | --- |\n| cutoff | Brightness |\n\nListen to the tail.[^release]\n\n[^release]: Release controls how long the note fades.\n\nOr add an inline note.^[Try a longer release.]'),
    el('p', '', 'Keep a footnote reference and its definition in the same writing field. Notes are numbered separately in each field. Indent extra footnote paragraphs by four spaces.'),
    el('p', '', 'Use a blank line between paragraphs. Single line breaks also appear in the lesson. Images use ![description](https://example.com/image.png).'));
  const columns = el('div', 'lesson-columns'); columns.append(form, preview);
  const tools = el('div', 'lesson-tools');
  const discard = button('Reload saved course…', () => { confirmBox.hidden = !confirmBox.hidden; });
  const confirmBox = el('div', 'lesson-confirm'); confirmBox.hidden = true;
  confirmBox.append(el('p', '', 'Reloading replaces all unsaved changes in this editor. Download a copy first if you want to keep it.'),
    button('Discard draft and reload', () => { void reload(); }), button('Keep editing', () => { confirmBox.hidden = true; }));
  tools.append(button('Download draft', download), discard,
    el('p', 'muted', 'Development only. Save writes src/tutorial/course.json; publishing is a separate step.'), confirmBox);
  workspace.append(columns, tools);
  const layout = el('div', 'lesson-layout'); layout.append(nav, workspace);
  const review = el('dialog', 'help lesson-review');
  root.replaceChildren(header, message, layout, review);

  // ---- the course

  const chapterOf = (id: string) => draft.chapters.find((c) => c.id === id);
  const chapterIndex = (id: string) => draft.chapters.findIndex((c) => c.id === id);
  const stepOf = (p: Page): StepData | undefined => (p.kind === 'step' ? chapterOf(p.chapter)?.steps.find((s) => s.id === p.step) : undefined);
  const stepIndex = (p: Page & { kind: 'step' }) => chapterOf(p.chapter)!.steps.findIndex((s) => s.id === p.step);
  const savedChapter = (id: string) => saved.chapters.find((c) => c.id === id);

  function pages(): Page[] {
    return [{ kind: 'roles' }, { kind: 'checks' }, ...draft.chapters.flatMap((ch) => [{ kind: 'chapter', chapter: ch.id } as Page, ...ch.steps.map((s) => ({ kind: 'step', chapter: ch.id, step: s.id } as Page))])];
  }
  const same = (a: Page, b: Page) => equal(a, b);
  function changed(p: Page): boolean {
    if (p.kind === 'chapter') {
      const ch = chapterOf(p.chapter)!, s = savedChapter(p.chapter);
      if (!s) return true;
      const { steps: a, ...x } = ch, { steps: b, ...y } = s;
      return !equal(x, y) || !equal(a.map((st) => st.id), b.map((st) => st.id));
    }
    if (p.kind === 'step') { const s = savedChapter(p.chapter)?.steps.find((x) => x.id === p.step); return !equal(stepOf(p), s) || !equal(draft.references[refKey(p.chapter, p.step)], saved.references[refKey(p.chapter, p.step)]); }
    if (p.kind === 'roles') return !equal(draft.roles, saved.roles);
    return false;
  }
  const dirty = () => !equal(draft, saved);
  const issuesOf = (chapter: string, step?: string): Issue[] => report.errors.filter((e) => e.chapter === chapter && (step === undefined || e.step === step));

  function tell(text: string, error = false) { message.textContent = text; message.hidden = !text; message.classList.toggle('error', error); }
  function persist() {
    try {
      if (dirty()) {
        const snapshot = JSON.stringify({ revision, content: draft });
        sessionStorage.setItem(DRAFT, snapshot); localStorage.setItem(DRAFT, snapshot);
      } else {
        sessionStorage.removeItem(DRAFT);
        const shared = localStorage.getItem(DRAFT);
        if (shared && equal(JSON.parse(shared).content, saved)) localStorage.removeItem(DRAFT);
      }
      draftSafe = true;
    } catch { draftSafe = false; tell('Browser draft storage is unavailable. Save or download your draft before closing.', true); }
  }
  let validateTimer = 0;
  function revalidate(now = false) {
    clearTimeout(validateTimer);
    const run = () => { report = validateCourse(draft); updateStatus(); renderNav(); if (page.kind === 'checks') renderFields(); };
    if (now) run(); else validateTimer = window.setTimeout(run, 350);
  }
  /** after any edit: keep the draft, re-check, refresh what shows it */
  function edited(opts: { fields?: boolean } = {}) {
    persist(); updateStatus(); renderNav(); renderPreview(); revalidate();
    if (opts.fields) renderFields();
  }
  function updateStatus() {
    const n = pages().filter(changed).length;
    const e = report.errors.length, w = report.warnings.length;
    status.textContent = busy ? 'Saving…' : `${n ? `${n} changed ${n === 1 ? 'page' : 'pages'}` : 'All changes saved'} · ${e ? `${e} error${e === 1 ? '' : 's'}` : 'no errors'}${w ? ` · ${w} warning${w === 1 ? '' : 's'}` : ''}${n && draftSafe ? ' · draft kept in this browser' : ''}`;
    save.disabled = busy || !dirty() || e > 0;
    save.title = e ? 'Fix the errors in Course checks before saving' : '';
    discard.disabled = busy;
    document.title = `${n ? '• ' : ''}Lesson editor · Matryoshka`;
  }

  // ---- navigation

  let dragging: { chapter: string; step?: string } | null = null;
  function renderNav() {
    navTools.replaceChildren(
      button(`Roles (${Object.keys(draft.roles).length})`, () => select_({ kind: 'roles' }), page.kind === 'roles' ? 'lesson-page current' : 'lesson-page'),
      button(`Course checks${report.errors.length ? ` · ${report.errors.length} ✗` : ' ✓'}`, () => select_({ kind: 'checks' }), `lesson-page${page.kind === 'checks' ? ' current' : ''}${report.errors.length ? ' bad' : ''}`),
      button('+ Chapter', () => addChapter(), 'lesson-add', 'Add a chapter after the selected one'));
    results.replaceChildren(); let matches = 0;
    draft.chapters.forEach((ch, i) => {
      const words = (s: StepData) => `${s.title} ${s.text} ${s.why}`;
      const visibleSteps = ch.steps.filter((s) => !query || `${ch.title} ${words(s)}`.toLowerCase().includes(query));
      const chapterMatch = !query || `${ch.title} ${ch.intro} ${ch.payoff} ${ch.challenge}`.toLowerCase().includes(query);
      if (!chapterMatch && !visibleSteps.length) return;
      matches++;
      const group = el('div', 'lesson-chapter');
      const open = button(`${i + 1}. ${ch.title}`, () => select_({ kind: 'chapter', chapter: ch.id }), 'lesson-chapter-title');
      if (changed({ kind: 'chapter', chapter: ch.id }) || ch.steps.some((s) => changed({ kind: 'step', chapter: ch.id, step: s.id }))) open.append(el('span', 'lesson-dirty', ' •'));
      if (issuesOf(ch.id).length) open.append(el('span', 'lesson-bad', ' ✗'));
      if (page.kind === 'chapter' && page.chapter === ch.id) open.setAttribute('aria-current', 'page');
      open.draggable = true;
      open.ondragstart = (e) => { dragging = { chapter: ch.id }; e.dataTransfer?.setData('text/plain', ch.id); };
      dropTarget(open, () => dragging && !dragging.step ? moveChapter(dragging.chapter, i) : dragging?.step ? moveStepTo(dragging.chapter, dragging.step, ch.id, 0) : undefined);
      group.append(open);
      const current = (page.kind === 'chapter' || page.kind === 'step') && page.chapter === ch.id;
      if (current || query) {
        for (const s of visibleSteps) {
          const k = ch.steps.indexOf(s);
          const p: Page = { kind: 'step', chapter: ch.id, step: s.id };
          const row = button(`${k + 1}. ${s.kind === 'continue' ? '▷ ' : ''}${s.title}${changed(p) ? ' •' : ''}`, () => select_(p), 'lesson-page');
          if (issuesOf(ch.id, s.id).length) row.append(el('span', 'lesson-bad', ' ✗'));
          if (same(p, page)) row.setAttribute('aria-current', 'page');
          row.draggable = true;
          row.ondragstart = (e) => { dragging = { chapter: ch.id, step: s.id }; e.dataTransfer?.setData('text/plain', s.id); };
          dropTarget(row, () => dragging?.step ? moveStepTo(dragging.chapter, dragging.step, ch.id, k) : undefined);
          group.append(row);
        }
      }
      results.append(group);
    });
    if (!matches) results.append(el('p', 'muted', 'No matching lesson text. Try another word.'));
  }
  function dropTarget(node: HTMLElement, drop: () => void) {
    node.ondragover = (e) => { if (dragging) { e.preventDefault(); node.classList.add('drop'); } };
    node.ondragleave = () => node.classList.remove('drop');
    node.ondrop = (e) => { e.preventDefault(); node.classList.remove('drop'); drop(); dragging = null; };
  }
  // `select` is a DOM helper above
  function select_(p: Page) {
    page = p; renderNav(); renderFields(); renderPreview(); heading.focus({ preventScroll: true });
    workspace.scrollTop = 0;
  }
  function move(delta: number) {
    const list = pages(), i = list.findIndex((p) => same(p, page));
    if (list[i + delta]) select_(list[i + delta]);
  }

  // ---- structure edits

  function renameReferences(fromChapter: string, toChapter: string, steps: string[]) {
    for (const s of steps) {
      const r = draft.references[refKey(fromChapter, s)];
      if (r) draft.references[refKey(toChapter, s)] = copy(r);
    }
  }
  function addChapter() {
    const at = page.kind === 'chapter' || page.kind === 'step' ? chapterIndex(page.chapter) + 1 : draft.chapters.length;
    const id = slugId('New chapter', draft.chapters.map((c) => c.id));
    const ch: ChapterData = { id, title: 'New chapter', intro: '', payoff: '', challenge: '', patchName: 'Tutorial patch', start: { kind: 'new' }, steps: [] };
    draft.chapters.splice(at, 0, ch);
    edited(); select_({ kind: 'chapter', chapter: id });
  }
  function duplicateChapter(id: string) {
    const ch = chapterOf(id)!;
    const copyId = slugId(`${ch.title} copy`, draft.chapters.map((c) => c.id));
    draft.chapters.splice(chapterIndex(id) + 1, 0, { ...copy(ch), id: copyId, title: `${ch.title} (copy)` });
    renameReferences(id, copyId, ch.steps.map((s) => s.id));
    edited(); select_({ kind: 'chapter', chapter: copyId });
  }
  function deleteChapter(id: string) {
    const i = chapterIndex(id);
    const ch = draft.chapters[i];
    if (!window.confirm(`Delete chapter ${i + 1} “${ch.title}” and its ${ch.steps.length} steps? (Download a draft first if unsure; Reload saved course brings back the saved version.)`)) return;
    for (const s of ch.steps) delete draft.references[refKey(id, s.id)];
    draft.chapters.splice(i, 1);
    edited();
    select_(draft.chapters[Math.min(i, draft.chapters.length - 1)] ? { kind: 'chapter', chapter: draft.chapters[Math.min(i, draft.chapters.length - 1)].id } : { kind: 'roles' });
  }
  function moveChapter(id: string, to: number) {
    const i = chapterIndex(id); if (i < 0 || i === to) return;
    const [ch] = draft.chapters.splice(i, 1); draft.chapters.splice(to, 0, ch);
    edited();
  }
  function addStep(chapter: string, after: number, kind: 'task' | 'continue') {
    const ch = chapterOf(chapter)!;
    const title = kind === 'continue' ? 'Read on' : 'New step';
    const id = slugId(title, ch.steps.map((s) => s.id));
    const st: StepData = kind === 'continue' ? { id, kind, title, text: '', why: '' } : { id, kind, title, text: '', why: '', parts: [] };
    ch.steps.splice(after + 1, 0, st);
    edited(); select_({ kind: 'step', chapter, step: id });
  }
  function duplicateStep(chapter: string, id: string) {
    const ch = chapterOf(chapter)!; const k = ch.steps.findIndex((s) => s.id === id);
    const st = ch.steps[k];
    const copyId = slugId(`${st.id} copy`, ch.steps.map((s) => s.id));
    ch.steps.splice(k + 1, 0, { ...copy(st), id: copyId, title: `${st.title} (copy)` });
    edited(); select_({ kind: 'step', chapter, step: copyId });
  }
  function deleteStep(chapter: string, id: string) {
    const ch = chapterOf(chapter)!; const k = ch.steps.findIndex((s) => s.id === id);
    if (!window.confirm(`Delete step ${k + 1} “${ch.steps[k].title}”?`)) return;
    ch.steps.splice(k, 1);
    delete draft.references[refKey(chapter, id)];
    edited();
    const next = ch.steps[Math.min(k, ch.steps.length - 1)];
    select_(next ? { kind: 'step', chapter, step: next.id } : { kind: 'chapter', chapter });
  }
  function moveStepTo(fromChapter: string, id: string, toChapter: string, to: number) {
    if (fromChapter !== toChapter) { tell('Steps move within their chapter. To use a step in another chapter, duplicate it there by hand.', true); return; }
    const ch = chapterOf(fromChapter)!; const k = ch.steps.findIndex((s) => s.id === id);
    if (k < 0 || k === to) return;
    const [st] = ch.steps.splice(k, 1); ch.steps.splice(to, 0, st);
    edited(); if (page.kind === 'step') renderFields();
  }

  // ---- references to modules: the picker

  /** the module a part is about: a type (n-th, every, outside assemblies), a module role, or a type inside an assembly role */
  function refPicker(ref: Ref, onChange: (r: Ref) => void, allowEvery = true): HTMLElement {
    const box = el('span', 'lesson-ref');
    const roles = draft.roles;
    const modRoles = [...Object.entries(roles).filter(([, r]) => r.kind === 'member').map(([n, r]) => [`r:${n}`, `${r.label} (role)`] as [string, string]), ...Object.entries(ROLES).map(([n, r]) => [`r:${n}`, `${r.label} (code role)`] as [string, string])];
    const asmRoles = Object.entries(roles).filter(([, r]) => r.kind !== 'member').map(([n, r]) => [`a:${n}`, `inside ${r.label}`] as [string, string]);
    const what = ref.role ? (ref.type ? `a:${ref.role}` : `r:${ref.role}`) : `t:${ref.type ?? ''}`;
    const sel = el('select'); sel.setAttribute('aria-label', 'Module');
    const group = (label: string, opts: [string, string][]) => { const g = el('optgroup'); g.label = label; for (const [v, t] of opts) g.append(new Option(t, v, false, v === what)); sel.append(g); };
    group('Module type', TYPES.map(([v, t]) => [`t:${v}`, t]));
    if (modRoles.length) group('Module role', modRoles);
    if (asmRoles.length) group('A type inside an assembly role', asmRoles);
    sel.onchange = () => {
      const [k, name] = [sel.value.slice(0, 1), sel.value.slice(2)];
      if (k === 't') onChange({ type: name });
      else if (k === 'r') onChange({ role: name });
      else { const r = roles[name]; onChange({ role: name, type: r?.kind === 'assembly' ? r.types[0] : 'osc' }); }
    };
    box.append(sel);
    if (ref.role && ref.type) box.append(select(TYPES, ref.type, (v) => onChange({ ...ref, type: v, index: undefined }), 'Type inside the assembly'));
    if (ref.type) {
      const idx = select([...ORD.map((o, i) => [String(i), o] as [string, string]), ...(allowEvery ? [['every', 'every'] as [string, string]] : [])], ref.every ? 'every' : String(ref.index ?? 0),
        (v) => onChange(v === 'every' ? { ...ref, every: true, index: undefined, loose: undefined } : { ...ref, every: undefined, index: Number(v) || undefined }), 'Which one');
      box.prepend(idx);
      if (!ref.role && !ref.every) box.append(check('outside assemblies', !!ref.loose, (v) => onChange({ ...ref, loose: v || undefined, index: undefined })));
    }
    return box;
  }
  const portsOf = (type: string | undefined, dir: 'in' | 'out'): [string, string][] => (type ? (dir === 'in' ? DEFS[type]?.inputs : DEFS[type]?.outputs) ?? [] : []).map((p) => [p.name, p.label ?? p.name]);
  const paramsOf = (type: string | undefined): [string, string][] => (type ? DEFS[type]?.params ?? [] : []).map((p) => [p.name, p.unit ? `${p.name} (${p.unit})` : p.name]);
  function portPicker(type: string | undefined, value: string, dir: 'in' | 'out', onChange: (v: string) => void): HTMLElement {
    const opts = portsOf(type, dir);
    return opts.length ? select(opts, value, onChange, dir === 'in' ? 'Input' : 'Output') : textInput(value, onChange, dir === 'in' ? 'Input' : 'Output');
  }
  function paramPicker(type: string | undefined, value: string, onChange: (v: string) => void): HTMLElement {
    const opts = paramsOf(type);
    return opts.length ? select(opts, value, onChange, 'Parameter') : textInput(value, onChange, 'Parameter');
  }
  /** a value input that knows choice and toggle parameters */
  function valuePicker(type: string | undefined, param: string, value: number | undefined, onChange: (v: number | undefined) => void, label = 'value'): HTMLElement {
    const pd = type ? DEFS[type]?.params.find((p) => p.name === param) : undefined;
    if (pd?.choices) return select(pd.choices.map((c, i) => [String(i), c] as [string, string]), String(value ?? 0), (v) => onChange(Number(v)), label);
    const i = numberInput(value, onChange, pd?.unit ? `${label} (${pd.unit})` : label);
    if (pd) { i.min = String(pd.min); i.max = String(pd.max); }
    return i;
  }
  const fixPort = (type: string | undefined, port: string, dir: 'in' | 'out') => { const o = portsOf(type, dir); return !o.length || o.some(([n]) => n === port) ? port : o[0][0]; };
  const fixParam = (type: string | undefined, param: string) => { const o = paramsOf(type); return !o.length || o.some(([n]) => n === param) ? param : o[0][0]; };

  // ---- a requirement's row

  function partEditor(st: StepData, i: number, onStructure: () => void): HTMLElement {
    const parts = st.parts!;
    const part = parts[i];
    const row = el('fieldset', 'lesson-part');
    const set = (next: Part, structural = true) => { parts[i] = next; if (structural) { row.replaceWith(partEditor(st, i, onStructure)); } else gen.textContent = partLabel({ ...next, label: undefined } as Part, draft.roles); edited(); };
    const roles = draft.roles;
    const head = el('div', 'lesson-part-head');
    const dot = el('span', 'lesson-dot'); dot.dataset.part = String(i); dot.title = 'Live check against the synth';
    const kind = select(PART_KINDS.map((k) => [k, KINDS[k]]), part.kind, (v) => set(defaultPart(v as PartKind, draft)), 'Requirement kind');
    const gen = el('span', 'lesson-part-label', partLabel({ ...part, label: undefined } as Part, roles));
    head.append(dot, kind, gen,
      button('↑', () => { if (i > 0) { [parts[i - 1], parts[i]] = [parts[i], parts[i - 1]]; edited(); onStructure(); } }, 'sm', 'Move up'),
      button('↓', () => { if (i < parts.length - 1) { [parts[i + 1], parts[i]] = [parts[i], parts[i + 1]]; edited(); onStructure(); } }, 'sm', 'Move down'),
      button('✕', () => { parts.splice(i, 1); edited(); onStructure(); }, 'sm', 'Remove this requirement'));
    if (momentary(part)) head.append(el('small', 'muted', ' momentary'));
    const body = el('div', 'lesson-part-body');
    const T = (r: Ref) => refType(roles, r);
    switch (part.kind) {
      case 'module':
        body.append(labelled('type', select(TYPES, part.type, (v) => set({ ...part, type: v }))), labelled('at least', numberInput(part.count, (v) => set({ ...part, count: v && v > 1 ? v : undefined }, false), 'count', '1')),
          check('outside every assembly', !!part.loose, (v) => set({ ...part, loose: v || undefined })));
        break;
      case 'cable': case 'noCable':
        body.append(labelled('from', refPicker(part.from, (r) => set({ ...part, from: r, fromPort: fixPort(T(r), part.fromPort, 'out') }), false), portPicker(T(part.from), part.fromPort, 'out', (v) => set({ ...part, fromPort: v }))),
          labelled('to', refPicker(part.to, (r) => set({ ...part, to: r, toPort: fixPort(T(r), part.toPort, 'in') }), part.kind === 'cable'), portPicker(T(part.to), part.toPort, 'in', (v) => set({ ...part, toPort: v }))));
        break;
      case 'slider': {
        const t = T(part.ref);
        body.append(labelled('module', refPicker(part.ref, (r) => set({ ...part, ref: r, param: fixParam(T(r), part.param) }), false), paramPicker(t, part.param, (v) => set({ ...part, param: v }))),
          labelled('is', select(SLIDER_OPS.map((o) => [o, OPS[o]]), part.op, (v) => set({ ...part, op: v as SliderOp }))));
        if (part.op !== 'changed') body.append(valuePicker(t, part.param, part.value, (v) => set({ ...part, value: v }, false)));
        if (part.op === 'between') body.append(labelled('and', valuePicker(t, part.param, part.max, (v) => set({ ...part, max: v }, false), 'upper value')));
        body.append(labelled('tolerance', numberInput(part.tolerance, (v) => set({ ...part, tolerance: v || undefined }, false), 'tolerance')));
        break;
      }
      case 'routed':
        body.append(labelled('from', refPicker(part.from, (r) => set({ ...part, from: r, fromPort: fixPort(T(r), part.fromPort, 'out') }), false), portPicker(T(part.from), part.fromPort, 'out', (v) => set({ ...part, fromPort: v }))),
          labelled('onto', refPicker(part.to, (r) => set({ ...part, to: r, param: fixParam(T(r), part.param) }), false), paramPicker(T(part.to), part.param, (v) => set({ ...part, param: v }))));
        break;
      case 'pinMap':
        body.append(labelled('module', refPicker(part.ref, (r) => set({ ...part, ref: r, param: fixParam(T(r), part.param) }), false)), labelled('pin', select([['p1', 'P1'], ['p2', 'P2']], part.pin, (v) => set({ ...part, pin: v as 'p1' })) ),
          labelled('drives', paramPicker(T(part.ref), part.param, (v) => set({ ...part, param: v }))));
        break;
      case 'att':
        body.append(labelled('module', refPicker(part.ref, (r) => set({ ...part, ref: r }), false)), labelled('pin', select([['p1', 'P1'], ['p2', 'P2']], part.pin, (v) => set({ ...part, pin: v as 'p1' }))),
          labelled('is', select(SLIDER_OPS.map((o) => [o, OPS[o]]), part.op, (v) => set({ ...part, op: v as SliderOp }))));
        if (part.op !== 'changed') body.append(numberInput(part.value, (v) => set({ ...part, value: v ?? 0 }, false), 'value (-1..1)'));
        if (part.op === 'between') body.append(labelled('and', numberInput(part.max, (v) => set({ ...part, max: v }, false), 'upper value')));
        body.append(labelled('tolerance', numberInput(part.tolerance, (v) => set({ ...part, tolerance: v || undefined }, false), 'tolerance')));
        break;
      case 'macroRange': {
        const t = T(part.ref);
        body.append(labelled('module', refPicker(part.ref, (r) => set({ ...part, ref: r, param: fixParam(T(r), part.param) }), false), paramPicker(t, part.param, (v) => set({ ...part, param: v }))),
          labelled('pin', select([['p1', 'P1'], ['p2', 'P2']], part.pin, (v) => set({ ...part, pin: v as 'p1' }))),
          labelled('from', valuePicker(t, part.param, part.min, (v) => set({ ...part, min: v ?? 0 }, false), 'from')), labelled('to', valuePicker(t, part.param, part.max, (v) => set({ ...part, max: v ?? 0 }, false), 'to')),
          labelled('depth', numberInput(part.depth, (v) => set({ ...part, depth: v }, false), 'any')));
        break;
      }
      case 'assembly': {
        const asmRoles = Object.entries(roles).filter(([, r]) => r.kind !== 'member').map(([n, r]) => [n, r.label] as [string, string]);
        const r = roles[part.role];
        const memberTypes: [string, string][] = r?.kind === 'assembly' ? [...new Set(r.types)].map((t) => [t, DEFS[t]?.label ?? t]) : TYPES;
        body.append(labelled('role', select(asmRoles, part.role, (v) => set({ ...part, role: v }))), labelled('fact', select(ASSEMBLY_FACTS.map((f) => [f, FACTS[f]]), part.fact, (v) => set({ ...part, fact: v as AssemblyFact }))));
        if (part.fact === 'promoted' || part.fact === 'exposed') body.append(labelled('member', select(memberTypes, part.type ?? '', (v) => set({ ...part, type: v, param: part.fact === 'promoted' ? fixParam(v, part.param ?? '') : undefined, port: part.fact === 'exposed' ? fixPort(v, part.port ?? '', 'out') : undefined }))));
        if (part.fact === 'promoted') body.append(paramPicker(part.type, part.param ?? '', (v) => set({ ...part, param: v })));
        if (part.fact === 'exposed') body.append(portPicker(part.type, part.port ?? '', 'out', (v) => set({ ...part, port: v })));
        if (part.fact === 'merged') body.append(labelled('input', textInput(part.port ?? '', (v) => set({ ...part, port: v }, false), 'input', 'pitch')));
        if (part.fact === 'contains') body.append(labelled('child', select(asmRoles, part.child ?? '', (v) => set({ ...part, child: v }))));
        if (part.fact === 'saved') body.append(labelled('tag', textInput(part.tag ?? '', (v) => set({ ...part, tag: v }, false), 'tag', 'my-voice')), labelled('name', textInput(part.name ?? '', (v) => set({ ...part, name: v }, false), 'name', 'My voice')));
        break;
      }
      case 'voices': body.append(labelled('at least', numberInput(part.min, (v) => set({ ...part, min: v ?? 2 }, false), 'voices', '1'))); break;
      case 'event': {
        body.append(labelled('event', select(EVENT_NAMES.map((e) => [e, EVENTS[e]]), part.event, (v) => set({ kind: 'event', event: v as EventName }))));
        if (['notes', 'undos', 'redos', 'zooms', 'flips', 'shares', 'bypasses', 'news', 'saves'].includes(part.event)) body.append(labelled('times', numberInput(part.count, (v) => set({ ...part, count: v && v > 1 ? v : undefined }, false), 'at least', '1')));
        if (part.event === 'probe') body.append(labelled('on', refPicker(part.ref ?? { type: 'osc' }, (r) => set({ ...part, ref: r, port: fixPort(T(r), part.port ?? 'out', 'out') }), false), portPicker(part.ref && T(part.ref), part.port ?? 'out', 'out', (v) => set({ ...part, port: v }))));
        if (part.event === 'bypassed' || part.event === 'bypasses') body.append(labelled('module', refPicker(part.ref ?? { type: 'reverb' }, (r) => set({ ...part, ref: r }), false)));
        if (part.event === 'bypassed') body.append(check('bypassed (off = switched back on)', !!part.on, (v) => set({ ...part, on: v || undefined })));
        if (part.event === 'selected') {
          const multi = el('select'); multi.multiple = true; multi.size = 6; multi.setAttribute('aria-label', 'Types to select');
          for (const [v, t] of TYPES) multi.append(new Option(t, v, false, !!part.types?.includes(v)));
          multi.onchange = () => set({ ...part, types: [...multi.selectedOptions].map((o) => o.value) }, false);
          body.append(labelled('types', multi));
        }
        break;
      }
      case 'sound':
        body.append(labelled('the patch', select([['held', 'sounds while a key is held'], ['silent', 'is silent without a key']], part.mode, (v) => set({ ...part, mode: v as 'held' }))),
          labelled('threshold', numberInput(part.threshold, (v) => set({ ...part, threshold: v }, false), part.mode === 'held' ? 'peak above (0.01)' : 'peak below (0.0001)')));
        break;
      case 'custom': {
        const c = CUSTOM[part.name];
        body.append(labelled('check', select(Object.entries(CUSTOM).map(([n, x]) => [n, `${n}: ${x.describe}`]), part.name, (v) => set({ kind: 'custom', name: v }))));
        for (const a of c?.args ?? []) body.append(labelled(a.name, a.options ? select(a.options.map((o) => [o, o]), String(part.args?.[a.name] ?? ''), (v) => set({ ...part, args: { ...part.args, [a.name]: v } })) : textInput(String(part.args?.[a.name] ?? ''), (v) => set({ ...part, args: { ...part.args, [a.name]: v } }, false), a.name)));
        break;
      }
    }
    const label = textInput(part.label ?? '', (v) => { parts[i] = { ...parts[i], label: v || undefined } as Part; edited(); }, 'Checklist line (optional)', 'Checklist line: leave empty to use the generated one');
    label.className = 'lesson-part-override';
    row.append(head, body, label);
    return row;
  }

  // ---- pages

  function textField(labelText: string, value: string, rows: number, onInput: (v: string) => void, single = false): HTMLElement {
    const field = el('label', 'lesson-field'); field.append(el('span', '', labelText));
    const input = single ? el('input') : el('textarea');
    input.value = value; input.maxLength = 20000; input.setAttribute('aria-label', labelText); input.spellcheck = true;
    if (input instanceof HTMLTextAreaElement) input.rows = rows;
    const count = el('small', 'muted');
    const measure = () => { const n = wordCount(input.value); count.textContent = `${n} ${n === 1 ? 'word' : 'words'}`; };
    input.oninput = () => { onInput(input.value); measure(); edited(); };
    measure(); field.append(input); if (!single) field.append(count);
    return field;
  }

  function renderFields() {
    fields.replaceChildren(); pageTools.replaceChildren();
    help.remove();
    const list = pages(), index = list.findIndex((p) => same(p, page));
    prev.disabled = index <= 0; next.disabled = index === list.length - 1;
    if (page.kind === 'roles') return renderRoles();
    if (page.kind === 'checks') return renderChecks();
    const ch = chapterOf(page.chapter);
    if (!ch) { select_({ kind: 'roles' }); return; }
    const ci = chapterIndex(ch.id);
    if (page.kind === 'chapter') {
      heading.textContent = `Chapter ${ci + 1} · ${ch.title}`;
      context.textContent = 'The chapter’s idea, its starting patch, and what the learner made.';
      pageTools.append(
        button('+ Task step at start', () => addStep(ch.id, -1, 'task')), button('+ Continue step at start', () => addStep(ch.id, -1, 'continue')),
        button('↑', () => { if (ci > 0) { moveChapter(ch.id, ci - 1); renderFields(); } }, '', 'Move the chapter up'), button('↓', () => { if (ci < draft.chapters.length - 1) { moveChapter(ch.id, ci + 1); renderFields(); } }, '', 'Move the chapter down'),
        button('Duplicate chapter', () => duplicateChapter(ch.id)), button('Delete chapter', () => deleteChapter(ch.id), 'danger'));
      form.insertBefore(help, fields);
      fields.append(
        textField('Title', ch.title, 1, (v) => { ch.title = v; }, true),
        textField('Patch name', ch.patchName, 1, (v) => { ch.patchName = v; }, true),
        startEditor(ch, ci),
        textField('Introduction', ch.intro, 10, (v) => { ch.intro = v; }),
        textField('Payoff', ch.payoff, 5, (v) => { ch.payoff = v; }),
        textField('Optional challenge', ch.challenge, 5, (v) => { ch.challenge = v; }));
      return;
    }
    const st = stepOf(page)!;
    const k = stepIndex(page);
    const key = refKey(ch.id, st.id);
    heading.textContent = `Chapter ${ci + 1} · Step ${k + 1}. ${st.title}`;
    context.textContent = st.kind === 'continue' ? 'A Continue step: text to read (and optionally listen to), no requirements. The learner presses Continue.' : 'A task step: the learner meets every requirement below, then the tutorial moves on.';
    pageTools.append(
      button('+ Task step after', () => addStep(ch.id, k, 'task')), button('+ Continue step after', () => addStep(ch.id, k, 'continue')),
      button('↑', () => moveStepTo(ch.id, st.id, ch.id, k - 1 < 0 ? 0 : k - 1), '', 'Move the step up'), button('↓', () => moveStepTo(ch.id, st.id, ch.id, Math.min(ch.steps.length - 1, k + 1)), '', 'Move the step down'),
      button('Duplicate step', () => duplicateStep(ch.id, st.id)), button('Delete step', () => deleteStep(ch.id, st.id), 'danger'));
    form.insertBefore(help, fields);
    const kindRow = el('div', 'lesson-row');
    kindRow.append(el('strong', '', 'Kind '), select([['task', 'Task: requirements to meet'], ['continue', 'Continue: read or listen, then Continue']], st.kind, (v) => {
      st.kind = v as 'task' | 'continue';
      if (st.kind === 'continue') { delete st.parts; delete st.listen; delete st.superseded; delete st.optional; delete draft.references[key]; } else { st.parts ??= []; delete st.pointer; delete st.playback; }
      edited({ fields: true });
    }, 'Step kind'));
    fields.append(
      textField('Title', st.title, 1, (v) => { st.title = v; heading.textContent = `Chapter ${ci + 1} · Step ${k + 1}. ${v}`; }, true),
      textField('Instructions', st.text, 10, (v) => { st.text = v; }),
      textField('Why (optional)', st.why, 5, (v) => { st.why = v; }),
      kindRow);
    for (const issue of issuesOf(ch.id, st.id)) fields.append(el('p', 'lesson-issue', issue.message));
    for (const hint of report.hints.filter((h) => h.chapter === ch.id && h.step === st.id)) fields.append(el('p', 'lesson-hint', hint.message));
    if (st.kind === 'continue') {
      const box = el('section', 'lesson-section'); box.append(el('h3', '', 'Continue step'));
      box.append(check('Show the playback buttons (Note, Chord, Riff)', !!st.playback, (v) => { st.playback = v || undefined; edited(); }), pointerEditor(st));
      fields.append(box);
      return;
    }
    const flags = el('section', 'lesson-section'); flags.append(el('h3', '', 'Pace'));
    const transient = compileStep(st, draft.roles).transient;
    flags.append(
      check('Wait for Continue (a listening step)', !!st.listen, (v) => { st.listen = v || undefined; edited(); }, 'otherwise it moves on 0.9 s after its requirements are met'),
      check('Optional (the learner may skip it)', !!st.optional, (v) => { st.optional = v || undefined; edited(); }),
      check('Superseded (a later step undoes it on purpose)', !!st.superseded, (v) => { st.superseded = v || undefined; edited(); }, 'it is not re-checked after its turn'),
      el('p', 'muted', transient ? 'Transient: a requirement here is something that happens during the step, so a finished patch cannot show it. The step is skipped when judging whether a patch completes the chapter.' : 'Structural: a finished patch must still meet this step.'));
    const reqs = el('section', 'lesson-section'); reqs.append(el('h3', '', 'Requirements'));
    const partList = el('div', 'lesson-parts');
    const redraw = () => { partList.replaceChildren(...(st.parts ?? []).map((_, i) => partEditor(st, i, redraw))); updateLive(); };
    redraw();
    const add = select([['', '+ Add requirement…'], ...PART_KINDS.map((k) => [k, KINDS[k]] as [string, string])], '', (v) => { if (!v) return; (st.parts ??= []).push(defaultPart(v as PartKind, draft)); edited(); redraw(); add.value = ''; }, 'Add requirement');
    reqs.append(partList, add);
    fields.append(flags, reqs, referenceEditor(ch, ci, st, k));
  }

  function startEditor(ch: ChapterData, ci: number): HTMLElement {
    const box = el('section', 'lesson-section'); box.append(el('h3', '', 'Starts from'));
    const set = (s: StartRule) => { ch.start = s; edited({ fields: true }); };
    box.append(select([['new', 'a new patch'], ['continue', 'the previous chapter’s end'], ['preset', 'a factory patch'], ['patch', 'a stored patch']], ch.start.kind, (v) => {
      if (v === 'new') set({ kind: 'new' });
      else if (v === 'continue') set({ kind: 'continue' });
      else if (v === 'preset') set({ kind: 'preset', name: Object.keys(PRESETS)[0] });
      else if (synth) set({ kind: 'patch', patch: copy(synth.patch) });
      else { tell('Open the synth (Open synth) to store its current patch as the start.', true); renderFields(); }
    }, 'Start'));
    if (ch.start.kind === 'new') box.append(labelled('voices', numberInput(ch.start.voices, (v) => { ch.start = { kind: 'new', voices: v && v > 1 ? v : undefined }; edited(); }, '1', '1')));
    if (ch.start.kind === 'preset') box.append(select(Object.keys(PRESETS).map((n) => [n, n]), ch.start.name, (v) => set({ kind: 'preset', name: v }), 'Factory patch'));
    if (ch.start.kind === 'patch') box.append(el('span', 'muted', ` ${ch.start.patch.modules.length} modules, ${ch.start.patch.cables.length} cables `), button('Use the synth’s current patch', () => { if (synth) set({ kind: 'patch', patch: copy(synth.patch) }); else tell('The synth is not connected.', true); }));
    if (ch.start.kind === 'continue' && ci === 0) box.append(el('p', 'lesson-issue', 'The first chapter has no previous chapter; it starts from a new patch.'));
    box.append(button('Load the start into the synth', () => sendLoad(ch.id, 0, chapterStartOf(ci))));
    return box;
  }
  const chapterStartOf = (ci: number): Patch => stepStart(ci, 0, draft);

  function pointerEditor(st: StepData): HTMLElement {
    const box = el('div', 'lesson-row');
    const ptr = st.pointer;
    const set = (p: Pointer | undefined) => { st.pointer = p; edited({ fields: true }); };
    box.append(labelled('Point at', select([['', 'nothing'], ['module', 'a module'], ['port', 'a jack'], ['param', 'a slider'], ['ui', 'a sidebar control']], ptr?.kind ?? '', (v) => {
      if (!v) set(undefined);
      else if (v === 'module') set({ kind: 'module', ref: { type: 'osc' } });
      else if (v === 'port') set({ kind: 'port', ref: { type: 'osc' }, port: 'out', dir: 'out' });
      else if (v === 'param') set({ kind: 'param', ref: { type: 'osc' }, param: 'wave' });
      else set({ kind: 'ui', id: 'add-btn' });
    })));
    if (ptr && ptr.kind !== 'ui') box.append(refPicker(ptr.ref, (r) => set({ ...ptr, ref: r } as Pointer), false));
    if (ptr?.kind === 'port') box.append(select([['out', 'output'], ['in', 'input']], ptr.dir, (v) => set({ ...ptr, dir: v as 'in' })), portPicker(refType(draft.roles, ptr.ref), ptr.port, ptr.dir, (v) => set({ ...ptr, port: v })));
    if (ptr?.kind === 'param') box.append(paramPicker(refType(draft.roles, ptr.ref), ptr.param, (v) => set({ ...ptr, param: v })));
    if (ptr?.kind === 'ui') box.append(select(UI_IDS.map((x) => [x, x]), ptr.id, (v) => set({ kind: 'ui', id: v })));
    return box;
  }

  function referenceEditor(ch: ChapterData, ci: number, st: StepData, k: number): HTMLElement {
    const key = refKey(ch.id, st.id);
    const box = el('section', 'lesson-section'); box.append(el('h3', '', 'Reference patch'));
    const ref = draft.references[key];
    box.append(el('p', 'muted', 'The patch after doing this step. The next step begins from it, Back falls back to it, and the course checks test this step and the ones before against it.'));
    box.append(el('p', ref ? '' : 'lesson-hint', ref ? `${ref.patch.modules.length} modules, ${ref.patch.cables.length} cables${ref.saved ? ` · saves “${ref.saved.name}” (${ref.saved.tutorial})` : ''}` : 'No reference yet: record the step in the synth.'));
    const row = el('div', 'lesson-row');
    const isRec = recording?.key === key;
    row.append(
      button('Try this step in the synth', () => sendLoad(ch.id, k, stepStart(ci, k, draft)), '', 'Load the step’s beginning state into the synth'),
      button(isRec ? 'Stop recording' : 'Record in the synth', () => (isRec ? stopRecording(ch, st) : startRecording(ch, ci, st, k)), isRec ? 'primary' : ''),
      button('Use the synth’s patch as the reference', () => { if (!synth) { tell('The synth is not connected.', true); return; } draft.references[key] = { patch: copy(synth.patch), ...(draft.references[key]?.saved ? { saved: draft.references[key].saved } : {}) }; edited({ fields: true }); }),
      ...(ref ? [button('Load the reference into the synth', () => sendLoad(ch.id, k + 1, ref.patch)), button('Clear reference', () => { delete draft.references[key]; edited({ fields: true }); }, 'danger')] : []));
    box.append(row);
    if (isRec) box.append(el('p', 'lesson-hint', 'Recording: do the step in the synth, then press Stop recording.'));
    return box;
  }

  function renderRoles() {
    heading.textContent = 'Roles';
    context.textContent = 'Names for the assemblies (and modules inside them) that checks in several chapters look for. A role is found by shape, never by id. Code roles (carrier, modulator) are defined in registry.ts.';
    const used = (name: string) => draft.chapters.some((ch) => ch.steps.some((s) => JSON.stringify([s.parts, s.pointer]).includes(`"${name}"`))) || Object.values(draft.roles).some((r) => r.kind === 'member' && r.role === name);
    for (const [name, r] of Object.entries(draft.roles)) {
      const row = el('fieldset', 'lesson-part');
      const head = el('div', 'lesson-part-head');
      head.append(el('strong', '', name), textInput(r.label, (v) => { r.label = v; edited(); }, 'Label'),
        select([['assembly', 'assembly with these types'], ['named', 'assembly with this library name'], ['member', 'a module inside an assembly role']], r.kind, (v) => {
          const nr: RoleDef = v === 'assembly' ? { kind: 'assembly', label: r.label, types: ['osc'] } : v === 'named' ? { kind: 'named', label: r.label, name: r.label } : { kind: 'member', label: r.label, role: Object.keys(draft.roles).find((n) => draft.roles[n].kind !== 'member') ?? '', type: 'vca' };
          draft.roles[name] = nr; edited({ fields: true });
        }, 'Role kind'),
        button('✕', () => { if (used(name)) { tell(`“${name}” is used by a requirement or another role.`, true); return; } delete draft.roles[name]; edited({ fields: true }); }, 'sm', 'Delete this role'));
      const body = el('div', 'lesson-part-body');
      if (r.kind === 'assembly') {
        const twice = textInput(r.types.join(', '), (v) => { r.types = v.split(/[\s,]+/).filter(Boolean); edited(); }, 'Types (a type twice means two of them)');
        body.append(labelled('contains at least', twice), el('small', 'muted', 'e.g. osc, osc, env, vca; the smallest assembly that has them is the match'));
      }
      if (r.kind === 'named') body.append(labelled('library name', textInput(r.name, (v) => { r.name = v; edited(); }, 'name')));
      if (r.kind === 'member') body.append(labelled('the', select(TYPES, r.type, (v) => { r.type = v; edited(); })), labelled('inside', select(Object.entries(draft.roles).filter(([, x]) => x.kind !== 'member').map(([n, x]) => [n, x.label] as [string, string]), r.role, (v) => { r.role = v; edited(); })));
      row.append(head, body);
      fields.append(row);
    }
    const name = textInput('', () => {}, 'New role name', 'newRole');
    fields.append(el('div', 'lesson-row'));
    fields.lastElementChild!.append(name, button('+ Add role', () => {
      const n = name.value.trim();
      if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(n) || draft.roles[n] || ROLES[n]) { tell('A role name is letters and digits, starting with a letter, and not in use.', true); return; }
      draft.roles[n] = { kind: 'assembly', label: n, types: ['osc'] }; edited({ fields: true });
    }));
    fields.append(el('h3', '', 'Code roles'), ...Object.entries(ROLES).map(([n, r]) => el('p', 'muted', `${n}: ${r.describe}`)));
  }

  function renderChecks() {
    heading.textContent = 'Course checks';
    context.textContent = 'The whole course, checked on every change. Errors block saving; warnings and hints do not.';
    const where = (i: Issue) => {
      const ci = i.chapter ? chapterIndex(i.chapter) : -1;
      const ch = ci >= 0 ? draft.chapters[ci] : undefined;
      const k = ch && i.step ? ch.steps.findIndex((s) => s.id === i.step) : -1;
      return { label: ch ? `Chapter ${ci + 1}${k >= 0 ? `, step ${k + 1} (${ch.steps[k].title})` : ''}` : 'Course', page: (ch ? (k >= 0 ? { kind: 'step', chapter: ch.id, step: ch.steps[k].id } : { kind: 'chapter', chapter: ch.id }) : null) as Page | null };
    };
    for (const [title, list, cls] of [['Errors', report.errors, 'lesson-issue'], ['Warnings', report.warnings, 'lesson-hint'], ['Hints', report.hints, 'muted']] as const) {
      fields.append(el('h3', '', `${title} (${list.length})`));
      for (const i of list) {
        const w = where(i);
        const row = el('p', cls);
        row.append(w.page ? button(w.label, () => select_(w.page!), 'sm') : el('strong', '', w.label), ` ${i.message}`);
        fields.append(row);
      }
    }
  }

  // ---- preview

  function renderPreview() {
    if (page.kind === 'roles' || page.kind === 'checks') { preview.replaceChildren(el('h3', '', 'Synth'), linkPanel()); return; }
    const ch = chapterOf(page.chapter); if (!ch) return;
    const ci = chapterIndex(ch.id);
    const card = el('div', 'tutorial lesson-card');
    const head = el('div', 'tutorial-head');
    const st = stepOf(page);
    head.append(el('h2', '', st ? st.title : ch.title));
    card.append(head, el('span', 'tour-count', `Chapter ${ci + 1} of ${draft.chapters.length} · ${ch.title}`));
    if (!st) {
      card.append(lessonProse(ch.intro));
      const done = el('div', 'tutorial lesson-card');
      done.append(el('div', 'tutorial-head'), lessonProse(ch.payoff), lessonChallenge(ch.challenge));
      (done.firstChild as HTMLElement).append(el('h2', '', 'Chapter done'));
      preview.replaceChildren(el('h3', '', 'Lesson card preview'), card, el('h3', '', 'Chapter end'), done, el('h3', '', 'Synth'), linkPanel());
      return;
    }
    const k = ch.steps.indexOf(st);
    card.append(el('span', 'tour-step', `Step ${k + 1} of ${ch.steps.length}`), lessonProse(st.text));
    if (st.why) {
      const why = el('details', 'tutorial-why'); why.open = true;
      why.append(el('summary', '', 'Why'), lessonProse(st.why)); card.append(why);
    }
    const todo = el('div', 'tutorial-todo'); todo.dataset.live = '1';
    card.append(todo);
    const n = wordCount(`${st.title} ${st.text} ${st.why}`);
    preview.replaceChildren(el('h3', '', 'Lesson card preview'), card,
      el('p', 'muted lesson-preview-note', `About ${Math.max(1, Math.ceil(n / 200 * 60))} seconds to read. The checklist shows what the synth still lacks (or every requirement when the synth is not connected).`),
      el('h3', '', 'Synth'), linkPanel());
    updateLive();
  }
  function linkPanel(): HTMLElement {
    const box = el('div', 'lesson-link');
    box.append(el('p', 'muted', link.connected() ? `Connected: the synth has ${synth?.patch.modules.length ?? 0} modules. Requirements show ✓ / ✗ against it.` : 'Not connected. Open the synth (Open synth, same server) to check steps live, try them and record them.'));
    if (link.connected()) box.append(button('Reset event counts', () => { link.send({ t: 'reset' }); }, 'sm', 'Count notes, undo, zoom… from now'));
    return box;
  }

  // ---- the live link to the synth

  const link = editorLink((s) => { const was = !!synth; synth = s; updateLive(); if (!was) { renderPreview(); } });
  function sendLoad(chapter: string, step: number, patch: Patch) {
    if (!link.connected()) { tell('Open the synth first (Open synth): the link needs it running in another tab.', true); return; }
    const ch = chapterOf(chapter)!;
    const st = ch.steps[step];
    linkEntry = { key: st ? refKey(chapter, st.id) : `${chapter}/end`, patch: copy(patch) };
    link.send({ t: 'load', patch: copy(patch) });
    tell(st ? `Loaded the beginning of step ${step + 1} (${st.title}) into the synth.` : 'Loaded into the synth.');
  }
  function startRecording(ch: ChapterData, ci: number, st: StepData, k: number) {
    if (!link.connected()) { tell('Open the synth first (Open synth): recording needs it running in another tab.', true); return; }
    const before = stepStart(ci, k, draft);
    recording = { key: refKey(ch.id, st.id), before };
    sendLoad(ch.id, k, before);
    tell(`Recording step ${k + 1}: do it in the synth, then press Stop recording.`);
    renderFields();
  }
  function stopRecording(ch: ChapterData, st: StepData) {
    const rec = recording; recording = null;
    if (!rec || !synth) { renderFields(); return; }
    const result = capture({ before: rec.before, after: synth.patch, seen: synth.seen, probes: synth.probes, selected: synth.selected, arpPlay: synth.arpPlay, audio: synth.audio, snapshots: synth.snapshots, saved: synth.lastSaved }, draft.roles);
    openReview(ch, st, result.proposals, result.notes, copy(synth.patch), synth.lastSaved ? copy(synth.lastSaved) : undefined);
    renderFields();
  }
  function openReview(ch: ChapterData, st: StepData, proposals: Proposal[], notes: string[], after: Patch, savedDef: CourseData['references'][string]['saved']) {
    const key = refKey(ch.id, st.id);
    const ticks = proposals.map((p) => p.keep);
    const list = el('div', 'lesson-review-list');
    proposals.forEach((p, i) => list.append(check(partLabel(p.part, draft.roles), ticks[i], (v) => { ticks[i] = v; }, momentary(p.part) ? '(momentary)' : '')));
    if (!proposals.length) list.append(el('p', 'muted', 'Nothing changed in the synth.'));
    const later = ch.steps.slice(ch.steps.indexOf(st) + 1).some((s) => draft.references[refKey(ch.id, s.id)]);
    const keepRef = check('Keep the synth’s patch as this step’s reference', true, () => {});
    const done = (add: boolean) => {
      if (add) {
        if (st.kind === 'task') (st.parts ??= []).push(...proposals.filter((_, i) => ticks[i]).map((p) => p.part));
        if ((keepRef.firstChild as HTMLInputElement).checked && st.kind === 'task') draft.references[key] = { patch: after, ...(savedDef ? { saved: savedDef } : {}) };
        if (later) tell('Later steps of this chapter were recorded on the old state: Course checks shows any that no longer hold.');
      }
      review.close(); edited({ fields: true });
    };
    review.replaceChildren(el('h2', '', `Recorded: ${st.title}`), el('p', 'muted', 'Tick what the learner must do. Sliders are proposed as at least / at most the value you set; loosen them on the step afterwards.'), list,
      ...notes.map((n) => el('p', 'lesson-hint', n)), keepRef,
      ...(savedDef ? [el('p', 'muted', `The step saved “${savedDef.name}”: it is stored with the reference as the bundled copy.`)] : []),
      ...(later ? [el('p', 'lesson-hint', 'Later steps already have reference patches recorded on the old state.')] : []),
      el('div', 'tour-actions'));
    review.lastElementChild!.append(button('Add the ticked requirements', () => done(true), 'primary'), button('Cancel', () => done(false)));
    review.showModal();
  }
  /** the ✓ / ✗ of every requirement of the open step against the synth, and the preview's checklist */
  function updateLive() {
    linkState.textContent = link.connected() ? '● synth linked' : '○ synth not linked';
    linkState.classList.toggle('on', link.connected());
    if (page.kind !== 'step') return;
    const ch = chapterOf(page.chapter); const st = stepOf(page);
    if (!ch || !st) return;
    const todo = preview.querySelector<HTMLElement>('[data-live]');
    const parts = st.kind === 'task' ? st.parts ?? [] : [];
    if (!synth || !link.connected()) {
      for (const d of fields.querySelectorAll<HTMLElement>('.lesson-dot')) { d.textContent = '–'; d.className = 'lesson-dot'; }
      if (todo) todo.replaceChildren();
      if (todo && parts.length) { const ul = el('ul'); ul.append(...parts.map((p) => el('li', '', partLabel(p, draft.roles)))); todo.replaceChildren(el('span', '', 'Still to do'), ul); }
      return;
    }
    const entry = linkEntry?.key === refKey(ch.id, st.id) ? linkEntry.patch : stepStart(chapterIndex(ch.id), ch.steps.indexOf(st), draft);
    const s = linkedState(synth, entry);
    const results = parts.map((p) => { try { return partCheck(p, s, draft.roles); } catch { return false; } });
    for (const d of fields.querySelectorAll<HTMLElement>('.lesson-dot')) {
      const ok = results[Number(d.dataset.part)];
      d.textContent = ok ? '✓' : '✗'; d.className = `lesson-dot ${ok ? 'ok' : 'bad'}`;
    }
    if (todo) {
      const left = parts.filter((_, i) => !results[i]);
      if (!left.length) todo.replaceChildren(el('span', '', parts.length ? '✓ The synth meets this step' : ''));
      else { const ul = el('ul'); ul.append(...left.map((p) => el('li', '', partLabel(p, draft.roles)))); todo.replaceChildren(el('span', '', 'Still to do'), ul); }
    }
  }
  window.setInterval(updateLive, 1000);

  // ---- save, reload, download

  async function saveAll() {
    if (busy || !dirty()) return;
    revalidate(true);
    if (report.errors.length) { tell(`Not saved: ${report.errors.length} error${report.errors.length === 1 ? '' : 's'} in Course checks.`, true); select_({ kind: 'checks' }); return; }
    try { validateShape(draft); } catch (err) { tell((err as Error).message, true); return; }
    busy = true; updateStatus(); tell('');
    const submitted = copy(draft);
    try {
      const result = await request({ method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision, content: submitted }) });
      saved = submitted; revision = result.revision;
      tell('Saved to the course source. The local synth reloads with your changes.'); persist(); renderNav();
    } catch (err) { tell((err as Error).message, true); }
    finally { busy = false; updateStatus(); }
  }
  async function reload() {
    if (busy) return;
    busy = true; updateStatus();
    try {
      const result = await request();
      try {
        const shared = localStorage.getItem(DRAFT);
        if (shared && equal(JSON.parse(shared).content, draft)) localStorage.removeItem(DRAFT);
      } catch { /* reload is still available when browser storage is blocked */ }
      saved = result.content; draft = copy(saved); revision = result.revision;
      if ((page.kind === 'chapter' || page.kind === 'step') && (!chapterOf(page.chapter) || (page.kind === 'step' && !stepOf(page)))) page = { kind: 'chapter', chapter: draft.chapters[0]?.id ?? '' };
      tell('Reloaded the saved course.'); persist(); confirmBox.hidden = true; renderNav(); renderFields(); renderPreview(); revalidate(true);
    } catch (err) { tell((err as Error).message, true); }
    finally { busy = false; updateStatus(); }
  }
  function download() {
    const url = URL.createObjectURL(new Blob([formatCourse(draft)], { type: 'application/json' }));
    const a = el('a'); a.href = url; a.download = 'course-draft.json'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  window.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void saveAll(); }
  });
  window.addEventListener('beforeunload', (event) => { if (dirty() && !draftSafe) { event.preventDefault(); event.returnValue = ''; } });
  tell(recovery); renderNav(); renderFields(); renderPreview(); revalidate(true); updateStatus();
}

void mount().catch((err) => {
  root.replaceChildren(el('h1', '', 'Lesson editor unavailable'), el('p', '', `${(err as Error).message} Open this page through the local Vite development server.`), button('Try again', () => location.reload()));
});
