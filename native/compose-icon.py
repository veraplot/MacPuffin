#!/usr/bin/env python3
"""Compose the macOS icon master from the generated puffin artwork.

The bird itself comes from the Gemini prompt in `native/icon-prompt.txt`; that
render puts the mark on a flat slate background whose value is almost identical
to the head, so the head silhouette is unusable as-is. This script keys that
flat colour out and rebuilds the tile with the app's own palette: a graphite
squircle washed with the red-to-blue signature gradient.

    python3 native/compose-icon.py native/icon-source.png native/icon.png

Run it again only when the artwork changes. The committed `native/icon.png` is
what the build slices, so the build itself needs no Python and no Chrome.
"""

import sys
from PIL import Image, ImageDraw, ImageFilter

CANVAS = 1024
# Apple's grid: the art sits in a squircle with roughly 10% breathing room.
TILE = 824
RADIUS = int(TILE * 0.2237)

GRAPHITE = (18, 16, 15)      # near-black graphite, as in the app background
RED = (220, 38, 38)          # #DC2626
BLUE = (37, 99, 235)         # #2563EB


def key_out_background(art: Image.Image, tol: int = 16) -> Image.Image:
    """Make the flat slate background (and the head painted in the same value)
    transparent, leaving the face, beak and eye rings."""
    art = art.convert("RGBA")
    bg = art.getpixel((2, 2))[:3]
    out = []
    for r, g, b, a in art.getdata():
        near = max(abs(r - bg[0]), abs(g - bg[1]), abs(b - bg[2])) <= tol
        out.append((r, g, b, 0) if near else (r, g, b, a))
    art.putdata(out)
    return art


def glow(size: int, centre, radius: float, colour, strength: float) -> Image.Image:
    """A soft radial light, the same device the app uses for its background."""
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    steps = 48
    for i in range(steps, 0, -1):
        t = i / steps
        r = radius * t
        alpha = round(255 * strength * (1 - t) ** 1.6)
        if alpha <= 0:
            continue
        draw.ellipse([centre[0] - r, centre[1] - r, centre[0] + r, centre[1] + r],
                     fill=(*colour, alpha))
    return layer.filter(ImageFilter.GaussianBlur(size * 0.05))


def gradient_tile() -> Image.Image:
    """Graphite squircle lit from the top-left in red and the bottom-right in
    blue — the signature gradient, kept off the centre so the bird stays
    readable against a dark field."""
    tile = Image.new("RGBA", (TILE, TILE), (*GRAPHITE, 255))
    tile.alpha_composite(glow(TILE, (TILE * 0.12, TILE * 0.06), TILE * 0.95, RED, 0.85))
    tile.alpha_composite(glow(TILE, (TILE * 0.92, TILE * 1.02), TILE * 1.00, BLUE, 0.9))

    # A restrained top edge highlight, so the tile reads as lit, not flat.
    gloss = Image.new("RGBA", (TILE, TILE), (0, 0, 0, 0))
    ImageDraw.Draw(gloss).ellipse(
        [-TILE * 0.3, -TILE * 0.62, TILE * 1.3, TILE * 0.24],
        fill=(255, 255, 255, 26),
    )
    tile.alpha_composite(gloss.filter(ImageFilter.GaussianBlur(TILE * 0.06)))

    mask = Image.new("L", (TILE, TILE), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, TILE - 1, TILE - 1], RADIUS, fill=255)
    tile.putalpha(mask)
    return tile


def main(src_path: str, dst_path: str) -> None:
    art = key_out_background(Image.open(src_path))
    box = art.getbbox()
    if box is None:
        sys.exit("nothing left after keying — check the source artwork")
    art = art.crop(box)

    # The bird fills about 72% of the tile: big enough to read at 32 px, with
    # enough margin that the squircle still registers as a shape.
    target = int(TILE * 0.72)
    scale = target / max(art.size)
    art = art.resize((round(art.width * scale), round(art.height * scale)), Image.LANCZOS)

    canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    tile = gradient_tile()
    tile_pos = ((CANVAS - TILE) // 2, (CANVAS - TILE) // 2)
    canvas.alpha_composite(tile, tile_pos)

    # Optically centred: the beak hangs low, so the mark sits slightly high.
    x = (CANVAS - art.width) // 2
    y = (CANVAS - art.height) // 2 - int(TILE * 0.015)
    canvas.alpha_composite(art, (x, y))

    canvas.save(dst_path)
    print(f"wrote {dst_path} ({canvas.size[0]}x{canvas.size[1]})")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "native/icon-source.png",
         sys.argv[2] if len(sys.argv) > 2 else "native/icon.png")
