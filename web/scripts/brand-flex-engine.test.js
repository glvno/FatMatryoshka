import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadFont, normalizeState, renderWordmark, renderFigures, spacingPairs } from './brand-flex-engine.js';
import { presets } from './brand-flex-presets.js';

const font = loadFont(new Uint8Array(readFileSync(new URL('../public/brand/round-three/fonts/RobotoFlex.ttf', import.meta.url))));
const initial = () => normalizeState(font,presets[1],presets[1]);

test('presets keep their independent layout, case and axis settings', () => {
  const outlines = new Set();
  for (const preset of presets) {
    const state = normalizeState(font,preset,presets[1]);
    assert.equal(state.case,preset.case);
    assert.equal(state.layout,preset.layout);
    assert.equal(state.mat.wdth,preset.mat.wdth);
    assert.equal(state.id,undefined);
    const result = renderWordmark(font,state);
    assert.ok(result.width>0 && result.height>0 && Number.isFinite(result.widthRatio));
    assert.ok(!/NaN|Infinity/.test(result.svg));
    assert.equal((result.svg.match(/class="accent numeral"/g)||[]).length,1);
    assert.equal((result.svg.match(/class="accent"/g)||[]).length,state.layout === 'matryoshka' ? 1 : 2);
    outlines.add(result.svg);
  }
  assert.equal(outlines.size,presets.length);
});

test('lowercase axes change the mixed-case wordmark', () => {
  for (const tag of ['YTLC','YTAS','YTDE']) {
    const state = initial();
    state.mat[tag]=font.variationAxes[tag].min;
    const low=renderWordmark(font,state).svg;
    state.mat[tag]=font.variationAxes[tag].max;
    assert.notEqual(renderWordmark(font,state).svg,low,tag);
  }
});

test('figure height changes figures, while the custom R/1 stays at capital height', () => {
  const state=initial();
  state.mat.YTFI=font.variationAxes.YTFI.min;
  const word=renderWordmark(font,state).svg;
  const figures=renderFigures(font,state.mat,'dark');
  state.mat.YTFI=font.variationAxes.YTFI.max;
  assert.equal(renderWordmark(font,state).svg,word);
  assert.notEqual(renderFigures(font,state.mat,'dark'),figures);
});

test('all axis extremes render without broken geometry', () => {
  for (const [tag,axis] of Object.entries(font.variationAxes)) {
    for (const value of [axis.min,axis.max]) {
      const state=initial(); state.fat[tag]=value; state.mat[tag]=value;
      assert.ok(!/NaN|Infinity/.test(renderWordmark(font,state).svg),`${tag} ${value}`);
    }
  }
});

test('shared settings round-trip and invalid values are bounded', () => {
  const state=initial();
  assert.deepEqual(normalizeState(font,JSON.parse(JSON.stringify(state)),presets[1]),state);
  const clamped=normalizeState(font,{fat:{wdth:9999,wght:'bad'},mat:{slnt:-100},ratio:99,case:'<script>'},presets[1]);
  assert.equal(clamped.fat.wdth,151); assert.equal(clamped.fat.wght,400);
  assert.equal(clamped.mat.slnt,-10); assert.equal(clamped.ratio,3); assert.equal(clamped.case,'mixed');
});

test('the numeral serif matches the font thin stroke, including slanted settings', () => {
  for (const preset of [presets[1],presets[2],presets[4]]) {
    for (const YOPQ of [25,79,135]) {
      const state=normalizeState(font,preset,presets[1]);
      state.mat.YOPQ=YOPQ;
      const svg=renderWordmark(font,state).svg;
      const d=svg.match(/class="accent numeral"[^>]* d="([^"]+)"/)[1];
      const points=d.slice(1,-1).split('L').map(p=>p.split(' ').map(Number));
      const [a,b]=points, lower=points.at(-1);
      const distance=Math.abs((b[0]-a[0])*(lower[1]-a[1])-(b[1]-a[1])*(lower[0]-a[0]))/Math.hypot(b[0]-a[0],b[1]-a[1]);
      const h=font.getVariation(state.mat).glyphForCodePoint(72);
      const ys=h.path.commands.filter(c=>c.args.length).map(c=>c.args.at(-1)).filter(y=>y>0&&y<h.bbox.maxY);
      assert.ok(Math.abs(distance-(Math.max(...ys)-Math.min(...ys)))<.01,`${preset.id}, YOPQ ${YOPQ}`);
    }
  }
});

test('older settings seed new lines from MAT and independent settings round-trip', () => {
  const state=initial();
  assert.deepEqual(state.ryo,state.mat);
  assert.deepEqual(state.shka,state.mat);
  state.ryo.wdth=font.variationAxes.wdth.default;
  state.shka.YOPQ=25;
  state.layout='four'; state.gaps=[10,90,25];
  assert.deepEqual(normalizeState(font,JSON.parse(JSON.stringify(state)),presets[1]),state);
});

test('three- and four-line layouts preserve FM1 and independent line outlines', () => {
  const linePaths=svg=>Object.fromEntries([...svg.matchAll(/<g data-line="([^"]+)"[^>]*>(.*?)<\/g>/g)].map(match=>[match[1],match[2]]));
  for (const [layout,names] of [['three',['FAT','MAT','RYOSHKA']],['four',['FAT','MAT','RYO','SHKA']]]) {
    const state=initial();state.layout=layout;state.case='caps';
    const before=renderWordmark(font,state);
    assert.deepEqual(before.lineNames,names);
    assert.equal(before.lineWidths.length,names.length);
    assert.equal((before.svg.match(/class="accent"/g)||[]).length,state.layout === 'matryoshka' ? 1 : 2);
    assert.equal((before.svg.match(/class="accent numeral"/g)||[]).length,1);
    state.ryo.YOPQ=25;
    const after=renderWordmark(font,state);
    const a=linePaths(before.svg), b=linePaths(after.svg);
    assert.equal(a.fat,b.fat);assert.equal(a.mat,b.mat);assert.equal(a.shka,b.shka);
    assert.notEqual(a.ryo,b.ryo);
  }
});

test('each visible gap affects only spacing and hidden gaps add no padding', () => {
  for (const layout of ['three','four']) {
    const state=initial();state.layout=layout;
    const before=renderWordmark(font,state);
    for (let index=0;index<3;index++) {
      state.gaps[index]+=30;
      const after=renderWordmark(font,state);
      const visible=layout==='four'||index<2;
      assert.ok(Math.abs(after.height-before.height-(visible?30:0))<.001);
      assert.deepEqual(after.lineWidths,before.lineWidths);
      state.gaps[index]-=30;
    }
  }
});

test('stacked alignment preserves outlines and aligns visible line edges', () => {
  const offsets = svg => [...svg.matchAll(/data-line="[^"]+" transform="translate\(([-\d.]+) ([-\d.]+)\)"/g)]
    .map(match => match.slice(1).map(Number));
  const paths = svg => svg.match(/<path[^>]+\/>/g);
  for (const layout of ['stack','three','four']) {
    const state=initial(); state.layout=layout;
    const center=renderWordmark(font,state);
    for (const alignment of ['left','right','justify']) {
      state.alignment=alignment;
      const result=renderWordmark(font,state);
      assert.equal(result.width,center.width);
      assert.equal(result.height,center.height);
      assert.deepEqual(paths(result.svg),paths(center.svg));
      offsets(result.svg).forEach(([x,y],index) => {
        const [centerX,centerY]=offsets(center.svg)[index];
        assert.ok(Math.abs(x-(alignment==='right'?2*centerX:0))<.002);
        assert.equal(y,centerY);
      });
      assert.deepEqual(normalizeState(font,JSON.parse(JSON.stringify(state)),presets[1]),state);
    }
  }
});

test('justification adds equal letter spacing, keeping the R and its numeral together', () => {
  const state=initial();state.layout='four';state.case='caps';
  const natural=renderWordmark(font,state);
  state.alignment='justify';
  const justified=renderWordmark(font,state);
  assert.deepEqual(justified.lineWidths,[natural.width,natural.width,natural.width,natural.width]);
  const rows=justified.svg.split(/<g data-line="[^"]+"[^>]*>/).slice(1);
  rows.forEach((row,index) => {
    const shifts=[...row.matchAll(/<g transform="translate\(([-\d.]+) 0\)">/g)].map(match=>Number(match[1]));
    assert.equal(shifts.length,[3,3,3,4][index]);
    assert.equal(shifts[0],0);
    assert.ok(Math.abs(shifts.at(-1)-(natural.width-natural.lineWidths[index]))<.001);
    const steps=shifts.slice(1).map((shift,i)=>shift-shifts[i]);
    assert.ok(Math.max(...steps)-Math.min(...steps)<.002);
  });
  assert.match(rows[2],/<g transform="translate\(0 0\)"><path class="ink"[^>]+\/><path class="accent numeral"[^>]+\/><\/g>/);
  assert.equal(normalizeState(font,{alignment:'invalid'},presets[1]).alignment,'center');
  state.layout='line';
  const oneLine=renderWordmark(font,state).svg;
  state.alignment='right';
  assert.equal(renderWordmark(font,state).svg,oneLine);
});

const current = () => normalizeState(font,presets.find(p=>p.id==='p10'),presets[1]);
const outlineData = svg => [...svg.matchAll(/<path[^>]* d="([^"]+)"/g)].map(m=>m[1]);
const letterPositions = svg => [...svg.matchAll(/<path[^>]*translate\(([-\d.]+) 0\)/g)].map(m=>Number(m[1]));

test('Every pair spacing moves only that pair and subsequent letters, without changing outlines', () => {
  for (const [index,key] of spacingPairs.entries()) {
    const first=index+1+(index>=3?1:0);
    const state=current(), before=renderWordmark(font,state);
    state.tuning[key]=-25;
    const after=renderWordmark(font,state);
    assert.equal(after.width,before.width-25);
    assert.deepEqual(outlineData(after.svg),outlineData(before.svg));
    const a=letterPositions(before.svg),b=letterPositions(after.svg);
    a.forEach((x,i)=>assert.ok(Math.abs(b[i]-x-(i>=first?-25:0))<.002));
  }
});

test('T arm edits preserve stem and horizontal thickness across axis extremes', () => {
  const coords=d=>d.match(/-?\d+(?:\.\d+)?/g).map(Number);
  for (const [tag,axis] of Object.entries(font.variationAxes)) {
    for (const value of [axis.min,axis.max]) {
      const state=current();state.mat[tag]=value;
      const before=renderWordmark(font,state), paths=outlineData(before.svg), original=coords(paths[2]);
      for (const key of ['leftArm','rightArm']) {
        state.tuning[key]=30;
        const after=renderWordmark(font,state), edited=outlineData(after.svg), shortened=coords(edited[2]);
        assert.ok(!/NaN|Infinity/.test(after.svg),`${tag} ${key}`);
        assert.ok(after.width<before.width,`${tag} ${key}`);
        // Only the T outline changes. All y coordinates and stem vertices stay intact.
        assert.deepEqual(edited.filter((_,i)=>i!==2),paths.filter((_,i)=>i!==2));
        assert.deepEqual(shortened.filter((_,i)=>i%2),original.filter((_,i)=>i%2));
        assert.deepEqual(shortened.slice(2,10),original.slice(2,10));
        state.tuning[key]=100;
      }
    }
  }
});

test('T adjustments round-trip, clamp invalid values and do not affect legacy FAT or mixed case', () => {
  const state=current();state.tuning={...state.tuning,at:-20,tr:10,leftArm:85,rightArm:65};
  assert.deepEqual(normalizeState(font,JSON.parse(JSON.stringify(state)),presets[1]),state);
  assert.deepEqual(normalizeState(font,{tuning:{at:-999,tr:'bad',leftArm:-1,rightArm:999}},presets[1]).tuning,
    {...current().tuning,at:-80,tr:0,leftArm:0,rightArm:100});
  assert.deepEqual(current().tuning,{...Object.fromEntries(spacingPairs.map(pair=>[pair,0])),leftArm:100,rightArm:100});
  for (const layout of ['matryoshka','line','stack','three','four']) {
    const base=current();base.layout=layout; const before=renderWordmark(font,base);
    base.tuning=state.tuning;const after=renderWordmark(font,base);
    assert.ok(!/NaN|Infinity/.test(after.svg));
    if (layout!=='matryoshka') assert.deepEqual(outlineData(before.svg).slice(0,3),outlineData(after.svg).slice(0,3));
    if (['three','four'].includes(layout)) {
      const split=after.svg;base.tuning.tr=80;assert.equal(renderWordmark(font,base).svg,split);
    }
    base.case='mixed'; const mixed=renderWordmark(font,base).svg;
    base.tuning={...base.tuning,leftArm:100,rightArm:100};assert.equal(renderWordmark(font,base).svg,mixed);
  }
});


test('pair spacing applies in mixed case and to each separate line, ignoring broken pairs', () => {
  for (const letterCase of ['caps','mixed']) {
    for (const layout of ['matryoshka','three','four']) {
      for (const [index,pair] of spacingPairs.entries()) {
        const state=current();state.case=letterCase;state.layout=layout;
        const before=renderWordmark(font,state);
        state.tuning[pair]=20;
        const after=renderWordmark(font,state);
        const broken=layout!=='matryoshka' && (pair==='tr'||(layout==='four'&&pair==='os'));
        if (broken) assert.equal(after.svg,before.svg);
        else {
          assert.notEqual(after.svg,before.svg);
          assert.deepEqual(outlineData(after.svg),outlineData(before.svg));
          if (layout==='matryoshka') assert.ok(Math.abs(after.width-before.width-20)<.001);
          else {
            const row=index<2?1:layout==='three'||index<5?2:3;
            before.lineWidths.forEach((width,i)=>assert.ok(Math.abs(after.lineWidths[i]-width-(i===row?20:0))<.001));
          }
        }
      }
    }
  }
});

test('older T-only links retain their settings and the latest working preset matches the shared version', () => {
  const old={...presets.find(p=>p.id==='p10'),tuning:{at:-23,tr:6,leftArm:89,rightArm:56}};
  const state=normalizeState(font,old,presets[1]);
  for(const pair of spacingPairs) assert.equal(state.tuning[pair],old.tuning[pair]??0);
  const latest=normalizeState(font,presets.find(p=>p.id==='p11'),presets[1]);
  assert.deepEqual(latest.tuning,state.tuning);
  assert.equal(latest.mat.wght,597);assert.equal(latest.mat.wdth,64);
  assert.equal(latest.mat.XOPQ,39);assert.equal(latest.mat.YOPQ,121);assert.equal(latest.mat.XTRA,425);
});
