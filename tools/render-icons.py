"""Render app/icons/icon.svg to the PNG sizes the platforms ask for.

    uv run --with playwright python tools/render-icons.py

Run again after changing the SVG; the PNGs are committed.
"""

from pathlib import Path

from playwright.sync_api import sync_playwright

ICONS = Path(__file__).resolve().parent.parent / "app" / "icons"
SIZES = {"apple-touch-icon.png": 180, "icon-192.png": 192, "icon-512.png": 512}


def main() -> None:
    svg = (ICONS / "icon.svg").read_text()
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for name, size in SIZES.items():
            page = browser.new_page(viewport={"width": size, "height": size})
            sized = svg.replace("<svg ", f'<svg width="{size}" height="{size}" ', 1)
            page.set_content(f'<html><body style="margin:0">{sized}</body></html>')
            page.screenshot(path=ICONS / name, omit_background=False)
            page.close()
        browser.close()


if __name__ == "__main__":
    main()
