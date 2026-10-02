"""
Add-on configuration: tools/addons.py.

    python3 -m unittest discover -s tests -p 'test_*.py'

Standard library only. Covers the checks that stop a bad assets/data/addons.json
at build time: shape, prices, rules, the payment-integration gate, and the
compliance guard that keeps add-ons to shipping, documentation and packaging.
"""
from __future__ import annotations

import copy
import json
import pathlib
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
import addons  # noqa: E402

DATA = json.loads((ROOT / "assets/data/products.json").read_text(encoding="utf-8"))
PRODUCTS, CATEGORIES = DATA["products"], DATA["categories"]
FIXTURE = addons.load(ROOT / "tests/fixtures/addons.json")


def good_addon(**over):
    a = {"id": "insulated-shipper", "name": "Insulated shipper", "description": "An insulated box.",
         "kind": "shipping", "quantity": "per-line", "price": 12, "trackInventory": True, "enabled": True}
    a.update(over)
    return a


def config(*items, rules=None):
    return {"addons": list(items),
            "rules": rules if rules is not None else
            [{"id": "r-all", "recommend": [items[0]["id"]] if items else ["x"], "when": {"allBuyable": True}}]}


def errors(cfg, ready=True):
    return addons.validate(cfg, PRODUCTS, CATEGORIES, ready=ready)


class ShippedConfig(unittest.TestCase):
    def test_the_shipped_file_is_valid(self):
        self.assertEqual(errors(addons.load(), ready=addons.PAYMENT_INTEGRATION_READY), [])

    def test_every_shipped_example_is_disabled_and_unpriced(self):
        for a in addons.load()["addons"]:
            self.assertIs(a["enabled"], False, a["id"])
            self.assertIsNone(a["price"], a["id"])

    def test_payment_integration_is_not_ready_yet(self):
        self.assertIs(addons.PAYMENT_INTEGRATION_READY, False)

    def test_fixture_is_valid_once_ready(self):
        self.assertEqual(errors(FIXTURE, ready=True), [])


class Gate(unittest.TestCase):
    def test_enabled_addons_are_refused_until_payment_integration_is_ready(self):
        errs = errors(FIXTURE, ready=False)
        self.assertEqual(len(errs), 1)
        self.assertIn("PAYMENT_INTEGRATION_READY", errs[0])

    def test_disabled_addons_are_fine_before_then(self):
        cfg = copy.deepcopy(FIXTURE)
        for a in cfg["addons"]:
            a["enabled"] = False
        self.assertEqual(errors(cfg, ready=False), [])


class Shape(unittest.TestCase):
    def assertRefused(self, cfg, fragment):
        errs = errors(cfg)
        self.assertTrue(any(fragment in e for e in errs), f"expected {fragment!r} in {errs}")

    def test_kind_and_quantity(self):
        self.assertRefused(config(good_addon(kind="accessory")), "kind must be")
        self.assertRefused(config(good_addon(quantity="per-order")), "quantity must be")

    def test_price(self):
        self.assertRefused(config(good_addon(price=None)), "needs a price")
        self.assertRefused(config(good_addon(price=0)), "needs a price")
        self.assertRefused(config(good_addon(price=-3)), "needs a price")
        self.assertRefused(config(good_addon(price="12")), "needs a price")
        self.assertRefused(config(good_addon(price=True)), "needs a price")
        self.assertRefused(config(good_addon(price=5000)), "needs a price")
        self.assertRefused(config(good_addon(price=1.005)), "two decimal places")
        self.assertEqual(errors(config(good_addon(price=4.5))), [])

    def test_ids(self):
        self.assertRefused(config(good_addon(id="Bad Id")), "lower-case")
        self.assertRefused(config(good_addon(), good_addon()), "duplicate id")
        self.assertRefused(config(good_addon(id="bpc-157")), "catalogue product id")

    def test_required_text_and_flags(self):
        self.assertRefused(config(good_addon(name="")), "name is required")
        self.assertRefused(config(good_addon(description=None)), "description is required")
        self.assertRefused(config(good_addon(enabled="yes")), "enabled must be")
        self.assertRefused(config(good_addon(trackInventory=1)), "trackInventory must be")

    def test_rules(self):
        a = good_addon()
        self.assertRefused(config(a, rules=[{"id": "r", "recommend": ["nope"], "when": {"allBuyable": True}}]), "unknown add-on")
        self.assertRefused(config(a, rules=[{"id": "r", "recommend": [a["id"]], "when": {"products": ["nope"]}}]), "unknown product")
        self.assertRefused(config(a, rules=[{"id": "r", "recommend": [a["id"]], "when": {"categories": ["nope"]}}]), "unknown category")
        self.assertRefused(config(a, rules=[{"id": "r", "recommend": [a["id"]], "when": {}}]), "matches nothing")
        self.assertRefused(config(a, rules=[{"id": "r", "recommend": [a["id"]], "when": {"minSpend": 5}}]), "unknown condition")
        self.assertRefused(config(a, rules=[{"id": "r", "recommend": [], "when": {"allBuyable": True}}]), "at least one")
        self.assertRefused(config(a, rules=[{"id": "r", "recommend": [a["id"]], "when": {"allBuyable": True}},
                                            {"id": "r", "recommend": [a["id"]], "when": {"allBuyable": True}}]), "duplicate id")


class ComplianceGuard(unittest.TestCase):
    """Nothing that prepares, measures or administers material, and no claims."""
    REFUSED = [
        ("bac-water", "Bacteriostatic water", "10 ml vial."),
        ("diluent-pack", "Diluent pack", "Sterile water to go with each vial."),
        ("syringe-pack", "Insulin syringes", "Ten 1 ml syringes."),
        ("needle-set", "Needle set", "29G needles."),
        ("swab-pack", "Alcohol prep pads", "Box of 100 swabs."),
        ("recon-kit", "Reconstitution kit", "Everything you need."),
        ("dosing-guide", "Dosing chart", "Printed guide."),
        ("cycle-planner", "Cycle planner", "Plan your stack."),
        ("lean-bundle", "Weight-loss starter bundle", "Pairs with tirzepatide."),
        ("recovery-kit", "Recovery add-on", "Supports healing."),
        ("nasal-kit", "Nasal spray bottle", "For selank."),
        ("pen-kit", "Pen cartridge", "Refill."),
        ("plain-name", "Storage box", "Ideal for personal use."),
    ]

    def test_refused(self):
        for aid, name, desc in self.REFUSED:
            errs = errors(config(good_addon(id=aid, name=name, description=desc)))
            self.assertTrue(any("not allowed as an add-on" in e for e in errs), f"{name!r} was accepted")

    def test_ordinary_services_pass(self):
        for aid, name, desc, kind in [
            ("insulated-shipper", "Insulated shipper with cold packs", "Frozen gel packs in an insulated box.", "shipping"),
            ("signature-courier", "Signature-on-delivery courier upgrade", "Delivered against a signature.", "shipping"),
            ("coa-certified-copy", "Additional certified copy of the COA", "A second signed paper copy.", "documentation"),
            ("lot-letter", "Lot traceability letter", "Lot number and release date on letterhead.", "documentation"),
            ("moisture-barrier-pouch", "Moisture-barrier pouch with desiccant", "Each vial in a foil pouch.", "packaging"),
            ("tamper-evident-seal", "Tamper-evident outer seal", "A numbered seal on the outer carton.", "packaging"),
        ]:
            self.assertEqual(errors(config(good_addon(id=aid, name=name, description=desc, kind=kind))), [], name)


class Eligibility(unittest.TestCase):
    def test_resolution(self):
        e = addons.eligibility(FIXTURE, PRODUCTS)
        self.assertEqual([o["addon"] for o in e["bpc-157"]], ["moisture-barrier-pouch", "coa-certified-copy"])
        self.assertEqual(e["bpc-157"][1]["rule"], "coa-copy-everything")
        self.assertNotIn("tamper-evident-seal", json.dumps(e))

    def test_products_not_sold_online_get_nothing(self):
        products = copy.deepcopy(PRODUCTS)
        for p in products:
            if p["id"] == "semax":
                p["cart"] = False
            if p["id"] == "selank":
                p["available"] = False
        e = addons.eligibility(FIXTURE, products)
        self.assertNotIn("semax", e)
        self.assertNotIn("selank", e)

    def test_tables_hide_addons_until_ready_unless_previewing(self):
        _, browser = addons.tables(FIXTURE, PRODUCTS, "USD", ready=False)
        self.assertIs(browser["show"], False)
        _, browser = addons.tables(FIXTURE, PRODUCTS, "USD", ready=False, preview=True)
        self.assertIs(browser["show"], True)
        self.assertIs(browser["preview"], True)
        server, _ = addons.tables(FIXTURE, PRODUCTS, "USD", ready=True)
        self.assertEqual(server["addons"]["coa-certified-copy"]["price"], 4.5)
        self.assertNotIn("tamper-evident-seal", server["addons"])


if __name__ == "__main__":
    unittest.main()
