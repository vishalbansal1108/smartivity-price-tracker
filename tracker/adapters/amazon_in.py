from __future__ import annotations

import re

from ..http import NotFound
from ..models import OK, PriceResult, parse_money
from .base import Adapter


class AmazonIn(Adapter):
    key = "amazon_in"

    def fetch(self, platform_id, pincode, result: PriceResult) -> PriceResult:
        html = self.http.get(result.url)
        soup = self.soup(html)

        title = self.select_text(soup, "title")
        if not title:
            if any(m in html for m in self.cfg.get("not_found_markers", [])):
                raise NotFound("Amazon says this page does not exist")
            raise Exception("Product title not found - page layout may have changed")
        result.listing_title = title

        result.price = parse_money(self.select_text(soup, "price"))
        if result.price is None:
            m = re.search(self.cfg["patterns"]["price"], html)
            if m and self.exists(soup, "buy_button"):
                result.price = parse_money(m.group(1))
        result.mrp = parse_money(self.select_text(soup, "mrp"))
        result.seller = (self.select_text(soup, "seller") or "")[:80]

        availability = (self.select_text(soup, "availability") or "").lower()
        has_buy_button = self.exists(soup, "buy_button")
        if any(w in availability for w in self.cfg.get("out_of_stock_words", [])):
            result.in_stock = "N"
        elif has_buy_button:
            result.in_stock = "Y"
        elif result.price is None:
            result.in_stock = "N"
            result.error = "No buy box (no seller currently winning / only 'See all buying options')"
        else:
            result.in_stock = "Y"

        result.status = OK
        return result
