import { loadFont, defaults, normalizeState, renderWordmark, renderFigures, lineKeys } from './brand-flex-engine.js';
import { presets, selectedPresetId } from './brand-flex-presets.js';

const $ = id => document.getElementById(id);
const labels = {
  wght:['Weight','Overall weight'], wdth:['Width','Letter proportions'], opsz:['Optical size','Small-text robustness to display detail'],
  GRAD:['Grade','Adjust darkness'], slnt:['Slant','Lean the actual outlines'],
  XTRA:['Counter width','Space inside letters'], XOPQ:['Thick strokes','Vertical stroke thickness'], YOPQ:['Thin strokes','Horizontal stroke thickness'],
  YTUC:['Capital height','F, M, R and other capitals'], YTLC:['Lowercase height','a, o, s and other lowercase bodies'],
  YTAS:['Ascender height','Tall lowercase forms, including h and k'], YTDE:['Descender depth','The tail of y'], YTFI:['Figure height','Numeral sample below; R/1 stays at cap height'],
};
const order = ['wdth','XTRA','wght','XOPQ','YOPQ','GRAD','opsz','slnt','YTUC','YTLC','YTAS','YTDE','YTFI'];
const parameters = new URLSearchParams(location.search);
let font, state, latest, frame, svgURL;
const controls = new Map();
function node(tag, text, className) {
  const result = document.createElement(tag);
  if (text) result.textContent = text;
  if (className) result.className = className;
  return result;
}
function updateURL() {
  const compact = {case:state.case,layout:state.layout,alignment:state.alignment,ratio:state.ratio,gaps:state.gaps};
  for (const word of lineKeys) compact[word] = state[word];
  const url = new URL(location.href);
  url.searchParams.set('state', JSON.stringify(compact));
  url.searchParams.set('theme', $('theme').value);
  history.replaceState(null, '', url);
}
function draw() {
  frame = null;
  try {
    const theme = $('theme').value;
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.layout = state.layout;
    $('alignment').disabled = state.layout === 'line';
    latest = renderWordmark(font, state, theme);
    $('large-preview').innerHTML = latest.svg;
    $('small-preview').innerHTML = latest.svg;
    const split = ['three','four'].includes(state.layout);
    $('width-ratio').textContent = split
      ? `Line widths relative to FAT: ${latest.lineWidths.map((width,index)=>`${latest.lineNames[index]} ${(width/latest.lineWidths[0]).toFixed(2)}×`).join(' · ')}`
      : `MatRyoshka is ${latest.widthRatio.toFixed(2)}× the width of ${state.case === 'mixed' ? 'Fat' : 'FAT'}.`;
    for (const word of lineKeys) $(word+'-figures').innerHTML = renderFigures(font, state[word], theme);
    $('ryo-panel').hidden=!split;
    $('shka-panel').hidden=state.layout!=='four';
    $('mat-title').textContent=split?'MAT':'MatRyoshka';
    $('mat-reset').textContent=split?'Reset MAT axes':'Reset MatRyoshka axes';
    $('ryo-title').textContent=state.layout==='three'?'RYOSHKA':'RYO';
    $('ryo-reset').textContent=state.layout==='three'?'Reset RYOSHKA axes':'Reset RYO axes';
    $('line-gaps').hidden=!split;
    $('gap-row-2').hidden=state.layout!=='four';
    $('gap-label-1').textContent=state.layout==='three'?'MAT → RYOSHKA':'MAT → RYO';
    if (svgURL) URL.revokeObjectURL(svgURL);
    svgURL = URL.createObjectURL(new Blob([latest.svg], {type:'image/svg+xml'}));
    $('download').href = svgURL;
    updateURL();
    $('status').textContent = '';
  } catch (error) {
    $('status').textContent = 'This combination could not render. Choose a starting point to reset it.';
    console.error(error);
  }
}
function schedule() { if (!frame) frame = requestAnimationFrame(draw); }
function sync() {
  for (const [key, {range, output}] of controls) {
    const [word, tag] = key.split(':');
    range.value = state[word][tag];
    output.value = state[word][tag];
  }
  $('case').value = state.case;
  $('layout').value = state.layout;
  $('alignment').value = state.alignment;
  $('ratio').value = state.ratio;
  $('ratio-value').value = `${state.ratio.toFixed(2)}×`;
  state.gaps.forEach((gap,index) => { $('gap-'+index).value=gap; $('gap-value-'+index).value=gap; });
  schedule();
}

try {
  const response = await fetch('../round-three/fonts/RobotoFlex.ttf');
  if (!response.ok) throw new Error('Font download failed');
  font = loadFont(new Uint8Array(await response.arrayBuffer()));
  let initial = presets.find(preset=>preset.id===(parameters.get('preset') ?? selectedPresetId)) ?? presets[1];
  if (parameters.has('state')) {
    try { initial = JSON.parse(parameters.get('state')); }
    catch { $('status').textContent = 'The saved settings could not be read. Using the mixed-case starting point.'; }
  }
  state = normalizeState(font, initial, presets[1]);
  for (const word of lineKeys) {
    for (const tag of order) {
      const axis = font.variationAxes[tag];
      const row = node('div', '', 'axis');
      const label = node('label', labels[tag][0]);
      const id = `${word}-${tag}`;
      label.htmlFor = id;
      const output = node('output'); output.htmlFor = id;
      const range = node('input'); range.type='range'; range.id=id;
      range.min=axis.min; range.max=axis.max; range.step=tag==='slnt' ? '.1' : '1';
      const detail = node('small', `${tag} · ${labels[tag][1]}`);
      detail.id = id+'-help'; range.setAttribute('aria-describedby',detail.id);
      range.oninput = () => { state[word][tag]=Number(range.value); output.value=range.value; schedule(); };
      row.append(label,output,range,detail);
      $(word+'-axes').append(row);
      controls.set(word+':'+tag,{range,output});
    }
    $(word+'-reset').onclick = () => { state[word] = defaults(font); sync(); };
  }
  state.gaps.forEach((_,index) => {
    $('gap-'+index).oninput=()=>{
      state.gaps[index]=Number($('gap-'+index).value);
      $('gap-value-'+index).value=state.gaps[index];
      schedule();
    };
  });
  for (const preset of presets) {
    const card = node('article');
    const sample = node('img'); sample.src=preset.id+'.svg'; sample.alt=preset.name; sample.loading='lazy';
    const button = node('button','Try these settings'); button.type='button';
    button.setAttribute('aria-label',`Try ${preset.name}`);
    button.onclick = () => { state=normalizeState(font,preset,presets[1]); sync(); $('workbench').scrollIntoView({block:'start'}); };
    card.append(sample,node('h3',preset.name),node('p',preset.description),button);
    $('presets').append(card);
  }
  for (const key of ['case','layout','alignment']) $(key).onchange = () => {state[key]=$(key).value; schedule();};
  $('ratio').oninput = () => {state.ratio=Number($('ratio').value); $('ratio-value').value=state.ratio.toFixed(2)+'×'; schedule();};
  $('theme').value=parameters.get('theme')==='light'?'light':'dark';
  $('theme').onchange=schedule;
  $('copy').onclick=async()=>{
    updateURL();
    try {await navigator.clipboard.writeText(location.href); $('copy-status').textContent='Link copied.';}
    catch {$('copy-status').textContent=location.href;}
  };
  $('controls').disabled=false;
  $('copy').disabled=false;
  sync();
} catch (error) {
  $('status').textContent='The font could not load. Reload to try again; the downloadable starting points still work.';
  console.error(error);
}
