from __future__ import annotations

import json
import re

from ..models import parse_money
from .catalog import CatalogAdapter, Listing


class Myntra(CatalogAdapter):
    """Myntra brand page: the product list is embedded as JSON (window.__myx)."""
    key = "myntra"

    def fetch_catalog(self, pincode):
        listings, page = [], 1
        while page <= int(self.cfg.get("max_pages", 5)):
            html = self.http.get(self.cfg["listing_url"].format(page=page))
            m = re.search(self.cfg["patterns"]["data"], html, re.S)
            if not m:
                raise Exception("Product data (window.__myx) not found - page layout may have changed")
            results = json.loads(m.group(1)).get("searchData", {}).get("results", {})
            products = results.get("products") or []
            for p in products:
                if "smartivity" not in (p.get("brand") or "").lower():
                    continue
                inv = p.get("inventoryInfo") or []
                listings.append(Listing(
                    id=str(p["productId"]),
                    title=p.get("productName") or p.get("product") or "",
                    price=parse_money(p.get("price")), mrp=parse_money(p.get("mrp")),
                    in_stock=any(i.get("available") for i in inv) if inv else None,
                    url="https://www.myntra.com/" + (p.get("landingPageUrl") or str(p["productId"])),
                ))
            total = int(results.get("totalCount") or 0)
            if not products or page * len(products) >= total:
                break
            page += 1
        return listings
