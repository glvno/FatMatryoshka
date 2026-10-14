# /// script
# requires-python = ">=3.9"
# dependencies = ["fonttools"]
# ///
"""Build the third-round outlined studies: uv run web/scripts/wordmark-flex.py."""
import json
from pathlib import Path
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.recordingPen import RecordingPen
from fontTools.pens.transformPen import TransformPen

OUT = Path(__file__).resolve().parents[1] / "public/brand/round-three"
FONT = TTFont(OUT / "fonts/RobotoFlex.ttf")
CMAP = FONT.getBestCmap()
STUDIES = [
    dict(id="r01", name="Wide FAT / narrow MATRYOSHKA", fat=[1000, 140, 72], mat=[720, 45, 72], layout="line", ratio=1,
         description="Same cap height. Width and weight give FAT its own voice while pulling the long name inward."),
    dict(id="r02", name="Big FAT / small MATRYOSHKA", fat=[1000, 125, 96], mat=[800, 25, 96], layout="line", ratio=1.35,
         description="A taller FAT and the narrowest MATRYOSHKA. A compact horizontal signature with a shared baseline."),
    dict(id="r03", name="Full-width stack", fat=[1000, 151, 72], mat=[800, 35, 72], layout="stack", ratio=1,
         description="Both words fill the same width. The oversized FAT turns the name into a solid graphic block."),
    dict(id="r04", name="Compact stack", fat=[950, 140, 48], mat=[700, 50, 48], layout="stack", ratio=.72,
         description="A centered FAT at 72% of the lower line’s width. More breathing room, less dominance."),
]

def num(value):
    return f"{value:.2f}".rstrip("0").rstrip(".") if value else "0"

def word(text, axes, height):
    glyphs = FONT.getGlyphSet(location=dict(zip(["wght", "wdth", "opsz"], axes)))
    scale = height / FONT["OS/2"].sCapHeight
    x, parts = 0, []
    for index, char in enumerate(text):
        glyph = glyphs[CMAP[ord(char)]]
        bounds = BoundsPen(glyphs)
        glyph.draw(bounds)
        left, _, right, _ = bounds.bounds
        width = (right-left)*scale
        # Reserve space for the 1's serif without crowding the preceding T.
        hook = height * .10 if char == "R" else 0
        x += hook
        pen = SVGPathPen(glyphs, ntos=num)
        glyph.draw(TransformPen(pen, (scale,0,0,-scale,x-left*scale,height)))
        cls = "accent" if index == 0 else "ink"
        parts.append(f'<path class="{cls}" d="{pen.getCommands()}"/>')
        if char == "R":
            # Read the native stem's baseline edges, preserving its weight
            # and the original R bowl, counter and diagonal leg.
            recording = RecordingPen()
            glyph.draw(recording)
            baseline = sorted({p[0] for _, points in recording.value for p in points
                               if p is not None and p[1] == 0})
            stem_left, stem_right = [x + (edge-left)*scale for edge in baseline[:2]]
            points = [(stem_left-hook,height*.13),(stem_left,0),(stem_right,0),
                      (stem_right,height),(stem_left,height),(stem_left,height*.21),
                      (stem_left-hook,height*.34)]
            d = "M" + "L".join(f"{num(a)} {num(b)}" for a,b in points) + "Z"
            parts.append(f'<path class="accent numeral" d="{d}"/>')
        x += width + height * (.025 if text == "FAT" else .045)
    x -= height * (.025 if text == "FAT" else .045)
    return "".join(parts), x

for study in STUDIES:
    mat_height = 300
    fat_height = mat_height * study["ratio"] if study["layout"] == "line" else mat_height
    fat, fw = word("FAT", study["fat"], fat_height)
    mat, mw = word("MATRYOSHKA", study["mat"], mat_height)
    if study["layout"] == "line":
        width, height = fw + mw + 55, fat_height
        content = f'<g>{fat}</g><g transform="translate({num(fw+55)} {num(height-mat_height)})">{mat}</g>'
    else:
        factor = mw / fw * study["ratio"]
        width, height = mw, fat_height*factor + mat_height + 45
        content = f'<g transform="translate({num((mw-fw*factor)/2)} 0) scale({num(factor)})">{fat}</g><g transform="translate(0 {num(height-mat_height)})">{mat}</g>'
    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="-8 -8 {num(width+16)} {num(height+16)}" role="img" aria-label="FatMatryoshka — {study['name']}">
<title>FatMatryoshka — {study['name']}</title>
<desc>Roboto Flex. Teal F, M and a full-cap-height footless numeral 1 forming the R stem in MATRYOSHKA read FM1. The R bowl and diagonal leg remain in the regular text color. Both Ts and the K retain their original font shapes. {study['description']}</desc>
<style>.ink{{fill:var(--wordmark-ink,#202a2c)}}.accent{{fill:var(--wordmark-accent,#226669)}}@media(prefers-color-scheme:dark){{.ink{{fill:var(--wordmark-ink,#fff7e8)}}.accent{{fill:var(--wordmark-accent,#79c7c1)}}}}</style>
{content}</svg>'''
    (OUT / f"{study['id']}.svg").write_text(svg+"\n")
    study["file"] = f"{study['id']}.svg"
    study["aspect"] = round(width/height, 2)
(OUT / "wordmarks.json").write_text(json.dumps(STUDIES, indent=2)+"\n")
