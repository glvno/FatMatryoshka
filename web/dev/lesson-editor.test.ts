// SPDX-License-Identifier: GPL-3.0-only
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { CONTENT_URL, lessonEditor, lessonMiddleware, lessonStore } from './lesson-editor';
import { formatCourse, validateShape, type CourseData } from '../src/tutorial/course-schema';
import { COURSE as content } from '../src/tutorial/chapters';

const dirs: string[] = [], servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(s => new Promise<void>((resolve, reject) => s.listening ? s.close(e => e ? reject(e) : resolve()) : resolve())));
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'lesson-editor-')); dirs.push(dir);
  const file = join(dir, 'course.json'); await writeFile(file, formatCourse(content));
  const store = lessonStore(file);
  return { file, store };
}
const changed = (original: CourseData, text = 'A new introduction.\nA second paragraph.') => {
  const copy = structuredClone(original); copy.chapters[0].intro = text; return copy;
};

describe('lesson content', () => {
  it('accepts plain multiline prose, blank optional explanations, and new steps and chapters', () => {
    const next = changed(content, 'Unicode “quotes”, \\slashes, <script>plain text</script>.\n\nNext paragraph.');
    next.chapters[0].steps[0].why = '';
    next.chapters[0].steps.splice(1, 0, { id: 'read-me', kind: 'continue', title: 'A pause', text: 'Some words.', why: '' });
    next.chapters.push({ ...structuredClone(next.chapters[0]), id: 'another' });
    expect(() => validateShape(next)).not.toThrow();
  });
  it('recovers unfinished drafts without allowing blank required text to be saved', () => {
    const draft = changed(content, '');
    expect(() => validateShape(draft, true)).not.toThrow();
    expect(() => validateShape(draft)).toThrow();
  });
  it.each([
    (x: CourseData) => { x.chapters[1].id = x.chapters[0].id; },
    (x: CourseData) => { x.chapters[0].steps[1].text = '   '; },
    (x: CourseData) => { Object.assign(x.chapters[0].steps[0], { kind: 'code' }); },
    (x: CourseData) => { x.chapters[0].intro = 'x'.repeat(20001); },
    (x: CourseData) => { (x as { version: number }).version = 1; },
    (x: CourseData) => { x.chapters[0].steps[0].id = 'Not An Id'; },
  ])('rejects malformed drafts', mutate => {
    const next: CourseData = structuredClone(content); mutate(next);
    expect(() => validateShape(next)).toThrow();
  });
});

describe('local lesson saves', () => {
  it('round-trips prose, rejects stale revisions, and preserves newer source edits', async () => {
    const { store, file } = await fixture(); const before = await store.read();
    const next = changed(before.content, '## Listen\n\nTurn **cutoff** *slowly*.\n\n- Play `C4`\n- [Compare](https://example.com)');
    const saved = await store.save(before.revision, next);
    expect((await store.read()).content).toEqual(next);
    expect(saved.revision).not.toBe(before.revision);
    await expect(store.save(before.revision, content)).rejects.toMatchObject({ status: 409 });
    await writeFile(file, formatCourse(changed(next, 'Edited outside the GUI')));
    await expect(store.save(saved.revision, content)).rejects.toMatchObject({ status: 409 });
    expect(JSON.parse(await readFile(file, 'utf8')).chapters[0].intro).toBe('Edited outside the GUI');
  });
  it('serializes competing saves so only one writer can use a revision', async () => {
    const { store } = await fixture(); const before = await store.read();
    const results = await Promise.allSettled([store.save(before.revision, changed(content, 'First')), store.save(before.revision, changed(content, 'Second'))]);
    expect(results.map(r => r.status)).toEqual(['fulfilled', 'rejected']);
    expect((await store.read()).content.chapters[0].intro).toBe('First');
  });
  it('never changes the file for invalid content', async () => {
    const { store, file } = await fixture(); const before = await store.read(), raw = await readFile(file, 'utf8');
    await expect(store.save(before.revision, { path: '/elsewhere', chapters: {} })).rejects.toMatchObject({ status: 400 });
    expect(await readFile(file, 'utf8')).toBe(raw);
  });
  it('serves and saves locally but refuses cross-origin writes and non-JSON requests', async () => {
    const { store } = await fixture(); const middleware = lessonMiddleware(store);
    const server = createServer((req, res) => { void middleware(req, res, () => { res.statusCode = 404; res.end(); }); }); servers.push(server);
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const addr = server.address(); if (!addr || typeof addr === 'string') throw new Error('No test port');
    const origin = `http://127.0.0.1:${addr.port}`, url = origin + CONTENT_URL;
    const response = await fetch(url); expect(response.status).toBe(200);
    const initial = await response.json(); const body = JSON.stringify({ revision: initial.revision, content: changed(content) });
    const rejectedHeaders: Record<string, string>[] = [ { 'Content-Type': 'application/json' }, { Origin: 'https://untrusted.example', 'Content-Type': 'application/json' }, { Origin: origin, 'Content-Type': 'text/plain' } ];
    for (const headers of rejectedHeaders) {
      expect((await fetch(url, { method: 'PUT', headers, body })).status).toBe(403);
    }
    expect((await fetch(url, { method: 'PUT', headers: { Origin: origin, 'Content-Type': 'application/json' }, body })).status).toBe(200);
    expect((await fetch(url, { method: 'POST' })).status).toBe(405);
    expect((await fetch(url, { method: 'PUT', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: 'null' })).status).toBe(400);
    expect((await fetch(origin + '/not-an-endpoint')).status).toBe(404);
  });
  it('registers only as a development-server plugin, with no preview or build route', () => {
    const plugin = lessonEditor();
    expect(plugin.apply).toBe('serve'); expect(plugin.configurePreviewServer).toBeUndefined(); expect(plugin.generateBundle).toBeUndefined();
  });
});
