from __future__ import annotations

import json
import re
from urllib.parse import quote_plus

from ..models import OK, PriceResult, Sku, parse_money
from .base import Adapter

STOPWORDS = {"the", "and", "n", "for", "of", "a", "kit", "smartivity", "with", "to", "in"}


def _words(text: str) -> set[str]:
    words = re.split(r"[^a-z0-9]+", text.lower())
    return {w[:-1] if len(w) > 3 and w.endswith("s") else w for w in words if w and w not in STOPWORDS}


def name_match_score(product_name: str, listing_text: str) -> float:
    wanted = _words(product_name)
    if not wanted:
        return 0.0
    return len(wanted & _words(listing_text)) / len(wanted)


def _block_fields(html: str, start_pattern: str) -> dict:
    """Read simple "key":value pairs from the ~1000 characters after start_pattern."""
    m = re.search(start_pattern, html)
    if not m:
        return {}
    window = html[m.end():m.end() + 1000]
    return {k: (s if s else float(n)) for k, s, n in
            re.findall(r'"(\w+)":(?:"([^"]*)"|(-?\d+(?:\.\d+)?))', window)[::-1]}


class Flipkart(Adapter):
    key = "flipkart"

    def fetch(self, platform_id, pincode, result: PriceResult) -> PriceResult:
        html = self.http.get(result.url)
        pat = self.cfg["patterns"]

        offers = None
        for m in re.finditer(pat["ld_json"], html):
            try:
                data = json.loads(m.group(1))
            except ValueError:
                continue
            for item in data if isinstance(data, list) else [data]:
                if isinstance(item, dict) and item.get("offers"):
                    offers = item["offers"]
                    result.listing_title = item.get("name", "")
                    break
            if offers:
                break

        ppd = _block_fields(html, pat["price_block"])
        pls = _block_fields(html, pat["listing_block"])

        if not offers and not ppd:
            if "Currently Unavailable" in html or "Sold Out" in html:
                result.in_stock, result.status = "N", OK
                return result
            raise Exception("Price data not found on page - layout may have changed")

        result.price = parse_money((offers or {}).get("price")) or parse_money(ppd.get("fsp"))
        result.mrp = parse_money(ppd.get("mrp"))
        availability = (offers or {}).get("availability", "") + " " + str(pls.get("availabilityStatus", ""))
        result.in_stock = "N" if re.search(r"OutOfStock|SoldOut|OUT_OF_STOCK|SOLD_OUT|UNAVAILABLE", availability) else "Y"
        if pls.get("sellerId"):
            result.seller = f"seller id {pls['sellerId']}"
        if not result.listing_title:
            t = re.search(pat["title"], html)
            result.listing_title = t.group(1).split(" Price in India")[0] if t else ""
        result.status = OK
        return result

    def discover_id(self, sku: Sku):
        query = f"{self.cfg.get('search_prefix', '')} {sku.name}".strip()
        html = self.http.get(self.cfg["search_url"].format(query=quote_plus(query)))
        best, best_score = None, 0.0
        seen = set()
        for m in re.finditer(self.cfg["patterns"]["search_result"], html):
            slug, pid = m.group(2), m.group(3)
            if pid in seen or not slug.startswith("smartivity"):
                continue
            seen.add(pid)
            score = name_match_score(sku.name, slug)
            if score > best_score:        # strict ">" keeps Flipkart's own ranking on ties
                best, best_score = (pid, slug.replace("-", " ")), score
        if best and best_score >= float(self.cfg.get("search_min_match", 0.6)):
            return best
        return None
