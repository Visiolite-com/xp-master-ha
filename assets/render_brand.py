"""Render the Home Assistant brand PNGs from the SVGs in this folder.

    pip install resvg-py pillow
    python assets/render_brand.py      (from the repo root)

netroni_icon*.svg -> icon.png 256x256, icon@2x.png 512x512 (square, transparent padding)
netroni_logo*.svg -> logo.png 128 px high, logo@2x.png 256 px high
*_dark.svg        -> the dark_ variants Home Assistant uses in its dark theme
"""
import io
from pathlib import Path

import resvg_py
from PIL import Image

ASSETS = Path(__file__).parent
BRAND = ASSETS.parent / "custom_components" / "netroni" / "brand"


def render(svg: str, width: int) -> Image.Image:
    png = resvg_py.svg_to_bytes(svg_string=(ASSETS / svg).read_text(encoding="utf-8"), width=width)
    img = Image.open(io.BytesIO(bytes(png))).convert("RGBA")
    return img.crop(img.getbbox())  # trim transparent edges


def save_icon(svg: str, name: str, size: int) -> None:
    img = render(svg, size * 4)
    img.thumbnail((size, size), Image.LANCZOS)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.paste(img, ((size - img.width) // 2, (size - img.height) // 2), img)
    canvas.save(BRAND / name, optimize=True)


def save_logo(svg: str, name: str, height: int) -> None:
    img = render(svg, 3000)
    img = img.resize((round(img.width * height / img.height), height), Image.LANCZOS)
    img.save(BRAND / name, optimize=True)


def main() -> None:
    BRAND.mkdir(parents=True, exist_ok=True)
    for prefix, suffix in (("", ""), ("dark_", "_dark")):
        save_icon(f"netroni_icon{suffix}.svg", f"{prefix}icon.png", 256)
        save_icon(f"netroni_icon{suffix}.svg", f"{prefix}icon@2x.png", 512)
        save_logo(f"netroni_logo{suffix}.svg", f"{prefix}logo.png", 128)
        save_logo(f"netroni_logo{suffix}.svg", f"{prefix}logo@2x.png", 256)
    for png in sorted(BRAND.glob("*.png")):
        print(png.name, Image.open(png).size)


if __name__ == "__main__":
    main()
