// SPDX-License-Identifier: GPL-3.0-only
import { positionPopover } from './popover';
import { canSeparate, isPin, parameterInputs, pinRoutes, removeRoute, separateDepth, setInputRoute } from './parameter-routing';
import { paramValue, rangeOf, type Cable, type ModuleDef, type ModuleInst, type ParamDef, type Patch } from './patch';
import { DEFS } from './modules';
import { choiceName, longName, moduleName } from './labels';

interface Events {
  patch(): Patch;
  change(fn: () => void): void;
  onAtt(id: number, index: number, value: number): void;
  onRange(id: number, index: number, name: string, range: [number, number] | null): void;
}

const sourceName = (p: Patch, c: Cable): string => {
  const m = p.modules.find((x) => x.id === c.from.module);
  return m ? `${moduleName(m.type, DEFS[m.type].label)} ${longName(m.type, c.from.port)}` : c.from.port;
};

/**
 * Routing controls live with their destination: what modulates this parameter (each source with its depth or range),
 * the module's own inputs routed to it, and the FM-1 knobs that turn it. The saved matrix remains compatible with the FM-1.
 */
export function parameterMenu(m: ModuleInst, def: ModuleDef, pd: ParamDef, ev: Events, open: boolean, onToggle: (open: boolean) => void): HTMLElement {
  const menu = document.createElement('details');
  menu.className = 'parameter-routing';
  menu.addEventListener('keydown', (e) => {
    if (!menu.open && ![' ', 'Enter', 'Tab'].includes(e.key)) return;
    if (e.key === 'Escape') { menu.open = false; summary.focus(); }
    if (!e.ctrlKey && !e.metaKey) e.stopPropagation();
  });
  menu.open = open;
  const refreshers: (() => void)[] = [];
  menu.ontoggle = () => {
    if (!menu.isConnected) return;
    if (menu.open) {
      for (const refresh of refreshers) refresh();
      content.showPopover();
      positionPopover(content, summary);
    } else if (content.matches(':popover-open')) content.hidePopover();
    onToggle(menu.open);
  };
  const label = longName(def.type, pd.name);
  const summary = document.createElement('summary');
  summary.textContent = '⋮';
  summary.title = `${def.label} ${label}: modulation and knob assignments`;
  summary.setAttribute('aria-label', summary.title);
  const content = document.createElement('div');
  content.className = 'routing-controls';
  content.popover = 'auto';
  content.addEventListener('toggle', () => {
    if (!content.matches(':popover-open') && menu.isConnected) menu.open = false;
  });
  const hint = (text: string): void => {
    const p = document.createElement('p');
    p.textContent = text;
    content.append(p);
  };
  const heading = (text: string): void => {
    const h = document.createElement('h4');
    h.textContent = text;
    content.append(h);
  };
  const p = ev.patch();
  const target = pd.toggle || pd.choices ? 'jack' : 'thumb';
  hint(`Drop a cable on the ${target} to modulate ${label}, with its own depth. ${def.label} takes up to two different sources.`
    + (pd.input ? ` The ${longName(def.type, pd.input)} jack is ${label}'s built-in input.` : ''));

  // what modulates it: the cables into the pins routed to this parameter
  const routes = pinRoutes(p, m, pd.name);
  if (routes.length) heading('Modulated by');
  for (const { cable, pin, index, shared } of routes) {
    const group = document.createElement('div');
    group.className = 'routing-source';
    const head = document.createElement('div');
    head.className = 'routing-head';
    const name = document.createElement('strong');
    name.textContent = sourceName(p, cable);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'sm';
    remove.textContent = 'Remove';
    remove.title = `Stop ${name.textContent} modulating ${label}`;
    remove.onclick = () => ev.change(() => removeRoute(ev.patch(), cable, pd.name));
    head.append(name, remove);
    group.append(head);
    const r = rangeOf(m, pin, pd.name);
    {
      const depthLabel = document.createElement('label');
      depthLabel.textContent = shared.length ? `Depth, shared with ${shared.map((n) => longName(def.type, n)).join(', ')}` : 'Depth';
      const depth = document.createElement('input');
      depth.type = 'range'; depth.min = '-1'; depth.max = '1'; depth.step = '.01';
      depth.value = String(m.att![index]);
      depth.setAttribute('aria-label', `${def.label} ${label}: depth of ${name.textContent}`);
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
      if (shared.length && canSeparate(p, m, pd.name)) {
        const split = document.createElement('button');
        split.type = 'button';
        split.className = 'sm';
        split.textContent = 'Separate depth';
        split.title = `Give ${label} its own depth for ${name.textContent} (uses ${def.label}'s second modulation input)`;
        split.onclick = () => ev.change(() => separateDepth(ev.patch(), DEFS, m, pd.name));
        group.append(split);
      }
    }
    const rangeLabel = document.createElement('label');
    const range = document.createElement('input'); range.type = 'checkbox'; range.checked = !!r;
    range.setAttribute('aria-label', `${def.label}: ${name.textContent} plays ${label} between two values`);
    range.onchange = () => ev.change(() => {
      if (range.checked) ((m.range ??= {})[pin] ??= {})[pd.name] = [0, 1];
      else delete m.range?.[pin]?.[pd.name];
    });
    rangeLabel.append(range, 'Play between two values');
    group.append(rangeLabel);
    if (r) for (const end of [0, 1] as const) {
      const row = document.createElement('label');
      row.textContent = end ? 'To' : 'From';
      const input = document.createElement('input');
      input.type = 'range'; input.min = '0'; input.max = '1'; input.step = '.01'; input.value = String(r[end]);
      input.setAttribute('aria-label', `${def.label}: ${name.textContent} on ${label}, ${end ? 'high' : 'low'} end`);
      const output = document.createElement('output');
      const show = (): void => {
        const v = paramValue(pd, r[end]);
        output.textContent = pd.choices ? choiceName(def.type, pd.name, pd.choices[Math.round(v)] ?? '') : `${Number(v.toFixed(3))}${pd.unit ? ' ' + pd.unit : ''}`;
      };
      input.oninput = () => {
        r[end] = Number(input.value);
        show();
        ev.onRange(m.id, index, pd.name, [r[0], r[1]]);
      };
      show(); row.append(input, output); group.append(row);
    }
    content.append(group);
  }
  // the dedicated input's cables (built in: no depth here)
  if (pd.input) for (const c of p.cables.filter((c) => c.to.module === m.id && c.to.port === pd.input)) hint(`${sourceName(p, c)} → ${longName(def.type, pd.input)} (built in)`);

  // the module's own inputs feeding this parameter as well
  const own = def.inputs.filter((q) => !isPin(q.name));
  if (own.length) heading(`${def.label}'s inputs`);
  for (const port of own) {
    const row = document.createElement('label');
    const box = document.createElement('input'); box.type = 'checkbox';
    box.checked = parameterInputs(m, pd).includes(port.name);
    box.disabled = port.name === pd.input;
    box.setAttribute('aria-label', `${def.label}: ${longName(def.type, port.name)} input controls ${label}`);
    box.onchange = () => ev.change(() => setInputRoute(m, def, port.name, pd.name, box.checked));
    row.append(box, `${longName(def.type, port.name)} → ${label}${port.name === pd.input ? ' (built in)' : ''}`);
    content.append(row);
  }

  // the FM-1's SELECT page: which hardware knobs turn this parameter
  if (def.paramInputs) {
    const knobs = document.createElement('fieldset');
    const legend = document.createElement('legend'); legend.textContent = 'FM-1 knobs';
    knobs.append(legend);
    for (const source of ['k1', 'k2', 'k3', 'k4'] as const) {
      const row = document.createElement('label');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = !!m.map?.[source].includes(pd.name);
      box.setAttribute('aria-label', `${def.label}: FM-1 knob ${source.toUpperCase()} turns ${label}`);
      box.onchange = () => ev.change(() => {
        const list = m.map![source].filter((name) => name !== pd.name);
        if (box.checked) list.push(pd.name);
        m.map![source] = list;
      });
      row.append(box, source.toUpperCase());
      knobs.append(row);
    }
    content.append(knobs);
  }
  menu.append(summary, content);
  return menu;
}
