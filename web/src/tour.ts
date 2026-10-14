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
  ['A sound you can see', 'Hold A on your keyboard, or hold the button below. Main turns a key press into pitch and gate. Follow the cables through Oscillator → VCA → Output.'],
  ['Every cable has a job', 'Teal carries pitch and control; gold carries the key’s gate; coral carries audio. The VCA opens while a key is held. Release it and the signal stops. Click ◎ beside an output to watch its signal on the scope.'],
  ['Shape it at the source', 'Hold a note and change the Oscillator’s wave or fine tuning. The controls belong to the sound source itself. Drag a slider to adjust it; Alt-drag its thumb to patch a control signal into it.'],
  ['Turn a voice into a building block', 'The oscillator and VCA are now one assembly. Its pitch and gate inputs still connect to Main. The wave and gain controls expose the exact same internal parameters. Nothing in the sound engine has changed.'],
  ['Open it. Understand it. Reuse it.', 'Click Expand on Simple voice to see the original modules and cables. Assemblies can contain other assemblies. Resize the container from its corner; save it to your library to reuse the structure in another instrument.'],
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
    const title = document.createElement('h2'); title.textContent = 'See inside a sound';
    const p = document.createElement('p'); p.textContent = 'Five short steps: play a simple voice, trace its signals, then open it as an assembly. Your current patch will be kept.';
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
    const count = document.createElement('span'); count.className = 'tour-count'; count.textContent = `INSIDE THE PATCH · ${this.step + 1} / ${steps.length}`;
    const title = document.createElement('h2'); title.textContent = steps[this.step][0]; title.tabIndex = -1;
    const p = document.createElement('p'); p.textContent = steps[this.step][1];
    const hold = this.button('Hold to hear C', () => {}); hold.className = 'tour-note';
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
