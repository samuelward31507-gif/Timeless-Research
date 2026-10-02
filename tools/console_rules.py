"""What every operations-console page must and must not contain.

Used by tools/check.py for every page under console/, and by
tests/test_console_rules.py. The storefront's own page rules (research-use
wording, the support assistant, the compliance notice) do not apply to the
console; these do, because the console is private and runs under a strict
Content-Security-Policy (netlify.toml, /console/*):

  - noindex,nofollow, and nothing that would advertise the page (canonical,
    Open Graph);
  - no inline <script>, no inline event handler, no <style> and no style=
    attribute: the CSP refuses all of them, so they would only be dead code;
  - none of the storefront's scripts or chrome: the cart, the assistant, the
    entry gate;
  - no link out to the storefront: every link stays inside console/ or is an
    asset;
  - the console's own scripts, in their order.
"""
from __future__ import annotations

import re

ROBOTS = '<meta name="robots" content="noindex,nofollow">'
STOREFRONT_SCRIPTS = ("site.js", "chat.js", "config.js", "catalog.js", "contact.js")
CONSOLE_SCRIPTS = ("auth.js", "api.js", "ui.js", "shell.js")

INLINE_SCRIPT = re.compile(r"<script\b(?![^>]*\bsrc=)[^>]*>", re.I)
SCRIPT_SRC = re.compile(r'<script\b[^>]*\bsrc="([^"]+)"', re.I)
EVENT_ATTR = re.compile(r"<[a-z][^>]*\son[a-z]+\s*=", re.I)
STYLE_ATTR = re.compile(r"<[a-z][^>]*\sstyle\s*=", re.I)
HREF = re.compile(r'\bhref="([^"]+)"', re.I)


def check(rel: str, txt: str) -> list[str]:
    """Failures for one console page; rel is its path from the root."""
    out = []
    if ROBOTS not in txt:
        out.append(f"{rel}: console page is not noindex,nofollow")
    if 'rel="canonical"' in txt or 'property="og:' in txt:
        out.append(f"{rel}: console page advertises itself (canonical or Open Graph)")
    if INLINE_SCRIPT.search(txt):
        out.append(f"{rel}: inline <script> (the console CSP refuses it)")
    if EVENT_ATTR.search(txt):
        out.append(f"{rel}: inline event handler attribute (the console CSP refuses it)")
    if "<style" in txt.lower() or STYLE_ATTR.search(txt):
        out.append(f"{rel}: inline style (the console CSP refuses it)")

    sources = SCRIPT_SRC.findall(txt)
    names = [s.split("?")[0].rsplit("/", 1)[-1] for s in sources]
    for s, name in zip(sources, names):
        if name in STOREFRONT_SCRIPTS:
            out.append(f"{rel}: loads the storefront script {name}")
        elif "assets/js/console/" not in s:
            out.append(f"{rel}: loads a script from outside assets/js/console/: {s}")
    if [n for n in names if n in CONSOLE_SCRIPTS] != list(CONSOLE_SCRIPTS):
        out.append(f"{rel}: does not load the console scripts in order ({', '.join(CONSOLE_SCRIPTS)})")
    if 'id="gate"' in txt or 'id="chat-drawer"' in txt or 'id="cart"' in txt:
        out.append(f"{rel}: carries storefront chrome (gate, cart or assistant)")

    up = "../" * rel.count("/")
    for ref in HREF.findall(txt):
        if ref.startswith("#"):
            continue
        if ref.startswith(("http://", "https://", "//", "mailto:", "tel:", "javascript:", "data:")):
            out.append(f"{rel}: link leaves the console: {ref}")
            continue
        if ref.startswith(up + "assets/"):
            continue
        if ref.startswith("/") or (up and ref.startswith(up)):
            out.append(f"{rel}: link leaves the console: {ref}")
    return out
