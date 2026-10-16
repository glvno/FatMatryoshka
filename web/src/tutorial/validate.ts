// SPDX-License-Identifier: GPL-3.0-only
// The whole-course check the lesson editor runs on every change and the test suite runs on course.json:
// - every part names module types, ports, parameters, roles and checks that exist;
// - every task step's reference patch passes the step's own parts (the momentary ones aside: a patch cannot show an event)
//   and every earlier step of the chapter that a finished patch must still pass;
// - a step that saves an assembly stores the saved definition;
// - each chapter's end completes it.
// Errors block a save; warnings (a task step without a reference patch) and hints (a step that a later one undoes but is
// not marked superseded) do not.
import { DEFS } from '../modules';
import { PRESETS } from '../presets';
import { completes, headlessState, type TutorialState } from './model';
import { compileCourse, chapterEnd, chapterStart, stepStart } from './chapters';
import { momentary, partCheck, partLabel, refType, type Roles } from './parts';
import { CUSTOM, ROLES } from './registry';
import { placedRequirements } from './markdown';
import { EVENT_NAMES, refKey, SLIDER_OPS, validateShape, type CourseData, type PartSpec, type Ref } from './course-schema';
import type { AssemblyDef } from '../assembly';

export interface Issue {
  chapter?: string;
  step?: string;
  message: string;
}
export interface Report {
  errors: Issue[];
  warnings: Issue[];
  hints: Issue[];
}

const ports = (type: string, dir: 'in' | 'out'): string[] => (dir === 'in' ? DEFS[type]?.inputs : DEFS[type]?.outputs)?.map((p) => p.name) ?? [];
const params = (type: string): string[] => DEFS[type]?.params.map((p) => p.name) ?? [];

/** what is wrong with one part's names, if anything */
export function partProblems(part: PartSpec, roles: Roles): string[] {
  const out: string[] = [];
  const ref = (r: Ref, what: string): string | undefined => {
    if (r.role && !roles[r.role] && !ROLES[r.role]) { out.push(`${what}: there is no role "${r.role}"`); return undefined; }
    if (r.role && roles[r.role]?.kind === 'member' && r.type) out.push(`${what}: "${r.role}" is a module role; it cannot have a type`);
    if (r.role && (roles[r.role]?.kind === 'assembly' || roles[r.role]?.kind === 'named') && !r.type) out.push(`${what}: pick a module type inside ${r.role}`);
    if (r.type && !DEFS[r.type]) { out.push(`${what}: there is no module type "${r.type}"`); return undefined; }
    if (!r.role && !r.type) out.push(`${what}: pick a module`);
    return refType(roles, r);
  };
  const port = (type: string | undefined, name: string, dir: 'in' | 'out', what: string): void => {
    if (type && !ports(type, dir).includes(name)) out.push(`${what}: ${DEFS[type].label} has no ${dir === 'in' ? 'input' : 'output'} "${name}"`);
  };
  const param = (type: string | undefined, name: string, what: string): void => {
    if (type && !params(type).includes(name)) out.push(`${what}: ${DEFS[type].label} has no parameter "${name}"`);
  };
  const num = (v: unknown, what: string): void => { if (typeof v !== 'number' || !Number.isFinite(v)) out.push(`${what}: enter a number`); };
  switch (part.kind) {
    case 'module': if (!DEFS[part.type]) out.push(`there is no module type "${part.type}"`); break;
    case 'cable': case 'noCable':
      port(ref(part.from, 'from'), part.fromPort, 'out', 'from');
      port(ref(part.to, 'to'), part.toPort, 'in', 'to');
      break;
    case 'slider':
      param(ref(part.ref, 'module'), part.param, 'slider');
      if (!SLIDER_OPS.includes(part.op)) out.push(`unknown comparison "${part.op}"`);
      if (part.op !== 'changed') num(part.value, 'value');
      if (part.op === 'between') num(part.max, 'upper value');
      break;
    case 'routed':
      port(ref(part.from, 'from'), part.fromPort, 'out', 'from');
      param(ref(part.to, 'to'), part.param, 'to');
      break;
    case 'pinMap': param(ref(part.ref, 'module'), part.param, 'parameter'); break;
    case 'att': ref(part.ref, 'module'); if (part.op !== 'changed') num(part.value, 'value'); break;
    case 'macroRange': param(ref(part.ref, 'module'), part.param, 'parameter'); num(part.min, 'from'); num(part.max, 'to'); break;
    case 'assembly': {
      const r = roles[part.role];
      if (!r || r.kind === 'member') { out.push(`"${part.role}" is not an assembly role`); break; }
      if (part.fact === 'promoted') param(part.type, part.param ?? '', 'promoted');
      if (part.fact === 'exposed') port(part.type, part.port ?? '', 'out', 'exposed');
      if ((part.fact === 'promoted' || part.fact === 'exposed') && (!part.type || !DEFS[part.type])) out.push('pick the member module type');
      if (part.fact === 'contains' && (!part.child || !roles[part.child])) out.push('pick the nested assembly role');
      if (part.fact === 'saved' && !part.tag) out.push('give the saved assembly a tag');
      break;
    }
    case 'voices': num(part.min, 'voices'); break;
    case 'event':
      if (!EVENT_NAMES.includes(part.event)) out.push(`unknown event "${part.event}"`);
      if (part.event === 'probe') port(part.ref ? ref(part.ref, 'probe') : undefined, part.port ?? 'out', 'out', 'probe');
      if ((part.event === 'probe' || part.event === 'bypassed') && !part.ref) out.push('pick the module');
      if (part.event === 'selected' && !part.types?.length) out.push('pick the module types to select');
      for (const t of part.types ?? []) if (!DEFS[t]) out.push(`there is no module type "${t}"`);
      break;
    case 'sound': if (part.mode !== 'held' && part.mode !== 'silent') out.push('pick held or silent'); break;
    case 'custom': if (!CUSTOM[part.name]) out.push(`there is no custom check "${part.name}"`); break;
  }
  return out;
}

export function validateCourse(course: CourseData): Report {
  const report: Report = { errors: [], warnings: [], hints: [] };
  try { validateShape(course, true); } catch (err) { report.errors.push({ message: (err as Error).message }); return report; }
  const roles = course.roles;
  for (const [name, r] of Object.entries(roles)) {
    if (ROLES[name]) report.errors.push({ message: `Role "${name}" has the name of a code role` });
    if (r.kind === 'assembly') for (const t of r.types) if (!DEFS[t]) report.errors.push({ message: `Role "${name}": there is no module type "${t}"` });
    if (r.kind === 'member') {
      if (roles[r.role]?.kind !== 'assembly' && roles[r.role]?.kind !== 'named') report.errors.push({ message: `Role "${name}": "${r.role}" is not an assembly role` });
      if (!DEFS[r.type]) report.errors.push({ message: `Role "${name}": there is no module type "${r.type}"` });
    }
  }
  // names first: a broken name would make the reference checks meaningless
  if (course.chapters.filter((ch) => ch.tour).length > 1) report.errors.push({ message: 'Only one chapter can be the tour' });
  for (const [ci, ch] of course.chapters.entries()) {
    if (ch.tour && ch.start.kind === 'continue') report.errors.push({ chapter: ch.id, message: 'The tour stands alone: it cannot continue from the chapter before it' });
    if (ch.start.kind === 'continue' && course.chapters[ci - 1]?.tour) report.errors.push({ chapter: ch.id, message: 'A chapter cannot continue from the tour' });
    if (ch.start.kind === 'preset' && !PRESETS[ch.start.name]) report.errors.push({ chapter: ch.id, message: `There is no factory patch "${ch.start.name}"` });
    if (ch.start.kind === 'continue' && ch === course.chapters[0]) report.warnings.push({ chapter: ch.id, message: 'The first chapter cannot continue from a previous one; it starts from a new patch' });
    for (const [f, label] of [['title', 'Title'], ['patchName', 'Patch name'], ['intro', 'Introduction'], ['payoff', 'Payoff'], ['challenge', 'Optional challenge']] as const) {
      if (!ch[f].trim()) report.errors.push({ chapter: ch.id, message: `${label} is empty` });
      if (f !== 'title' && f !== 'patchName' && placedRequirements(ch[f]).length) report.errors.push({ chapter: ch.id, message: `${label} cannot hold requirements (req: links): only a task step’s instructions can` });
    }
    for (const st of ch.steps) {
      if (!st.title.trim()) report.errors.push({ chapter: ch.id, step: st.id, message: 'Title is empty' });
      if (!st.text.trim()) report.errors.push({ chapter: ch.id, step: st.id, message: 'Instructions are empty' });
      if (st.kind === 'task' && !st.parts?.length) report.errors.push({ chapter: ch.id, step: st.id, message: 'A task step needs at least one requirement (or make it a Continue step)' });
      const placed = placedRequirements(st.text).flat();
      if (st.kind === 'continue' && placed.length) report.errors.push({ chapter: ch.id, step: st.id, message: 'A Continue step has no requirements to place: remove the req: links from its text' });
      if (st.kind === 'task') {
        const ids = new Set((st.parts ?? []).map((p) => p.id));
        for (const id of new Set(placed)) if (!ids.has(id)) report.errors.push({ chapter: ch.id, step: st.id, message: `The text places "${id}", which is not one of the step’s requirements` });
        for (const p of st.parts ?? []) if (!p.hidden && !placed.includes(p.id)) report.errors.push({ chapter: ch.id, step: st.id, message: `Requirement "${p.id}" is not placed in the text: place it, or mark it hidden` });
      }
      if (placedRequirements(st.why).length) report.errors.push({ chapter: ch.id, step: st.id, message: 'Why cannot hold requirements: move the req: links to the instructions' });
      for (const [i, p] of (st.parts ?? []).entries()) for (const m of partProblems(p, roles)) report.errors.push({ chapter: ch.id, step: st.id, message: `Requirement ${i + 1}: ${m}` });
    }
  }
  if (report.errors.length) return report;

  let chapters;
  try { chapters = compileCourse(course); } catch (err) { report.errors.push({ message: `The course does not compile: ${(err as Error).message}` }); return report; }
  let library: AssemblyDef[] = [];
  for (const [ci, ch] of course.chapters.entries()) {
    const compiled = chapters[ci];
    for (const [si, st] of ch.steps.entries()) {
      if (st.kind !== 'task') continue;
      const step = compiled.steps[si];
      const ref = course.references[refKey(ch.id, st.id)];
      if (!ref) {
        if (!step.transient) report.warnings.push({ chapter: ch.id, step: st.id, message: 'No reference patch yet: record the step in the synth' });
        continue;
      }
      if (ref.saved) library = [...library.filter((d) => d.tutorial !== ref.saved!.tutorial), ref.saved];
      const s: TutorialState = { ...headlessState(ref.patch, library), entry: stepStart(ci, si, course) };
      for (const p of st.parts ?? []) {
        if (momentary(p)) continue;
        let ok = false;
        try { ok = partCheck(p, s, roles); } catch { ok = false; }
        if (!ok) report.errors.push({ chapter: ch.id, step: st.id, message: `The reference patch fails its own requirement: ${partLabel(p, roles)}` });
      }
      for (const p of st.parts ?? []) if (p.kind === 'assembly' && p.fact === 'saved' && ref.saved?.tutorial !== p.tag) report.errors.push({ chapter: ch.id, step: st.id, message: `The step saves "${p.name ?? p.tag}" but its reference stores no saved assembly with the tag "${p.tag}"` });
      for (let k = 0; k < si; k++) {
        const earlier = compiled.steps[k];
        if (earlier.kind !== 'task' || earlier.transient || earlier.superseded) continue;
        if (!earlier.check(s)) report.errors.push({ chapter: ch.id, step: st.id, message: `The reference patch breaks step ${k + 1} (${earlier.title}): ${earlier.todo?.(s).join('; ')}` });
      }
    }
    try {
      if (!completes(compiled, chapterEnd(ci, course), library)) report.errors.push({ chapter: ch.id, message: 'The chapter’s end does not complete the chapter' });
    } catch (err) { report.errors.push({ chapter: ch.id, message: `The chapter’s end could not be checked: ${(err as Error).message}` }); }
    try { chapterStart(ci, course); } catch (err) { report.errors.push({ chapter: ch.id, message: `The chapter’s start could not be built: ${(err as Error).message}` }); }
    // a step whose cable a later step removes is replaced on purpose: suggest `superseded`
    for (const [si, st] of ch.steps.entries()) {
      if (st.kind !== 'task' || st.superseded) continue;
      const later = ch.steps.slice(si + 1).flatMap((x) => x.parts ?? []);
      const undone = (st.parts ?? []).some((p) => (p.kind === 'cable' && later.some((q) => q.kind === 'noCable' && JSON.stringify([q.from, q.fromPort, q.to, q.toPort]) === JSON.stringify([p.from, p.fromPort, p.to, p.toPort])))
        || (p.kind === 'slider' && later.some((q) => q.kind === 'slider' && q.param === p.param && JSON.stringify(q.ref) === JSON.stringify(p.ref))));
      if (undone && !compiled.steps[si].transient) report.hints.push({ chapter: ch.id, step: st.id, message: 'A later step removes this step’s cable or sets the same slider: mark it superseded if that is on purpose' });
    }
  }
  return report;
}
