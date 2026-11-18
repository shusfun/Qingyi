"""Render modern Qingyi (轻译) browser extension brand icons.

Requires Pillow. Offline & deterministic; matches mistral squircle geometry as a sister suite.
"""
from pathlib import Path
import math
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
ICONS_DIR = ROOT / "static/icons"


def superellipse_points(cx, cy, rx, ry, n=4.5, steps=360):
    pts = []
    for i in range(steps):
        theta = (2.0 * math.pi * i) / steps
        ct, st = math.cos(theta), math.sin(theta)
        x = cx + rx * (1 if ct >= 0 else -1) * (abs(ct) ** (2.0 / n))
        y = cy + ry * (1 if st >= 0 else -1) * (abs(st) ** (2.0 / n))
        pts.append((x, y))
    return pts


def linear_gradient(size, p0, p1, stops):
    w, h = size
    sw, sh = max(1, w // 4), max(1, h // 4)
    sx0, sy0 = p0[0] / 4.0, p0[1] / 4.0
    sx1, sy1 = p1[0] / 4.0, p1[1] / 4.0
    dx, dy = sx1 - sx0, sy1 - sy0
    denom = dx * dx + dy * dy or 1.0

    small = Image.new("RGBA", (sw, sh))
    px = small.load()
    for y in range(sh):
        for x in range(sw):
            t = ((x - sx0) * dx + (y - sy0) * dy) / denom
            t = 0.0 if t < 0.0 else (1.0 if t > 1.0 else t)
            c = stops[-1][1]
            for idx in range(len(stops) - 1):
                t0, c0 = stops[idx]
                t1, c1 = stops[idx + 1]
                if t <= t1:
                    u = 0.0 if t1 == t0 else (t - t0) / (t1 - t0)
                    c = tuple(int(round(c0[k] + (c1[k] - c0[k]) * u)) for k in range(4))
                    break
            px[x, y] = c
    return small.resize((w, h), Image.Resampling.BICUBIC)


def cubic_bezier(p0, p1, p2, p3, steps=64):
    pts = []
    for i in range(steps + 1):
        t = i / steps
        mt = 1.0 - t
        x = (mt**3) * p0[0] + 3 * (mt**2) * t * p1[0] + 3 * mt * (t**2) * p2[0] + (t**3) * p3[0]
        y = (mt**3) * p0[1] + 3 * (mt**2) * t * p1[1] + 3 * mt * (t**2) * p2[1] + (t**3) * p3[1]
        pts.append((x, y))
    return pts


def draw_round_polyline(draw, pts, radius, fill=255):
    for i in range(len(pts) - 1):
        x0, y0 = pts[i]
        x1, y1 = pts[i + 1]
        dx, dy = x1 - x0, y1 - y0
        length = math.hypot(dx, dy)
        if length > 0:
            nx, ny = -dy / length * radius, dx / length * radius
            draw.polygon(
                [(x0 + nx, y0 + ny), (x1 + nx, y1 + ny), (x1 - nx, y1 - ny), (x0 - nx, y0 - ny)],
                fill=fill,
            )
        draw.ellipse((x0 - radius, y0 - radius, x0 + radius, y0 + radius), fill=fill)
    xl, yl = pts[-1]
    draw.ellipse((xl - radius, yl - radius, xl + radius, yl + radius), fill=fill)


def build_front_card_mask(S, s):
    mask = Image.new("L", (S, S), 0)
    d = ImageDraw.Draw(mask)
    d.rounded_rectangle((98 * s, 172 * s, 332 * s, 368 * s), radius=46 * s, fill=255)
    # Seamless tangent-rounded speech tail at bottom-left
    tip = (138 * s, 395 * s)
    r_tip = 5.8 * s
    d.polygon(
        [
            (139 * s, 356 * s),
            (tip[0] - r_tip * 0.85, tip[1] - r_tip * 0.35),
            (tip[0] + r_tip * 0.55, tip[1] + r_tip * 0.8),
            (198 * s, 364 * s),
        ],
        fill=255,
    )
    d.ellipse((tip[0] - r_tip, tip[1] - r_tip, tip[0] + r_tip, tip[1] + r_tip), fill=255)
    return mask


def render_qingyi_icon():
    S = 2048
    s = S / 512.0
    canvas = Image.new("RGBA", (S, S), (0, 0, 0, 0))

    # 1. Squircle mask
    sq_pts = superellipse_points(256 * s, 256 * s, 228 * s, 228 * s, n=4.5, steps=512)
    sq_mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(sq_mask).polygon(sq_pts, fill=255)

    # 2. Clean vibrant vermilion-crimson gradient
    bg_grad = linear_gradient(
        (S, S),
        (64 * s, 36 * s),
        (448 * s, 476 * s),
        [
            (0.0, (250, 82, 70, 255)),
            (0.52, (225, 37, 36, 255)),
            (1.0, (185, 24, 29, 255)),
        ],
    )
    canvas.paste(bg_grad, (0, 0), sq_mask)

    # 3. Soft warm top glow
    glow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse((60 * s, -40 * s, 420 * s, 300 * s), fill=(255, 215, 205, 68))
    glow = glow.filter(ImageFilter.GaussianBlur(radius=64 * s))
    glow_clipped = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    glow_clipped.paste(glow, (0, 0), sq_mask)
    canvas = Image.alpha_composite(canvas, glow_clipped)

    # 4. Crisp inner specular rim
    rim_layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    rim_pts = superellipse_points(256 * s, 256 * s, 226.2 * s, 226.2 * s, n=4.5, steps=512)
    ImageDraw.Draw(rim_layer).line(rim_pts + [rim_pts[0]], fill=(255, 255, 255, 68), width=int(3.2 * s))
    canvas = Image.alpha_composite(canvas, rim_layer)

    # 5. Back translucent source speech-card (top-right) + unobstructed 'A' cue
    back_mask = Image.new("L", (S, S), 0)
    bd = ImageDraw.Draw(back_mask)
    bd.rounded_rectangle((198 * s, 98 * s, 414 * s, 284 * s), radius=44 * s, fill=255)
    back_layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    back_fill = Image.new("RGBA", (S, S), (255, 255, 255, 80))
    back_layer.paste(back_fill, (0, 0), back_mask)
    canvas = Image.alpha_composite(canvas, back_layer)

    a_mask = Image.new("L", (S, S), 0)
    ad = ImageDraw.Draw(a_mask)
    ra = 6.8 * s
    draw_round_polyline(ad, [(350 * s, 196 * s), (371 * s, 138 * s), (392 * s, 196 * s)], ra)
    draw_round_polyline(ad, [(356 * s, 180 * s), (386 * s, 180 * s)], ra * 0.88)
    a_layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    a_layer.paste(Image.new("RGBA", (S, S), (255, 255, 255, 206)), (0, 0), a_mask)
    canvas = Image.alpha_composite(canvas, a_layer)

    # 6. Soft drop shadow beneath front card
    front_mask = build_front_card_mask(S, s)
    shadow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    shadow_alpha = front_mask.filter(ImageFilter.GaussianBlur(radius=16 * s))
    shadow_solid = Image.new("RGBA", (S, S), (110, 8, 12, 96))
    shadow.paste(shadow_solid, (int(4 * s), int(10 * s)), shadow_alpha)
    shadow_clipped = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    shadow_clipped.paste(shadow, (0, 0), sq_mask)
    canvas = Image.alpha_composite(canvas, shadow_clipped)

    # 7. Crisp pure-white front card
    front_layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    front_layer.paste(Image.new("RGBA", (S, S), (255, 255, 255, 255)), (0, 0), front_mask)
    canvas = Image.alpha_composite(canvas, front_layer)

    # 8. Geometric '文' glyph centered inside front card
    wen_mask = Image.new("L", (S, S), 0)
    wd = ImageDraw.Draw(wen_mask)
    r = 11.2 * s
    # Top dot/crest
    draw_round_polyline(wd, [(215 * s, 208 * s), (215 * s, 231 * s)], r)
    # Horizontal bar
    draw_round_polyline(wd, [(153 * s, 237 * s), (277 * s, 237 * s)], r)
    # Right-to-left sweeping stroke (撇)
    stroke_pie = cubic_bezier(
        (247 * s, 239 * s),
        (237 * s, 281 * s),
        (205 * s, 314 * s),
        (159 * s, 332 * s),
    )
    draw_round_polyline(wd, stroke_pie, r)
    # Left-to-right sweeping stroke (捺)
    stroke_na = cubic_bezier(
        (179 * s, 256 * s),
        (201 * s, 288 * s),
        (233 * s, 315 * s),
        (271 * s, 332 * s),
    )
    draw_round_polyline(wd, stroke_na, r)

    wen_grad = linear_gradient(
        (S, S),
        (153 * s, 208 * s),
        (277 * s, 334 * s),
        [
            (0.0, (239, 50, 43, 255)),
            (1.0, (198, 26, 32, 255)),
        ],
    )
    wen_layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    wen_layer.paste(wen_grad, (0, 0), wen_mask)
    canvas = Image.alpha_composite(canvas, wen_layer)

    return canvas.resize((1024, 1024), Image.Resampling.LANCZOS)


def main():
    import sys
    ICONS_DIR.mkdir(parents=True, exist_ok=True)
    im = render_qingyi_icon()
    for sz in (16, 32, 48, 128, 256):
        im.resize((sz, sz), Image.Resampling.LANCZOS).save(ICONS_DIR / f"icon-{sz}.png")
    im.save(ICONS_DIR / "favicon.ico", sizes=[(n, n) for n in (16, 32, 48)])

    if len(sys.argv) > 1:
        preview = Image.new("RGB", (860, 300), "#F4F5F7")
        dark_half = Image.new("RGB", (430, 300), "#14171F")
        preview.paste(dark_half, (430, 0))
        for n, x in [(16, 24), (24, 54), (32, 94), (48, 142), (192, 212)]:
            icon = im.resize((n, n), Image.Resampling.LANCZOS)
            y = (300 - n) // 2
            preview.paste(icon, (x, y), icon)
            preview.paste(icon, (430 + x, y), icon)
        Path(sys.argv[1]).parent.mkdir(parents=True, exist_ok=True)
        preview.save(sys.argv[1])


if __name__ == "__main__":
    main()
