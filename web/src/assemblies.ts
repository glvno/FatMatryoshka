// SPDX-License-Identifier: GPL-3.0-only
// The assembly library: the factory set shipped with the editor (src/assemblies/*.json) and the user's own, kept in
// localStorage, each one in the file format of assembly.ts. The Assemblies page lists them: insert, export, import, delete.
import { validateAssemblyDef, type AssemblyDef } from './assembly';
import { DEFS } from './modules';

const STORE = 'modular-1.assemblies';

/** the assemblies shipped with the editor, in file order */
export const FACTORY: AssemblyDef[] = Object.entries(import.meta.glob('./assemblies/*.json', { eager: true, import: 'default' }) as Record<string, unknown>)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([, raw]) => validateAssemblyDef(JSON.parse(JSON.stringify(raw)), DEFS));

export function loadLibrary(): AssemblyDef[] {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE) ?? 'null') as unknown;
    if (Array.isArray(raw)) return raw.flatMap((d) => {
      try {
        return [validateAssemblyDef(d, DEFS)];
      } catch {
        return [];
      }
    });
  } catch {
    /* fall through */
  }
  return [];
}

export function saveLibrary(list: AssemblyDef[]): void {
  try {
    localStorage.setItem(STORE, JSON.stringify(list));
  } catch {
    /* storage blocked: the library is not remembered */
  }
}

/** put a definition into the user library; a name that exists is replaced after a confirm. Returns what happened. */
export function storeAssembly(def: AssemblyDef, confirm: (msg: string) => boolean = (m) => window.confirm(m)): 'saved' | 'replaced' | 'cancelled' {
  const list = loadLibrary();
  const i = list.findIndex((d) => d.name === def.name);
  if (i >= 0) {
    if (!confirm(`Replace the assembly "${def.name}" in the library?`)) return 'cancelled';
    list[i] = def;
    saveLibrary(list);
    return 'replaced';
  }
  list.push(def);
  saveLibrary(list);
  return 'saved';
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  const { class: cls, ...rest } = props as Record<string, unknown>;
  if (cls) e.className = String(cls);
  Object.assign(e, rest);
  e.append(...kids);
  return e;
}

const summary = (d: AssemblyDef): string => {
  const io = [d.inputs.map((r) => r.label).join(', '), d.outputs.map((r) => r.label).join(', ')].filter(Boolean).join(' → ');
  return `${d.modules.map((m) => DEFS[m.type].label).join(' + ')}${io ? ` · ${io}` : ''}`;
};

export function download(def: AssemblyDef): void {
  const blob = new Blob([JSON.stringify(def, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${def.name.replace(/[^\w.-]+/g, '_') || 'assembly'}.assembly.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

export interface LibraryEvents {
  insert(def: AssemblyDef): void;
  status(msg: string): void;
}

/** the Assemblies page. Returns a refresh function for when the library changed elsewhere (a save from the editor). */
export function buildAssembliesTab(root: HTMLElement, ev: LibraryEvents): () => void {
  const userEl = el('div', { class: 'bank-list' });
  const factoryEl = el('div', { class: 'bank-list' });
  const note = el('p', { class: 'muted' });
  const row = (d: AssemblyDef, user: boolean): HTMLElement =>
    el(
      'div',
      { class: 'bank-row' },
      el('span', { class: 'grow' }, el('b', { textContent: d.name }), ' ', el('span', { class: 'muted', textContent: summary(d) })),
      el('button', { textContent: 'Insert', title: 'Put it into the patch', onclick: () => ev.insert(d) }),
      el('button', { textContent: 'Export', title: 'Download as a .json file', onclick: () => download(d) }),
      ...(user
        ? [
            el('button', {
              textContent: '×',
              title: 'Delete from the library',
              onclick: () => {
                if (!window.confirm(`Delete the assembly "${d.name}" from the library?`)) return;
                saveLibrary(loadLibrary().filter((x) => x.name !== d.name));
                refresh();
              },
            }),
          ]
        : []),
    );
  const refresh = (): void => {
    const list = loadLibrary();
    userEl.replaceChildren(...list.map((d) => row(d, true)));
    note.textContent = list.length ? '' : 'None yet. Select modules in the patch, click "Make assembly", then "save" on its card.';
    factoryEl.replaceChildren(...FACTORY.map((d) => row(d, false)));
  };
  const file = el('input', { type: 'file', accept: 'application/json,.json', hidden: true });
  file.onchange = async () => {
    const f = file.files?.[0];
    file.value = '';
    if (!f) return;
    try {
      const def = validateAssemblyDef(JSON.parse(await f.text()), DEFS);
      const r = storeAssembly(def);
      ev.status(r === 'cancelled' ? 'import cancelled' : `"${def.name}" ${r === 'replaced' ? 'replaced in' : 'added to'} the library`);
      refresh();
    } catch (e) {
      ev.status(`import failed: ${(e as Error).message}`);
    }
  };
  root.append(
    el(
      'div',
      { class: 'card' },
      el('h2', { textContent: 'Assemblies' }),
      el('p', { class: 'muted', textContent: 'An assembly is a group of prewired modules that appears as one card with the ports and parameters it exposes. Make one from a selection in the patch; save it here to use it again.' }),
      el('h3', { textContent: 'Your library' }),
      userEl,
      note,
      el('div', { class: 'row' }, el('label', { class: 'btn', textContent: 'Import .json' }, file)),
      el('h3', { textContent: 'Factory' }),
      factoryEl,
    ),
  );
  refresh();
  return refresh;
}
