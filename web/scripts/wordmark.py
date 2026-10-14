# /// script
# requires-python = ">=3.11"
# dependencies = ["fonttools"]
# ///
"""Generate outlined branding: uv run web/scripts/wordmark.py.

Barlow Semi Condensed Bold is distributed under SIL OFL 1.1. See
public/fonts/OFL-BarlowSemiCondensed.txt. The outlined SVG requires no font download.
"""
from pathlib import Path
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

web = Path(__file__).resolve().parents[1]
font = TTFont(web / "public/fonts/BarlowSemiCondensed-Bold.ttf")
glyphs = font.getGlyphSet()
cmap = font.getBestCmap()

def outline(char, transform):
    pen = SVGPathPen(glyphs, ntos=lambda n: f"{n:.2f}".rstrip("0").rstrip(".") if n else "0")
    glyphs[cmap[ord(char)]].draw(TransformPen(pen, transform))
    return pen.getCommands()

paths = []
x = 0
for char in "FatMatryoshka":
    scale = .78
    color = "brand-accent" if char in "FM" else "brand-ink"
    d = outline(char.upper(), (scale, 0, 0, scale, 0, 0))
    paths.append(f'  <path class="{color}" transform="translate({x:.2f} 565) scale(1 -1)" d="{d}"/>')
    if char == "k":
        # Align the footless numeral's stem with K's stem; retain the dark diagonals.
        d = outline("1", (.78, 0, 0, .78, -61.62, 0))
        paths.append(f'  <path class="brand-accent" transform="translate({x:.2f} 565) scale(1 -1)" d="{d}"/>')
    x += glyphs[cmap[ord(char.upper())]].width * scale + 8

svg = f'''<svg xmlns="http://www.w3.org/2000/svg" class="brand-mark" viewBox="0 0 {x:.2f} 590" role="img" aria-label="FatMatryoshka">
  <title>FatMatryoshka</title>
  <desc>Small-cap letters, with teal F and M and a teal numeral 1 forming the stem of K.</desc>
  <!-- Outlines from Barlow Semi Condensed Bold, SIL OFL 1.1; see fonts/OFL-BarlowSemiCondensed.txt. -->
  <style>.brand-ink{{fill:#202a2c}}.brand-accent{{fill:#226669}}@media(prefers-color-scheme:dark){{.brand-ink{{fill:#fff7e8}}.brand-accent{{fill:#79c7c1}}}}</style>
{chr(10).join(paths)}
</svg>'''
(web / "public/brand/wordmark.svg").write_text(svg + "\n")
index = web / "index.html"
html = index.read_text()
start = html.index('        <h1 class="wordmark">')
end = html.index('</h1>', start) + len('</h1>')
index.write_text(html[:start] + '        <h1 class="wordmark">' + svg + '</h1>' + html[end:])
