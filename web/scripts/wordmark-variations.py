# /// script
# requires-python = ">=3.11"
# dependencies = ["fonttools"]
# ///
"""Build outlined logo studies: uv run web/scripts/wordmark-variations.py."""
from pathlib import Path
import json
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.varLib.instancer import instantiateVariableFont

web = Path(__file__).resolve().parents[1]
out = web / 'public/brand/round-two'
fonts = out / 'fonts'
configs = [
 ('w01', 'Compact', '../../fonts/BarlowSemiCondensed-Bold.ttf', 1, 8, 0, False, False, 'Compact proportions, close to the current wordmark.', 'The 1 is subtle at sidebar size.'),
 ('w02', 'Wide', 'fonts/Barlow-Bold.ttf', 1, 12, 0, False, False, 'Wider letters with a larger opening inside each shape.', 'Takes more horizontal space.'),
 ('w03', 'Condensed', 'fonts/BarlowCondensed-Bold.ttf', 1, 16, 0, False, False, 'Narrow letters let the name be taller in the same sidebar.', 'The narrow A and R need a small-size check.'),
 ('w04', 'Geometric', 'fonts/SpaceGrotesk.ttf', 1, 4, 0, False, False, 'Rounder O and a broad, straight-sided M.', 'Less room for the symbol at the same total height.'),
 ('w05', 'Square', 'fonts/Rajdhani-SemiBold.ttf', 1, 14, 0, False, False, 'Squared curves and lighter strokes, like instrument lettering.', 'The lighter strokes may lose contrast when very small.'),
 ('w06', 'Heavy', 'fonts/ArchivoBlack-Regular.ttf', 1, 0, 0, False, False, 'Thick strokes match the pictorial mark’s outlines.', 'Small counters close sooner at 175 pixels.'),
 ('w07', 'Spaced', 'fonts/SpaceGrotesk.ttf', 1, 90, 0, False, False, 'More space between letters makes the name easier to scan at large sizes.', 'The extra width makes letters smaller in the sidebar.'),
 ('w08', 'Narrow square', 'fonts/Rajdhani-SemiBold.ttf', .82, 4, 0, False, False, 'Narrow square letters with a tall visual rhythm.', 'More technical and less friendly.'),
 ('w09', 'Stencil', 'fonts/BarlowCondensed-Bold.ttf', 1, 20, 0, True, False, 'Two narrow stencil cuts through the lettering.', 'Cuts can disappear at small sizes; better for print or large use.'),
 ('w10', 'Two lines', '../../fonts/BarlowSemiCondensed-Bold.ttf', 1, 8, 0, False, True, 'FAT sits above MATRYOSHKA at the same letter height.', 'The short first line changes the balance with the icon.'),
 ('w11', 'Forward', 'fonts/Barlow-Bold.ttf', 1, 8, .15, False, False, 'A slight forward slant with straight, equal-height letters.', 'Leans away from the calm shape of the dolls.'),
 ('w12', 'Rounded lines', None, 1, 24, 0, False, False, 'Custom single-width strokes, drawn like patch cables.', 'The line-built letters are less dense and need more width.'),
]

def num(n): return f'{n:.2f}'.rstrip('0').rstrip('.') if n else '0'
def path(d, cls, transform=''):
 return f'<path class="{cls}" transform="{transform}" d="{d}"/>'
manifest=[]
for ident, name, file, width, tracking, skew, stencil, stacked, description, risk in configs:
 font=TTFont(out/file) if file else None
 if font and 'fvar' in font: font=instantiateVariableFont(font, {'wght':650})
 gs=font.getGlyphSet() if font else None
 cmap=font.getBestCmap() if font else None
 scale=600 / font['OS/2'].sCapHeight if font else 1
 x=20; y=620; maxwidth=0; parts=[]
 linepaths={'F':'M80 0V600H440M80 310H370','A':'M40 0L250 600L460 0M110 190H390','T':'M20 600H480M250 600V0','M':'M40 0V600L250 260L460 600V0','R':'M60 0V600H270Q450 600 450 440Q450 300 270 300H60M250 300L470 0','Y':'M30 600L250 300L470 600M250 300V0','O':'M250 600Q50 600 50 400V200Q50 0 250 0Q450 0 450 200V400Q450 600 250 600','S':'M440 540Q400 600 250 600Q50 600 50 450Q50 310 250 300Q450 290 450 150Q450 0 250 0Q100 0 40 70','H':'M50 0V600M450 0V600M50 300H450'}
 for index,char in enumerate('FATMATRYOSHKA'):
  if stacked and index==3: maxwidth=max(maxwidth,x); x=20; y=1360
  cls='accent' if index in (0,3) else 'ink'
  if char=='K':
   advance=(gs[cmap[ord('K')]].width*scale*width if font else 510)
   w=advance-30; h=600
   # One numeral-shaped vertical stroke, plus the two ordinary K diagonals.
   stem=f'M{num(.05*w)} 480 L{num(.31*w)} 600 H{num(.49*w)} V0 H{num(.25*w)} V438 L{num(.13*w)} 390 Z'
   arms=f'M{num(.47*w)} 300 L{num(.77*w)} 600 H{num(w)} L{num(.66*w)} 310 L{num(w)} 0 H{num(.75*w)} L{num(.47*w)} 245 Z'
   if font:
    parts.append(path(arms,'ink',f'translate({num(x)} {y}) matrix(1 0 {num(skew)} -1 0 0)'))
    parts.append(path(stem,'accent',f'translate({num(x)} {y}) matrix(1 0 {num(skew)} -1 0 0)'))
   else:
    parts.append(path('M160 280L440 600M230 360L460 0','ink line',f'translate({x} {y}) scale(1 -1)'))
    parts.append(path('M50 480L160 600V0','accent line',f'translate({x} {y}) scale(1 -1)'))
  elif font:
   pen=SVGPathPen(gs,ntos=num)
   gs[cmap[ord(char)]].draw(TransformPen(pen,(scale*width,0,skew,-scale,x,y)))
   parts.append(path(pen.getCommands(),cls))
   advance=gs[cmap[ord(char)]].width*scale*width
  else:
   parts.append(f'<path class="{cls} line" transform="translate({x} {y}) scale(1 -1)" d="{linepaths[char]}"/>')
   advance=510
  x+=advance+tracking
 maxwidth=max(maxwidth,x)+100
 height=1430 if stacked else 690
 if stencil:
  mask=f'<defs><mask id="cuts"><rect width="{maxwidth}" height="{height}" fill="white"/><path d="M0 200H{maxwidth}M0 450H{maxwidth}" stroke="black" stroke-width="16"/></mask></defs>'
  content=mask+'<g mask="url(#cuts)">'+''.join(parts)+'</g>'
 else: content=''.join(parts)
 svg=f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {num(maxwidth)} {height}" role="img" aria-label="FatMatryoshka — {name}"><title>FatMatryoshka — {name}</title><desc>Equal-height small caps. Teal F, M, and footless numeral 1 as K stem.</desc><style>.ink{{fill:var(--wordmark-ink,#202a2c)}}.accent{{fill:var(--wordmark-accent,#226669)}}.line{{fill:none;stroke-width:70;stroke-linecap:round;stroke-linejoin:round}}.ink.line{{stroke:var(--wordmark-ink,#202a2c)}}.accent.line{{stroke:var(--wordmark-accent,#226669)}}@media(prefers-color-scheme:dark){{.ink{{fill:var(--wordmark-ink,#fff7e8)}}.accent{{fill:var(--wordmark-accent,#79c7c1)}}.ink.line{{fill:none;stroke:var(--wordmark-ink,#fff7e8)}}.accent.line{{fill:none;stroke:var(--wordmark-accent,#79c7c1)}}}}</style>{content}</svg>'''
 (out/f'{ident}.svg').write_text(svg+'\n')
 manifest.append(dict(id=ident,name=name,file=f'{ident}.svg',description=description,risk=risk,font=file))
(out/'wordmarks.json').write_text(json.dumps(manifest,indent=2)+'\n')
