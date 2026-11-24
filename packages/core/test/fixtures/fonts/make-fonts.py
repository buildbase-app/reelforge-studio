"""Builds the tiny test fonts in this folder (#303). Run: python3 make-fonts.py <out-dir>
Needs fontTools and brotli (pip install fonttools brotli). The fonts are made here from nothing
(no third-party glyphs), CC0: every glyph of "RF Block" is a solid box, so text set in it is
easy to tell from any fallback font by its pixels."""
import sys
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.pens.t2CharStringPen import T2CharStringPen

out = sys.argv[1]
chars = [chr(c) for c in range(0x21, 0x7f)]
names = ['.notdef', 'space'] + ['g%04x' % ord(c) for c in chars]
cmap = {0x20: 'space', **{ord(c): 'g%04x' % ord(c) for c in chars}}
UPM, ADV = 1000, 700

def box(pen, empty=False):
    if not empty:
        pen.moveTo((50, -100)); pen.lineTo((50, 800)); pen.lineTo((650, 800)); pen.lineTo((650, -100)); pen.closePath()

def build(family, style, weight, italic, cff=False, axes=None):
    fb = FontBuilder(UPM, isTTF=not cff)
    fb.setupGlyphOrder(names)
    fb.setupCharacterMap(cmap)
    if cff:
        cs = {}
        for n in names:
            p = T2CharStringPen(ADV, None); box(p, n == 'space'); cs[n] = p.getCharString()
        fb.setupCFF(family.replace(' ', '') + '-' + style.replace(' ', ''), {'FullName': f'{family} {style}'}, cs, {'BlueValues': []})
    else:
        gl = {}
        for n in names:
            p = TTGlyphPen(None); box(p, n == 'space'); gl[n] = p.glyph()
        fb.setupGlyf(gl)
    fb.setupHorizontalMetrics({n: (ADV if n != 'space' else 300, 50) for n in names})
    fb.setupHorizontalHeader(ascent=900, descent=-200)
    fb.setupNameTable({'familyName': family, 'styleName': style, 'licenseDescription': 'CC0-1.0 test font made by ReelForge tests', 'licenseInfoURL': 'https://creativecommons.org/publicdomain/zero/1.0/'})
    fb.setupOS2(sTypoAscender=900, sTypoDescender=-200, usWinAscent=900, usWinDescent=200, usWeightClass=weight, fsSelection=(0x01 if italic else 0x40))
    fb.updateHead(macStyle=(2 if italic else 0) | (1 if weight >= 700 else 0))
    fb.setupMaxp()
    fb.setupPost(keepGlyphNames=not cff)
    if axes:
        fb.setupFvar(axes, [])
    return fb.font

f = build('RF Block', 'Regular', 400, False); f.save(f'{out}/rf-block.ttf')
f = build('RF Block', 'Regular', 400, False); f.flavor = 'woff'; f.save(f'{out}/rf-block.woff')
f = build('RF Block', 'Regular', 400, False); f.flavor = 'woff2'; f.save(f'{out}/rf-block.woff2')
f = build('RF Block Serif', 'Bold Italic', 700, True, cff=True); f.save(f'{out}/rf-block-bold-italic.otf')
f = build('RF Block Var', 'Regular', 400, False, axes=[('wght', 100, 400, 900, 'Weight'), ('wdth', 75, 100, 125, 'Width')]); f.flavor = 'woff2'; f.save(f'{out}/rf-block-var.woff2')
# Parses (name, head and OS/2 are fine) but browsers refuse it: its cmap table is overwritten with 0xFF bytes.
f = build('RF Broken', 'Regular', 400, False); f.save(f'{out}/rf-broken.ttf')
import struct
data = bytearray(open(f'{out}/rf-broken.ttf', 'rb').read())
for i in range(struct.unpack('>H', data[4:6])[0]):
    rec = 12 + i * 16
    if data[rec:rec + 4] == b'cmap':
        off, length = struct.unpack('>II', data[rec + 8:rec + 16])
        data[off:off + length] = b'\xff' * length
open(f'{out}/rf-broken.ttf', 'wb').write(bytes(data))
