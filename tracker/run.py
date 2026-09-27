"""Run one price check: every enabled platform x every tracked SKU.

    python -m tracker.run                  # full run, uploads to the Google Sheet
    python -m tracker.run --dry-run        # print results only, upload nothing
    python -m tracker.run --platforms flipkart --skus SMRT1245,SMRT1301
"""
from __future__ import annotations

import argparse
import os
import sys
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import yaml

from . import sheet
from .adapters import REGISTRY
from .models import NO_ID, PriceResult, Sku, now_ist

ROOT = Path(__file__).resolve().parent.parent
CONFIG = ROOT / "config" / "platforms.yaml"


def load_config() -> dict:
    with open(CONFIG, encoding="utf-8") as f:
        return yaml.safe_load(f)


def run_platform(key: str, cfg: dict, defaults: dict, skus: list[Sku]) -> list[PriceResult]:
    adapter = REGISTRY[key](cfg, defaults)
    pincodes = defaults.get("pincodes", []) if cfg.get("per_pincode") else [None]
    results = []
    for sku in skus:
        if key not in sku.ids and not cfg.get("search_if_missing"):
            continue                      # not listed on this platform
        for pin in pincodes:
            r = adapter.run_one(sku, pin)
            print(f"  [{cfg['name']}] {sku.sku} {pin or ''} -> {r.status} "
                  f"{r.price if r.price is not None else ''} {r.error[:80]}", flush=True)
            if r.status != NO_ID:
                results.append(r)
    return results


def print_table(results: list[PriceResult]):
    cols = [("SKU", 10), ("Platform", 10), ("Pin", 6), ("ID", 17), ("Price", 9), ("MRP", 8),
            ("Disc%", 5), ("Stock", 5), ("Status", 9), ("Seller / note", 40)]
    print("\n" + " ".join(n.ljust(w) for n, w in cols))
    print("-" * 125)
    for r in results:
        vals = [r.sku, r.platform, r.pincode, r.platform_id + ("*" if r.id_discovered else ""),
                f"{r.price:.2f}" if r.price is not None else "", f"{r.mrp:.0f}" if r.mrp else "",
                f"{r.discount_pct:.0f}" if r.discount_pct else "", r.in_stock, r.status,
                (r.error or r.seller)]
        print(" ".join(str(v)[:w].ljust(w) for v, (_, w) in zip(vals, cols)))
    if any(r.id_discovered for r in results):
        print("\n* = ID found by searching the product name (written to the SKUs tab for you to check)")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="don't upload to the sheet")
    ap.add_argument("--platforms", help="comma-separated platform keys to run (default: all enabled)")
    ap.add_argument("--skus", help="comma-separated SKU codes to run (default: all tracked)")
    args = ap.parse_args(argv)

    config = load_config()
    defaults, platforms = config["defaults"], config["platforms"]
    wanted = set(args.platforms.split(",")) if args.platforms else None
    active = {k: c for k, c in platforms.items()
              if c.get("enabled", True) and k in REGISTRY and (not wanted or k in wanted)}

    started, t0 = now_ist(), time.monotonic()
    skus = sheet.load_skus(platforms)
    if args.skus:
        keep = set(args.skus.split(","))
        skus = [s for s in skus if s.sku in keep]
    print(f"Run started {started} IST: {len(skus)} SKUs x {len(active)} platforms "
          f"({'sheet' if sheet.sheet_configured() else 'local CSV'})", flush=True)

    # One thread per platform: platforms run side by side, requests to the
    # same site stay one at a time with polite pauses.
    results: list[PriceResult] = []
    with ThreadPoolExecutor(max_workers=max(1, len(active))) as pool:
        futures = [pool.submit(run_platform, k, c, defaults, skus) for k, c in active.items()]
        for f in futures:
            results.extend(f.result())

    duration = round(time.monotonic() - t0, 1)
    stats = {}
    for k in active:
        mine = [r for r in results if r.platform == k]
        stats[k] = {s: sum(r.status == s for r in mine) for s in ("OK", "NOT_FOUND", "BLOCKED", "ERROR")}
        stats[k]["total"] = len(mine)

    print_table(results)
    print(f"\nFinished in {duration}s. " + "; ".join(
        f"{platforms[k]['name']}: {v['OK']}/{v['total']} OK" for k, v in stats.items()))

    payload = {
        "action": "results",
        "run": {"id": uuid.uuid4().hex[:8], "started": started, "finished": now_ist(),
                "duration_s": duration, "trigger": os.environ.get("RUN_TRIGGER", "manual"),
                "stats": stats},
        "platforms": [{"key": k, "name": c["name"], "reference": bool(c.get("reference")),
                       "id_column": c.get("id_column", ""),
                       "pincodes": defaults.get("pincodes", []) if c.get("per_pincode") else []}
                      for k, c in platforms.items() if c.get("enabled", True) and k in REGISTRY],
        "partial": bool(wanted or args.skus),
        "results": [r.to_dict() for r in results],
    }
    if args.dry_run or not sheet.sheet_configured():
        if not args.dry_run:
            print("\n(SHEET_WEBAPP_URL / SHEET_TOKEN not set - results were not uploaded)")
        return 0
    answer = sheet.upload(payload)
    print(f"Uploaded to sheet: {answer.get('message', 'ok')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
