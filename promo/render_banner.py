# Плавающий баннер Audio Chat для TikTok.
# Рендерит бесшовный цикл кадров (PIL) и собирает видео через ffmpeg:
#   *_green.mp4  — на зелёном фоне (хромакей в CapCut / TikTok)
#   *_alpha.mov  — с прозрачностью (ProRes 4444, для CapCut на ПК / Premiere)
#   *_alpha.webm — с прозрачностью (VP9, для браузера)
#
# Запуск:  python render_banner.py [домен] [выходная_папка]
import math, os, shutil, subprocess, sys, tempfile
from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageChops

DOMAIN = sys.argv[1] if len(sys.argv) > 1 else "audio-chat.ru"
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(__file__), "out")
TITLE = "Аудио Костя"
SUBTITLE = "Аналог Дискорда"

W, H = 1080, 360          # размер видео
SS = 2                    # суперсэмплинг
FPS, LOOP_S, REPEAT = 30, 4, 3
N = FPS * LOOP_S

HERE = os.path.dirname(os.path.abspath(__file__))
LOGO = Image.open(os.path.join(HERE, "logo-transparent.png")).convert("RGBA")
FONT_B = "C:/Windows/Fonts/segoeuib.ttf"
FONT_R = "C:/Windows/Fonts/segoeui.ttf"

BLUE = (26, 102, 240)
BLUE_D = (15, 85, 214)
BLUE_L = (90, 160, 255)
INK = (13, 26, 51)
MUTED = (90, 103, 130)


def S(v):
    return int(round(v * SS))


def font(path, size):
    return ImageFont.truetype(path, S(size))


F_TITLE = font(FONT_B, 76)
F_SUB = font(FONT_R, 36)
F_LINK = font(FONT_B, 36)

# Геометрия карточки (базовые px)
CX0, CY0, CX1, CY1 = 40, 56, 1040, 316
CR = (CY1 - CY0) // 2
LOGO_C = (178, 186)
TEXT_X = 330


def vgrad(w, h, top, bottom):
    g = Image.new("RGBA", (1, h))
    for y in range(h):
        k = y / max(1, h - 1)
        g.putpixel((0, y), tuple(int(top[i] + (bottom[i] - top[i]) * k) for i in range(3)) + (255,))
    return g.resize((w, h))


def hgrad(w, h, left, right):
    g = Image.new("RGBA", (w, 1))
    for x in range(w):
        k = x / max(1, w - 1)
        g.putpixel((x, 0), tuple(int(left[i] + (right[i] - left[i]) * k) for i in range(3)) + (255,))
    return g.resize((w, h))


def rrect_mask(size, box, r):
    m = Image.new("L", size, 0)
    ImageDraw.Draw(m).rounded_rectangle(box, r, fill=255)
    return m


def star(draw, cx, cy, r, color):
    k = r * 0.28
    pts = [(cx, cy - r), (cx + k, cy - k), (cx + r, cy), (cx + k, cy + k),
           (cx, cy + r), (cx - k, cy + k), (cx - r, cy), (cx - k, cy - k)]
    draw.polygon(pts, fill=color)


# Статичные заготовки
SW, SH = S(W), S(H)
CARD_BOX = (S(CX0), S(CY0), S(CX1), S(CY1))
CARD_MASK = rrect_mask((SW, SH), CARD_BOX, S(CR))
INNER_BOX = (S(CX0 + 6), S(CY0 + 6), S(CX1 - 6), S(CY1 - 6))
INNER_MASK = rrect_mask((SW, SH), INNER_BOX, S(CR - 6))
BORDER = hgrad(SW, SH, BLUE_L, BLUE_D)
FILL = vgrad(SW, SH, (255, 255, 255), (232, 241, 255))

title_w = ImageDraw.Draw(Image.new("L", (1, 1))).textlength(TITLE, font=F_TITLE)
link_w = ImageDraw.Draw(Image.new("L", (1, 1))).textlength(DOMAIN, font=F_LINK)
ARROW_W = S(40)
PILL_PAD = S(26)
PILL_H = S(60)
PILL_W = int(link_w + ARROW_W + PILL_PAD * 2 + S(6))

logo_h = S(232)
LOGO_S = LOGO.resize((int(LOGO.width * logo_h / LOGO.height), logo_h), Image.LANCZOS)


def frame(i):
    t = i / N                     # 0..1, бесшовный цикл
    tau = 2 * math.pi * t
    img = Image.new("RGBA", (SW, SH), (0, 0, 0, 0))

    # --- карточка: обводка + заливка
    card = Image.new("RGBA", (SW, SH), (0, 0, 0, 0))
    card.paste(BORDER, (0, 0), CARD_MASK)
    card.paste(FILL, (0, 0), INNER_MASK)

    # --- звуковые волны от логотипа (внутри карточки)
    waves = Image.new("RGBA", (SW, SH), (0, 0, 0, 0))
    wd = ImageDraw.Draw(waves)
    for k in range(3):
        p = (t * 2 + k / 3) % 1.0
        r = S(105 + 150 * p)
        a = int(170 * (1 - p) ** 1.6)
        cx, cy = S(LOGO_C[0]), S(LOGO_C[1])
        wd.ellipse((cx - r, cy - r, cx + r, cy + r), outline=BLUE + (a,), width=S(5))
    wmask = ImageChops.multiply(INNER_MASK, waves.getchannel("A"))
    waves.putalpha(wmask)
    card.alpha_composite(waves)

    d = ImageDraw.Draw(card)

    # --- заголовок + эквалайзер
    d.text((S(TEXT_X), S(62)), TITLE, font=F_TITLE, fill=INK)
    eq_x = S(TEXT_X) + int(title_w) + S(28)
    base_y = S(146)
    for b in range(5):
        hh = 14 + 30 * (0.5 + 0.5 * math.sin(tau * (2 + b % 3) + b * 1.3))
        x = eq_x + b * S(16)
        d.rounded_rectangle((x, base_y - S(hh), x + S(9), base_y), S(4), fill=BLUE)

    # --- подзаголовок
    d.text((S(TEXT_X + 2), S(156)), SUBTITLE, font=F_SUB, fill=MUTED)

    # --- кнопка-ссылка (пульсирует)
    pulse = 1 + 0.035 * max(0.0, math.sin(tau * 2)) ** 3
    pw, ph = int(PILL_W * pulse), int(PILL_H * pulse)
    px0 = S(TEXT_X)
    py_c = S(244)
    pill = Image.new("RGBA", (PILL_W, PILL_H), (0, 0, 0, 0))
    pill.paste(hgrad(PILL_W, PILL_H, BLUE, BLUE_D), (0, 0),
               rrect_mask((PILL_W, PILL_H), (0, 0, PILL_W - 1, PILL_H - 1), PILL_H // 2))
    pdr = ImageDraw.Draw(pill)
    ty = (PILL_H - S(36)) // 2 - S(8)
    pdr.text((PILL_PAD, ty), DOMAIN, font=F_LINK, fill=(255, 255, 255))
    ax = PILL_PAD + int(link_w) + S(14) + int(S(6) * (0.5 + 0.5 * math.sin(tau * 4)))
    ay = PILL_H // 2
    pdr.line((ax, ay, ax + S(24), ay), fill=(255, 255, 255), width=S(5))
    pdr.line((ax + S(13), ay - S(11), ax + S(25), ay), fill=(255, 255, 255), width=S(5))
    pdr.line((ax + S(13), ay + S(11), ax + S(25), ay), fill=(255, 255, 255), width=S(5))
    pill = pill.resize((pw, ph), Image.LANCZOS)
    card.alpha_composite(pill, (px0 - (pw - PILL_W) // 2, py_c - ph // 2))

    # --- блик по карточке
    sp = (t - 0.5) / 0.35
    if 0 <= sp <= 1:
        sh = Image.new("L", (SW, SH), 0)
        sx = int(S(CX0 - 200) + (S(CX1 + 200) - S(CX0 - 200)) * sp)
        ImageDraw.Draw(sh).polygon(
            [(sx, SH), (sx + S(70), SH), (sx + S(190), 0), (sx + S(120), 0)], fill=110)
        sh = sh.filter(ImageFilter.GaussianBlur(S(10)))
        sh = ImageChops.multiply(sh, INNER_MASK)
        white = Image.new("RGBA", (SW, SH), (255, 255, 255, 0))
        white.putalpha(sh)
        card.alpha_composite(white)

    img.alpha_composite(card)

    # --- логотип (свой ритм покачивания, выходит за карточку)
    bob = math.sin(tau * 2) * S(7)
    ang = math.sin(tau) * 5
    lg = LOGO_S.rotate(ang, resample=Image.BICUBIC, expand=True)
    img.alpha_composite(lg, (S(LOGO_C[0]) - lg.width // 2, int(S(LOGO_C[1] - 6) - lg.height // 2 + bob)))

    # --- искорки
    sd = ImageDraw.Draw(img)
    for (sx_, sy_, sr, ph_) in [(300, 70, 15, 0.0), (318, 112, 9, 0.35), (60, 92, 11, 0.65)]:
        k = max(0.0, math.sin(tau * 2 + ph_ * 2 * math.pi))
        if k > 0.02:
            star(sd, S(sx_), S(sy_), S(sr) * (0.5 + 0.5 * k), (255, 205, 60, int(255 * k)))

    # --- общее «парение» всей композиции
    fy = math.sin(tau) * 7
    rot = math.sin(tau + 1.2) * 0.9
    img = img.rotate(rot, resample=Image.BICUBIC, center=(SW / 2, SH / 2), translate=(0, S(fy)))
    return img.resize((W, H), Image.LANCZOS)


def with_shadow(fr):
    a = fr.getchannel("A")
    sh = Image.new("RGBA", fr.size, (8, 20, 60, 0))
    sh.putalpha(a.point(lambda v: int(v * 0.45)).filter(ImageFilter.GaussianBlur(14)))
    out = Image.new("RGBA", fr.size, (0, 0, 0, 0))
    out.alpha_composite(sh, (0, 10))
    out.alpha_composite(fr)
    return out


def main():
    os.makedirs(OUT, exist_ok=True)
    tmp = tempfile.mkdtemp(prefix="banner_")
    fa, fg = os.path.join(tmp, "a"), os.path.join(tmp, "g")
    os.makedirs(fa); os.makedirs(fg)
    for i in range(N):
        fr = frame(i)
        with_shadow(fr).save(os.path.join(fa, f"{i:04d}.png"))
        g = Image.new("RGBA", (W, H), (0, 255, 0, 255))
        g.alpha_composite(fr)
        g.convert("RGB").save(os.path.join(fg, f"{i:04d}.png"))
        if i == N // 4:
            with_shadow(fr).save(os.path.join(OUT, f"banner_{DOMAIN}_preview.png"))
        print(f"\rкадр {i + 1}/{N}", end="", flush=True)
    print()
    name = os.path.join(OUT, f"banner_{DOMAIN}")
    loop = ["-stream_loop", str(REPEAT - 1)]
    ff = ["ffmpeg", "-y", "-loglevel", "error", "-framerate", str(FPS)]
    subprocess.run(ff + loop + ["-i", os.path.join(fg, "%04d.png"), "-c:v", "libx264",
                    "-pix_fmt", "yuv420p", "-crf", "16", "-movflags", "+faststart",
                    name + "_green.mp4"], check=True)
    subprocess.run(ff + loop + ["-i", os.path.join(fa, "%04d.png"), "-c:v", "prores_ks",
                    "-profile:v", "4444", "-pix_fmt", "yuva444p10le", name + "_alpha.mov"], check=True)
    subprocess.run(ff + loop + ["-i", os.path.join(fa, "%04d.png"), "-c:v", "libvpx-vp9",
                    "-pix_fmt", "yuva420p", "-b:v", "0", "-crf", "24", "-auto-alt-ref", "0",
                    name + "_alpha.webm"], check=True)
    shutil.rmtree(tmp, ignore_errors=True)
    print("готово:", name + "_*")


if __name__ == "__main__":
    main()
