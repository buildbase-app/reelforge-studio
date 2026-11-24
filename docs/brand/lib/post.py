"""Post-process: optimise PNGs, write favicon.ico, check sizes and safe zones.
Usage: python3 -I lib/post.py <kit-root> <checks.json>"""
import json, math, os, sys
from PIL import Image

root, checks_path = sys.argv[1], sys.argv[2]
checks = json.load(open(checks_path))
problems = []

# 1. favicon.ico from the hand-tuned 16/32/48 rasters (not downscaled from one image)
ico = checks["ico"]
ims = [Image.open(os.path.join(root, p)).convert("RGBA") for p in ico["sources"]]
ims.sort(key=lambda im: im.size[0])
ims[-1].save(os.path.join(root, ico["out"]), format="ICO", sizes=[im.size for im in ims], append_images=ims[:-1])
back = Image.open(os.path.join(root, ico["out"]))
got = sorted(back.info.get("sizes", set()))
for im in ims:
    back.size = im.size
    back.load()
    a = back.convert("RGBA").tobytes()
    if a != im.tobytes():
        problems.append(f"ico {im.size} differs from its source raster")
print("favicon.ico sizes:", got)

# 2. sizes
for rel, (w, h) in checks["sizes"].items():
    im = Image.open(os.path.join(root, rel))
    if im.size != (w, h):
        problems.append(f"{rel}: {im.size} != {(w, h)}")

def content_box_radius(im, bg):
    """Largest distance from centre of any pixel that differs from bg (opaque assets)."""
    im = im.convert("RGB")
    w, h = im.size
    px = im.load()
    cx, cy = (w - 1) / 2, (h - 1) / 2
    bgc = tuple(int(bg[i:i + 2], 16) for i in (1, 3, 5))
    r = 0
    step = max(1, w // 400)
    for y in range(0, h, step):
        for x in range(0, w, step):
            p = px[x, y]
            if max(abs(p[i] - bgc[i]) for i in range(3)) > 24:
                r = max(r, math.hypot(x - cx, y - cy))
    return r / (w / 2)

# 3. circle-safe avatars and maskable safe zone: all mark pixels inside a centred circle
for rel, (bg, limit) in checks["circle"].items():
    im = Image.open(os.path.join(root, rel))
    r = content_box_radius(im, bg)
    status = "ok" if r <= limit else "FAIL"
    if r > limit:
        problems.append(f"{rel}: content reaches {r:.2f} of the radius (limit {limit})")
    print(f"circle check {rel}: {r:.2f} of radius ({status})")

# 4. optimise PNGs: lossless re-encode; flat-colour images over 300 KB get a 256-colour palette
total = 0
for dp, dn, fn in os.walk(root):
    if "node_modules" in dp or "/.cache" in dp:
        continue
    for f in fn:
        if not f.endswith(".png"):
            continue
        p = os.path.join(dp, f)
        im = Image.open(p)
        im.load()
        im.save(p, optimize=True)
        if os.path.getsize(p) > 300_000:
            q = im.convert("RGBA").quantize(256, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.NONE)
            q.save(p, optimize=True)
        total += os.path.getsize(p)
        if os.path.getsize(p) > 1_500_000:
            problems.append(f"{p}: {os.path.getsize(p)} bytes > 1.5 MB")
print(f"PNG total after optimisation: {total/1e6:.2f} MB")

if problems:
    print("PROBLEMS:\n  " + "\n  ".join(problems))
    sys.exit(1)
print("post checks passed")
