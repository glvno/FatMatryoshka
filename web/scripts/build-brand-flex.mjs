import { build } from 'esbuild';
import { readFile, writeFile, mkdir, readdir, copyFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFont, normalizeState, renderWordmark } from './brand-flex-engine.js';
import { presets, selectedPresetId } from './brand-flex-presets.js';

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(web, 'public/brand/round-four');
await mkdir(output, {recursive:true});
const font = loadFont(new Uint8Array(await readFile(join(web,'public/brand/round-three/fonts/RobotoFlex.ttf'))));
const manifest = [];
for (const preset of presets) {
  const state = normalizeState(font, preset, presets[1]);
  const rendered = renderWordmark(font, state);
  await writeFile(join(output,preset.id+'.svg'), rendered.svg+'\n');
  manifest.push({...preset, ...state, widthRatio:rendered.widthRatio});
}
await writeFile(join(output,'presets.json'), JSON.stringify(manifest,null,2)+'\n');
const selected = manifest.find(preset => preset.id === selectedPresetId);
if (!selected) throw new Error(`Missing selected wordmark: ${selectedPresetId}`);
await writeFile(join(web,'public/brand/wordmark.svg'), renderWordmark(font,selected,'auto').svg+'\n');
await writeFile(join(web,'public/brand/wordmark-settings.json'), JSON.stringify(selected,null,2)+'\n');
await copyFile(join(web,'public/brand/round-three/29-hidden-arm-ends.png'), join(web,'public/brand/matryoshka.png'));
const bundled = await build({absWorkingDir:web,entryPoints:['scripts/brand-flex-lab.js'],outfile:'public/brand/round-four/lab.js',
  bundle:true,minify:true,format:'esm',platform:'browser',target:'es2022',legalComments:'linked',metafile:true});
const packages = new Set();
for (const input of Object.keys(bundled.metafile.inputs)) {
  const segments = input.split('/');
  const index = segments.lastIndexOf('node_modules');
  if (index >= 0) packages.add(segments.slice(0,index+(segments[index+1].startsWith('@')?3:2)).join('/'));
}
const notices = [];
for (const folder of [...packages].sort()) {
  const metadata = JSON.parse(await readFile(join(web,folder,'package.json'),'utf8'));
  notices.push(`${metadata.name} ${metadata.version}\nLicense: ${metadata.license}\n`);
  const files = (await readdir(join(web,folder))).filter(name => /^(licen[sc]e|copying|notice)(\.|$)/i.test(name));
  for (const file of files) notices.push(await readFile(join(web,folder,file),'utf8'));
  if (!files.length && metadata.name === 'fontkit') notices.push(`Fontkit by Devon Govett <devongovett@gmail.com>\nhttps://github.com/foliojs/fontkit\n\nMIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.\n`);
}
await writeFile(join(output,'third-party-notices.txt'),notices.join('\n\n--------------------\n\n'));
console.log(`Built ${presets.length} outlined studies and the full-axis browser lab.`);
