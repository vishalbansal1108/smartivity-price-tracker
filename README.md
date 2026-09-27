# Smartivity Price Tracker

Checks the live selling price and stock of your SKUs on Indian marketplaces,
compares every platform with **Amazon.in** (the reference price), writes
everything into a Google Sheet, and emails you when anything is cheaper than
Amazon.in.

### Platforms

| Platform | Tracked? | How |
|---|---|---|
| Amazon.in (reference price) | ✅ | product page per ASIN (buy-box price) |
| Flipkart | ✅ | product page per FSN; FSN found by name search when missing |
| Myntra | ✅ | Smartivity brand page (one request for all products) |
| FirstCry | ✅ | Smartivity brand listing feed (a few requests for all products) |
| Blinkit | ✅ at 560056, 560065, 110030 | Blinkit search for "smartivity" at each location |
| Meesho, Nykaa, Ajio, JioMart, BigBasket / BB Now, Swiggy Instamart, Zepto | ❌ | these sites refuse automated access ("Access Denied" or bot challenges), even from a home connection. The tracker does not try to get around that. |
| Tata CLiQ, Snapdeal | ❌ | no Smartivity products listed (Sep 2026) |

The "not tracked" list is also shown on the Latest tab, and it lives in `config/platforms.yaml` (`not_tracked:`).
Re-check it every few months: if a site opens up, it needs a new adapter.

**Quick commerce and pincodes:** Blinkit stock differs per area. "N/A here" on the Latest tab means the
product is not sold at that pincode right now. Pincode 560065's centre point is outside Blinkit's
delivery zone, so the tracker uses a point inside Thindlu (same pincode). Coordinates are in `config/platforms.yaml`.

**Blinkit IDs:** the "Blinkit Item ID(s)" numbers in the sheet are Blinkit's seller-side codes. The public
website uses different numbers, so the tracker fills a new column, **Blinkit Product ID**, by name matching.

---

## How it works (in plain words)

```
 GitHub (free robot, runs on a schedule)          Your Google Sheet
 ┌────────────────────────────────────┐          ┌──────────────────────────────┐
 │ 1. asks the sheet for the SKU list │ ───────▶ │ SKUs tab (you edit this)     │
 │ 2. opens each product page         │          │                              │
 │    (Amazon.in, Flipkart, ...)      │          │ Latest / History / Alerts /  │
 │ 3. sends all prices to the sheet   │ ───────▶ │ Run Log  (filled for you)    │
 └────────────────────────────────────┘          │ + emails you on alerts       │
                                                 └──────────────────────────────┘
```

* The **robot** is a free GitHub Actions job. It runs every 10 minutes while
  testing, then every 4 hours.
* The **sheet** has a small script inside it (Apps Script) that builds the tabs
  and sends the emails from your own Gmail. You never need an email password.

---

## One-time setup (about 20 minutes)

### Part A: the Google Sheet

1. Sign in to Google as **vishalbansal1108@gmail.com** and open <https://sheets.new>.
   Rename the sheet (top left) to **Smartivity Price Tracker**.
2. Menu **Extensions → Apps Script**. A code editor opens in a new tab.
3. Delete everything in the editor. Open the file `apps_script/Code.gs` from
   this folder in Notepad, select all, copy, and paste it into the editor.
   Click the **Save** icon (💾). If asked for a project name, type `Price Tracker`.
4. Go back to the sheet tab and **reload the page**. After a few seconds a new
   menu **Price Tracker** appears at the top.
5. Click **Price Tracker → 1. Set up tabs & daily summary**.
   Google asks for permission. This is your own script, so it is safe to allow:
   * **Continue** → pick your account
   * If you see "Google hasn't verified this app": click **Advanced** →
     **Go to Price Tracker (unsafe)** → **Allow**
   * If nothing happens after allowing, click the menu item again.

   You now have the tabs **SKUs, Latest, History, Alerts, Run Log**. The SKUs tab
   already has your 7 test SKUs.
6. Back in the **Apps Script** tab: click **Deploy → New deployment**.
   * Click the gear ⚙ next to "Select type" → **Web app**
   * Description: `price tracker`
   * Execute as: **Me**
   * Who has access: **Anyone**. The robot needs this to reach the sheet; it
     also has to send a secret token, so strangers can't use it.
   * Click **Deploy**, then allow the permissions again if asked.
   * **Copy the "Web app URL"** and keep it in Notepad for Part B.
7. In the sheet: **Price Tracker → 2. Show connection details**. Copy the
   **SHEET_TOKEN** value into Notepad too.
8. **Price Tracker → Send test email**. Check your inbox (and the spam folder).

### Part B: GitHub (the free robot)

1. Create a free account at <https://github.com/signup> (skip this if you already have one).
2. Click **+ → New repository**.
   * Name: `smartivity-price-tracker`
   * Choose **Public**. Public repositories get unlimited free robot minutes;
     private ones get only 2,000 minutes a month, which is not enough.
     Only the code is public. Your SKU list stays in your Google Sheet, and the
     URL and token go into GitHub's hidden "Secrets".
   * Click **Create repository**.
3. Put the code in the repository. Either:
   * **Ask Claude to push it** (you sign in to GitHub once when the window pops up), or
   * On the new repository page click **uploading an existing file**, then drag
     **everything inside** `D:\Claude AI\price-tracker` into the browser
     **except the `.venv` folder**. Make sure the `.github` folder is included.
     Click **Commit changes**.
4. In the repository: **Settings → Secrets and variables → Actions → New repository secret**.
   Add two secrets:
   | Name | Value |
   |---|---|
   | `SHEET_WEBAPP_URL` | the Web app URL from Part A step 6 |
   | `SHEET_TOKEN` | the token from Part A step 7 |
5. Open the **Actions** tab. If GitHub asks, click **I understand my workflows, enable them**.
   Click **Price check** on the left → **Run workflow** → **Run workflow**.
   After 2–3 minutes it shows a green tick ✅. Open your sheet: the **Latest** tab is filled in.

From now on it runs by itself **every 4 hours** (05:30, 09:30, 13:30, 17:30, 21:30, 01:30 IST).
GitHub sometimes starts scheduled runs 5–30 minutes late. That is normal.
To change the timing, edit the `cron:` line in `.github/workflows/price-check.yml` on GitHub (✏ icon).

### Part C: the green "Check prices now" button

The **Latest** tab has a green **▶ Check prices now** button (also in the menu: **Price Tracker → ▶ Check prices now**).
It asks GitHub to run a price check immediately. Results appear in the sheet after about **15–20 minutes**
for all SKUs. If a check is already running, it tells you instead of starting a second one.

To make the button work, the sheet needs permission to start the robot. This is a one-time setup:

1. On GitHub, click your **profile picture → Settings → Developer settings (at the very bottom)
   → Personal access tokens → Fine-grained tokens → Generate new token**.
2. Token name: `sheet button`. Expiration: the longest option offered.
   Repository access: **Only select repositories** → `smartivity-price-tracker`.
3. **Permissions → Repository permissions → Actions → Read and write**.
4. Click **Generate token**, then copy it. It starts with `github_pat_`.
5. In the sheet: **Price Tracker → 3. Connect GitHub**. Type your repository as `yourname/smartivity-price-tracker`,
   then paste the token. You should see "Connected".
6. The first time you click the button, Google asks for one more permission (to contact GitHub). Allow it.

The token can only start this robot; it can't read or change anything else. If the button stops working
after the token expires, repeat these steps.

On the phone app, image buttons don't work. Use the menu instead, or open the sheet in a browser.

### Adding more SKUs

Add rows to the **SKUs** tab using the same columns. To bulk-add from an Excel file (on a PC with Python):
```
.venv\Scripts\python -m pip install openpyxl
.venv\Scripts\python import_skus.py "D:\path\to\file.xlsx" --upload
```
SKUs already in the tab are skipped.

---

## Using the sheet

| Tab | What it is |
|---|---|
| **SKUs** | Your input. One row per SKU. Add more rows any time using the same columns. Put `N` in **Track (Y/N)** to pause a SKU. A blank ID means "not listed there". |
| **Latest** | One row per SKU, one column per platform, with Amazon.in first. **Red** = cheaper than Amazon.in. **Grey** = the fetch failed or was blocked. ~~Strikethrough~~ or **OOS** = out of stock. **—** = no ID / not listed. Click a price to open the product. Hover over a cell to see the seller, MRP and any error. "Last updated" is at the top. |
| **History** | Every price ever fetched, one row per fetch. Use it for trend charts (Insert → Chart). Rows older than 60 days are removed automatically, because Google Sheets has a size limit. |
| **Alerts** | Every SKU/platform that is (ACTIVE) or was (RESOLVED) cheaper than Amazon.in, with both prices, the difference in ₹ and %, and links. |
| **Run Log** | One line per platform per run, with OK / NOT_FOUND / BLOCKED / ERROR counts. |

**Yellow cells in the SKUs tab:** when a SKU has no ID for Flipkart, Myntra, FirstCry or Blinkit,
the robot matches it by product name (and checks the MRP is within 20%). It writes the ID it found
into the SKUs tab in **yellow**. New columns such as "Myntra ID" and "Blinkit Product ID" are added automatically.
Hover over the cell to see the listing it matched and open the link. If the match is right,
remove the yellow colour. If it is wrong, type the correct FSN or clear the cell. You can find
the FSN in any Flipkart product link after `pid=`.

**Grey "none" cells:** the search found nothing, so that platform is skipped for that SKU.
You can also type `none` yourself for any platform where a SKU isn't sold. Clear the cell to search again.

### Emails you will get

* **Price Alert**: right after a run, **only** when a case is new or its price changed
  (even by a few paise). The same case is not re-sent if nothing changed. If Amazon.in's
  price couldn't be read for a SKU, the email says so instead of comparing.
* **Daily summary at 9 AM IST**: all cases that are currently active, plus any platform that is failing.
* **Platform needs attention**: when a platform returns no prices for 3 runs in a row.
  Sent once per problem.

To change the email address: **Price Tracker → Change alert email address**.

---

## Fetch statuses

| Status | Meaning |
|---|---|
| OK | Price read successfully |
| NOT_FOUND | The product page doesn't exist, or a name search found no matching listing |
| BLOCKED | The site showed a robot check / CAPTCHA or refused access. The robot never tries to get around these. |
| ERROR | Anything else. Usually the site changed its page layout, so the adapter needs a small fix. |

**Blocking from cloud servers:** GitHub's robots run in Microsoft data centres. Amazon.in
usually works but sometimes shows a robot check. Flipkart is stricter with data-centre
traffic. Occasional BLOCKED cells are expected. If a platform is BLOCKED on almost every run,
you will get a "needs attention" email. The free fix is to run the robot on an office PC
(ask Claude about a "self-hosted runner").

---

## When something breaks

* **Selectors live in `config/platforms.yaml`.** When a site changes its layout, the fix is
  usually a line there, not in the code.
* **Test one SKU per platform** (on a PC with Python):
  ```
  .venv\Scripts\python test_platforms.py
  .venv\Scripts\python test_platforms.py SMRT1245
  ```
* **Full run without touching the sheet:** `.venv\Scripts\python -m tracker.run --dry-run`
* **Robot logs:** GitHub → Actions → click a run → **check** → "Fetch prices and update the Google Sheet".

### Updating the sheet script later

After pasting a new `Code.gs` into Apps Script and saving, you **must** publish it again,
otherwise the robot keeps talking to the old version:
**Deploy → Manage deployments → ✏ Edit → Version: New version → Deploy.** The URL stays the same.

---

## For developers

```
config/platforms.yaml      selectors, URLs, delays, per-platform settings
tracker/models.py          PriceResult: the common result format
tracker/http.py            polite HTTP: random delays, retries with backoff, block detection
tracker/adapters/base.py   Adapter interface: fetch(platform_id, pincode) -> PriceResult
tracker/adapters/*.py      one file per platform
tracker/run.py             runs all platforms in parallel (one thread each), uploads to the sheet
tracker/sheet.py           talks to the sheet's Apps Script web app (POST + secret token)
apps_script/Code.gs        sheet side: tabs, colours, alerts, emails, health check
test_platforms.py          fetch 1 SKU per platform and print it
.github/workflows/         price-check (schedule) + keepalive (stops GitHub pausing the schedule)
```

To add a platform: add a section in `config/platforms.yaml`, create
`tracker/adapters/<key>.py` with a class extending `Adapter` that implements `fetch()`,
and register it in `tracker/adapters/__init__.py`. A broken adapter only produces
ERROR rows. It never stops the other platforms.

Secrets (`SHEET_WEBAPP_URL`, `SHEET_TOKEN`) come only from environment variables or
GitHub Secrets, never from code. Without them, the runner reads `config/skus_local.csv`
and uploads nothing.
