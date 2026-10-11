"""Build idear's logo: the line-art deer, with a lightbulb where the moon was.

Reads scripts/deer.png, paints out the moon, draws the bulb in the same ink
and stroke weight (supersampled, so its edges match the drawing), and writes
the logo and every app icon:

    python3 scripts/make-logo.py
"""
import math
import os
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PAPER = (255, 250, 247)
INK = (62, 57, 41)

art = Image.open(os.path.join(HERE, 'deer.png')).convert('RGB')
W, H = art.size

# Paint out the moon.
ImageDraw.Draw(art).rectangle((268, 96, 314, 143), fill=PAPER)

# The bulb, drawn at 8x and scaled down.
S = 8
mask = Image.new('L', (W * S, H * S), 0)
d = ImageDraw.Draw(mask)
w = 4.6 * S  # stroke, matched to the moon's


def p(x, y):
    return (x * S, y * S)


def line(pts):
    pts = [p(*q) for q in pts]
    d.line(pts, fill=255, width=round(w), joint='curve')
    for x, y in (pts[0], pts[-1]):
        d.ellipse((x - w / 2, y - w / 2, x + w / 2, y + w / 2), fill=255)


cx, cy, r = 292, 112, 12.5
# Glass: an arc over the top, tapering into the neck.
a0, a1 = 140, 400  # degrees, screen coordinates (0 = right, 90 = down)
arc = [(cx + r * math.cos(math.radians(a)), cy + r * math.sin(math.radians(a)))
       for a in range(a0, a1 + 1, 4)]
neck_y = 131
line([(cx - 5, neck_y)] + arc + [(cx + 5, neck_y)])
# Screw base.
line([(cx - 5, neck_y), (cx + 5, neck_y)])
line([(cx - 4, neck_y + 6), (cx + 4, neck_y + 6)])
# A little glint inside the glass.
glint = [(cx + 6.5 * math.cos(math.radians(a)), cy + 6.5 * math.sin(math.radians(a)))
         for a in range(200, 256, 5)]
d.line([p(*q) for q in glint], fill=255, width=round(2.6 * S), joint='curve')
for q in (glint[0], glint[-1]):
    x, y = p(*q)
    rr = 1.3 * S
    d.ellipse((x - rr, y - rr, x + rr, y + rr), fill=255)

mask = mask.resize((W, H), Image.LANCZOS)
art = Image.composite(Image.new('RGB', (W, H), INK), art, mask)

# Square, centred on the drawing (ink spans about x 145-354, y 75-299).
x0, y0, x1, y1 = 145, 75, 354, 299
side = round(max(x1 - x0, y1 - y0) * 1.32)
mx, my = (x0 + x1) / 2, (y0 + y1) / 2
canvas = Image.new('RGB', (side, side), PAPER)
canvas.paste(art, (round(side / 2 - mx), round(side / 2 - my)))
logo = canvas.resize((1024, 1024), Image.LANCZOS)


def rounded(img, radius):
    m = Image.new('L', (img.width * 4, img.height * 4), 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, m.width - 1, m.height - 1), radius * 4, fill=255)
    out = img.convert('RGBA')
    out.putalpha(m.resize(img.size, Image.LANCZOS))
    return out


icon = rounded(logo, 225)  # the app icon: paper tile with rounded corners


def at(n):
    return icon.resize((n, n), Image.LANCZOS)


at(256).save(os.path.join(ROOT, 'public', 'idear.png'))
os.makedirs(os.path.join(ROOT, 'docs', 'images'), exist_ok=True)
at(512).save(os.path.join(ROOT, 'docs', 'images', 'idear.png'))
at(1024).save(os.path.join(ROOT, 'app-icon.png'))
icons = os.path.join(ROOT, 'src-tauri', 'icons')
for name, n in [('32x32.png', 32), ('64x64.png', 64), ('128x128.png', 128), ('128x128@2x.png', 256),
                ('icon.png', 512), ('Square30x30Logo.png', 30), ('Square44x44Logo.png', 44),
                ('Square71x71Logo.png', 71), ('Square89x89Logo.png', 89), ('Square107x107Logo.png', 107),
                ('Square142x142Logo.png', 142), ('Square150x150Logo.png', 150), ('Square284x284Logo.png', 284),
                ('Square310x310Logo.png', 310), ('StoreLogo.png', 50)]:
    at(n).save(os.path.join(icons, name))
at(256).save(os.path.join(icons, 'icon.ico'), sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
at(1024).save(os.path.join(icons, 'icon.icns'))
print('ok')
