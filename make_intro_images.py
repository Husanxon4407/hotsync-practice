"""HotSync home page: make the 3D Earth pictures (run once, by hand).

Inputs: the NASA Blue Marble picture and the height map from the three-globe
examples (https://cdn.jsdelivr.net/npm/three-globe@2.31.1/example/img/), the same
pictures the "Find on globe" button uses.
Usage: python make_intro_images.py earth-blue-marble.jpg earth-topology.png web/intro/earth.jpg web/intro/earth-normal.jpg

Make web/intro/earth.jpg (colour, 2048x1024) and web/intro/earth-normal.jpg
(tangent-space normal map from the topology height map). Paths come as arguments."""
import sys
import numpy as np
from PIL import Image

src_color, src_height, out_color, out_normal = sys.argv[1:5]

col = Image.open(src_color).convert("RGB").resize((2048, 1024), Image.LANCZOS)
col.save(out_color, "JPEG", quality=86, optimize=True, progressive=True)

h = np.asarray(Image.open(src_height).convert("L"), dtype=np.float32) / 255.0   # 2048 x 1024
strength = 6.0
# wrap around left/right (longitude), clamp top/bottom (poles)
dx = (np.roll(h, -1, axis=1) - np.roll(h, 1, axis=1)) * 0.5
dy = np.zeros_like(h)
dy[1:-1] = (h[2:] - h[:-2]) * 0.5
nx, ny, nz = -dx * strength, dy * strength, np.ones_like(h)
n = np.sqrt(nx * nx + ny * ny + nz * nz)
rgb = np.stack([(nx / n) * 0.5 + 0.5, (ny / n) * 0.5 + 0.5, (nz / n) * 0.5 + 0.5], axis=-1)
Image.fromarray((rgb * 255).clip(0, 255).astype(np.uint8)).save(out_normal, "JPEG", quality=88, optimize=True)
print("ok", col.size)
