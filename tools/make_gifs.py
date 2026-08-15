# Generates placeholder animated GIFs (buy/sell/burn style) into tools/previews/.
# The LIVE embed images in public/gifs/ are user-provided (ffmpeg-converted
# videos + one static PNG) — this script never touches them.
# Run from anywhere: python tools/make_gifs.py. Requires Pillow.

import math
import random
import tempfile
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

W, H = 480, 270
FRAMES = 30
FRAME_MS = 80
OUT_DIR = Path(__file__).resolve().parent / "previews"
FONT_PATH = "C:/Windows/Fonts/arialbd.ttf"  # Arial Bold — always present on Windows


def load_font(size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(FONT_PATH, size)


def lerp(a, b, t: float):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def vertical_gradient(top, bottom) -> Image.Image:
    grad = Image.new("RGB", (1, H))
    for y in range(H):
        grad.putpixel((0, y), lerp(top, bottom, y / (H - 1)))
    return grad.resize((W, H))


def dim(layer: Image.Image, factor: float) -> Image.Image:
    return layer.point(lambda v: int(v * factor))


def text_layer(text: str, font, fill, center) -> Image.Image:
    """Draw centered text on a transparent-black layer (for glow compositing)."""
    layer = Image.new("RGB", (W, H), (0, 0, 0))
    d = ImageDraw.Draw(layer)
    l, t, r, b = d.textbbox((0, 0), text, font=font)
    d.text((center[0] - (r - l) / 2 - l, center[1] - (b - t) / 2 - t), text, font=font, fill=fill)
    return layer


def arrow_polygon(cx: float, cy: float, height: float, up: bool):
    """A fat arrow polygon centered on (cx, cy)."""
    half, head, shaft = height * 0.42, height * 0.45, height * 0.30
    if up:
        return [
            (cx, cy - height / 2), (cx + half, cy - height / 2 + head),
            (cx + shaft * 0.45, cy - height / 2 + head), (cx + shaft * 0.45, cy + height / 2),
            (cx - shaft * 0.45, cy + height / 2), (cx - shaft * 0.45, cy - height / 2 + head),
            (cx - half, cy - height / 2 + head),
        ]
    return [(x, 2 * cy - y) for x, y in arrow_polygon(cx, cy, height, True)]


def make_trade_gif(kind: str) -> Image.Image:
    """buy.gif / sell.gif — pulsing arrow, drifting particles, mini trend line."""
    is_buy = kind == "buy"
    bg = vertical_gradient((8, 22, 14), (2, 6, 4)) if is_buy else vertical_gradient((26, 8, 10), (5, 2, 3))
    main = (0, 230, 120) if is_buy else (255, 70, 70)
    glow_c = (0, 180, 90) if is_buy else (200, 30, 30)
    dark = (0, 70, 40) if is_buy else (110, 15, 15)
    label = "BUY $GW" if is_buy else "SELL $GW"
    rng = random.Random(11 if is_buy else 22)
    particles = [
        {"x": rng.uniform(30, W - 30), "y": rng.uniform(0, H), "v": rng.uniform(8, 26), "r": rng.uniform(1.5, 3.5)}
        for _ in range(26)
    ]
    font = load_font(46)

    frames = []
    for f in range(FRAMES):
        t = f / FRAMES
        pulse = 0.5 + 0.5 * math.sin(t * 2 * math.pi)
        frame = bg.copy()

        # Soft center glow behind everything.
        glow = Image.new("RGB", (W, H), (0, 0, 0))
        ImageDraw.Draw(glow).ellipse((W / 2 - 150, 150 - 95, W / 2 + 150, 150 + 95), fill=glow_c)
        frame = ImageChops.screen(frame, dim(glow.filter(ImageFilter.GaussianBlur(50)), 0.16 + 0.10 * pulse))

        # Arrow: blurred glow copy first, then crisp on top.
        bob = 4 * math.sin(t * 2 * math.pi) * (1 if is_buy else -1)
        scale = 1 + 0.035 * math.sin(t * 2 * math.pi)
        pts = arrow_polygon(W / 2, 152 + bob, 130 * scale, is_buy)
        aglow = Image.new("RGB", (W, H), (0, 0, 0))
        ImageDraw.Draw(aglow).polygon(pts, fill=main)
        frame = ImageChops.screen(frame, dim(aglow.filter(ImageFilter.GaussianBlur(14)), 0.45 + 0.45 * pulse))
        d = ImageDraw.Draw(frame)
        d.polygon(pts, fill=main, outline=dark)
        d.line(pts + [pts[0]], fill=dark, width=2)

        # Particles drifting up (buy) or down (sell), wrapping around.
        for p in particles:
            py = (p["y"] - p["v"] * t * (1 if is_buy else -1)) % H
            wobble = 3 * math.sin(t * 2 * math.pi + p["x"])
            alpha_fill = lerp(dark, main, 0.5 + 0.5 * math.sin(t * 4 * math.pi + p["y"]))
            d.ellipse((p["x"] + wobble - p["r"], py - p["r"], p["x"] + wobble + p["r"], py + p["r"]), fill=alpha_fill)

        # Mini trend line along the bottom.
        pts = []
        for x in range(0, W + 10, 10):
            trend = (x / W) * (34 if is_buy else -34)
            y = H - 26 - trend - 9 * math.sin(x * 0.045 + t * 2 * math.pi)
            pts.append((x, y))
        d.line(pts, fill=main, width=3)
        tip = pts[-1]
        d.ellipse((tip[0] - 5, tip[1] - 5, tip[0] + 5, tip[1] + 5), fill=(255, 255, 255))

        # Label with pulsing glow.
        tl = text_layer(label, font, (255, 255, 255), (W / 2, 52))
        frame = ImageChops.screen(frame, dim(tl.filter(ImageFilter.GaussianBlur(8)), 0.5 + 0.5 * pulse))
        frame = ImageChops.screen(frame, tl)

        frames.append(frame)
    return frames


def make_burn_gif() -> list[Image.Image]:
    """burn.gif — flickering flame + rising embers."""
    bg = vertical_gradient((26, 9, 4), (7, 2, 2))
    rng = random.Random(33)
    embers = [
        {"x": rng.uniform(W / 2 - 55, W / 2 + 55), "y0": rng.uniform(150, 235),
         "v": rng.uniform(30, 70), "r": rng.uniform(1.2, 3.0), "ph": rng.uniform(0, 6.28)}
        for _ in range(22)
    ]
    font = load_font(42)
    frames = []
    for f in range(FRAMES):
        t = f / FRAMES
        pulse = 0.5 + 0.5 * math.sin(t * 2 * math.pi)
        frame = bg.copy()

        # Warm floor glow.
        glow = Image.new("RGB", (W, H), (0, 0, 0))
        ImageDraw.Draw(glow).ellipse((W / 2 - 170, 120, W / 2 + 170, 270), fill=(180, 45, 0))
        frame = ImageChops.screen(frame, dim(glow.filter(ImageFilter.GaussianBlur(55)), 0.16 + 0.08 * pulse))

        # Flame: stacked flickering blobs, dark red (bottom) -> yellow (tip).
        flame = Image.new("RGB", (W, H), (0, 0, 0))
        fd = ImageDraw.Draw(flame)
        n = 9
        for i in range(n):
            p = i / (n - 1)
            flick = math.sin(t * 2 * math.pi * (2 + i * 0.9) + i * 1.7)
            rx = 30 * (1 - 0.72 * p) + 5 * flick
            ry = rx * 1.5
            y = 235 - p * 105
            x = W / 2 + flick * (3 + 9 * p)
            color = lerp((255, 60, 0), (255, 225, 120), p)
            fd.ellipse((x - rx, y - ry, x + rx, y + ry), fill=color)
        frame = ImageChops.screen(frame, dim(flame.filter(ImageFilter.GaussianBlur(6)), 0.8 + 0.2 * pulse))
        frame = ImageChops.screen(frame, dim(flame.filter(ImageFilter.GaussianBlur(2)), 0.55))

        # Bright core at the flame base.
        core = Image.new("RGB", (W, H), (0, 0, 0))
        cw = 16 + 5 * math.sin(t * 2 * math.pi * 3)
        ImageDraw.Draw(core).ellipse((W / 2 - cw, 218 - cw, W / 2 + cw, 224 + cw), fill=(255, 245, 200))
        frame = ImageChops.screen(frame, core.filter(ImageFilter.GaussianBlur(4)))

        # Embers rising from the flame.
        d = ImageDraw.Draw(frame)
        for e in embers:
            py = (e["y0"] - e["v"] * t) % 110 + 130
            wobble = 8 * math.sin(t * 2 * math.pi + e["ph"])
            flick = 0.5 + 0.5 * math.sin(t * 6 * math.pi + e["ph"] * 2)
            d.ellipse((e["x"] + wobble - e["r"], py - e["r"], e["x"] + wobble + e["r"], py + e["r"]),
                      fill=lerp((120, 20, 0), (255, 200, 90), flick))

        # Label.
        tl = text_layer("$GW BURNED", font, (255, 250, 240), (W / 2, 55))
        frame = ImageChops.screen(frame, dim(tl.filter(ImageFilter.GaussianBlur(9)), 0.55 + 0.45 * pulse))
        frame = ImageChops.screen(frame, tl)

        frames.append(frame)
    return frames


def save_gif(frames: list[Image.Image], name: str) -> Path:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out = OUT_DIR / name
    frames[0].save(out, save_all=True, append_images=frames[1:], duration=FRAME_MS, loop=0, optimize=True)
    return out

# ALL live embed images under public/gifs/ are user-provided (videos
# converted via ffmpeg + one static PNG). This generator is kept only for
# designing placeholders, so it writes to tools/previews/ — it can never
# clobber the real assets.


def dump_previews(name: str, frames: list[Image.Image]) -> None:
    tmp = Path(tempfile.gettempdir())
    for i in (0, FRAMES // 3, 2 * FRAMES // 3):
        frames[i].save(tmp / f"gw_preview_{name[:-4]}_{i}.png")


if __name__ == "__main__":
    for name, frames in (
        ("buy.gif", make_trade_gif("buy")),
        ("sell.gif", make_trade_gif("sell")),
        ("burn.gif", make_burn_gif()),
    ):
        out = save_gif(frames, name)
        dump_previews(name, frames)
        print(f"{out.name}: {out.stat().st_size / 1024:.0f} KB, {len(frames)} frames")
