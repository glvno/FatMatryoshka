// SPDX-License-Identifier: GPL-3.0-only
// rv32.mjs profile() on a pool of worker threads: `run(elfName, patch, events)` resolves with the blocks.
import { availableParallelism } from 'node:os';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { profile, readElf } from './rv32.mjs';

if (!isMainThread) {
  const elfs = Object.fromEntries(Object.entries(workerData).map(([k, path]) => [k, readElf(path)]));
  parentPort.on('message', ({ id, elf, patch, events }) => {
    try {
      parentPort.postMessage({ id, result: profile(elfs[elf], patch, events) });
    } catch (e) {
      parentPort.postMessage({ id, error: String(e) });
    }
  });
}

/** a pool over the ELF files `elfs` (name -> path) */
export function pool(elfs, size = availableParallelism()) {
  const workers = Array.from({ length: size }, () => new Worker(new URL(import.meta.url), { workerData: elfs }));
  const waiting = new Map();
  const idle = [...workers];
  const queue = [];
  let next = 0;
  const pump = () => {
    while (idle.length && queue.length) idle.pop().postMessage(queue.shift());
  };
  for (const w of workers)
    w.on('message', ({ id, result, error }) => {
      const { resolve, reject } = waiting.get(id);
      waiting.delete(id);
      idle.push(w);
      pump();
      if (error) reject(new Error(error));
      else resolve(result);
    });
  return {
    run(elf, patch, events) {
      const id = next++;
      return new Promise((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        queue.push({ id, elf, patch, events });
        pump();
      });
    },
    close: () => Promise.all(workers.map((w) => w.terminate())),
  };
}
