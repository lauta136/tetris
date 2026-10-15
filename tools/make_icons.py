#!/usr/bin/env python3
"""Generate the PWA icons for Tetris.

Pure standard library — no Pillow, no ImageMagick. Renders with a signed
distance field so edges come out anti-aliased, then writes PNGs by hand.

    python3 tools/make_icons.py
"""

import math
import os
import struct
import zlib

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "icons")

# --- look -------------------------------------------------------------------
BG_TOP = (0x1d, 0x23, 0x2d)
BG_BOTTOM = (0x0d, 0x0f, 0x13)
BLOCK = (0xb4, 0x8c, 0xe8)          # the T-piece purple used in-game

# T-piece, in 3x2 cell coordinates
PIECE = [(1, 0), (0, 1), (1, 1), (2, 1)]
PIECE_W, PIECE_H = 3, 2

CELL_FRACTION = 0.165                # cell size as a fraction of the icon
BLOCK_INSET = 0.055                  # matches tetris.js
BLOCK_RADIUS = 0.17


def sd_round_rect(px, py, cx, cy, hw, hh, r):
    """Signed distance from (px, py) to a rounded rectangle. <0 is inside."""
    qx = abs(px - cx) - (hw - r)
    qy = abs(py - cy) - (hh - r)
    outside = math.hypot(max(qx, 0.0), max(qy, 0.0))
    inside = min(max(qx, qy), 0.0)
    return outside + inside - r


def coverage(d):
    """Anti-aliased coverage from a signed distance, over a ~1px band."""
    return min(max(0.5 - d, 0.0), 1.0)


def mix(a, b, t):
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(3))


def render(size):
    cell = size * CELL_FRACTION
    inset = cell * BLOCK_INSET
    radius = cell * BLOCK_RADIUS
    half = (cell - inset * 2) / 2

    ox = (size - PIECE_W * cell) / 2
    oy = (size - PIECE_H * cell) / 2

    boxes = []
    for (gx, gy) in PIECE:
        cx = ox + gx * cell + cell / 2
        cy = oy + gy * cell + cell / 2
        boxes.append((cx, cy, cy - half, cy + half))

    rows = []
    for y in range(size):
        py = y + 0.5
        bg = mix(BG_TOP, BG_BOTTOM, y / max(size - 1, 1))
        row = bytearray()
        for x in range(size):
            px = x + 0.5
            r, g, b = bg

            for (cx, cy, top, bottom) in boxes:
                d = sd_round_rect(px, py, cx, cy, half, half, radius)
                cov = coverage(d)
                if cov <= 0.0:
                    continue
                # vertical shading: lighter at the top, darker at the bottom
                t = min(max((py - top) / max(bottom - top, 1e-6), 0.0), 1.0)
                shade = 1.0 + 0.30 * (1.0 - t) - 0.22 * t
                br = min(255.0, BLOCK[0] * shade)
                bg_ = min(255.0, BLOCK[1] * shade)
                bb = min(255.0, BLOCK[2] * shade)
                r += (br - r) * cov
                g += (bg_ - g) * cov
                b += (bb - b) * cov

            row += bytes((int(round(r)), int(round(g)), int(round(b)), 255))
        rows.append(bytes(row))
    return rows


def write_png(path, rows, width, height):
    raw = b"".join(b"\x00" + row for row in rows)

    def chunk(tag, data):
        payload = tag + data
        return struct.pack(">I", len(data)) + payload + struct.pack(">I", zlib.crc32(payload) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")

    with open(path, "wb") as fh:
        fh.write(png)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    targets = [
        ("icon-192.png", 192),
        ("icon-512.png", 512),
        ("apple-touch-icon.png", 180),
    ]
    for name, size in targets:
        path = os.path.join(OUT_DIR, name)
        write_png(path, render(size), size, size)
        print(f"wrote {os.path.relpath(path)} ({size}x{size})")


if __name__ == "__main__":
    main()
