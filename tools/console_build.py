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

The console is one screen, not a set of modules: the business overview
(index.html) shows sales, orders, customers, stock, what needs attention and
what happened recently, from the read API. An order opens on its own page
(order.html), read-only, because it holds more than a line of the overview
can. There is deliberately no navigation of screens beyond that.

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

# The navigation: the overview only. An order's page is reached from it.
NAV = [{"key": "overview", "label": "Business overview", "page": "index.html"}]

SCRIPTS = ["auth.js", "api.js", "ui.js", "shell.js"]


def nav(active: str) -> str:
    items = []
    for n in NAV:
        current = ' aria-current="page"' if active == n["key"] else ""
        items.append(f'<li><a class="console-nav-link" href="{E(n["page"])}"{current}>{E(n["label"])}</a></li>')
    return "\n    ".join(items)


def document(path: str, title: str, active: str, body: str, page_scripts=(), page: str = "",
             wide: bool = False) -> str:
    """One console page. `path` is relative to the repository root (console/...).

    `page_scripts` load after the four core scripts, in order; `page` is the
    body's data-console-page (it defaults to `active`); `wide` lets the main
    column use the whole screen."""
    up = "../" * path.count("/")
    scripts = "\n".join(f'<script src="{up}assets/js/console/{s}" defer></script>'
                        for s in SCRIPTS + list(page_scripts))
    main_class = "console-main console-main--wide" if wide else "console-main"
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
<body class="console" data-console-page="{E(page or active)}">
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
  <main class="{main_class}" id="main" tabindex="-1">
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


COMMAND_SCRIPTS = ["format.js", "page.js", "csv.js", "command.js"]


# Every order as a CSV (assets/js/console/csv.js): next to the orders, not in a menu.
CSV_BUTTON = """
          <button type="button" class="btn btn--ghost btn--sm" id="cc-csv">Download CSV</button>"""


def section(key: str, title: str, extra: str = "", cls: str = "") -> str:
    """One part of the overview: a heading and a view the script fills."""
    return f"""      <section class="cc-section{(' ' + cls) if cls else ''}" id="cc-{key}" aria-labelledby="cc-{key}-title">
        <div class="cc-section-head">
          <h2 class="cc-section-title" id="cc-{key}-title">{E(title)}</h2>{extra}
        </div>
        <div class="console-view cc-body" id="cc-{key}-body"></div>
      </section>"""


def command() -> str:
    """The business overview: the console's one screen."""
    body = f"""    <div class="cc-head">
      <h1 class="console-title">Business overview</h1>
      <div class="cc-head-meta">
        <p class="cc-updated" id="cc-updated" aria-live="polite"></p>
        <button type="button" class="btn btn--ghost btn--sm" id="cc-refresh" hidden>Refresh</button>
      </div>
    </div>
    <div class="console-view cc-notice" id="cc-notice" data-state="loading" aria-busy="true">
      <p class="console-state-text">Loading&hellip;</p>
    </div>
    <div class="cc-workspace" id="cc-workspace" hidden>
      <section class="cc-snapshot" id="cc-snapshot" aria-labelledby="cc-snapshot-title">
        <h2 class="sr-only" id="cc-snapshot-title">At a glance</h2>
        <div class="cc-snapshot-groups" id="cc-snapshot-body"></div>
      </section>
{section("stages", "Order stages", cls="cc-section--stages")}
      <div class="cc-row">
{section("attention", "Needs attention", cls="cc-section--attention")}
{section("recent", "Recent orders", cls="cc-section--recent", extra=CSV_BUTTON)}
        <div class="cc-stack">
{section("activity", "Recent activity")}
{section("stock", "Low stock")}
        </div>
      </div>
    </div>"""
    return document("console/index.html", "Business overview", "overview", body,
                    page_scripts=COMMAND_SCRIPTS, page="command", wide=True)


ORDER_SCRIPTS = ["format.js", "page.js", "order.js"]


def order() -> str:
    """One order, read-only: console/order.html?id=<uuid>."""
    body = """    <div class="cc-head">
      <div class="od-head-title">
        <a class="od-back" href="index.html">&larr; Business overview</a>
        <h1 class="console-title" id="od-title">Order</h1>
      </div>
      <div class="cc-head-meta">
        <p class="cc-updated" id="od-updated" aria-live="polite"></p>
        <button type="button" class="btn btn--ghost btn--sm" id="od-refresh" hidden>Refresh</button>
      </div>
    </div>
    <div class="console-view cc-notice" id="od-notice" data-state="loading" aria-busy="true">
      <p class="console-state-text">Loading&hellip;</p>
    </div>
    <div class="od-workspace" id="od-workspace" hidden></div>"""
    return document("console/order.html", "Order", "order", body, page_scripts=ORDER_SCRIPTS, wide=True)


def all_pages() -> dict[str, str]:
    """Every console page, by path relative to the root."""
    return {"console/index.html": command(), "console/order.html": order()}


def build_console() -> list[str]:
    """Writes every console page; returns their paths, relative to the root."""
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)
    pages = all_pages()
    for rel_path, text in pages.items():
        (ROOT / rel_path).write_text(text, encoding="utf-8")
    return list(pages)
