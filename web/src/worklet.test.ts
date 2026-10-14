// SPDX-License-Identifier: GPL-3.0-only
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { addModule, connect, emptyPatch, type Patch } from './patch';
import { DEFS } from './modules';
import { PRESETS } from './presets';
import type { HostMsg } from './worklet';

interface ProbeMessage { probe: string; data: Float32Array; sr: number; revision: number }
interface Processor {
  port: { onmessage: (event: { data: HostMsg }) => void; postMessage: ReturnType<typeof vi.fn> };
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}
let Processor: new () => Processor;
beforeAll(async () => {
  vi.stubGlobal('sampleRate', 48000);
  vi.stubGlobal('AudioWorkletProcessor', class { port = { postMessage: vi.fn(), onmessage: null }; });
  vi.stubGlobal('registerProcessor', (_name: string, ctor: new () => Processor) => { Processor = ctor; });
  await import('./worklet');
});
afterAll(() => vi.unstubAllGlobals());

function send(processor: Processor, data: HostMsg): void { processor.port.onmessage({ data }); }
function render(processor: Processor, blocks = 12) {
  const channels = [new Float32Array(128), new Float32Array(128)];
  for (let i = 0; i < blocks; i++) expect(processor.process([], [channels])).toBe(true);
  return channels;
}
function probes(processor: Processor): ProbeMessage[] {
  return processor.port.postMessage.mock.calls.map(([message]) => message).filter(message => message.probe);
}
function stereoPatch(): Patch {
  const patch = emptyPatch();
  const left = addModule(patch, DEFS.const, 0, 0);
  const right = addModule(patch, DEFS.const, 0, 0);
  const extra = addModule(patch, DEFS.const, 0, 0);
  const output = addModule(patch, DEFS.output, 0, 0);
  left.params.value = .5; right.params.value = -.75; extra.params.value = .25;
  output.params.level = .5;
  connect(patch, DEFS, { module: left.id, port: 'out' }, { module: output.id, port: 'l' });
  connect(patch, DEFS, { module: extra.id, port: 'out' }, { module: output.id, port: 'l' });
  connect(patch, DEFS, { module: right.id, port: 'out' }, { module: output.id, port: 'r' });
  return patch;
}

it('automatically scopes both rendered channels through every factory preset and polyphonic patch load', () => {
  const processor = new Processor();
  const poly = PRESETS['Subtractive saw'](); poly.voices = 4;
  for (const [index, patch] of [...Object.values(PRESETS).map(make => make()), poly].entries()) {
    processor.port.postMessage.mockClear();
    send(processor, { t: 'patch', patch, revision: index + 1 });
    send(processor, { t: 'on', note: 60, vel: .8 });
    send(processor, { t: 'on', note: 67, vel: .8 });
    const channels = render(processor);
    const messages = probes(processor);
    expect(messages.map(p => p.probe), patch.name).toEqual(['output:left', 'output:right']);
    for (const [channel, message] of messages.entries()) {
      expect(message.revision).toBe(index + 1);
      expect(message.data.slice(-128)).toEqual(channels[channel]);
      expect(message.data.every(Number.isFinite)).toBe(true);
    }
    expect(processor.port.postMessage.mock.calls.some(([m]) => m.error), patch.name).toBe(false);
  }
});

it('scopes the summed, level-adjusted stereo signal without cancellation or retaining samples from a previous patch', () => {
  const processor = new Processor();
  send(processor, { t: 'patch', patch: stereoPatch(), revision: 1 });
  render(processor, 36); // Wrap the 4096-sample rings.
  const messages = probes(processor).slice(-2);
  expect(messages[0].data.every(value => value === .375)).toBe(true);
  expect(messages[1].data.every(value => value === -.375)).toBe(true);
  processor.port.postMessage.mockClear();
  send(processor, { t: 'patch', patch: emptyPatch(), revision: 2 });
  render(processor);
  for (const message of probes(processor)) {
    expect(message.revision).toBe(2);
    expect(message.data.every(value => value === 0)).toBe(true);
  }
});
