"""The operations console's page rules (tools/console_rules.py) and its build
and deployment wiring. Offline: reads files in the repository only.

    python3 -m unittest discover -s tests -p 'test_*.py'
"""
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))

import console_build  # noqa: E402
import console_rules  # noqa: E402

PAGE = "console/index.html"


def built():
    return (ROOT / PAGE).read_text(encoding="utf-8")


class ConsoleRules(unittest.TestCase):
    def test_the_built_page_passes(self):
        self.assertEqual(console_rules.check(PAGE, built()), [])

    def test_a_fresh_build_passes_too(self):
        self.assertEqual(console_rules.check(PAGE, console_build.command()), [])

    def assertRefused(self, txt, words):
        found = console_rules.check(PAGE, txt)
        self.assertTrue(any(words in f for f in found), f"expected {words!r} in {found}")

    def test_each_rule_catches_its_fault(self):
        ok = built()
        self.assertRefused(ok.replace(console_rules.ROBOTS, ""), "not noindex")
        self.assertRefused(ok.replace("</head>", '<link rel="canonical" href="x">\n</head>'), "advertises")
        self.assertRefused(ok.replace("</head>", '<meta property="og:title" content="x">\n</head>'), "advertises")
        self.assertRefused(ok.replace("</body>", "<script>alert(1)</script>\n</body>"), "inline <script>")
        self.assertRefused(ok.replace("<main ", '<main onclick="x()" '), "event handler")
        self.assertRefused(ok.replace("<main ", '<main style="color:red" '), "inline style")
        self.assertRefused(ok.replace("</head>", "<style>p{}</style>\n</head>"), "inline style")
        self.assertRefused(ok.replace("</head>", '<script src="../assets/js/site.js" defer></script>\n</head>'), "storefront script")
        self.assertRefused(ok.replace("</head>", '<script src="https://cdn.example/x.js" defer></script>\n</head>'), "outside assets/js/console/")
        self.assertRefused(re.sub(r'<script src="[^"]*shell\.js[^"]*" defer></script>', "", ok), "console scripts in order")
        self.assertRefused(ok.replace("</main>", '<div id="gate"></div></main>'), "storefront chrome")
        self.assertRefused(ok.replace("</main>", '<a href="../index.html">Shop</a></main>'), "leaves the console")
        self.assertRefused(ok.replace("</main>", '<a href="/catalog.html">Shop</a></main>'), "leaves the console")
        self.assertRefused(ok.replace("</main>", '<a href="https://example.org">x</a></main>'), "leaves the console")
        self.assertRefused(ok.replace("</main>", '<a href="javascript:void(0)">x</a></main>'), "leaves the console")


class ConsoleBuild(unittest.TestCase):
    def test_the_navigation_is_one_screen(self):
        self.assertEqual([n["key"] for n in console_build.NAV], ["overview"])
        page = built()
        self.assertEqual(len(re.findall(r'class="console-nav-link"', page)), 1)
        self.assertIn('href="index.html" aria-current="page">Business overview</a>', page)
        self.assertNotIn('aria-disabled="true"', page)

    def test_every_built_page_passes_and_loads_its_scripts_after_the_core(self):
        for rel in console_build.all_pages():
            txt = (ROOT / rel).read_text(encoding="utf-8")
            self.assertEqual(console_rules.check(rel, txt), [], rel)
            names = re.findall(r'assets/js/console/([a-z]+)\.js', txt)
            self.assertEqual(names[:4], ["auth", "api", "ui", "shell"], rel)
            self.assertTrue(len(names) > 4, f"{rel} loads no page script")

    def test_the_build_is_the_committed_pages(self):
        for rel, text in console_build.all_pages().items():
            # The committed copy is stamped with asset hashes; compare without them.
            committed = re.sub(r"\?v=[0-9a-f]+", "", (ROOT / rel).read_text(encoding="utf-8"))
            self.assertEqual(committed, text, rel)

    def test_check_lists_every_console_file_as_generated(self):
        check = (ROOT / "tools/check.py").read_text(encoding="utf-8")
        for rel in console_build.all_pages():
            self.assertIn(f'"{rel}"', check)
        for f in sorted((ROOT / "assets/js/console").glob("*.js")):
            self.assertIn(f'"assets/js/console/{f.name}"', check)

    def test_the_console_is_not_in_the_sitemap_and_is_disallowed_on_a_trading_build(self):
        self.assertNotIn("/console/", (ROOT / "sitemap.xml").read_text(encoding="utf-8"))
        self.assertIn("Disallow: /console/", (ROOT / "tools/build.py").read_text(encoding="utf-8"))

    def test_dist_publishes_the_console(self):
        self.assertIn('"console"', (ROOT / "tools/dist.py").read_text(encoding="utf-8"))

    def test_netlify_serves_the_console_privately(self):
        toml = (ROOT / "netlify.toml").read_text(encoding="utf-8")
        block = toml.split('for = "/console/*"', 1)[1].split("[[headers]]", 1)[0]
        self.assertIn('Cache-Control = "no-store"', block)
        self.assertIn("X-Robots-Tag = \"noindex, nofollow\"", block)
        for d in ("default-src 'none'", "script-src 'self'", "style-src 'self'", "connect-src 'self'", "frame-ancestors 'self'"):
            self.assertIn(d, block)
        self.assertNotIn("unsafe-", block)

    def test_browser_code_holds_no_credentials_or_storage(self):
        for f in sorted((ROOT / "assets/js/console").glob("*.js")):
            # Code only: the comments say where the token must never go.
            js = re.sub(r"//[^\n]*", "", re.sub(r"/\*.*?\*/", "", f.read_text(encoding="utf-8"), flags=re.S))
            for bad in ("localStorage.", "sessionStorage.", "document.cookie", ".innerHTML", ".outerHTML",
                        ".insertAdjacentHTML(", "document.write", "SUPABASE", "DATABASE_URL", "service_role",
                        "eval(", "new Function"):
                self.assertNotIn(bad, js, f"{f.name} mentions {bad}")

    def test_screens_log_nothing_and_never_name_the_payment_provider(self):
        for f in sorted((ROOT / "assets/js/console").glob("*.js")):
            if f.name in ("auth.js", "api.js", "ui.js", "shell.js"):
                continue
            js = f.read_text(encoding="utf-8")
            self.assertNotIn("console.", js, f"{f.name} logs")
            self.assertNotIn("fetch(", js, f"{f.name} fetches outside requestAdmin")
            self.assertNotRegex(js, r"(?i)stripe", f"{f.name} names the payment provider")


if __name__ == "__main__":
    unittest.main()
