"""Match my product names to platform listing titles.

Used when a SKU has no ID for a platform: the adapter searches the platform,
then picks the best listing here. Each listing is given to at most one SKU.
"""
from __future__ import annotations

import re
from difflib import SequenceMatcher

# Words that say nothing about WHICH product it is
STOPWORDS = {
    "the", "and", "n", "for", "of", "a", "an", "with", "to", "in", "by", "on", "at",
    "smartivity", "kit", "kits", "diy", "toy", "toys", "kids", "kid", "stem", "building",
    "pack", "years", "year", "yrs", "old", "boys", "girls", "gift", "gifts", "educational",
    "learning", "activity", "multicolour", "multicolor", "age", "ages", "plus",
    # Smartivity product-line names: shared by many products, so they identify nothing
    "little", "spark", "quick", "smartcraft",
}


def words(text: str) -> set[str]:
    text = text.lower().replace("&", " and ").replace("'s", "")
    out = set()
    for w in re.split(r"[^a-z0-9]+", text):
        if len(w) < 2 or w in STOPWORDS or w.isdigit():
            continue
        out.add(w[:-1] if len(w) > 3 and w.endswith("s") else w)
    return out


def name_variants(name: str) -> list[set[str]]:
    """'Telescope (Pirate's Telescope)' -> {telescope}, {pirate, telescope}, ...
    'Little Sparks - Space Explorer' -> {little, spark, space, explorer}, {space, explorer}"""
    parts = [name, re.sub(r"\([^)]*\)", " ", name)]
    parts += re.findall(r"\(([^)]*)\)", name)
    if " - " in name:
        parts.append(name.split(" - ", 1)[1])
    if ":" in name:
        parts.append(name.split(":", 1)[1])      # "STEAM Warriors: Clash of Cyborgs" -> the specific part
    full = words(name)
    out = [full] if full else []
    for w in (words(p) for p in parts[1:]):
        # a one-word part ("Mega", "Telescope") is only trusted when the whole name is short
        if w and (len(w) >= 2 or len(full) <= 2) and w not in out:
            out.append(w)
    return out


def _hits(wanted: set[str], listing: set[str]) -> int:
    """Words of `wanted` found in `listing`; tolerates small typos ("missle" = "missile")."""
    n = 0
    for w in wanted:
        if w in listing or (len(w) >= 5 and any(
                len(x) >= 5 and SequenceMatcher(None, w, x).ratio() >= 0.85 for x in listing)):
            n += 1
    return n


def score(name: str, listing_title: str) -> float:
    listing = words(listing_title)
    variants = name_variants(name)
    if not variants or not listing:
        return 0.0
    best = max(_hits(v, listing) / len(v) for v in variants)
    full = _hits(variants[0], listing) / len(variants[0])
    return round(best + 0.01 * full, 4)


def assign(names: dict[str, str], listings: dict[str, str], min_score: float,
           sku_mrp: dict[str, float | None] | None = None,
           listing_mrp: dict[str, float | None] | None = None) -> dict[str, tuple[str, float]]:
    """names: sku -> product name; listings: listing id -> title.
    Optional MRPs: a listing whose MRP is >20% away from the SKU's MRP is
    probably a different product, so its score is cut.
    Returns sku -> (listing id, score), one-to-one, best scores first."""
    sku_mrp, listing_mrp = sku_mrp or {}, listing_mrp or {}
    pairs = []
    for sku, name in names.items():
        for lid, title in listings.items():
            s = score(name, title)
            a, b = sku_mrp.get(sku), listing_mrp.get(lid)
            if a and b and abs(a - b) / a > 0.20:
                s -= 0.3
            if s >= min_score:
                # tie-break: the listing with fewer unexplained words is the closer match
                pairs.append((s, -len(words(title) - words(name)), sku, lid))
    pairs.sort(reverse=True)
    out, used = {}, set()
    for s, _, sku, lid in pairs:
        if sku in out or lid in used:
            continue
        out[sku] = (lid, s)
        used.add(lid)
    return out
