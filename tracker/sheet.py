"""Talks to the Google Sheet through its Apps Script web app (see apps_script/Code.gs).

Needs two environment variables (GitHub secrets when running in the cloud):
  SHEET_WEBAPP_URL  - the web app URL shown by "Price Tracker > Show connection details"
  SHEET_TOKEN       - the secret token shown in the same dialog
Without them, SKUs are read from config/skus_local.csv and nothing is uploaded.
"""
from __future__ import annotations

import csv
import os
from pathlib import Path

import requests

from .models import Sku, parse_money

ROOT = Path(__file__).resolve().parent.parent
LOCAL_CSV = ROOT / "config" / "skus_local.csv"


def sheet_configured() -> bool:
    return bool(os.environ.get("SHEET_WEBAPP_URL") and os.environ.get("SHEET_TOKEN"))


def _rows_to_skus(rows: list[dict], platforms: dict) -> list[Sku]:
    skus = []
    for row in rows:
        code = str(row.get("SKU", "")).strip()
        track = str(row.get("Track (Y/N)", "Y")).strip().upper()
        if not code or track == "N":
            continue
        ids = {}
        for key, pcfg in platforms.items():
            raw = str(row.get(pcfg.get("id_column", ""), "") or "").strip()
            if raw:
                ids[key] = raw.split(",")[0].strip()   # several IDs in one cell: use the first
        if not ids.get("amazon_in") and not ids.get("flipkart") and not str(row.get("Product Name", "")).strip():
            continue                                    # empty/junk row
        skus.append(Sku(sku=code, name=str(row.get("Product Name", "")).strip(),
                        mrp=parse_money(row.get("MRP (INR)")), ids=ids))
    return skus


def load_skus(platforms: dict) -> list[Sku]:
    if sheet_configured():
        data = _post({"action": "skus"}, timeout=60)
        return _rows_to_skus(data["rows"], platforms)
    with open(LOCAL_CSV, newline="", encoding="utf-8-sig") as f:
        return _rows_to_skus(list(csv.DictReader(f)), platforms)


def upload(payload: dict) -> dict:
    return _post(payload, timeout=300)


def _post(payload: dict, timeout: int) -> dict:
    # The token travels in the POST body, never in the URL.
    payload = dict(payload, token=os.environ["SHEET_TOKEN"])
    resp = requests.post(os.environ["SHEET_WEBAPP_URL"], json=payload, timeout=timeout)
    resp.raise_for_status()
    try:
        data = resp.json()
    except ValueError:
        raise RuntimeError(f"Sheet returned a non-JSON answer (is the web app deployed with access "
                           f"'Anyone'?): {resp.text[:300]}")
    if not data.get("ok"):
        raise RuntimeError(f"Sheet refused the request: {data.get('error')}")
    return data
