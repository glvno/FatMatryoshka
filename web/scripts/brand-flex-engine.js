import { create } from 'fontkit';

export const loadFont = bytes => create(bytes);
const n = value => Number(value.toFixed(3));
export const defaults = font => Object.fromEntries(Object.entries(font.variationAxes).map(([tag, axis]) => [tag, axis.default]));
export const lineKeys = ['fat', 'mat', 'ryo', 'shka'];

export function normalizeState(font, input, fallback) {
  const result = {};
  for (const word of lineKeys) {
    result[word] = defaults(font);
    for (const [tag, axis] of Object.entries(font.variationAxes)) {
      const inherited = ['ryo','shka'].includes(word) ? result.mat[tag] : axis.default;
      const value = Number(input?.[word]?.[tag] ?? fallback[word]?.[tag] ?? inherited);
      result[word][tag] = Number.isFinite(value) ? Math.max(axis.min, Math.min(axis.max, value)) : axis.default;
    }
  }
  result.layout = ['line','stack','three','four'].includes(input?.layout) ? input.layout : fallback.layout;
  const alignments = ['left','right','center','justify'];
  result.alignment = alignments.includes(input?.alignment) ? input.alignment
    : alignments.includes(fallback.alignment) ? fallback.alignment : 'center';
  result.gaps = [0,1,2].map(index => {
    const value = Number(input?.gaps?.[index] ?? fallback.gaps?.[index] ?? 45);
    return Number.isFinite(value) ? Math.max(0,Math.min(240,value)) : 45;
  });
  result.case = ['caps', 'mixed', 'contrast'].includes(input?.case) ? input.case : fallback.case;
  const ratio = Number(input?.ratio ?? fallback.ratio);
  result.ratio = Number.isFinite(ratio) ? Math.max(.5, Math.min(3, ratio)) : fallback.ratio;
  return result;
}

function word(font, text, axes, size, signature = true) {
  const face = font.getVariation(axes);
  const scale = size / font.capHeight;
  let x = 0, above = 0, below = 0;
  const parts = [];
  const letters = [];
  const gap = size * .035;
  for (const [index, character] of [...text].entries()) {
    const start = parts.length;
    const glyph = face.glyphForCodePoint(character.codePointAt(0));
    const { minX, maxX, minY, maxY } = glyph.bbox;
    const hook = signature && character === 'R' ? font.capHeight * .10 : 0;
    x += hook * scale;
    const transform = `translate(${n(x-minX*scale)} 0) scale(${n(scale)} ${n(-scale)})`;
    const color = signature && index === 0 && ['F','M'].includes(character) ? 'accent' : 'ink';
    parts.push(`<path class="${color}" transform="${transform}" d="${glyph.path.toSVG()}"/>`);
    if (hook) {
      const endpoints = glyph.path.commands.filter(c => c.args.length >= 2).map(c => c.args.slice(-2));
      const baseline = [...new Set(endpoints.filter(p => p[1] === 0).map(p => p[0]))].sort((a,b) => a-b);
      if (baseline.length < 2) throw new Error('Could not locate the R stem.');
      const [left, right] = baseline;
      const topLeft = Math.min(...endpoints.filter(p => p[1] === maxY).map(p => p[0]));
      const shear = (topLeft-left)/maxY;
      const stemAt = y => left + shear*y;
      // Measure the selected font's horizontal stroke rather than assigning
      // the serif a fixed fraction of cap height. This follows YOPQ and grade.
      const h = face.glyphForCodePoint(72);
      const crossbar = h.path.commands.filter(c => c.args.length >= 2).map(c => c.args.at(-1))
        .filter(y => y > h.bbox.minY && y < h.bbox.maxY);
      const thinStroke = Math.max(...crossbar)-Math.min(...crossbar);
      const tip = [stemAt(maxY*.87)-hook,maxY*.87];
      const slope = (maxY-tip[1])/(topLeft-tip[0]);
      // Offset perpendicular to the diagonal so its visible thickness equals
      // the crossbar, including when the R stem is slanted.
      const drop = thinStroke*Math.hypot(1,slope);
      const intercept = maxY-slope*topLeft;
      const joinY = (slope*left+intercept-drop)/(1-slope*shear);
      const points = [tip,[topLeft,maxY],[topLeft+right-left,maxY],
        [right,0],[left,0],[stemAt(joinY),joinY],[tip[0],tip[1]-drop]];
      parts.push(`<path class="accent numeral" transform="${transform}" d="M${points.map(p=>p.map(n).join(' ')).join('L')}Z"/>`);
    }
    letters.push(parts.slice(start).join(''));
    above = Math.max(above, maxY*scale);
    below = Math.max(below, -minY*scale);
    x += (maxX-minX)*scale + gap;
  }
  const width = x-gap;
  return { paths: parts.join(''), width, above, below,
    justify: targetWidth => letters.map((paths,index) =>
      `<g transform="translate(${n(index*Math.max(0,targetWidth-width)/Math.max(1,letters.length-1))} 0)">${paths}</g>`).join('') };
}

function alignedRow(row, width, baseline, key, alignment) {
  const x = alignment === 'right' ? width-row.width
    : alignment === 'left' || alignment === 'justify' ? 0 : (width-row.width)/2;
  const paths = alignment === 'justify' ? row.justify(width) : row.paths;
  return `<g data-line="${key}" transform="translate(${n(x)} ${n(baseline)})">${paths}</g>`;
}

export function renderWordmark(font, state, theme = 'dark') {
  const fatText = state.case === 'mixed' ? 'Fat' : 'FAT';
  const matText = state.case === 'caps' ? 'MATRYOSHKA' : 'MatRyoshka';
  const fat = word(font, fatText, state.fat, 300*state.ratio);
  const mat = word(font, matText, state.mat, 300);
  let width, height, content, lineWidths, lineNames;
  if (['three','four'].includes(state.layout)) {
    const three = state.layout === 'three';
    const rows = [fat, word(font,matText.slice(0,3),state.mat,300),
      word(font,three?matText.slice(3):matText.slice(3,6),state.ryo,300)];
    if (!three) rows.push(word(font,matText.slice(6),state.shka,300));
    lineNames = three ? ['FAT','MAT','RYOSHKA'] : ['FAT','MAT','RYO','SHKA'];
    lineWidths = rows.map(row => row.width);
    width = Math.max(...lineWidths);
    height = 0;
    content = rows.map((row,index) => {
      const baseline = height + row.above;
      height = baseline + row.below + (index<rows.length-1 ? state.gaps[index] : 0);
      return alignedRow(row,width,baseline,lineKeys[index],state.alignment);
    }).join('');
    if (state.alignment === 'justify') lineWidths = rows.map(() => width);
  } else if (state.layout === 'line') {
    const baseline = Math.max(fat.above, mat.above);
    width = fat.width+mat.width+50;
    height = baseline+Math.max(fat.below, mat.below);
    content = `<g transform="translate(0 ${n(baseline)})">${fat.paths}</g><g transform="translate(${n(fat.width+50)} ${n(baseline)})">${mat.paths}</g>`;
  } else {
    width = Math.max(fat.width, mat.width);
    const matBaseline = fat.above+fat.below+45+mat.above;
    height = matBaseline+mat.below;
    content = alignedRow(fat,width,fat.above,'fat',state.alignment)
      + alignedRow(mat,width,matBaseline,'mat',state.alignment);
  }
  const ink = theme === 'dark' ? '#fff7e8' : '#202a2c';
  const accent = theme === 'dark' ? '#79c7c1' : '#226669';
  const autoTheme = theme === 'auto' ? '@media(prefers-color-scheme:dark){.ink{fill:#fff7e8}.accent{fill:#79c7c1}}' : '';
  return { widthRatio: mat.width/fat.width, lineWidths, lineNames, width, height,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-12 -12 ${n(width+24)} ${n(height+24)}" role="img" aria-label="FatMatryoshka wordmark"><title>FatMatryoshka — Roboto Flex</title><desc>F, M and the full-height numeral 1 in the R stem use the original teal brand accent.</desc><style>.ink{fill:var(--wordmark-ink,${ink})}.accent{fill:var(--wordmark-accent,${accent})}${autoTheme}</style>${content}</svg>` };
}

export function renderFigures(font, axes, theme) {
  const figures = word(font, '0123456789', axes, 150, false);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-8 -8 ${n(figures.width+16)} ${n(figures.above+figures.below+16)}" aria-label="Numeral specimen"><g fill="${theme === 'light' ? '#202a2c' : '#fff7e8'}" transform="translate(0 ${n(figures.above)})">${figures.paths}</g></svg>`;
}
