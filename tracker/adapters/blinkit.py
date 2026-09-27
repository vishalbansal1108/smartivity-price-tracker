from __future__ import annotations

import json
import re
from urllib.parse import urljoin

from ..models import parse_money
from .catalog import CatalogAdapter, Listing


class Blinkit(CatalogAdapter):
    """Blinkit search, per delivery location. The location is sent the way the
    Blinkit website sends it: as lat / lon headers for the pincode's area."""
    key = "blinkit"
    not_found_text = "Not available at this pincode (not in Blinkit search results)"

    def fetch_catalog(self, pincode):
        loc = self.cfg["locations"][str(pincode)]
        headers = {"lat": str(loc["lat"]), "lon": str(loc["lon"]), "app_client": "consumer_web",
                   "Accept": "application/json", "Content-Type": "application/json"}
        url = self.cfg["search_url"]
        items: dict[str, Listing] = {}
        for _ in range(int(self.cfg.get("max_pages", 8))):
            data = json.loads(self.http.request("POST", url, headers=headers, data="{}"))
            if not data.get("is_success", True) and not data.get("response"):
                raise Exception("Blinkit search answered is_success=false")
            self._collect(data, items)
            nxt = (data.get("response") or {}).get("pagination", {}).get("next_url")
            if not nxt:
                break
            url = urljoin("https://blinkit.com", nxt)
        return list(items.values())

    def _collect(self, node, items):
        if isinstance(node, dict):
            if "product_id" in node and "normal_price" in node:
                name = (node.get("name") or {}).get("text", "")
                brand = str(node.get("brand_name") or "")
                if "smartivity" in (name + " " + brand).lower():
                    pid = str(node["product_id"])
                    eta = ((node.get("eta_tag") or {}).get("title") or {}).get("text", "")
                    sold_out = bool(node.get("is_sold_out")) or node.get("inventory") == 0
                    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
                    items[pid] = Listing(
                        id=pid, title=name,
                        price=parse_money((node.get("normal_price") or {}).get("text")),
                        mrp=parse_money((node.get("mrp") or {}).get("text")),
                        in_stock=not sold_out,
                        url=f"https://blinkit.com/prn/{slug}/prid/{pid}",
                        seller=f"delivery {eta}" if eta else "",
                    )
            for v in node.values():
                self._collect(v, items)
        elif isinstance(node, list):
            for v in node:
                self._collect(v, items)
