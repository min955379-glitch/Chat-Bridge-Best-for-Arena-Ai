#!/usr/bin/env python3
"""dev/make-icons.py — regenerate the extension icons.

Draws two rounded chat bubbles joined by a small link, in the Chat Bridge
colours, and writes extension/icons/icon16.png, icon48.png and icon128.png.

Usage:
    python3 dev/make-icons.py

Needs Pillow:  pip install pillow
This script is only for regenerating the images. The extension itself does not
need Python or Pillow.
"""

import os
from PIL import Image, ImageDraw

BG = (47, 111, 237, 255)       # blue
LIGHT = (255, 255, 255, 255)   # white bubble
ACCENT = (255, 215, 106, 255)  # warm yellow bubble

OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "extension", "icons")


def draw_icon(size: int) -> Image.Image:
    """Draw one icon at the requested size (supersampled for smooth edges)."""
    scale = 8
    s = size * scale
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # Rounded background
    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * 0.22), fill=BG)

    # Left bubble with a tail
    lx0, ly0, lx1, ly1 = int(s * 0.12), int(s * 0.20), int(s * 0.60), int(s * 0.50)
    d.rounded_rectangle([lx0, ly0, lx1, ly1], radius=int(s * 0.09), fill=LIGHT)
    d.polygon(
        [(lx0 + int(s * 0.08), ly1 - 2),
         (lx0 + int(s * 0.08), ly1 + int(s * 0.08)),
         (lx0 + int(s * 0.22), ly1 - 2)],
        fill=LIGHT,
    )

    # Right bubble with a tail
    rx0, ry0, rx1, ry1 = int(s * 0.40), int(s * 0.50), int(s * 0.88), int(s * 0.80)
    d.rounded_rectangle([rx0, ry0, rx1, ry1], radius=int(s * 0.09), fill=ACCENT)
    d.polygon(
        [(rx1 - int(s * 0.08), ry0 + 2),
         (rx1 - int(s * 0.08), ry0 - int(s * 0.08)),
         (rx1 - int(s * 0.22), ry0 + 2)],
        fill=ACCENT,
    )

    # Three small dots joining the bubbles
    dot = max(2, int(s * 0.035))
    for fx in (0.28, 0.40, 0.52):
        cx, cy = int(s * fx), int(s * 0.50)
        d.ellipse([cx - dot, cy - dot, cx + dot, cy + dot], fill=LIGHT)

    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    os.makedirs(OUT_DIR, exist_ok=True)
    for size in (16, 48, 128):
        path = os.path.join(OUT_DIR, f"icon{size}.png")
        draw_icon(size).save(path)
        print(f"wrote {path}")


if __name__ == "__main__":
    main()
