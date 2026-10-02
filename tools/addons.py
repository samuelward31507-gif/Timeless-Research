"""
Optional add-ons: the accessories and services a cart line can carry.

Configured in assets/data/addons.json, kept apart from products.json so the
operator can add, reprice or retire an add-on without touching the catalogue.
This module is the one place that reads that file. build.py uses it to write
the cart's copy and the server's copy; check.py uses it to refuse a bad file;
tests/test_addons_config.py tests it directly.

Three ideas carry the whole design:

  * Eligibility is resolved here, at build time, into a plain map of
    product id -> [{addon, rule}]. The cart and the server both read that map
    and neither re-implements the rules, so the two cannot disagree about what
    may be offered with what.

  * Add-ons are attached to a cart line, never to the order as a whole, and
    never change the line's own price, its volume tier or the free-shipping
    threshold. They are priced separately and recorded as their own lines.

  * Nothing in this file is about a payment processor. The server-side half,
    netlify/lib/addons.js, validates and prices a selection into neutral line
    objects that whichever payment integration is used turns into its own
    format. Until that integration exists, PAYMENT_INTEGRATION_READY is False:
    the cart shows no add-ons and check.py refuses an enabled one, so nobody
    can be shown a price that checkout would then silently drop.
"""
from __future__ import annotations

import json
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parent.parent
SOURCE = ROOT / "assets/data/addons.json"

# Flip to True in the same change that makes the payment integration accept,
# price and record add-ons. Not before: see the module docstring.
PAYMENT_INTEGRATION_READY = False

KINDS = ("shipping", "documentation", "packaging")
QUANTITY_MODES = ("per-line", "per-unit")
ID_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
MAX_PRICE = 1000

# Words that have no place in an add-on's id, name or description. An add-on is
# a shipping, documentation or packaging service, or a legitimate accessory;
# nothing that prepares, measures or administers the material, and nothing that
# claims an effect. Matched as whole words, case-insensitively. This is a guard
# against a data edit, not a substitute for judgement.
FORBIDDEN_TERMS = [
    # diluents and preparation
    r"bac(teriostatic)?", r"sterile water", r"water", r"saline", r"diluents?",
    r"solvents?", r"reconstitut\w*", r"mix(ing)? kit", r"dissolv\w*",
    # administration and measuring
    r"syringes?", r"needles?", r"pins?", r"insulin", r"alcohol (prep )?(pads?|swabs?)",
    r"swabs?", r"inject\w*", r"injectables?", r"auto-?injectors?", r"pens?",
    r"cartridges?", r"nasal", r"spray", r"capsules?", r"tablets?", r"oral",
    r"sharps", r"tourniquets?", r"lancets?",
    # dosing and use
    r"dos(e|es|ing|age)", r"cycles?", r"stacks?", r"protocols?", r"regimens?",
    r"administ\w*", r"human use", r"personal use", r"self-?use",
    # effects and claims
    r"weight[- ]?loss", r"fat[- ]?loss", r"slimming", r"appetite", r"muscle",
    r"bodybuild\w*", r"performance", r"recovery", r"heal\w*", r"therap\w*",
    r"treat(s|ment|ing)?", r"cures?", r"anti-?ag(e|ing|eing)", r"libido",
    r"tanning", r"wellness", r"health", r"medical", r"clinical", r"patients?",
]
_FORBIDDEN = re.compile(r"\b(" + "|".join(FORBIDDEN_TERMS) + r")\b", re.I)


def load(path: pathlib.Path | None = None) -> dict:
    p = pathlib.Path(path) if path else SOURCE
    return json.loads(p.read_text(encoding="utf-8"))


def forbidden_terms(text: str) -> list[str]:
    return sorted({m.group(0).lower() for m in _FORBIDDEN.finditer(text or "")})


def _buyable(p: dict) -> bool:
    return bool(p.get("available", True)) and p.get("cart", True) is not False


def validate(config: dict, products: list[dict], categories: list[dict],
             ready: bool = PAYMENT_INTEGRATION_READY) -> list[str]:
    """Every problem with the configuration, as sentences. Empty means usable."""
    errors: list[str] = []
    if not isinstance(config, dict):
        return ["addons.json must be an object with \"addons\" and \"rules\""]
    addons = config.get("addons")
    rules = config.get("rules")
    if not isinstance(addons, list):
        errors.append("addons.json: \"addons\" must be a list")
        addons = []
    if not isinstance(rules, list):
        errors.append("addons.json: \"rules\" must be a list")
        rules = []

    product_ids = {p["id"] for p in products}
    category_ids = {c["id"] for c in categories}
    seen: set[str] = set()
    enabled_ids: set[str] = set()

    for i, a in enumerate(addons):
        where = f"add-on #{i + 1}"
        if not isinstance(a, dict):
            errors.append(f"{where} must be an object")
            continue
        aid = a.get("id")
        if not isinstance(aid, str) or not ID_RE.match(aid):
            errors.append(f"{where}: id must be lower-case words joined by hyphens")
            continue
        where = f"add-on {aid}"
        if aid in seen:
            errors.append(f"{where}: duplicate id")
        seen.add(aid)
        if aid in product_ids:
            errors.append(f"{where}: id is already a catalogue product id")
        for field in ("name", "description"):
            if not isinstance(a.get(field), str) or not a[field].strip():
                errors.append(f"{where}: {field} is required")
        if a.get("kind") not in KINDS:
            errors.append(f"{where}: kind must be one of {', '.join(KINDS)}")
        if a.get("quantity") not in QUANTITY_MODES:
            errors.append(f"{where}: quantity must be one of {', '.join(QUANTITY_MODES)}")
        if not isinstance(a.get("enabled"), bool):
            errors.append(f"{where}: enabled must be true or false")
        if not isinstance(a.get("trackInventory"), bool):
            errors.append(f"{where}: trackInventory must be true or false")
        price = a.get("price")
        if a.get("enabled") is True:
            enabled_ids.add(aid)
            if (isinstance(price, bool) or not isinstance(price, (int, float))
                    or not (0 < price <= MAX_PRICE)):
                errors.append(f"{where}: an enabled add-on needs a price above 0 and at most {MAX_PRICE}")
            elif round(price * 100) != price * 100:
                errors.append(f"{where}: price has more than two decimal places")
        elif price is not None and (isinstance(price, bool) or not isinstance(price, (int, float)) or price <= 0):
            errors.append(f"{where}: price must be a positive number or null")
        text = " ".join(str(a.get(k, "")) for k in ("id", "name", "description"))
        bad = forbidden_terms(text.replace("-", " "))
        if bad:
            errors.append(f"{where}: not allowed as an add-on (mentions {', '.join(bad)}). "
                          "Add-ons are shipping, documentation or packaging services only")

    rule_ids: set[str] = set()
    for i, r in enumerate(rules):
        where = f"rule #{i + 1}"
        if not isinstance(r, dict):
            errors.append(f"{where} must be an object")
            continue
        rid = r.get("id")
        if not isinstance(rid, str) or not ID_RE.match(rid):
            errors.append(f"{where}: id must be lower-case words joined by hyphens")
            continue
        where = f"rule {rid}"
        if rid in rule_ids:
            errors.append(f"{where}: duplicate id")
        rule_ids.add(rid)
        rec = r.get("recommend")
        if not isinstance(rec, list) or not rec:
            errors.append(f"{where}: recommend must list at least one add-on id")
        else:
            for aid in rec:
                if aid not in seen:
                    errors.append(f"{where}: recommends unknown add-on {aid!r}")
        when = r.get("when")
        if not isinstance(when, dict):
            errors.append(f"{where}: when is required")
            continue
        unknown_keys = set(when) - {"products", "categories", "allBuyable"}
        if unknown_keys:
            errors.append(f"{where}: unknown condition {', '.join(sorted(unknown_keys))}")
        prods = when.get("products", [])
        cats = when.get("categories", [])
        everything = when.get("allBuyable", False)
        if not isinstance(prods, list) or not isinstance(cats, list) or not isinstance(everything, bool):
            errors.append(f"{where}: products and categories must be lists, allBuyable true or false")
            continue
        if not prods and not cats and not everything:
            errors.append(f"{where}: matches nothing; give products, categories or allBuyable")
        for pid in prods:
            if pid not in product_ids:
                errors.append(f"{where}: unknown product {pid!r}")
        for cid in cats:
            if cid not in category_ids:
                errors.append(f"{where}: unknown category {cid!r}")

    if enabled_ids and not ready:
        errors.append(
            "add-ons are enabled (" + ", ".join(sorted(enabled_ids)) + ") but the payment "
            "integration does not yet price or record them, so a customer would see an add-on "
            "that checkout drops. Keep them disabled until PAYMENT_INTEGRATION_READY is set in "
            "tools/addons.py.")
    return errors


def eligibility(config: dict, products: list[dict]) -> dict[str, list[dict]]:
    """product id -> [{"addon": id, "rule": id}] for enabled add-ons only.

    Each add-on appears once per product, credited to the first rule (in file
    order) that recommends it there, so reporting has one rule per sale.
    Products that cannot be bought online get nothing: an add-on is only ever
    attached to a line in the cart."""
    enabled = {a["id"] for a in config.get("addons", []) if a.get("enabled") is True}
    out: dict[str, list[dict]] = {}
    for p in products:
        if not _buyable(p):
            continue
        offered: list[dict] = []
        taken: set[str] = set()
        for r in config.get("rules", []):
            w = r.get("when", {})
            if not (w.get("allBuyable") or p["id"] in w.get("products", [])
                    or p.get("category") in w.get("categories", [])):
                continue
            for aid in r.get("recommend", []):
                if aid in enabled and aid not in taken:
                    taken.add(aid)
                    offered.append({"addon": aid, "rule": r["id"]})
        if offered:
            out[p["id"]] = offered
    return out


def tables(config: dict, products: list[dict], currency: str,
           ready: bool = PAYMENT_INTEGRATION_READY, preview: bool = False) -> tuple[dict, dict]:
    """(server table, browser table). Both carry enabled add-ons only.

    The server table is what netlify/lib/addons.js prices from. The browser
    table is what the cart shows; it is the same data, because the browser's
    copy only decides what the cart says and the server's decides the charge."""
    addons = {
        a["id"]: {
            "name": a["name"],
            "description": a["description"],
            "kind": a["kind"],
            "price": a["price"],
            "quantity": a["quantity"],
            "trackInventory": a["trackInventory"],
        }
        for a in config.get("addons", []) if a.get("enabled") is True
    }
    elig = eligibility(config, products)
    server = {"currency": currency, "paymentIntegrationReady": ready,
              "addons": addons, "eligibility": elig}
    browser = {"show": bool(ready or preview), "preview": bool(preview),
               "addons": addons, "eligibility": elig}
    return server, browser
