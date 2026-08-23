#!/usr/bin/env python3
"""Render a Mermaid source file to a trimmed SVG in the site's editorial palette.

Usage:
    python3 scripts/render-mermaid.py assets/explorers/ai-platform-map.mmd assets/explorers/ai-platform-map.svg --id pmap

Requires Google Chrome (headless) and network access for mermaid from jsDelivr and Inter from Google Fonts.
The explorer pages fetch the resulting SVG next to them at load time; keep the --id unique per figure on a page.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import tempfile

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

THEME = {
    "fontFamily": "Inter, sans-serif",
    "fontSize": "13px",
    "primaryColor": "#ffffff",
    "primaryTextColor": "#1c1c1c",
    "primaryBorderColor": "#1c1c1c",
    "lineColor": "#4a4a4a",
    "secondaryColor": "#ffffff",
    "tertiaryColor": "#ffffff",
    "clusterBkg": "#ffffff",
    "clusterBorder": "#dcdcd6",
    "edgeLabelBackground": "#ffffff",
    "titleColor": "#1c1c1c",
    # sequence diagrams
    "actorBkg": "#ffffff",
    "actorBorder": "#1c1c1c",
    "actorTextColor": "#1c1c1c",
    "actorLineColor": "#dcdcd6",
    "signalColor": "#4a4a4a",
    "signalTextColor": "#1c1c1c",
    "labelBoxBkgColor": "#ffffff",
    "labelBoxBorderColor": "#dcdcd6",
    "labelTextColor": "#1c1c1c",
    "loopTextColor": "#1c1c1c",
    "noteBkgColor": "#ffffff",
    "noteBorderColor": "#a02c1e",
    "noteTextColor": "#1c1c1c",
    "activationBkgColor": "#ffffff",
    "activationBorderColor": "#8a8a8a",
    "sequenceNumberColor": "#ffffff",
}

CONFIG = {
    "startOnLoad": False,
    "theme": "base",
    "securityLevel": "loose",
    "themeVariables": THEME,
    "flowchart": {"htmlLabels": False, "curve": "basis", "nodeSpacing": 20, "rankSpacing": 34, "padding": 8},
    "sequence": {"mirrorActors": False, "width": 120, "height": 44, "actorMargin": 22, "messageMargin": 28, "boxMargin": 8, "noteMargin": 8,
                 "diagramMarginX": 8, "diagramMarginY": 8, "useMaxWidth": True},
}

PAGE = """<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>body{font-family:Inter,sans-serif}</style></head><body><div id="out"></div>
<script type="module">
import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';
await document.fonts.load('13px Inter'); await document.fonts.ready;
mermaid.initialize(%(config)s);
const { svg } = await mermaid.render(%(id)s, %(src)s);
document.getElementById('out').innerHTML = svg;
document.title = 'RENDERED';
</script></body></html>"""


def trim(svg, source_name):
    # Round long decimals, but only numbers that stand alone between separators: compact path syntax
    # (e.g. "l.256.255") must be left untouched or the path breaks.
    svg = re.sub(r"(?<=[\s,(\"'=:])(-?\d+\.\d{2,})(?=[\s,)\"';]|$)",
                 lambda m: ("%.1f" % float(m.group(1))).rstrip("0").rstrip("."), svg)
    svg = re.sub(r'<svg ([^>]*?) style="max-width: [^"]*"', r"<svg \1", svg, count=1)
    note = "<!-- Rendered from %s with scripts/render-mermaid.py (Mermaid 11). Edit the .mmd and re-render; do not hand-edit. -->\n" % source_name
    return note + svg


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("source")
    ap.add_argument("output")
    ap.add_argument("--id", default="mermaid-fig", help="svg id; must be unique per page")
    ap.add_argument("--chrome", default=CHROME)
    args = ap.parse_args()

    src = open(args.source, encoding="utf-8").read()
    with tempfile.TemporaryDirectory() as tmp:
        page = os.path.join(tmp, "render.html")
        with open(page, "w", encoding="utf-8") as f:
            f.write(PAGE % {"config": json.dumps(CONFIG), "id": json.dumps(args.id), "src": json.dumps(src)})
        out = subprocess.run(
            [args.chrome, "--headless=new", "--disable-gpu", "--no-first-run", "--virtual-time-budget=15000",
             "--dump-dom", "file://" + page],
            capture_output=True, text=True, check=True,
        ).stdout
    if "<title>RENDERED" not in out:
        sys.exit("mermaid did not finish rendering; check the source for syntax errors")
    m = re.search(r'<svg[^>]*id="%s"[\s\S]*?</svg>' % re.escape(args.id), out)
    if not m:
        sys.exit("no svg found in rendered page")
    svg = trim(m.group(0), os.path.basename(args.source))
    with open(args.output, "w", encoding="utf-8") as f:
        f.write(svg)
    vb = re.search(r'viewBox="([^"]*)"', svg)
    print("wrote %s (%d bytes, viewBox %s)" % (args.output, len(svg), vb.group(1) if vb else "?"))


if __name__ == "__main__":
    main()
