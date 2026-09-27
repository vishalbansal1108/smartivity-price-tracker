"""Quick check: fetch ONE SKU on every platform and print what was found.

    python test_platforms.py                 # first suitable SKU per platform
    python test_platforms.py SMRT1245        # use this SKU everywhere

Nothing is written to the Google Sheet. Uses the sheet's SKU list if
SHEET_WEBAPP_URL / SHEET_TOKEN are set, otherwise config/skus_local.csv.
"""
import sys

from tracker import sheet
from tracker.adapters import REGISTRY
from tracker.run import load_config


def main():
    config = load_config()
    defaults, platforms = config["defaults"], config["platforms"]
    skus = sheet.load_skus(platforms)
    wanted = sys.argv[1] if len(sys.argv) > 1 else None
    failures = 0
    for key, cfg in platforms.items():
        if not cfg.get("enabled", True) or key not in REGISTRY:
            continue
        pool = [s for s in skus if (not wanted or s.sku == wanted)]
        can_search = cfg.get("search_if_missing") or hasattr(REGISTRY[key], "run_all")
        sku = next((s for s in pool if key in s.ids), None) or (pool[0] if can_search and pool else None)
        print(f"\n=== {cfg['name']} ===")
        if not sku:
            print("  no SKU with an ID for this platform - skipped")
            continue
        pin = defaults.get("pincodes", [None])[-1] if cfg.get("per_pincode") else None
        adapter = REGISTRY[key](cfg, defaults)
        if hasattr(adapter, "run_all"):         # catalogue platforms fetch their whole listing
            got = adapter.run_all([sku], [pin], log=lambda m: print(m))
            if not got:
                print("  listing could not be read - see message above")
                failures += 1
                continue
            r = got[0]
        else:
            r = adapter.run_one(sku, pin)
        for label, value in [("SKU", f"{r.sku} - {r.product_name}"), ("Platform ID", r.platform_id + (" (found by search)" if r.id_discovered else "")),
                             ("Pincode", r.pincode), ("URL", r.url), ("Listing", r.listing_title[:90]),
                             ("Price", r.price), ("MRP", r.mrp), ("Discount %", r.discount_pct),
                             ("In stock", r.in_stock), ("Seller", r.seller), ("STATUS", r.status), ("Error", r.error)]:
            if value not in (None, ""):
                print(f"  {label:<12} {value}")
        failures += r.status not in ("OK", "NOT_FOUND")
    print(f"\n{'All platforms responded.' if not failures else f'{failures} platform(s) failed - see above.'}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
