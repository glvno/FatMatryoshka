// SPDX-License-Identifier: GPL-3.0-only
// The assembly browser: a two-pane dialog opened from the toolbar's "Insert assembly" button. Shelves down the left (the
// user's library first, then the factory categories), the chosen shelf's entries on the right with name, summary and
// exposed ports; a search field at the top cuts across every shelf. A click inserts and closes. On a phone the dialog is
// a full-width sheet (style.css).
import type { AssemblyDef } from './assembly';
import { CATEGORIES, categoryOf, FACTORY, loadLibrary, summary, USER_SHELF } from './assemblies';
import { score } from './fuzzy';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  const { class: cls, ...rest } = props as Record<string, unknown>;
  if (cls) e.className = String(cls);
  Object.assign(e, rest);
  e.append(...kids);
  return e;
}

/** the exposed ports as `gate, pitch → out` */
export const portsOf = (d: AssemblyDef): string => [d.inputs.map((r) => r.label).join(', '), d.outputs.map((r) => r.label).join(', ')].filter(Boolean).join(' → ');

export class AssemblyBrowser {
  private dlg: HTMLDialogElement;
  private shelves: HTMLElement;
  private list: HTMLElement;
  private search: HTMLInputElement;
  private shelf: string = CATEGORIES[0];
  private sel = 0;
  private shown: AssemblyDef[] = [];

  constructor(private onInsert: (d: AssemblyDef) => void) {
    this.search = el('input', { type: 'search', placeholder: 'search every shelf…', autocomplete: 'off' });
    this.shelves = el('nav', { class: 'shelves' });
    this.list = el('ul', { class: 'entries' });
    this.dlg = el('dialog', { class: 'browser' }, el('div', { class: 'head' }, this.search, el('form', { method: 'dialog' }, el('button', { textContent: 'Close', type: 'submit' }))), el('div', { class: 'panes' }, this.shelves, this.list));
    document.body.append(this.dlg);
    this.search.oninput = () => {
      this.sel = 0;
      this.render();
    };
    this.search.onkeydown = (e) => {
      if (e.key === 'ArrowDown') (this.sel = Math.min(this.sel + 1, this.shown.length - 1)), this.render(), e.preventDefault();
      else if (e.key === 'ArrowUp') (this.sel = Math.max(this.sel - 1, 0)), this.render(), e.preventDefault();
      else if (e.key === 'Enter' && this.shown[this.sel]) this.pick(this.shown[this.sel]), e.preventDefault();
    };
    this.dlg.onclick = (e) => {
      if (e.target === this.dlg) this.dlg.close(); // a click on the backdrop
    };
  }

  open(): void {
    this.search.value = '';
    this.sel = 0;
    if (!loadLibrary().length && this.shelf === USER_SHELF) this.shelf = CATEGORIES[0];
    this.render();
    this.dlg.showModal();
    this.search.focus();
  }

  private pick(d: AssemblyDef): void {
    this.dlg.close();
    this.onInsert(d);
  }

  private render(): void {
    const user = loadLibrary();
    const q = this.search.value.trim().toLowerCase();
    const all: [string, AssemblyDef][] = [...user.map((d): [string, AssemblyDef] => [USER_SHELF, d]), ...FACTORY.map((d): [string, AssemblyDef] => [categoryOf(d), d])];
    const names = [USER_SHELF, ...CATEGORIES];
    this.shelves.replaceChildren(
      ...names.map((n) => {
        const count = all.filter(([s]) => s === n).length;
        const b = el('button', { type: 'button', textContent: n, class: n === this.shelf && !q ? 'on' : '', disabled: !count && n === USER_SHELF });
        b.append(el('span', { class: 'n', textContent: String(count) }));
        b.onclick = () => {
          this.shelf = n;
          this.search.value = '';
          this.sel = 0;
          this.render();
        };
        return b;
      }),
    );
    const rows = q
      ? all
          .map((x) => ({ x, s: score(q, x[1].name) }))
          .filter((r) => r.s >= 0)
          .sort((a, b) => b.s - a.s)
          .map((r) => r.x)
      : all.filter(([s]) => s === this.shelf);
    this.shown = rows.map(([, d]) => d);
    this.sel = Math.min(this.sel, Math.max(0, this.shown.length - 1));
    this.list.replaceChildren(
      ...rows.map(([s, d], i) => {
        const li = el(
          'li',
          { class: i === this.sel ? 'sel' : '' },
          el('div', { class: 'name' }, el('b', { textContent: d.name }), q ? el('span', { class: 'shelf', textContent: s }) : ''),
          el('div', { class: 'muted', textContent: summary(d) }),
          el('div', { class: 'ports', textContent: portsOf(d) }),
        );
        li.onclick = () => this.pick(d);
        return li;
      }),
    );
    if (!rows.length) this.list.append(el('li', { class: 'muted none', textContent: q ? 'nothing matches' : this.shelf === USER_SHELF ? 'none yet: select modules, "Make assembly", then "save" on the card' : 'empty shelf' }));
  }
}
