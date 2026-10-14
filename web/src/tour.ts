// SPDX-License-Identifier: GPL-3.0-only
import type { Patch } from './patch';
import { starterPatch } from './starter';
import { makeAssembly, promote } from './assembly';

interface TourEvents {
  getPatch(): Patch;
  load(patch: Patch): void;
  active(on: boolean): void;
  fit(): void;
  note(on: boolean): void;
}
const SEEN = 'fatmatryoshka.tour-seen';
const steps = [
  ['Play a note', 'Hold A on your keyboard, or hold the button below. Main sends the note’s pitch to the Oscillator. The Oscillator makes the sound, which passes through the VCA to Output.'],
  ['Follow the cables', 'Teal cables carry control values, gold cables carry gates, and coral cables carry audio. Main’s gate is on while you hold a key. It opens the VCA so the sound can pass. Click ◎ beside an output to see its signal on the scope.'],
  ['Change the sound', 'Hold a note and change the Oscillator’s wave or fine tuning. Drag a slider to set its value. A slider thumb is also an input jack: Alt-drag it to an output, or drag an output cable onto it, to control that parameter with a signal.'],
  ['Make an assembly', 'The tour has grouped the Oscillator and VCA into an assembly called Simple voice. The pitch cable still reaches the Oscillator, and the gate cable reaches the VCA through the cv input. The wave and gain sliders control those same parameters inside. To group modules yourself, select them and press G.'],
  ['Open an assembly', 'Click Expand on Simple voice to edit its modules and cables. An assembly can contain other assemblies. Drag the bottom-right corner to resize it. Click Save in its header to add it to your library. Keep this patch below, or return to the patch you had open.'],
] as const;

/** A reversible tour: the original patch stays in storage until “Keep this patch”. */
export class PatchTour {
  private panel = document.createElement('section');
  private original: Patch | null = null;
  private step = 0;
  private sounding = false;
  constructor(private ev: TourEvents) {
    this.panel.className = 'patch-tour'; this.panel.hidden = true;
    this.panel.setAttribute('role', 'region'); this.panel.setAttribute('aria-label', 'Patch editor tour');
    document.body.append(this.panel);
    window.addEventListener('blur', () => this.release());
  }
  private button(text: string, action: () => void, primary = false): HTMLButtonElement {
    const b = document.createElement('button'); b.textContent = text; b.classList.toggle('primary', primary); b.onclick = action; return b;
  }
  private seen(): void { try { localStorage.setItem(SEEN, '1'); } catch { /* storage optional */ } }
  welcome(): void {
    try { if (localStorage.getItem(SEEN)) return; } catch { /* storage optional */ }
    this.panel.hidden = false;
    const title = document.createElement('h2'); title.textContent = 'Patch editor tutorial';
    const p = document.createElement('p'); p.textContent = 'This tutorial opens a patch with four modules, explains its connections, and groups two modules into an assembly. You can return to your current patch afterward.';
    this.panel.replaceChildren(title, p, this.button('Take the tour', () => this.start(), true), this.button('Later', () => { this.seen(); this.panel.hidden = true; }));
  }
  start(): void {
    this.seen(); if (this.original) return;
    this.original = structuredClone(this.ev.getPatch()); this.ev.active(true); this.step = 0;
    this.ev.load(starterPatch()); this.ev.fit(); this.panel.hidden = false; this.render();
  }
  private release(): void { if (this.sounding) { this.sounding = false; this.ev.note(false); } }
  finish(keep: boolean): void {
    this.release(); const original = this.original; this.original = null;
    this.panel.hidden = true; document.querySelectorAll('.tour-focus').forEach(el => el.classList.remove('tour-focus'));
    if (!original) return;
    const patch = keep ? this.ev.getPatch() : original;
    this.ev.active(false); this.ev.load(patch);
  }
  private render(): void {
    this.release();
    const count = document.createElement('span'); count.className = 'tour-count'; count.textContent = `Step ${this.step + 1} of ${steps.length}`;
    const title = document.createElement('h2'); title.textContent = steps[this.step][0]; title.tabIndex = -1;
    const p = document.createElement('p'); p.textContent = steps[this.step][1];
    const hold = this.button('Hold to play C', () => {}); hold.className = 'tour-note';
    const press = (): void => { if (!this.sounding) { this.sounding = true; this.ev.note(true); } };
    hold.onpointerdown = e => { e.preventDefault(); hold.setPointerCapture(e.pointerId); press(); };
    hold.onpointerup = hold.onlostpointercapture = () => this.release();
    hold.onkeydown = e => { if ([' ', 'Enter'].includes(e.key)) { e.preventDefault(); e.stopPropagation(); press(); } };
    hold.onkeyup = e => { if ([' ', 'Enter'].includes(e.key)) { e.preventDefault(); e.stopPropagation(); this.release(); } };
    hold.onblur = () => this.release();
    const actions = document.createElement('div'); actions.className = 'tour-actions';
    if (this.step < steps.length - 1) actions.append(this.button('Next →', () => {
      this.release(); this.step++;
      if (this.step === 3) {
        const patch = structuredClone(this.ev.getPatch());
        const members = patch.modules.filter(m => ['osc', 'vca'].includes(m.type));
        if (members.length === 2 && !patch.assemblies?.length) {
          const a = makeAssembly(patch, members.map(m => m.id), 'Simple voice');
          for (const m of members) promote(a, m.id, m.type === 'osc' ? 'wave' : 'gain');
          this.ev.load(patch); this.ev.fit();
        }
      }
      this.render();
    }, true));
    else actions.append(this.button('Keep this patch', () => this.finish(true), true));
    actions.append(this.button('Return to my patch', () => this.finish(false)));
    this.panel.replaceChildren(count, title, p, hold, actions);
    document.querySelectorAll('.tour-focus').forEach(el => el.classList.remove('tour-focus'));
    const target = document.querySelector(this.step >= 3 ? '.assembly' : this.step === 2 ? '.module[data-id="2"]' : '.module[data-id="1"]');
    target?.classList.add('tour-focus');
    const canvas = document.getElementById('canvas');
    if (canvas && canvas.clientWidth < 700 && target instanceof HTMLElement) {
      canvas.scrollLeft = Math.max(0, target.offsetLeft - 12); canvas.scrollTop = Math.max(0, target.offsetTop - 12);
    }
    title.focus({ preventScroll: true });
  }
}
