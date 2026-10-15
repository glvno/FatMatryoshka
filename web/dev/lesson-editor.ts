// SPDX-License-Identifier: GPL-3.0-only
import { createHash, randomUUID } from 'node:crypto';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { formatCourse, validateShape, type CourseData } from '../src/tutorial/course-schema.ts';

export const CONTENT_URL = '/__lesson-editor/content';
/** the course with its reference patches is a few hundred KB */
const MAX_BODY = 16_000_000;
export class LessonError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const revision = (raw: string) => createHash('sha256').update(raw).digest('hex');

export function lessonStore(file: string) {
  const read = async () => {
    const raw = await readFile(file, 'utf8');
    return { revision: revision(raw), content: JSON.parse(raw) as CourseData };
  };
  // Serialize save requests so two tabs cannot both overwrite the same revision.
  let pending: Promise<unknown> = Promise.resolve();
  const save = (base: unknown, content: unknown) => {
    const task = pending.then(async () => {
      const current = await read();
      if (base !== current.revision) throw new LessonError(409, 'The lesson file changed since you opened it. Download your draft, then reload the saved text to review the newer version.');
      try { validateShape(content); }
      catch (err) { throw new LessonError(400, (err as Error).message); }
      const raw = formatCourse(content as CourseData);
      const temp = `${file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temp, raw, { flag: 'wx' });
        if ((await read()).revision !== base) throw new LessonError(409, 'The lesson file changed during save. Your draft is still here; download it before reloading.');
        await rename(temp, file);
      } finally { await unlink(temp).catch(() => {}); }
      return { revision: revision(raw), content };
    });
    pending = task.catch(() => {});
    return task;
  };
  return { read, save };
}

/** Local, same-origin only. The request can never choose a filesystem path. */
export function localRequest(req: IncomingMessage): boolean {
  const ip = req.socket.remoteAddress;
  if (!ip || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip)) return false;
  try {
    const host = new URL(`http://${req.headers.host}`);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(host.hostname)) return false;
    if (req.headers.origin && !['http:', 'https:'].some(protocol => req.headers.origin === `${protocol}//${host.host}`)) return false;
    if (req.headers['sec-fetch-site'] === 'cross-site') return false;
    return true;
  } catch { return false; }
}

export function lessonMiddleware(store: ReturnType<typeof lessonStore>) {
  return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (req.url?.split('?')[0] !== CONTENT_URL) { next(); return; }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    const reply = (status: number, value: unknown) => { res.statusCode = status; res.end(JSON.stringify(value)); };
    try {
      if (!localRequest(req)) throw new LessonError(403, 'The lesson editor is available only on localhost.');
      if (req.method === 'GET') { reply(200, await store.read()); return; }
      if (req.method !== 'PUT') { res.setHeader('Allow', 'GET, PUT'); throw new LessonError(405, 'Method not allowed'); }
      if (!req.headers.origin || req.headers['content-type']?.split(';')[0] !== 'application/json') throw new LessonError(403, 'Save from the local lesson editor.');
      let size = 0; const chunks: Buffer[] = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY) throw new LessonError(413, 'The lesson draft is too large.');
        chunks.push(Buffer.from(chunk));
      }
      let data;
      try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new LessonError(400, 'The lesson draft is not valid JSON.'); }
      if (!data || typeof data !== 'object') throw new LessonError(400, 'Missing lesson draft.');
      reply(200, await store.save(data.revision, data.content));
    } catch (err) {
      reply(err instanceof LessonError ? err.status : 500, { error: err instanceof LessonError ? err.message : 'The lesson file could not be read or saved. Your draft is still in the editor.' });
    }
  };
}

export function lessonEditor(): Plugin {
  return {
    name: 'local-lesson-editor',
    apply: 'serve',
    handleHotUpdate(ctx) {
      if (ctx.file !== resolve(ctx.server.config.root, 'src/tutorial/course.json')) return;
      // Refresh the synth, while the editor tab keeps its cursor, page and newer draft edits.
      ctx.server.ws.send({ type: 'custom', event: 'lesson-course-saved', data: {} });
      return [];
    },
    configureServer(server) {
      const store = lessonStore(resolve(server.config.root, 'src/tutorial/course.json'));
      server.middlewares.use(lessonMiddleware(store));
      server.middlewares.use(async (req, res, next) => {
        if (req.url?.split('?')[0] !== '/lesson-editor') { next(); return; }
        if (!localRequest(req)) { res.statusCode = 403; res.end('Open the lesson editor on localhost.'); return; }
        const html = await server.transformIndexHtml('/lesson-editor', `<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Lesson editor · Matryoshka</title></head>
<body><div id="lesson-editor"></div><script type="module" src="/src/dev/lesson-editor.ts"></script></body></html>`);
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.end(html);
      });
    },
  };
}
