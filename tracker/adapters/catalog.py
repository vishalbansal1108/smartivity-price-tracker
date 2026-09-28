"""Adapters for platforms where ONE search / brand listing returns all Smartivity
products with their prices (Myntra, FirstCry, Blinkit ...).

Instead of opening 159 product pages, the adapter fetches the listing once (per
pincode for quick commerce), then:
  * SKUs with an ID in the sheet  -> looked up in the listing by ID
  * SKUs without an ID            -> matched by product name (ID written back to
                                     the sheet in yellow for you to check)
  * no match anywhere             -> "none" written to the sheet, not searched again
"""
from __future__ import annotations

from dataclasses import dataclass

from .. import matching
from ..http import Blocked
from ..models import BLOCKED, ERROR, NOT_FOUND, NOT_LISTED, OK, PriceResult, Sku, now_ist
from .base import Adapter


@dataclass
class Listing:
    id: str
    title: str
    price: float | None
    mrp: float | None
    in_stock: bool | None
    url: str
    seller: str = ""


class CatalogAdapter(Adapter):
    not_found_text = "Not in the platform's Smartivity listing"

    def fetch_catalog(self, pincode: str | None) -> list[Listing]:
        raise NotImplementedError

    def run_all(self, skus: list[Sku], pincodes: list[str | None], log=print) -> list[PriceResult]:
        catalogs: dict[str | None, dict[str, Listing] | Exception] = {}
        for pin in pincodes:
            try:
                catalogs[pin] = {l.id: l for l in self.fetch_catalog(pin)}
                log(f"  [{self.name}] {pin or ''} listing: {len(catalogs[pin])} Smartivity products")
            except Exception as e:  # noqa: BLE001 - reported per SKU below
                catalogs[pin] = e
                log(f"  [{self.name}] {pin or ''} listing FAILED: {type(e).__name__}: {e}")

        # Name-match SKUs that have no ID, against everything seen at any pincode
        union = {}
        for cat in catalogs.values():
            if isinstance(cat, dict):
                union.update(cat)
        todo = {s.sku: s.name for s in skus if not s.ids.get(self.key)}
        found = matching.assign(todo, {i: l.title for i, l in union.items()},
                                float(self.cfg.get("search_min_match", 0.75)),
                                sku_mrp={s.sku: s.mrp for s in skus},
                                listing_mrp={i: l.mrp for i, l in union.items()}) if union else {}

        results = []
        failed = [c for c in catalogs.values() if isinstance(c, Exception)]
        if failed and len(failed) == len(catalogs):
            # Record the failure even when no SKU has an ID yet, so the Run Log and
            # the "platform needs attention" email see it. (Not shown on Latest.)
            e = failed[0]
            results.append(PriceResult(
                sku="(listing)", product_name=f"{self.name} Smartivity listing", platform=self.key,
                status=BLOCKED if isinstance(e, Blocked) else ERROR,
                error=f"{type(e).__name__}: {e}").finish())
        for sku in skus:
            pid = (sku.ids.get(self.key) or "").strip()
            if pid.lower() in NOT_LISTED:
                continue
            discovered = False
            if not pid:
                if sku.sku in found:
                    pid, discovered = found[sku.sku][0], True
                elif union:
                    # searched successfully, nothing matched: tell the sheet once
                    r = PriceResult(sku=sku.sku, product_name=sku.name, platform=self.key,
                                    status=NOT_FOUND, error="Not found by name search",
                                    id_search_failed=True, pincode=str(pincodes[0] or ""))
                    results.append(r.finish())
                    continue
                else:
                    continue    # listing failed everywhere and no ID: nothing to report per SKU
            for pin in pincodes:
                results.append(self._result(sku, pid, pin, catalogs[pin], discovered))
        return results

    def _result(self, sku: Sku, pid: str, pin, catalog, discovered: bool) -> PriceResult:
        r = PriceResult(sku=sku.sku, product_name=sku.name, platform=self.key, platform_id=pid,
                        pincode=str(pin or ""), id_discovered=discovered, timestamp=now_ist())
        r.url = self.cfg.get("product_url", "").format(id=pid) if self.cfg.get("product_url") else ""
        if isinstance(catalog, Blocked):
            r.status, r.error = BLOCKED, str(catalog)
        elif isinstance(catalog, Exception):
            r.status, r.error = ERROR, f"{type(catalog).__name__}: {catalog}"
        elif pid not in catalog:
            r.status, r.error = NOT_FOUND, self.not_found_text
        else:
            l = catalog[pid]
            r.status, r.listing_title, r.price, r.mrp = OK, l.title, l.price, l.mrp
            r.in_stock = "" if l.in_stock is None else ("Y" if l.in_stock else "N")
            r.url, r.seller = l.url or r.url, l.seller
        return r.finish()
