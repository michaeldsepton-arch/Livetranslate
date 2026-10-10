#!/usr/bin/env python3
"""Generate every icon / splash asset from the chosen logo (bottom-right tile of
assets-src/logo-options.png).  Run:  python3 scripts/make_icons.py

The gold + cream mark is separated from the navy tile (alpha extraction), then
re-composed at high resolution for: Android adaptive + legacy launcher icons,
splash screen, in-app header logo and favicon.
"""
import os
import sys
import numpy as np
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "assets-src", "logo-options.png")
TILE_BOX = (842, 820, 1188, 1157)           # bottom-right tile in the 3x3 sheet
RES = os.path.join(ROOT, "android", "app", "src", "main", "res")
WWW_ASSETS = os.path.join(ROOT, "www", "assets")

NAVY_TOP = (30, 70, 88)                      # sampled from the tile (top-left)
NAVY_BOTTOM = (20, 59, 75)                   # sampled from the tile (bottom-right)
NAVY_FLAT = "#184151"


def box_blur(a, r):
    """Fast separable box blur for 2-D / 3-D float arrays (edge-padded)."""
    k = 2 * r + 1
    out = a.astype(np.float64)
    for axis in (0, 1):
        pad = [(0, 0)] * out.ndim
        pad[axis] = (r + 1, r)
        p = np.pad(out, pad, mode="edge")
        c = np.cumsum(p, axis=axis)
        hi = np.take(c, range(k, c.shape[axis]), axis=axis)
        lo = np.take(c, range(0, c.shape[axis] - k), axis=axis)
        out = (hi - lo) / k
    return out


def extract_mark():
    im = Image.open(SRC).convert("RGB").crop(TILE_BOX)
    p = np.asarray(im).astype(np.float64)
    h, w, _ = p.shape
    yy, xx = np.mgrid[0:h, 0:w]

    # 1. Fit the navy gradient (plane) from pixels that are clearly background.
    lum = p.sum(axis=2)
    bgmask = (lum < 330) & (xx > 30) & (xx < w - 30) & (yy > 30) & (yy < h - 30)
    A = np.stack([np.ones(bgmask.sum()), xx[bgmask], yy[bgmask]], axis=1)
    navy = np.zeros_like(p)
    for c in range(3):
        coef, *_ = np.linalg.lstsq(A, p[..., c][bgmask], rcond=None)
        navy[..., c] = coef[0] + coef[1] * xx + coef[2] * yy

    diff = p - navy
    dist = np.sqrt((diff ** 2).sum(axis=2))

    # 2. Local ink colour (gold or cream) from strongly inked neighbours.
    strong = (dist > 120).astype(np.float64)
    weight = box_blur(strong, 5)
    ink = box_blur(p * strong[..., None], 5) / np.maximum(weight[..., None], 1e-6)
    ink = np.where(weight[..., None] > 1e-4, ink, np.array([207, 181, 135.0]))

    # 3. Alpha by projecting the pixel onto the navy -> ink colour line.
    d = ink - navy
    alpha = (diff * d).sum(axis=2) / np.maximum((d ** 2).sum(axis=2), 1.0)
    alpha = np.clip(alpha, 0, 1)
    alpha[dist < 14] = 0
    # ignore the rounded-tile corners / border (cream page background)
    margin = 26
    alpha[:margin, :] = 0
    alpha[-margin:, :] = 0
    alpha[:, :margin] = 0
    alpha[:, -margin:] = 0

    # 4. Un-mix colour so edges are not tinted navy.
    a3 = np.maximum(alpha, 0.35)[..., None]
    fg = np.clip(navy + diff / a3, 0, 255)
    fg = np.where(alpha[..., None] > 0.35, fg, ink)
    return fg, alpha


def upscale(fg, alpha, scale):
    h, w = alpha.shape
    size = (int(w * scale), int(h * scale))
    rgb = Image.fromarray(fg.astype(np.uint8), "RGB").resize(size, Image.LANCZOS)
    a = Image.fromarray((alpha * 255).astype(np.uint8), "L").resize(size, Image.BICUBIC)
    a = np.asarray(a).astype(np.float64) / 255.0
    # re-sharpen edges softened by the upscale (smoothstep around 0.5)
    t = np.clip((a - 0.5) * 2.1 + 0.5, 0, 1)
    a = t * t * (3 - 2 * t)
    out = np.dstack([np.asarray(rgb), (a * 255).astype(np.uint8)])
    return Image.fromarray(out, "RGBA")


def trim(img, pad=0):
    a = np.asarray(img)[..., 3]
    ys, xs = np.where(a > 20)
    box = (xs.min() - pad, ys.min() - pad, xs.max() + 1 + pad, ys.max() + 1 + pad)
    return img.crop(box)


def fit_on_canvas(mark, canvas, width_frac, dy_frac=0.0):
    """Centre `mark` on a transparent square canvas, scaled to width_frac of it."""
    scale = canvas * width_frac / mark.width
    m = mark.resize((round(mark.width * scale), round(mark.height * scale)), Image.LANCZOS)
    out = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    out.alpha_composite(m, ((canvas - m.width) // 2, (canvas - m.height) // 2 + round(dy_frac * canvas)))
    return out


def navy_square(size):
    t = np.linspace(0, 1, size)
    g = (t[None, :] + t[:, None]) / 2
    top, bot = np.array(NAVY_TOP, float), np.array(NAVY_BOTTOM, float)
    px = top[None, None, :] * (1 - g[..., None]) + bot[None, None, :] * g[..., None]
    return Image.fromarray(px.astype(np.uint8), "RGB").convert("RGBA")


def rounded(img, radius_frac):
    s = img.width
    mask = Image.new("L", (s * 4, s * 4), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, s * 4 - 1, s * 4 - 1), radius=int(s * 4 * radius_frac), fill=255)
    out = img.copy()
    out.putalpha(mask.resize((s, s), Image.LANCZOS))
    return out


def circle(img):
    s = img.width
    mask = Image.new("L", (s * 4, s * 4), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, s * 4 - 1, s * 4 - 1), fill=255)
    out = img.copy()
    out.putalpha(mask.resize((s, s), Image.LANCZOS))
    return out


def save(img, *parts):
    path = os.path.join(*parts)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path, optimize=True)
    return path


def main():
    fg, alpha = extract_mark()
    big = trim(upscale(fg, alpha, 6.0), pad=6)           # ~1500px wide master
    master_h = big.height
    print("mark master", big.size)

    # --- in-app logo + favicon --------------------------------------------
    logo = big.resize((round(big.width * 512 / master_h), 512), Image.LANCZOS)
    save(logo, WWW_ASSETS, "logo-mark.png")
    icon_full = fit_on_canvas(big, 1024, 0.64)
    base = navy_square(1024)
    base.alpha_composite(icon_full)
    save(rounded(base, 0.225), ROOT, "assets-src", "icon-1024.png")
    save(rounded(base.resize((192, 192), Image.LANCZOS), 0.225), WWW_ASSETS, "icon-192.png")
    save(base.resize((512, 512), Image.LANCZOS).convert("RGB"), WWW_ASSETS, "icon-512.png")

    # --- Android adaptive icon foreground (transparent, safe zone) ----------
    fg_sizes = {"mdpi": 108, "hdpi": 162, "xhdpi": 216, "xxhdpi": 324, "xxxhdpi": 432}
    leg_sizes = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
    master_fg = fit_on_canvas(big, 1296, 0.54)
    for d, s in fg_sizes.items():
        save(master_fg.resize((s, s), Image.LANCZOS), RES, f"mipmap-{d}", "ic_launcher_foreground.png")
    master_leg = navy_square(768)
    master_leg.alpha_composite(fit_on_canvas(big, 768, 0.62))
    for d, s in leg_sizes.items():
        sq = master_leg.resize((s, s), Image.LANCZOS)
        save(rounded(sq, 0.22), RES, f"mipmap-{d}", "ic_launcher.png")
        save(circle(sq), RES, f"mipmap-{d}", "ic_launcher_round.png")

    # adaptive background colour
    with open(os.path.join(RES, "values", "ic_launcher_background.xml"), "w") as f:
        f.write('<?xml version="1.0" encoding="utf-8"?>\n<resources>\n'
                f'    <color name="ic_launcher_background">{NAVY_FLAT}</color>\n</resources>\n')

    # --- splash --------------------------------------------------------------
    splash = Image.new("RGB", (1080, 1080), NAVY_FLAT)
    mark = fit_on_canvas(big, 1080, 0.40)
    splash.paste(mark, (0, 0), mark)
    save(splash, RES, "drawable", "splash.png")
    # one universal splash is enough; drop the per-density copies Capacitor ships
    for name in os.listdir(RES):
        if name.startswith(("drawable-land-", "drawable-port-")):
            import shutil
            shutil.rmtree(os.path.join(RES, name))
    print("icons written")


if __name__ == "__main__":
    sys.exit(main())
