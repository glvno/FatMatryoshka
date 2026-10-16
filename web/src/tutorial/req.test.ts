import { describe, expect, it } from 'vitest';
import { placedRequirements, renderLessonMarkdown } from './markdown';
import { DEFS } from '../modules';
import { newPatch, addModule } from '../patch';
import { COURSE, compileStep } from './chapters';
import { headlessState } from './model';
import { partSlug, withId } from './parts';
import { validateCourse } from './validate';
import type { StepData } from './course-schema';

describe('requirements placed in the text', () => {
  it('renders a req link as a checkbox around the words, in headings, lists and sentences', () => {
    const html = renderLessonMarkdown('## [Add a **VCA**](req:add-vca)\n\n- [Cable it](req:a,b)\n\nThen [click it](req:probe).');
    expect(html).toContain('<h4><span class="req" data-req="add-vca"><span class="req-box" aria-hidden="true"></span><span class="req-text">Add a <strong>VCA</strong></span></span></h4>');
    expect(html).toContain('data-req="a,b"');
    expect(html).not.toContain('href="req:');
  });
  it('leaves other links alone', () => {
    expect(renderLessonMarkdown('[site](https://example.com) and [x](req:Bad)')).not.toContain('class="req"');
  });
  it('lists the placed ids in reading order, not code spans', () => {
    expect(placedRequirements('`[no](req:code)`\n\n# [one](req:a)\n\n> [two](req:b,c)')).toEqual([['a'], ['b', 'c']]);
  });
});

describe('a step with placed requirements', () => {
  const step: StepData = {
    id: 's', kind: 'task', title: 'T', why: '',
    text: '## [Add a VCA](req:vca)\n\nThen [add an LFO](req:lfo).',
    parts: [{ id: 'lfo', kind: 'module', type: 'lfo' }, { id: 'vca', kind: 'module', type: 'vca' }, { id: 'quiet', kind: 'sound', mode: 'silent', hidden: true }, { id: 'loose', kind: 'module', type: 'adsr' }],
  };
  const compiled = compileStep(step, {});
  const p = newPatch(DEFS);
  it('reports each requirement by id', () => {
    addModule(p, DEFS.lfo, 0, 0);
    expect(compiled.met!(headlessState(p))).toEqual({ lfo: true, vca: false, quiet: true, loose: false });
  });
  it('points at the first unmet requirement in reading order', () => {
    const fresh = newPatch(DEFS);
    expect(compiled.focus!(headlessState(fresh))).toEqual([{ kind: 'ui', id: 'add-btn' }]);
    expect(compiled.targetsOf!(['vca'], headlessState(fresh))).toEqual([{ kind: 'ui', id: 'add-btn' }]);
  });
});

describe('the validator and req links', () => {
  it('rejects an unknown id, a req link in Why, and one in a Continue step', () => {
    const c = structuredClone(COURSE);
    const steps = c.chapters[0].steps;
    const task = steps.find((s) => s.kind === 'task')!;
    task.text += '\n\n[nope](req:no-such-part)';
    task.why = '[x](req:' + task.parts![0].id + ')';
    steps.find((s) => s.kind === 'continue')!.text += ' [x](req:a)';
    const msgs = validateCourse(c).errors.map((e) => e.message).join('\n');
    expect(msgs).toMatch(/places "no-such-part"/);
    expect(msgs).toMatch(/Why cannot hold requirements/);
    expect(msgs).toMatch(/A Continue step has no requirements to place/);
  });
  it('requires every requirement to be placed in the text unless it is hidden', () => {
    const c = structuredClone(COURSE);
    const task = c.chapters[0].steps.find((s) => s.id === 'vca')!;
    task.text = task.text.replace(/\[([^\]]*)\]\(req:add-vca\)/, '$1');
    const errors = validateCourse(c).errors.filter((e) => e.step === 'vca').map((e) => e.message);
    expect(errors).toEqual(['Requirement "add-vca" is not placed in the text: place it, or mark it hidden']);
  });
});

describe('requirement ids', () => {
  it('are short names of what the part checks', () => {
    expect(partSlug({ kind: 'cable', from: { type: 'fm1' }, fromPort: 'gate', to: { type: 'vca' }, toPort: 'cv' })).toBe('main-gate-vca-cv');
    expect(partSlug({ kind: 'noCable', from: { type: 'osc' }, fromPort: 'out', to: { type: 'output' }, toPort: 'l' })).toBe('unplug-osc-out-output-l');
    expect(partSlug({ kind: 'slider', ref: { type: 'adsr' }, param: 'a', op: 'ge', value: 0.1 })).toBe('adsr-a');
    expect(partSlug({ kind: 'module', type: 'osc', count: 2 })).toBe('add-osc-2');
    expect(partSlug({ kind: 'assembly', role: 'myVoice', fact: 'promoted', type: 'filter', param: 'cutoff' })).toBe('my-voice-promoted-filter-cutoff');
    expect(partSlug({ kind: 'cable', from: { type: 'clkdiv' }, fromPort: 'out', to: { type: 'clkdiv', index: 1 }, toPort: 'clock' })).toBe('clkdiv-out-clkdiv2-clock');
  });
  it('stay unique within the step', () => {
    expect(withId({ kind: 'module', type: 'vca' }, ['add-vca']).id).toBe('add-vca-2');
  });
});

describe('pace', () => {
  it('a task step waits for Continue unless it says advance', () => {
    const st: StepData = { id: 's', kind: 'task', title: 'T', text: '[Add a VCA](req:add-vca)', why: '', parts: [{ id: 'add-vca', kind: 'module', type: 'vca' }] };
    expect(compileStep(st, {}).listen).toBe(true);
    expect(compileStep({ ...st, advance: true }, {}).listen).toBe(false);
  });
});
