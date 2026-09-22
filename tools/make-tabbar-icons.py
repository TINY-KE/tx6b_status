# -*- coding: utf-8 -*-
"""把 tabBar 的 SVG 源图重绘成 PNG。

为什么要转：
    微信小程序的 <image> **不支持本地 .svg 文件**。开发者工具里能正常显示，
    一到真机（尤其 iOS）就是一片空白，而且不报错——很难查。
    所以 assets/tabbar/ 下的 .svg 只是源文件，真正被 image 加载的是同名 .png。

用法：
    python make-tabbar-icons.py
    需要 Pillow：pip install Pillow

改图标的流程：
    1. 改下面的坐标（48x48 坐标系，和 viewBox 一致）
    2. 跑本脚本重新导出 6 个 PNG
    3. Ctrl+R 重新编译

形状是按原 SVG 的 path 逐点复刻的；8 倍超采样后 LANCZOS 缩小，
边缘才平滑（Pillow 直接画 polygon 没有抗锯齿）。
"""

import os
from PIL import Image, ImageDraw

UNIT = 48          # 原 SVG 的 viewBox 尺寸
SCALE = 8          # 超采样倍数（画完再缩回去，得到抗锯齿边缘）
OUT = 144          # 输出边长（像素）。44rpx 的图标在 @3x 屏上约 66px，144 足够

NORMAL = (138, 138, 142, 255)   # #8a8a8e，与 tabBar 的 color 一致
ACTIVE = (24, 95, 165, 255)     # #185fa5，与 selectedColor 一致

DEST = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "miniprogram", "assets", "tabbar"
)


def s(v):
    return v * SCALE


def new_canvas():
    img = Image.new("RGBA", (UNIT * SCALE, UNIT * SCALE), (0, 0, 0, 0))
    return img, ImageDraw.Draw(img)


def draw_board(d, color):
    """在位看板：2x2 四宫格，每个方块 16x16、圆角半径 2。"""
    radius = 2
    for x0, y0 in [(6, 6), (26, 6), (6, 26), (26, 26)]:
        d.rounded_rectangle(
            [s(x0), s(y0), s(x0 + 16), s(y0 + 16)],
            radius=s(radius),
            fill=color,
        )


def draw_fill(d, color):
    """填写去向：一支斜放的笔（带状 + 左下角笔尖）。"""
    pts = [(34.6, 7.4), (40.6, 13.4), (15.6, 38.4), (8.4, 39.6), (9.6, 32.4)]
    d.polygon([(s(x), s(y)) for x, y in pts], fill=color)


def draw_mine(d, color):
    """我的：头（圆）+ 肩（半径 16 的上半圆）。"""
    d.ellipse([s(16), s(6), s(32), s(22)], fill=color)
    # Pillow 的角度从 3 点钟起、顺时针为正；180~360 正好是上半圆
    d.pieslice([s(8), s(26), s(40), s(58)], 180, 360, fill=color)


SHAPES = {"board": draw_board, "fill": draw_fill, "mine": draw_mine}


def main():
    dest = os.path.normpath(DEST)
    if not os.path.isdir(dest):
        raise SystemExit("目标目录不存在: " + dest)
    for name, fn in SHAPES.items():
        for suffix, color in [("normal", NORMAL), ("active", ACTIVE)]:
            img, d = new_canvas()
            fn(d, color)
            out = img.resize((OUT, OUT), Image.LANCZOS)
            path = os.path.join(dest, name + "-" + suffix + ".png")
            out.save(path, "PNG", optimize=True)
            print("written " + path + "  " + str(os.path.getsize(path)) + "B")


if __name__ == "__main__":
    main()
