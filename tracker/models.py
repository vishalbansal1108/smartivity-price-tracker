"""Shared data types used by every platform adapter."""
from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta, timezone

IST = timezone(timedelta(hours=5, minutes=30), "IST")

# Fetch status values
OK = "OK"
NOT_FOUND = "NOT_FOUND"   # product page / listing does not exist
BLOCKED = "BLOCKED"       # robot check, CAPTCHA, login wall or access denied
ERROR = "ERROR"           # anything else (network, page layout changed, ...)
NO_ID = "NO_ID"           # SKU has no ID for this platform and search is off


def now_ist() -> str:
    return datetime.now(IST).strftime("%Y-%m-%d %H:%M:%S")


def parse_money(text) -> float | None:
    """'₹1,332.98' -> 1332.98 ; returns None if no number found."""
    if text is None:
        return None
    if isinstance(text, (int, float)):
        return float(text)
    m = re.search(r"\d[\d,]*(?:\.\d+)?", str(text))
    return float(m.group(0).replace(",", "")) if m else None


@dataclass
class Sku:
    sku: str
    name: str
    mrp: float | None
    ids: dict[str, str] = field(default_factory=dict)   # platform key -> ID


@dataclass
class PriceResult:
    sku: str
    product_name: str
    platform: str                 # platform key, e.g. "amazon_in"
    platform_id: str = ""
    pincode: str = ""
    url: str = ""
    price: float | None = None    # selling (buy-box) price
    mrp: float | None = None
    discount_pct: float | None = None
    in_stock: str = ""            # "Y" / "N" / "" (unknown)
    seller: str = ""
    status: str = ERROR
    error: str = ""
    listing_title: str = ""       # product title as shown on the platform
    id_discovered: bool = False   # True when the ID was found by name search
    timestamp: str = field(default_factory=now_ist)

    def finish(self) -> "PriceResult":
        """Fill in derived fields."""
        if self.discount_pct is None and self.price and self.mrp and self.mrp > self.price:
            self.discount_pct = round((self.mrp - self.price) / self.mrp * 100, 1)
        self.error = (self.error or "")[:300]
        return self

    def to_dict(self) -> dict:
        return asdict(self)
