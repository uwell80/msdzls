# 图像预处理（PIL）——为 Windows OCR 准备"干净"的图：灰度/自动对比/放大/二值化。
# 用法:
#   python prep.py in.png out.png [--crop x,y,w,h] [--scale 3] [--gray] [--autocontrast]
#                             [--binarize THRESH] [--invert] [--sharpen]
import argparse
from PIL import Image, ImageOps, ImageFilter


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("dst")
    ap.add_argument("--crop", default="")
    ap.add_argument("--scale", type=float, default=1.0)
    ap.add_argument("--gray", action="store_true")
    ap.add_argument("--autocontrast", action="store_true")
    ap.add_argument("--binarize", type=int, default=-1)
    ap.add_argument("--invert", action="store_true")
    ap.add_argument("--sharpen", action="store_true")
    ap.add_argument("--dark-text", action="store_true", help="只保留暗色像素（暗字变黑、其余变白）")
    a = ap.parse_args()

    img = Image.open(a.src).convert("RGB")
    if a.crop:
        x, y, w, h = (int(v) for v in a.crop.split(","))
        img = img.crop((x, y, x + w, y + h))
    if a.gray or a.binarize >= 0 or a.dark_text:
        img = img.convert("L")
    if a.autocontrast:
        img = ImageOps.autocontrast(img)
    if a.binarize >= 0:
        img = img.point(lambda v: 255 if v > a.binarize else 0, mode="L")
    if a.dark_text:
        # 保留"暗"像素：亮度低于阈值 → 黑，其余 → 白（对深底浅字要先 --invert）
        img = img.point(lambda v: 0 if v < 140 else 255, mode="L")
    if a.invert:
        img = ImageOps.invert(img)
    if a.scale != 1.0:
        img = img.resize((int(img.width * a.scale), int(img.height * a.scale)), Image.LANCZOS)
    if a.sharpen:
        img = img.filter(ImageFilter.SHARPEN)
    img.save(a.dst)
    print(f"saved {a.dst} {img.size} mode={img.mode}")


if __name__ == "__main__":
    main()
