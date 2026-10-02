"""The operations console's pages: a private shell, separate from the storefront.

The storefront's page()/head() in build.py cannot be used here. Every page
they build carries the research-use entry gate (with its inline script), the
cart (site.js and config.js), the support assistant (chat.js), Open Graph tags
and, on a trading build, index,follow. None of that belongs in a console a
staff member signs in to, and the inline gate script would also break the
console's Content-Security-Policy (netlify.toml), which allows no inline script
or style at all.

So the console has its own document shell:

  - always noindex,nofollow, no canonical or Open Graph, never in sitemap.xml;
  - no storefront navigation, gate, cart or assistant, and no link out to the
    storefront;
  - only external scripts and stylesheets (no inline <script>, no style=);
  - the storefront's design tokens and base type (fonts.css, main.css), plus
    console.css for the shell.

This pass builds the foundation only: the shell and its overview page. The ten
business screens are listed in the navigation as not built yet; each becomes a
page here, with its own entry in AREAS, when it is built. The navigation is
rendered here, statically, so it is complete without JavaScript.

tools/check.py validates every page under console/ with tools/console_rules.py.
"""
from __future__ import annotations

import html
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "console"
BRAND = "Timeless Research"

E = html.escape

# Every documented console area (README, "Operations console: read API" and
# "write API"), in the order the navigation shows them. `permission` is the
# read permission its endpoint checks first; the server enforces it, and the
# navigation can only ever be a convenience. `page` is None until the screen
# is built.
AREAS = [
    {"key": "dashboard", "label": "Dashboard", "endpoint": "admin-dashboard", "permission": "orders.read", "page": None},
    {"key": "orders", "label": "Orders", "endpoint": "admin-orders", "permission": "orders.read", "page": None},
    {"key": "fulfilment", "label": "Fulfilment", "endpoint": "admin-orders", "permission": "orders.read", "page": None},
    {"key": "inventory", "label": "Inventory", "endpoint": "admin-inventory", "permission": "inventory.read", "page": None},
    {"key": "lots", "label": "Lots", "endpoint": "admin-inventory", "permission": "inventory.read", "page": None},
    {"key": "expenses", "label": "Expenses", "endpoint": "admin-expenses", "permission": "finance.read", "page": None},
    {"key": "import", "label": "CSV import", "endpoint": "admin-expenses", "permission": "finance.read", "page": None},
    {"key": "financials", "label": "Financials", "endpoint": "admin-financials", "permission": "finance.read", "page": None},
    {"key": "customers", "label": "Customers", "endpoint": "admin-customers", "permission": "customers.read", "page": None},
    {"key": "audit", "label": "Audit log", "endpoint": "admin-audit", "permission": "audit.read", "page": None},
]

SCRIPTS = ["auth.js", "api.js", "ui.js", "shell.js"]


def nav(active: str) -> str:
    items = ['<li><a class="console-nav-link" href="index.html"{}>Overview</a></li>'.format(
        ' aria-current="page"' if active == "overview" else "")]
    for a in AREAS:
        if a["page"]:
            current = ' aria-current="page"' if active == a["key"] else ""
            items.append(f'<li><a class="console-nav-link" href="{E(a["page"])}"{current} '
                         f'data-permission="{E(a["permission"])}">{E(a["label"])}</a></li>')
        else:
            items.append(f'<li><span class="console-nav-link is-pending" aria-disabled="true" '
                         f'data-area="{E(a["key"])}">{E(a["label"])}'
                         f'<span class="console-nav-tag">Not built yet</span></span></li>')
    return "\n    ".join(items)


def document(path: str, title: str, active: str, body: str) -> str:
    """One console page. `path` is relative to the repository root (console/...)."""
    up = "../" * path.count("/")
    scripts = "\n".join(f'<script src="{up}assets/js/console/{s}" defer></script>' for s in SCRIPTS)
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{E(title)} &middot; Operations &middot; {BRAND}</title>
<meta name="description" content="The {BRAND} operations console. Private: for staff only.">
<meta name="robots" content="noindex,nofollow">
<meta name="referrer" content="no-referrer">
<meta name="theme-color" content="#FAF9F7">
<link rel="icon" href="{up}assets/img/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="{up}assets/css/fonts.css">
<link rel="stylesheet" href="{up}assets/css/main.css">
<link rel="stylesheet" href="{up}assets/css/console.css">
{scripts}
</head>
<body class="console" data-console-page="{E(active)}">
<a class="skip-link" href="#main">Skip to content</a>
<header class="console-header">
  <a class="console-brand" href="index.html">{BRAND} <span class="console-brand-sub">Operations</span></a>
  <p class="console-session" id="console-session" aria-live="polite">Not signed in</p>
  <button type="button" class="console-menu-btn" id="console-menu-btn" aria-controls="console-nav" aria-expanded="false">Menu</button>
</header>
<div class="console-alert" id="console-alert" role="alert" hidden></div>
<div class="console-layout">
  <nav class="console-nav" id="console-nav" aria-label="Console">
    <ul class="console-nav-list">
    {nav(active)}
    </ul>
  </nav>
  <main class="console-main" id="main" tabindex="-1">
{body}
  </main>
</div>
<div class="console-toast" id="console-toast" role="status" aria-live="polite" hidden></div>
<dialog class="console-dialog" id="console-confirm" aria-labelledby="console-confirm-title" aria-describedby="console-confirm-body">
  <form method="dialog" class="console-dialog-form" id="console-confirm-form">
    <h2 class="console-dialog-title" id="console-confirm-title">Confirm</h2>
    <p class="console-dialog-body" id="console-confirm-body"></p>
    <div class="console-dialog-reason" id="console-confirm-reason-wrap" hidden>
      <label for="console-confirm-reason" id="console-confirm-reason-label">Reason</label>
      <textarea id="console-confirm-reason" rows="3" maxlength="1000"></textarea>
    </div>
    <div class="console-dialog-actions">
      <button type="button" class="btn btn--ghost btn--sm" id="console-confirm-cancel">Cancel</button>
      <button type="submit" class="btn btn--primary btn--sm" id="console-confirm-ok" value="confirm">Confirm</button>
    </div>
  </form>
</dialog>
</body>
</html>
"""


def overview() -> str:
    pending = "".join(f"<li>{E(a['label'])}</li>" for a in AREAS if not a["page"])
    body = f"""    <h1 class="console-title">Operations console</h1>
    <section class="console-panel" aria-labelledby="console-status-title">
      <h2 class="console-panel-title" id="console-status-title">Session</h2>
      <div class="console-view" id="console-status" data-state="loading" aria-busy="true">
        <p class="console-state-text">Checking for a session&hellip;</p>
      </div>
    </section>
    <section class="console-panel" aria-labelledby="console-areas-title">
      <h2 class="console-panel-title" id="console-areas-title">Screens</h2>
      <p class="console-note">The console&rsquo;s screens are built in a later phase. Each of these will appear in the
      navigation when it is ready:</p>
      <ul class="console-list">{pending}</ul>
    </section>"""
    return document("console/index.html", "Overview", "overview", body)


def build_console() -> list[str]:
    """Writes every console page; returns their paths, relative to the root."""
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)
    pages = {"console/index.html": overview()}
    for rel_path, text in pages.items():
        (ROOT / rel_path).write_text(text, encoding="utf-8")
    return list(pages)
