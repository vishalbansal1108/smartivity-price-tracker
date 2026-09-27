"""Common interface every platform adapter implements.

To add a platform:
  1. add a section for it in config/platforms.yaml
  2. create tracker/adapters/<key>.py with a class that extends Adapter
     and implements fetch()
  3. register it in tracker/adapters/__init__.py
"""
from __future__ import annotations

import traceback

from bs4 import BeautifulSoup

from ..http import Blocked, NotFound, PoliteSession
from ..models import BLOCKED, ERROR, NO_ID, NOT_FOUND, PriceResult, Sku


class Adapter:
    key = ""  # platform key, must match config/platforms.yaml

    def __init__(self, cfg: dict, defaults: dict):
        self.cfg = cfg
        self.name = cfg.get("name", self.key)
        self.http = PoliteSession(cfg, defaults)

    # --- to implement -----------------------------------------------------
    def fetch(self, platform_id: str, pincode: str | None, result: PriceResult) -> PriceResult:
        """Fill `result` with price data for one product. May raise Blocked/NotFound."""
        raise NotImplementedError

    def discover_id(self, sku: Sku) -> tuple[str, str] | None:
        """Optional: find (platform_id, listing_title) by searching the product name."""
        return None

    # --- shared -----------------------------------------------------------
    def run_one(self, sku: Sku, pincode: str | None = None) -> PriceResult:
        """Never raises: always returns a PriceResult with a status."""
        pid = (sku.ids.get(self.key) or "").strip()
        result = PriceResult(sku=sku.sku, product_name=sku.name, platform=self.key,
                             platform_id=pid, pincode=pincode or "")
        try:
            if not pid and self.cfg.get("search_if_missing"):
                found = self.discover_id(sku)
                if not found:
                    result.status, result.error = NOT_FOUND, "Not found by name search"
                    return result.finish()
                pid, result.listing_title = found
                result.platform_id, result.id_discovered = pid, True
            if not pid:
                result.status, result.error = NO_ID, "No ID in sheet"
                return result.finish()
            result.url = self.cfg["product_url"].format(id=pid)
            self.fetch(pid, pincode, result)
        except Blocked as e:
            result.status, result.error = BLOCKED, str(e)
        except NotFound as e:
            result.status, result.error = NOT_FOUND, str(e)
        except Exception as e:  # noqa: BLE001 - a broken adapter must not stop the run
            result.status = ERROR
            result.error = f"{type(e).__name__}: {e}"
            tb = traceback.format_exc(limit=2).strip().splitlines()
            if tb:
                result.error += f" | {tb[-1]}"
        return result.finish()

    # helpers for subclasses
    @staticmethod
    def soup(html: str) -> BeautifulSoup:
        return BeautifulSoup(html, "lxml")

    def select_text(self, soup: BeautifulSoup, field: str) -> str | None:
        for sel in self.cfg.get("selectors", {}).get(field, []):
            el = soup.select_one(sel)
            if el:
                text = el.get_text(" ", strip=True)
                if text:
                    return text
        return None

    def exists(self, soup: BeautifulSoup, field: str) -> bool:
        return any(soup.select_one(s) for s in self.cfg.get("selectors", {}).get(field, []))
