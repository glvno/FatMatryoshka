// SPDX-License-Identifier: GPL-3.0-only
import { describe, it, expect, vi, afterEach } from 'vitest';
import { CHAPTERS, chapterStart, chapterEnd, courseRun } from './chapters';
import { HeadlessSession, byId, cabled, loose, mod, mods, noSeen, place } from './model';
import { storeTutorialAssembly, loadLibrary } from '../assemblies';
import { allModules } from '../assembly';
import { Engine } from '../engine';
import { DEFS } from '../modules';
import { paramValue, removeModule, validatePatch, type Patch } from '../patch';
import { buildPerformance, hasPerformance } from './performance';
import { Audition } from './audition';
import { keepVariation, variations } from './variations';

function before(chapter: number, step: string): HeadlessSession {
  const session = new HeadlessSession(chapterStart(chapter), structuredClone(courseRun().library));
  for (const st of CHAPTERS[chapter].steps) {
    session.state.seen = noSeen(); session.state.entry = structuredClone(session.patch());
    if (st.id === step) break;
    if (!st.check(session.state)) st.apply(session, session.state);
  }
  return session;
}
function apply(chapter: number, step: string, s: HeadlessSession): void {
  CHAPTERS[chapter].steps.find((st) => st.id === step)!.apply(s, s.state);
}
function tail(patch: Patch): number {
  const e = new Engine(48000); e.load(patch); e.noteOn(60, 0.8);
  const l = new Float32Array(128), r = new Float32Array(128); let peak = 0;
  for (let block = 0; block < 1125; block++) {
    e.render(l, r);
    if (block >= 750) for (const sample of l) peak = Math.max(peak, Math.abs(sample));
  }
  return peak;
}
describe('manual tutorial regressions', () => {
  it('repairs a manually duplicated oscillator without adding a third', () => {
    const s = before(5, 'dup');
    s.edit((p) => { const copy = place(p, 'osc'); copy.params = { ...mod(p, 'osc')!.params }; });
    expect(CHAPTERS[5].steps.find((x) => x.id === 'dup')!.check(s.state)).toBe(false);
    apply(5, 'dup', s);
    expect(mods(s.patch(), 'osc')).toHaveLength(2);
    for (const o of mods(s.patch(), 'osc')) expect(cabled(s.patch(), mod(s.patch(), 'fm1'), 'pitch', o, 'pitch')).toBe(true);
  });
  it('selects a manually added external drum mixer and preserves factory internals', () => {
    const s = before(10, 'mix');
    const factoryIds = new Set(s.patch().assemblies!.filter((a) => ['kick', 'snare'].includes(a.name)).flatMap((a) => allModules(s.patch(), a)));
    const internal = () => s.patch().cables.filter((c) => factoryIds.has(c.from.module) && factoryIds.has(c.to.module));
    const cables = structuredClone(internal());
    s.edit((p) => place(p, 'mixer'));
    const id = loose(s.patch(), 'mixer')!.id;
    apply(10, 'mix', s);
    expect(loose(s.patch(), 'mixer')!.id).toBe(id);
    expect(internal()).toEqual(cables);
    const mixer = loose(s.patch(), 'mixer')!;
    expect(s.patch().cables.filter((c) => c.to.module === mixer.id)).toHaveLength(3);
  });
  it('manual hat settings have no held-note sustain and match helper settings', () => {
    const s = before(10, 'env'); apply(10, 'env', s);
    const env = mod(s.patch(), 'env')!;
    expect(env.params).toMatchObject({ l1: 1, r1: 0.001, l2: 0, r2: 0.08, l3: 0, l4: 0 });
    expect(tail(s.patch())).toBeLessThan(1e-6);
    env.params.l3 = 0.6;
    expect(CHAPTERS[10].steps.find((x) => x.id === 'env')!.check(s.state)).toBe(false);
    expect(tail(s.patch())).toBeGreaterThan(0.01);
  });
  it('the pluck dies while held and the FM envelope cannot rise to default sustain', () => {
    const pluck = before(1, 'pluck'); apply(1, 'pluck', pluck);
    expect(tail(pluck.patch())).toBeLessThan(1e-6);
    const fm = before(5, 'index'); apply(5, 'index', fm);
    expect(mod(fm.patch(), 'env')!.params.l3).toBe(0.3);
  });
  it.each([[5, 'dry'], [7, 'dry'], [7, 'grain']] as const)('chapter %i has an audible path at %s', (chapter, step) => {
    const s = before(chapter, step); apply(chapter, step, s);
    const e = new Engine(48000); e.load(s.patch()); e.noteOn(60, 0.8);
    const l = new Float32Array(128), r = new Float32Array(128); let peak = 0;
    for (let i = 0; i < 750; i++) { e.render(l, r); for (const sample of l) peak = Math.max(peak, Math.abs(sample)); }
    expect(peak).toBeGreaterThan(0.005);
  });
  it('uses a real morph target and Hz macro endpoints at full depth', () => {
    const p = chapterEnd(8); expect(p.modules.some((m) => m.paramsB)).toBe(true);
    expect(mod(p, 'fm1')!.params.morph).toBe(0.5);
    const f = mod(p, 'filter')!; const pd = DEFS.filter.params.find((x) => x.name === 'cutoff')!;
    expect(f.att![0]).toBe(1);
    expect(paramValue(pd, f.range!.p1!.cutoff[0])).toBeCloseTo(150);
    expect(paramValue(pd, f.range!.p1!.cutoff[1])).toBeCloseTo(4000);
  });
  it('clocks sequence pitch and both instruments from the same subdivision', () => {
    const p = chapterEnd(9); const [beat, half] = mods(p, 'clkdiv');
    expect(beat.params.div).toBe(6);
    expect(cabled(p, mod(p, 'fm1'), 'clock', beat, 'clock')).toBe(true);
    expect(cabled(p, beat, 'out', mod(p, 'seq'), 'clock')).toBe(true);
    expect(cabled(p, beat, 'out', half, 'clock')).toBe(true);
    expect(cabled(p, half, 'd2', mod(p, 'pulse'), 'trig')).toBe(true);
    expect(cabled(p, beat, 'd2', mod(p, 'pulse'), 'trig')).toBe(false);
  });
  it('does not accept a stale library name as a new save', () => {
    const s = before(3, 'save');
    expect(CHAPTERS[3].steps.find((x) => x.id === 'save')!.check(s.state)).toBe(false);
    s.saveAssembly(courseRun().library.find((d) => d.tutorial === 'my-space')!, 'my-space');
    expect(CHAPTERS[3].steps.find((x) => x.id === 'save')!.check(s.state)).toBe(false);
    apply(3, 'save', s);
    expect(CHAPTERS[3].steps.find((x) => x.id === 'save')!.check(s.state)).toBe(true);
  });
  it('the finale validates within the module budget and stores its eight-bar form', () => {
    const p = chapterEnd(10); expect(p.modules.length).toBeLessThanOrEqual(32);
    expect(() => validatePatch(structuredClone(p), DEFS)).not.toThrow();
    const a = p.assemblies!.find((x) => x.name === 'Eight-bar arrangement')!;
    const form = allModules(p, a).map((id) => byId(p, id)!).find((m) => m.type === 'seq')!;
    const e = new Engine(8000); e.load(p); const l = new Float32Array(128), r = new Float32Array(128);
    const values: number[] = [];
    // Read halfway through each bar, avoiding block-boundary timing differences.
    for (let block = 0; block < 1000; block++) { e.render(l, r); if (block % 125 === 62) values.push(e.probe(form.id, 'out')![0]); }
    expect(values).toEqual([0, 0, 0.5, 0.5, 0.5, 0.5, 1, 0]);
  });
});

describe('audition lifetime', () => {
  afterEach(() => vi.useRealTimers());
  it('stops every chord note and all recurring riff callbacks', async () => {
    vi.useFakeTimers(); const send = vi.fn(); const a = new Audition(send, async () => {});
    await a.play('chord'); a.stop();
    expect(send.mock.calls).toEqual([[true, 60], [true, 64], [true, 67], [false, 60], [false, 64], [false, 67]]);
    await a.play('riff'); await vi.advanceTimersByTimeAsync(1000); a.stop();
    const calls = send.mock.calls.length; await vi.advanceTimersByTimeAsync(10000);
    expect(send).toHaveBeenCalledTimes(calls); expect(vi.getTimerCount()).toBe(0);
  });
  it('never starts notes after Stop while audio unlock is pending', async () => {
    let unlock!: () => void; const send = vi.fn();
    const a = new Audition(send, () => new Promise<void>((r) => { unlock = r; }));
    const pending = a.play('riff'); a.stop(); unlock(); await pending;
    expect(send).not.toHaveBeenCalled();
  });
});
describe('variation recovery', () => {
  const storage = () => { const data = new Map<string, string>(); return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); } }; };
  it('keeps same-named Tutorial patches as distinct immutable versions', () => {
    const store = storage(); const p = chapterEnd(0);
    keepVariation(p, CHAPTERS[0].id, store); mod(p, 'osc')!.params.wave = 3;
    keepVariation(p, CHAPTERS[0].id, store);
    const saved = variations(store); expect(saved).toHaveLength(2);
    expect(mod(saved[0].patch, 'osc')!.params.wave).toBe(2);
    expect(mod(saved[1].patch, 'osc')!.params.wave).toBe(3);
  });
  it('surfaces a failed save rather than silently evicting or claiming success', () => {
    const p = chapterEnd(0); const original = structuredClone(p);
    expect(() => keepVariation(p, null, { getItem: () => '[]', setItem: () => { throw new Error('full'); } })).toThrow('full');
    expect(p).toEqual(original);
  });
});


it('tutorial saves preserve the previous instrument and leave only one active tag', () => {
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => data.set(k, v) });
  try {
    const original = structuredClone(courseRun().library[0]);
    storeTutorialAssembly(original);
    const updated = structuredClone(original); updated.name = 'My new voice'; updated.modules[0].params.wave = 3;
    storeTutorialAssembly(updated);
    const library = loadLibrary();
    expect(library).toHaveLength(2);
    expect(library.filter((d) => d.tutorial === original.tutorial)).toHaveLength(1);
    expect(library.find((d) => d.tutorial === original.tutorial)?.name).toBe('My new voice');
    expect(library.find((d) => d.name.includes('previous'))?.modules).toEqual(original.modules);
  } finally { vi.unstubAllGlobals(); }
});


it('repairs missing finale wiring and a deleted form sequencer without duplicating instruments', () => {
  const p = chapterEnd(10); const def = courseRun().library.find((d) => d.tutorial === 'pluck')!;
  const a = p.assemblies!.find((x) => x.name === 'Eight-bar arrangement')!;
  const form = allModules(p, a).map((id) => byId(p, id)!).find((m) => m.type === 'seq')!;
  p.cables = p.cables.filter((c) => c.from.module !== form.id);
  expect(hasPerformance(p)).toBe(false); buildPerformance(p, def); expect(hasPerformance(p)).toBe(true);
  const count = p.modules.length; removeModule(p, form.id); a.modules = a.modules.filter((id) => id !== form.id);
  expect(hasPerformance(p)).toBe(false); buildPerformance(p, def); expect(hasPerformance(p)).toBe(true);
  expect(p.modules).toHaveLength(count); expect(p.assemblies!.filter((x) => x.name === 'Pluck')).toHaveLength(1);
});
