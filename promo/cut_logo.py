# Вырезает светлый фон из icon-512.png -> logo-transparent.png
import sys
from PIL import Image, ImageDraw
src, dst = sys.argv[1], sys.argv[2]
im = Image.open(src).convert("RGB")
W, H = im.size
bg = im.getpixel((2, 2))
px = im.load()
THR = 60
def dist(c): return max(abs(c[0]-bg[0]), abs(c[1]-bg[1]), abs(c[2]-bg[2]))
mask = Image.new("L", (W, H), 0)
m = mask.load()
for y in range(H):
    for x in range(W):
        if dist(px[x, y]) < THR: m[x, y] = 255
for c in [(0,0),(W-1,0),(0,H-1),(W-1,H-1)]:
    ImageDraw.floodfill(mask, c, 128)
out = im.convert("RGBA"); o = out.load()
for y in range(H):
    for x in range(W):
        if m[x, y] == 128:
            d = dist(px[x, y])
            a = max(0, min(255, int((d - 6) / (THR - 6) * 255)))
            r, g, b = px[x, y]
            o[x, y] = (r, g, b, a)
out = out.crop(out.getbbox())
out.save(dst)
print(out.size)
