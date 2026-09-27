from __future__ import annotations

import json

from ..models import parse_money
from .catalog import CatalogAdapter, Listing


class FirstCry(CatalogAdapter):
    """FirstCry brand listing feed (the one its store page loads while you scroll)."""
    key = "firstcry"

    def fetch_catalog(self, pincode):
        listings, seen = [], set()
        for page in range(1, int(self.cfg.get("max_pages", 10)) + 1):
            raw = json.loads(self.http.get(self.cfg["listing_url"].format(page=page, brand_id=self.cfg["brand_id"])))
            data = json.loads(raw["ProductResponse"]) if isinstance(raw.get("ProductResponse"), str) else raw
            products = data.get("Products") or []
            new = 0
            for p in products:
                pid = str(p.get("PId"))
                if pid in seen:
                    continue
                seen.add(pid)
                new += 1
                mrp = parse_money(p.get("MRP"))
                price = parse_money(p.get("discprice")) or mrp
                listings.append(Listing(
                    id=pid, title=p.get("PNm", ""), price=price, mrp=mrp,
                    in_stock=(parse_money(p.get("CrntStock")) or 0) > 0,
                    url=self.cfg["product_url"].format(id=pid),
                ))
            if not products or new == 0:
                break
        if not listings:
            raise Exception("FirstCry returned no products for the brand - feed may have changed")
        return listings
