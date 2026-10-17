// SPDX-License-Identifier: GPL-3.0-only
// Voice control: the flaws of a poly assembly's voice cards (patch.ts PartFlaw), set by hand: a drop-down from the assembly's
// header with one row per voice and a
// slider per flaw. It lives outside the canvas (the editor rebuilds its cards on every change) and reads the settings
// through the host each time, so undo and a changed part count show at the next sync().
import { FLAW_KEYS, FLAW_NONE, FLAW_RANGE, flawOf, type PartFlaw, type PolyCards } from './patch';

export interface FlawHost {
  /** the assembly's label, for the header */
  title: string;
  /** the cards' settings now and how many voices run them (`fed`: an allocator feeds them), null once the assembly or its Poly switch is gone */
  cfg(): { cards: PolyCards; parts: number; fed: boolean } | null;
  /** a change while a slider moves: mutate, the host plays it at once */
  edit(fn: (cards: PolyCards, parts: number) => void): void;
  /** the gesture ended: one undo step */
  commit(): void;
  closed(): void;
}

const COLS: Record<keyof PartFlaw, { label: string; unit: string; title: string }> = {
  detune: { label: 'Detune', unit: 'ct', title: 'Tuning offset of the voice, in cents' },
  drift: { label: 'Drift', unit: '%', title: 'A slow random wander of the voice\'s pitch: at 100 % up to 20 cents either way' },
  bright: { label: 'Bright', unit: 'st', title: 'Moves the cutoff of every filter and ladder on the card, in semitones' },
  env: { label: 'Env', unit: '%', title: 'Makes every ADSR and envelope on the card slower (+) or faster (−)' },
  level: { label: 'Level', unit: '%', title: 'Scales the gain of every VCA on the card' },
};

/** subtle flaws for every part, as an aged polysynth might have */
function randomFlaw(): PartFlaw {
  const r = (lo: number, hi: number): number => Math.round(lo + Math.random() * (hi - lo));
  return { detune: r(-10, 10), drift: r(15, 45), bright: r(-3, 3), env: r(-15, 15), level: r(85, 100) };
}

/** part i's flaw `key` set to v; trailing flawless parts are dropped (patch.ts fixFlaws) */
export function setFlaw(cfg: PolyCards, i: number, key: keyof PartFlaw, v: number): void {
  const list = Array.from({ length: Math.max(cfg.flaws?.length ?? 0, i + 1) }, (_, k) => ({ ...flawOf(cfg, k) }));
  list[i][key] = v;
  while (list.length && FLAW_KEYS.every((k) => list[list.length - 1][k] === FLAW_NONE[k])) list.pop();
  if (list.length) cfg.flaws = list;
  else delete cfg.flaws;
}

export class FlawPanel {
  readonly el = document.createElement('div');
  private body = document.createElement('div');
  /** how many voices run the cards (the allocator's), or that none does */
  private note = document.createElement('div');
  private rows = 0;
  private cells = new Map<string, { input: HTMLInputElement; out: HTMLOutputElement }>();
  private onDown = (e: PointerEvent): void => {
    if (!this.el.contains(e.target as Node) && !(e.target as Element).closest?.('.vc-btn')) this.close();
  };
  private onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return;
    e.stopImmediatePropagation();
    this.close();
  };

  constructor(private host: FlawHost, at: DOMRect) {
    this.el.className = 'flaw-panel';
    this.el.setAttribute('role', 'dialog');
    this.el.setAttribute('aria-label', `Voice control of ${host.title}`);
    const head = document.createElement('div');
    head.className = 'flaw-head';
    const tag = document.createElement('span');
    tag.className = 'mtag mod';
    tag.textContent = 'VOICES';
    const title = document.createElement('span');
    title.className = 'flaw-title';
    title.textContent = host.title;
    const x = document.createElement('button');
    x.className = 'flaw-x';
    x.textContent = '×';
    x.title = 'Close (Esc)';
    x.onclick = () => this.close();
    head.append(tag, title, x);
    this.note.className = 'flaw-note';
    const tools = document.createElement('div');
    tools.className = 'flaw-tools';
    const rnd = document.createElement('button');
    rnd.textContent = 'Randomize';
    rnd.title = 'Give every voice card small flaws of its own';
    rnd.onclick = () => this.all((parts) => Array.from({ length: parts }, randomFlaw));
    const reset = document.createElement('button');
    reset.textContent = 'Reset';
    reset.title = 'No flaws: every voice card alike';
    reset.onclick = () => this.all(() => []);
    tools.append(rnd, reset);
    this.body.className = 'flaw-grid';
    this.el.append(head, this.note, this.body, tools);
    document.body.append(this.el);
    this.sync();
    this.place(at);
    document.addEventListener('pointerdown', this.onDown, true);
    document.addEventListener('keydown', this.onKey, true);
  }

  private place(at: DOMRect): void {
    const r = this.el.getBoundingClientRect();
    const left = Math.max(16, Math.min(innerWidth - r.width - 16, at.left));
    const below = at.bottom + 6;
    const top = below + r.height > innerHeight - 16 ? Math.max(16, at.top - r.height - 6) : below;
    this.el.style.left = `${left}px`;
    this.el.style.top = `${top}px`;
  }

  /** replace every part's flaws at once (one undo step) */
  private all(make: (parts: number) => PartFlaw[]): void {
    this.host.edit((cfg, parts) => {
      const list = make(parts);
      for (let i = 0; i < Math.max(cfg.flaws?.length ?? 0, list.length); i++)
        for (const k of FLAW_KEYS) setFlaw(cfg, i, k, (list[i] ?? FLAW_NONE)[k]);
    });
    this.host.commit();
  }

  /** show the settings as they are now (after undo, a part count change); close when the poly assembly is gone */
  sync(): void {
    const now = this.host.cfg();
    if (!now) return this.close();
    if (now.parts !== this.rows) this.build(now.parts);
    this.note.textContent = now.fed ? `${now.parts} voice${now.parts === 1 ? '' : 's'}, set on the Voice allocator` : 'No Voice allocator feeds these cards: they run once.';
    for (let i = 0; i < now.parts; i++) {
      const f = flawOf(now.cards, i);
      for (const k of FLAW_KEYS) {
        const c = this.cells.get(`${i}:${k}`)!;
        if (document.activeElement !== c.input) c.input.value = String(f[k]);
        this.show(c, k, f[k]);
      }
    }
  }

  private show(c: { input: HTMLInputElement; out: HTMLOutputElement }, k: keyof PartFlaw, v: number): void {
    c.out.textContent = `${(k === 'detune' || k === 'bright' || k === 'env') && v > 0 ? '+' : ''}${v}`;
    c.input.closest('.flaw-cell')!.classList.toggle('off', v === FLAW_NONE[k]);
  }

  private build(parts: number): void {
    this.rows = parts;
    this.cells.clear();
    const kids: HTMLElement[] = [document.createElement('span')];
    for (const k of FLAW_KEYS) {
      const h = document.createElement('span');
      h.className = 'flaw-col';
      h.title = COLS[k].title;
      h.innerHTML = `${COLS[k].label} <small>${COLS[k].unit}</small>`;
      kids.push(h);
    }
    for (let i = 0; i < parts; i++) {
      const n = document.createElement('span');
      n.className = 'flaw-part';
      n.textContent = `V${i + 1}`;
      kids.push(n);
      for (const k of FLAW_KEYS) {
        const cell = document.createElement('label');
        cell.className = 'flaw-cell';
        cell.title = `${COLS[k].title}. Double-click: back to ${FLAW_NONE[k]}`;
        const input = document.createElement('input');
        input.type = 'range';
        [input.min, input.max] = FLAW_RANGE[k].map(String);
        input.step = '1';
        input.setAttribute('aria-label', `Voice ${i + 1} ${COLS[k].label}`);
        const out = document.createElement('output');
        const c = { input, out };
        input.oninput = () => {
          const v = Number(input.value);
          this.host.edit((cfg) => setFlaw(cfg, i, k, v));
          this.show(c, k, v);
        };
        input.onchange = () => this.host.commit();
        input.ondblclick = () => {
          input.value = String(FLAW_NONE[k]);
          input.dispatchEvent(new Event('input'));
          this.host.commit();
        };
        cell.append(input, out);
        this.cells.set(`${i}:${k}`, c);
        kids.push(cell);
      }
    }
    this.body.replaceChildren(...kids);
  }

  close(): void {
    if (!this.el.isConnected) return;
    document.removeEventListener('pointerdown', this.onDown, true);
    document.removeEventListener('keydown', this.onKey, true);
    this.el.remove();
    this.host.closed();
  }
}
