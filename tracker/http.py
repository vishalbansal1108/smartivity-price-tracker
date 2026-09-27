"""A polite HTTP client: random delays between requests, retries with backoff."""
from __future__ import annotations

import random
import re
import time

import requests

RETRY_STATUS = {429, 500, 502, 503, 504, 520, 522, 529}


class Blocked(Exception):
    """The site refused us (robot check / access denied). Never retried around."""


class NotFound(Exception):
    pass


class PoliteSession:
    def __init__(self, platform_cfg: dict, defaults: dict):
        self.delay = platform_cfg.get("delay_seconds", defaults["delay_seconds"])
        self.retries = int(platform_cfg.get("retries", defaults["retries"]))
        self.backoff = float(platform_cfg.get("backoff_seconds", defaults["backoff_seconds"]))
        self.timeout = float(platform_cfg.get("timeout_seconds", defaults["timeout_seconds"]))
        self.blocked_markers = platform_cfg.get("blocked_markers", [])
        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": random.choice(defaults["user_agents"]),
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-IN,en;q=0.9",
        })
        self._last = 0.0

    def _wait_turn(self):
        gap = random.uniform(*self.delay)
        wait = self._last + gap - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        self._last = time.monotonic()

    def get(self, url: str) -> str:
        """Return page HTML. Raises Blocked / NotFound / requests exceptions."""
        last_error: Exception | None = None
        for attempt in range(self.retries + 1):
            if attempt:
                time.sleep(self.backoff * (2 ** (attempt - 1)) + random.uniform(0, 2))
            self._wait_turn()
            try:
                resp = self.session.get(url, timeout=self.timeout)
            except requests.RequestException as e:
                last_error = e
                continue
            html = resp.text
            # Real block pages are small. Big product pages can contain these words
            # inside embedded templates, so for those only the <title> is checked.
            if len(html) < 150_000:
                haystack = html
            else:
                m = re.search(r"<title[^>]*>([^<]*)", html, re.I)
                haystack = m.group(1) if m else ""
            for marker in self.blocked_markers:
                if marker in haystack:
                    raise Blocked(f"Robot check shown (HTTP {resp.status_code}, matched '{marker}')")
            if resp.status_code == 404:
                raise NotFound(f"HTTP 404 for {url}")
            if resp.status_code == 403:
                raise Blocked("HTTP 403 Forbidden (site refused automated access)")
            if resp.status_code in RETRY_STATUS:
                last_error = Exception(f"HTTP {resp.status_code}")
                continue
            if resp.status_code >= 400:
                raise Exception(f"HTTP {resp.status_code}")
            return html
        if last_error and "HTTP 503" in str(last_error):
            raise Blocked(f"Site kept answering 503 after {self.retries + 1} tries (throttled)")
        raise last_error or Exception("unknown fetch error")
