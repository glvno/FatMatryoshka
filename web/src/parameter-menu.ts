// SPDX-License-Identifier: GPL-3.0-only
import { paramValue, rangeOf, type ModuleDef, type ModuleInst, type ParamDef, type Source } from './patch';

interface Events {
  change(fn: () => void): void;
  onAtt(id: number, index: number, value: number): void;
  onRange(id: number, index: number, name: string, range: [number, number] | null): void;
}

/** Routing controls live with their destination. The saved matrix remains compatible with the FM-1. */
export function parameterMenu(m: ModuleInst, def: ModuleDef, pd: ParamDef, ev: Events, open: boolean, onToggle: (open: boolean) => void): HTMLElement {
  const menu = document.createElement('details');
  menu.className = 'parameter-routing';
  menu.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { menu.open = false; summary.focus(); }
    if (!e.ctrlKey && !e.metaKey) e.stopPropagation();
  });
  menu.open = open;
  const refreshers: (() => void)[] = [];
  menu.ontoggle = () => {
    if (!menu.isConnected) return;
    if (menu.open) for (const refresh of refreshers) refresh();
    onToggle(menu.open);
  };
  const summary = document.createElement('summary');
  summary.textContent = '⋯';
  summary.title = `${def.label} ${pd.name}: modulation and knob assignments`;
  summary.setAttribute('aria-label', summary.title);
  const content = document.createElement('div');
  content.className = 'routing-controls';
  const hint = (text: string): void => {
    const p = document.createElement('p');
    p.textContent = text;
    content.append(p);
  };
  if (pd.toggle) hint('Use p1 / p2 below to modulate this switch.');
  else if (pd.input) hint(`Thumb → ${pd.input} input. Drag to adjust; Alt-drag to patch.`);
  else hint('Drop a cable on the thumb, or Alt-drag to patch.');

  const assignment = (source: Source, parent: HTMLElement): void => {
    const label = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = !!m.map?.[source].includes(pd.name);
    box.setAttribute('aria-label', `${def.label}: ${source} controls ${pd.name}`);
    box.onchange = () => ev.change(() => {
      const list = m.map![source].filter((name) => name !== pd.name);
      if (box.checked) list.push(pd.name);
      else if (source === 'p1' || source === 'p2') delete m.range?.[source]?.[pd.name];
      m.map![source] = list;
    });
    label.append(box, source.toUpperCase());
    parent.append(label);
  };
  if (def.paramInputs) {
    for (const [index, pin] of (['p1', 'p2'] as const).entries()) {
      const group = document.createElement('div');
      group.className = 'routing-source';
      assignment(pin, group);
      content.append(group);
      if (!m.map![pin].includes(pd.name)) continue;
      const shared = m.map![pin].filter((name) => name !== pd.name);
      const depthLabel = document.createElement('label');
      depthLabel.textContent = shared.length ? `Depth (also ${shared.join(', ')})` : 'Depth';
      const depth = document.createElement('input');
      depth.type = 'range'; depth.min = '-1'; depth.max = '1'; depth.step = '.01';
      depth.value = String(m.att![index]);
      depth.setAttribute('aria-label', `${def.label} ${pd.name}: ${pin} depth`);
      const value = document.createElement('output');
      value.textContent = Number(depth.value).toFixed(2);
      refreshers.push(() => { depth.value = String(m.att![index]); value.textContent = Number(depth.value).toFixed(2); });
      depth.oninput = () => {
        m.att![index] = Number(depth.value);
        value.textContent = Number(depth.value).toFixed(2);
        ev.onAtt(m.id, index, Number(depth.value));
      };
      depthLabel.append(depth, value);
      group.append(depthLabel);
      const r = rangeOf(m, pin, pd.name);
      const rangeLabel = document.createElement('label');
      const range = document.createElement('input'); range.type = 'checkbox'; range.checked = !!r;
      range.setAttribute('aria-label', `${def.label}: macro range of ${pin} on ${pd.name}`);
      range.onchange = () => ev.change(() => {
        if (range.checked) ((m.range ??= {})[pin] ??= {})[pd.name] = [0, 1];
        else delete m.range?.[pin]?.[pd.name];
      });
      rangeLabel.append(range, 'Map between two values');
      group.append(rangeLabel);
      if (!r) continue;
      for (const end of [0, 1] as const) {
        const label = document.createElement('label');
        label.textContent = end ? 'To' : 'From';
        const input = document.createElement('input');
        input.type = 'range'; input.min = '0'; input.max = '1'; input.step = '.01'; input.value = String(r[end]);
        input.setAttribute('aria-label', `${def.label}: ${pin} on ${pd.name}, ${end ? 'high' : 'low'} end`);
        const output = document.createElement('output');
        const show = (): void => {
          const v = paramValue(pd, r[end]);
          output.textContent = pd.choices?.[Math.round(v)] ?? `${Number(v.toFixed(3))}${pd.unit ? ' ' + pd.unit : ''}`;
        };
        input.oninput = () => {
          r[end] = Number(input.value);
          show();
          ev.onRange(m.id, index, pd.name, [r[0], r[1]]);
        };
        show(); label.append(input, output); group.append(label);
      }
    }
    const knobs = document.createElement('fieldset');
    const legend = document.createElement('legend'); legend.textContent = 'FM-1 knobs';
    knobs.append(legend);
    for (const source of ['k1', 'k2', 'k3', 'k4'] as const) assignment(source, knobs);
    content.append(knobs);
  }
  menu.append(summary, content);
  return menu;
}
