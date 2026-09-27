/**
 * Smartivity Price Tracker - Google Sheet side.
 *
 * The price fetcher (running on GitHub) sends each run's results here.
 * This script then:
 *   - appends every result to "History"
 *   - rebuilds "Latest" (one row per SKU, coloured)
 *   - updates "Alerts" and emails you when something is cheaper than Amazon.in
 *   - writes "Run Log" and emails you if a platform fails 3 runs in a row
 *   - sends a daily summary at 9 AM IST
 *
 * Paste this whole file into Extensions > Apps Script, save, then reload the
 * sheet and use the "Price Tracker" menu. Full steps are in README.md.
 */

const TZ = 'Asia/Kolkata';
const DEFAULT_EMAIL = 'vishalbansal1108@gmail.com';
const HISTORY_KEEP_DAYS = 60;      // older History rows are deleted (Google Sheets has a size limit)
const HEALTH_FAIL_RUNS = 3;        // email if a platform fails this many runs in a row

const TAB = {
  SKUS: 'SKUs', LATEST: 'Latest', HISTORY: 'History', ALERTS: 'Alerts',
  RUNLOG: 'Run Log', STATE: '_latest_data',
};
const COLOR = { RED: '#f4a09c', GREY: '#d0d0d0', YELLOW: '#fff2b3', HEADER: '#1f3a5f' };

const SKU_HEADERS = ['SKU', 'Product Name', 'Category', 'Status', 'MRP (INR)', 'EAN/Barcode', 'Track (Y/N)',
  'Amazon ASIN(s)', 'Flipkart FSN/PID', 'Blinkit Item ID(s)', 'Swiggy Instamart PID(s)', 'Zepto ID',
  'Meesho ID', 'JioMart ID', 'Tata CLiQ ID', 'FirstCry ID', 'Snapdeal ID'];
const SKU_SEED = [
  ['SMRT1309', 'Airplanes Launchers', 'STEM', 'Active', 799, '8906187980222', 'Y', 'B0F9PJQXFV', '', '10282898', '452577'],
  ['SMRT1302', 'Interactive Clock', 'STEM', 'Active', 999, '8906187980178', 'Y', 'B0DYDQ2523', '', '10282895', ''],
  ['SMRT1245', 'Motor Gadgets', 'STEM', 'Active', 1699, '8908011797860', 'Y', 'B0DBZTDRL6', '', '10282891', '158421'],
  ['SMRT1301', 'Missile Truck', 'STEM', 'Active', 1099, '8906187980147', 'Y', 'B0DYDRWDGD', '', '10282882', '733619'],
  ['SMRT1216', 'Electro Play Lab', 'STEM', 'Active', 1399, '8908011797518', 'Y', 'B0BB7Q4K72', '', '10282877', '86497'],
  ['SMRT1334', 'Interactive Human Body', 'STEM', 'Active', 1149, '8906187980376', 'Y', 'B0FV2T1T8M', '', '1028287', ''],
  ['SMRT1303', 'Solar System', 'STEM', 'Active', 1149, '8906187980345', 'Y', 'B0FNDDRLZ2', '', '10274211', '822097'],
];
const HISTORY_HEADERS = ['Timestamp (IST)', 'Run ID', 'SKU', 'Product Name', 'Platform', 'Platform ID', 'Pincode',
  'Product URL', 'Selling Price', 'MRP', 'Discount %', 'In Stock', 'Seller', 'Fetch Status', 'Error', 'Listing Title'];
const ALERT_HEADERS = ['Status', 'First Seen', 'Last Seen', 'SKU', 'Product Name', 'Platform', 'Pincode',
  'Platform Price', 'Amazon.in Price', 'Difference ₹', 'Difference %', 'Platform URL', 'Amazon.in URL',
  'Last Emailed', 'Emailed Platform Price', 'Emailed Amazon Price'];
const RUNLOG_HEADERS = ['Run Time (IST)', 'Run ID', 'Trigger', 'Duration (s)', 'Platform', 'OK', 'NOT_FOUND',
  'BLOCKED', 'ERROR', 'Total', 'Result'];
const STATE_HEADERS = ['Key'].concat(HISTORY_HEADERS);

/* ------------------------------------------------------------------ menu */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Price Tracker')
    .addItem('▶ Check prices now', 'checkNow')
    .addSeparator()
    .addItem('1. Set up tabs & daily summary', 'setup')
    .addItem('2. Show connection details (for GitHub)', 'showConnectionDetails')
    .addItem('3. Connect GitHub (for the Check now button)', 'connectGitHub')
    .addItem('Re-add the Check now button', 'addCheckButton')
    .addSeparator()
    .addItem('Send test email', 'sendTestEmail')
    .addItem('Send daily summary now', 'dailySummary')
    .addItem('Change alert email address', 'changeEmail')
    .addToUi();
}

function setup() {
  const ss = SpreadsheetApp.getActive();
  ss.setSpreadsheetTimeZone(TZ);
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('TOKEN')) props.setProperty('TOKEN', Utilities.getUuid().replace(/-/g, ''));
  if (!props.getProperty('ALERT_EMAIL')) props.setProperty('ALERT_EMAIL', DEFAULT_EMAIL);

  let skus = ss.getSheetByName(TAB.SKUS);
  if (!skus) {
    skus = ss.insertSheet(TAB.SKUS, 0);
    skus.getRange(1, 1, 1, SKU_HEADERS.length).setValues([SKU_HEADERS]);
    skus.getRange(2, 1, SKU_SEED.length + 500, SKU_HEADERS.length).setNumberFormat('@'); // keep IDs as text
    const seed = SKU_SEED.map(r => r.concat(Array(SKU_HEADERS.length - r.length).fill('')).map(String));
    skus.getRange(2, 1, seed.length, SKU_HEADERS.length).setValues(seed);
    styleHeader_(skus, SKU_HEADERS.length);
    skus.autoResizeColumns(1, SKU_HEADERS.length);
  }
  ensureTab_(TAB.LATEST, null);
  ensureTab_(TAB.HISTORY, HISTORY_HEADERS);
  ensureTab_(TAB.ALERTS, ALERT_HEADERS);
  ensureTab_(TAB.RUNLOG, RUNLOG_HEADERS);
  ensureTab_(TAB.STATE, STATE_HEADERS).hideSheet();
  const blank = ss.getSheetByName('Sheet1');
  if (blank && blank.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(blank);

  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'dailySummary')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('dailySummary').timeBased().everyDays(1).atHour(9).nearMinute(0).inTimezone(TZ).create();
  addCheckButton();

  SpreadsheetApp.getUi().alert('Setup done',
    'Tabs created and the 9 AM daily summary is scheduled.\n\n' +
    'Next: Deploy > New deployment > Web app (Execute as: Me, Who has access: Anyone), ' +
    'then use "Price Tracker > 2. Show connection details".',
    SpreadsheetApp.getUi().ButtonSet.OK);
}

function showConnectionDetails() {
  const url = ScriptApp.getService().getUrl();
  const token = PropertiesService.getScriptProperties().getProperty('TOKEN');
  const html = HtmlService.createHtmlOutput(
    '<div style="font-family:Arial;font-size:13px">' +
    '<p>Add these two <b>secrets</b> in GitHub (Settings &gt; Secrets and variables &gt; Actions):</p>' +
    '<p><b>SHEET_WEBAPP_URL</b><br><textarea rows="3" style="width:100%">' + (url || 'NOT DEPLOYED YET - do Deploy > New deployment > Web app first') + '</textarea></p>' +
    '<p><b>SHEET_TOKEN</b><br><textarea rows="1" style="width:100%">' + (token || 'Run step 1 (Set up) first') + '</textarea></p>' +
    '<p style="color:#a00">Keep the token private - anyone with it can write to this sheet.</p></div>')
    .setWidth(520).setHeight(330);
  SpreadsheetApp.getUi().showModalDialog(html, 'Connection details');
}

function changeEmail() {
  const ui = SpreadsheetApp.getUi();
  const props = PropertiesService.getScriptProperties();
  const r = ui.prompt('Alert email', 'Current: ' + props.getProperty('ALERT_EMAIL') +
    '\nEnter new address (several: separate with commas):', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() === ui.Button.OK && r.getResponseText().trim()) {
    props.setProperty('ALERT_EMAIL', r.getResponseText().trim());
    ui.alert('Saved.');
  }
}

function sendTestEmail() {
  MailApp.sendEmail({
    to: alertEmail_(), subject: '[Price Tracker] Test email',
    htmlBody: '<p>Test email from your Smartivity price tracker sheet: ' +
      SpreadsheetApp.getActive().getUrl() + '</p>',
  });
  SpreadsheetApp.getUi().alert('Sent to ' + alertEmail_());
}

/* ------------------------------------------------ "Check prices now" button */

/** Asks for the GitHub repository and access token used by the Check now button. */
function connectGitHub() {
  const ui = SpreadsheetApp.getUi();
  const props = PropertiesService.getScriptProperties();
  const repo = ui.prompt('Connect GitHub (1/2)',
    'Your GitHub repository as  owner/name  (e.g.  vishalbansal/smartivity-price-tracker):',
    ui.ButtonSet.OK_CANCEL);
  if (repo.getSelectedButton() !== ui.Button.OK || !repo.getResponseText().trim()) return;
  const token = ui.prompt('Connect GitHub (2/2)',
    'Paste the GitHub fine-grained token (starts with github_pat_). See README "Check now button":',
    ui.ButtonSet.OK_CANCEL);
  if (token.getSelectedButton() !== ui.Button.OK || !token.getResponseText().trim()) return;
  props.setProperty('GITHUB_REPO', repo.getResponseText().trim().replace(/^https:\/\/github.com\//, '').replace(/\/$/, ''));
  props.setProperty('GITHUB_TOKEN', token.getResponseText().trim());
  const test = ghFetch_('get', '/actions/workflows/price-check.yml');
  if (test.getResponseCode() === 200) ui.alert('Connected. The "Check prices now" button is ready.');
  else ui.alert('GitHub answered ' + test.getResponseCode() + '. Check the repository name and token.\n\n' +
    test.getContentText().slice(0, 300));
}

function ghFetch_(method, path, payload) {
  const props = PropertiesService.getScriptProperties();
  const opts = {
    method: method, muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + props.getProperty('GITHUB_TOKEN'),
      Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
  };
  if (payload) { opts.contentType = 'application/json'; opts.payload = JSON.stringify(payload); }
  return UrlFetchApp.fetch('https://api.github.com/repos/' + props.getProperty('GITHUB_REPO') + path, opts);
}

/** Runs when the green button (or the menu item) is clicked: starts a price check on GitHub. */
function checkNow() {
  const ss = SpreadsheetApp.getActive();
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('GITHUB_TOKEN') || !props.getProperty('GITHUB_REPO')) {
    SpreadsheetApp.getUi().alert('Not connected to GitHub yet. Use "Price Tracker > 3. Connect GitHub" first.');
    return;
  }
  for (const status of ['in_progress', 'queued']) {
    const r = ghFetch_('get', '/actions/workflows/price-check.yml/runs?per_page=1&status=' + status);
    if (r.getResponseCode() === 200 && JSON.parse(r.getContentText()).total_count > 0) {
      ss.toast('A price check is already running. The Latest tab will update when it finishes.', 'Price Tracker', 8);
      return;
    }
  }
  const r = ghFetch_('post', '/actions/workflows/price-check.yml/dispatches', { ref: 'main' });
  if (r.getResponseCode() === 204) {
    const msg = 'Price check started at ' + Utilities.formatDate(new Date(), TZ, 'HH:mm') +
      ' - results appear here in about 15-20 minutes (no need to refresh).';
    const latest = ss.getSheetByName(TAB.LATEST);
    if (latest) latest.getRange(3, 1).setValue('⏳ ' + msg).setFontColor('#1e8846').setFontWeight('bold');
    ss.toast(msg, 'Price Tracker', 10);
  } else {
    SpreadsheetApp.getUi().alert('Could not start the check. GitHub answered ' + r.getResponseCode() + ':\n' +
      r.getContentText().slice(0, 300));
  }
}

/** Puts the green "Check prices now" button on the Latest tab (once). */
function addCheckButton() {
  const sh = SpreadsheetApp.getActive().getSheetByName(TAB.LATEST);
  if (!sh) return;
  if (sh.getImages().some(img => img.getScript() === 'checkNow')) return;
  const blob = Utilities.newBlob(Utilities.base64Decode(BUTTON_PNG), 'image/png', 'check-now.png');
  sh.setRowHeight(1, 50);
  sh.insertImage(blob, 4, 1, 4, 3).assignScript('checkNow').setAltTextTitle('Check prices now');
}

/* ------------------------------------------------------- web app (API) */

function doGet() {
  return json_({ ok: true, message: 'Price tracker web app is running.' });
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    if (!body.token || body.token !== PropertiesService.getScriptProperties().getProperty('TOKEN')) {
      return json_({ ok: false, error: 'Wrong or missing token' });
    }
    if (!SpreadsheetApp.getActive().getSheetByName(TAB.SKUS)) {
      return json_({ ok: false, error: 'Run "Price Tracker > 1. Set up" in the sheet first' });
    }
    if (body.action === 'skus') return json_({ ok: true, rows: readSkus_() });
    if (body.action === 'add_skus') return json_({ ok: true, message: addSkus_(body.rows || []) });
    if (body.action === 'results') {
      const lock = LockService.getScriptLock();
      lock.waitLock(120000);
      try {
        return json_({ ok: true, message: handleResults_(body) });
      } finally {
        lock.releaseLock();
      }
    }
    return json_({ ok: false, error: 'Unknown action' });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.stack || err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ------------------------------------------------------ main processing */

function handleResults_(p) {
  const results = p.results || [];
  const platforms = p.platforms || [];
  PropertiesService.getScriptProperties().setProperty('PLATFORMS', JSON.stringify(platforms));

  appendHistory_(p.run.id, results);
  writeDiscoveredIds_(results, platforms);
  const state = updateState_(results);
  const alertInfo = updateAlerts_(state);
  buildLatest_(state, platforms, p.run.finished);
  const failing = writeRunLog_(p.run);
  const sent = sendAlertEmail_(alertInfo);
  checkHealth_(failing);
  pruneHistoryDaily_();
  return results.length + ' results saved; ' + alertInfo.changed.length + ' new/changed alerts' +
    (sent ? ' (emailed)' : '');
}

function readSkus_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(TAB.SKUS);
  const data = sh.getDataRange().getDisplayValues();
  const head = data.shift();
  return data.filter(r => r[0]).map(r => {
    const o = {};
    head.forEach((h, i) => { o[h] = r[i]; });
    return o;
  });
}

function trackedSkus_() {
  return readSkus_().filter(r => String(r['Track (Y/N)'] || 'Y').trim().toUpperCase() !== 'N');
}

function appendHistory_(runId, results) {
  if (!results.length) return;
  const sh = SpreadsheetApp.getActive().getSheetByName(TAB.HISTORY);
  const rows = results.map(r => historyRow_(r, runId));
  const start = sh.getLastRow() + 1;
  sh.getRange(start, 1, rows.length, HISTORY_HEADERS.length).setValues(rows);
  sh.getRange(start, 1, rows.length, 1).setNumberFormat('yyyy-mm-dd hh:mm:ss');
  sh.getRange(start, 9, rows.length, 2).setNumberFormat('#,##0.00');
}

function historyRow_(r, runId) {
  return [r.timestamp, runId, r.sku, r.product_name, platformName_(r.platform), r.platform_id, r.pincode,
    r.url, num_(r.price), num_(r.mrp), num_(r.discount_pct), r.in_stock, r.seller, r.status, r.error,
    r.listing_title];
}

/** Adds SKU rows (objects keyed by column header) that are not in the SKUs tab yet. */
function addSkus_(rows) {
  const sh = SpreadsheetApp.getActive().getSheetByName(TAB.SKUS);
  const data = sh.getDataRange().getDisplayValues();
  const head = data[0];
  const have = {};
  data.slice(1).forEach(r => { have[String(r[0]).trim()] = true; });
  const add = rows.filter(r => r.SKU && !have[String(r.SKU).trim()])
    .map(r => head.map(h => (r[h] === undefined || r[h] === null) ? '' : String(r[h])));
  if (!add.length) return 'No new SKUs (all already in the SKUs tab)';
  const start = sh.getLastRow() + 1;
  sh.getRange(start, 1, add.length, head.length).setNumberFormat('@').setValues(add);
  return add.length + ' SKUs added';
}

/** IDs found by name search are written into the SKUs tab (yellow) so you can check them.
 *  When a search finds nothing, "none" is written so the platform is not searched again. */
function writeDiscoveredIds_(results, platforms) {
  const found = results.filter(r => (r.id_discovered && r.platform_id) || r.id_search_failed);
  if (!found.length) return;
  const sh = SpreadsheetApp.getActive().getSheetByName(TAB.SKUS);
  const data = sh.getDataRange().getDisplayValues();
  const head = data[0];
  found.forEach(r => {
    const pl = platforms.find(x => x.key === r.platform);
    const col = pl ? head.indexOf(pl.id_column) : -1;
    const row = data.findIndex((d, i) => i > 0 && d[0] === r.sku);
    if (col < 0 || row < 0 || data[row][col]) return;
    if (r.id_search_failed) {
      sh.getRange(row + 1, col + 1).setNumberFormat('@').setValue('none').setFontColor('#999999')
        .setNote('Searched "' + r.product_name + '" on ' + today_() + ' and found no matching listing, ' +
          'so this platform is skipped for this SKU. If it IS listed, type its ID here. ' +
          'Clear the cell to search again.');
      data[row][col] = 'none';
      return;
    }
    sh.getRange(row + 1, col + 1).setNumberFormat('@').setValue(r.platform_id)
      .setBackground(COLOR.YELLOW)
      .setNote('Found automatically by searching "' + r.product_name + '" on ' + today_() +
        '.\nListing: ' + r.listing_title + '\n' + r.url +
        '\nPlease open the link and check it is the right product. If wrong, replace or clear this cell. ' +
        'Remove the yellow colour once checked.');
    data[row][col] = r.platform_id;
  });
}

/** Hidden tab holding the most recent result for every SKU x platform x pincode. */
function updateState_(results) {
  const sh = SpreadsheetApp.getActive().getSheetByName(TAB.STATE);
  const data = sh.getDataRange().getValues();
  const index = {};
  for (let i = 1; i < data.length; i++) index[data[i][0]] = i;
  results.forEach(r => {
    const key = [r.sku, r.platform, r.pincode || ''].join('|');
    const row = [key].concat(historyRow_(r, ''));
    row[STATE_HEADERS.indexOf('Platform')] = r.platform;       // keep the key, not the display name
    if (key in index) data[index[key]] = row; else { index[key] = data.length; data.push(row); }
  });
  sh.clearContents();
  sh.getRange(1, 1, data.length, STATE_HEADERS.length).setValues(data);

  const state = {};
  data.slice(1).forEach(r => {
    const o = {};
    STATE_HEADERS.forEach((h, i) => { o[h] = r[i]; });
    state[r[0]] = o;
  });
  return state;
}

function stateGet_(state, sku, platform, pincode) {
  return state[[sku, platform, pincode || ''].join('|')];
}

function refPlatform_() {
  const p = platforms_().find(x => x.reference);
  return p ? p.key : 'amazon_in';
}

function isPriced_(s) {
  return s && s['Fetch Status'] === 'OK' && typeof s['Selling Price'] === 'number';
}

/* ---------------------------------------------------------------- Alerts */

function updateAlerts_(state) {
  const sh = SpreadsheetApp.getActive().getSheetByName(TAB.ALERTS);
  const now = nowStr_();
  const ref = refPlatform_();
  const tracked = trackedSkus_().map(r => r.SKU);
  const data = sh.getDataRange().getValues();
  const col = {};
  ALERT_HEADERS.forEach((h, i) => { col[h] = i; });
  const byKey = {};
  for (let i = 1; i < data.length; i++) {
    byKey[[data[i][col.SKU], data[i][col.Platform], data[i][col.Pincode]].join('|')] = i;
  }

  const changed = [];
  const amazonMissing = [];
  const cheaperKeys = {};

  tracked.forEach(sku => {
    const amz = stateGet_(state, sku, ref, '');
    const amzOk = isPriced_(amz);
    if (amz && !amzOk) {
      amazonMissing.push({ sku: sku, name: amz['Product Name'],
        reason: amz['Fetch Status'] === 'OK' ? (amz['Error'] || 'No price shown') : amz['Fetch Status'] + ': ' + amz['Error'] });
    }
    Object.keys(state).forEach(key => {
      const s = state[key];
      if (s.SKU !== sku || s.Platform === ref) return;
      const name = platformName_(s.Platform);
      const aKey = [sku, name, s.Pincode].join('|');
      const comparable = amzOk && isPriced_(s);
      const cheaper = comparable && s['In Stock'] !== 'N' && s['Selling Price'] < amz['Selling Price'];
      const i = byKey[aKey];
      if (cheaper) {
        cheaperKeys[aKey] = true;
        const pp = s['Selling Price'], ap = amz['Selling Price'];
        const diff = round2_(ap - pp), pct = round2_((ap - pp) / ap * 100);
        let row = i !== undefined ? data[i] : null;
        let tag = null;
        if (!row) {
          row = Array(ALERT_HEADERS.length).fill('');
          row[col['First Seen']] = now;
          byKey[aKey] = data.length;
          data.push(row);
          tag = 'NEW';
        } else if (row[col.Status] !== 'ACTIVE') {
          row[col['First Seen']] = now;
          tag = 'NEW';
        } else if (row[col['Emailed Platform Price']] !== pp || row[col['Emailed Amazon Price']] !== ap) {
          tag = 'CHANGED';
        }
        row[col.Status] = 'ACTIVE';
        row[col['Last Seen']] = now;
        row[col.SKU] = sku;
        row[col['Product Name']] = s['Product Name'];
        row[col.Platform] = name;
        row[col.Pincode] = s.Pincode;
        row[col['Platform Price']] = pp;
        row[col['Amazon.in Price']] = ap;
        row[col['Difference ₹']] = diff;
        row[col['Difference %']] = pct;
        row[col['Platform URL']] = s['Product URL'];
        row[col['Amazon.in URL']] = amz['Product URL'];
        if (tag) changed.push({ tag: tag, row: row });
      } else if (i !== undefined && data[i][col.Status] === 'ACTIVE' && comparable) {
        // Only close a case when both prices were actually read this time.
        data[i][col.Status] = 'RESOLVED';
        data[i][col['Last Seen']] = now;
      }
    });
  });

  const body = data.slice(1);
  // ACTIVE cases on top. `changed` holds references to these same row arrays,
  // so sendAlertEmail_ can update them after sorting.
  body.sort((a, b) => (a[col.Status] === 'ACTIVE' ? 0 : 1) - (b[col.Status] === 'ACTIVE' ? 0 : 1));
  sh.getRange(2, 1, Math.max(sh.getMaxRows() - 1, 1), ALERT_HEADERS.length).clearContent().setBackground(null);
  if (body.length) {
    sh.getRange(2, 1, body.length, ALERT_HEADERS.length).setValues(body);
    sh.getRange(2, col['Platform Price'] + 1, body.length, 3).setNumberFormat('₹#,##0.00');
    sh.getRange(2, col['Difference %'] + 1, body.length, 1).setNumberFormat('0.00"%"');
    const bgs = body.map(r => Array(ALERT_HEADERS.length).fill(r[col.Status] === 'ACTIVE' ? COLOR.RED : null));
    sh.getRange(2, 1, body.length, ALERT_HEADERS.length).setBackgrounds(bgs);
  }
  return { changed: changed, amazonMissing: amazonMissing, sheet: sh, body: body, col: col };
}

function sendAlertEmail_(info) {
  if (!info.changed.length) return false;
  if (MailApp.getRemainingDailyQuota() < 3) return false;
  const c = info.col;
  const rows = info.changed.map(x => ({
    tag: x.tag, sku: x.row[c.SKU], name: x.row[c['Product Name']], platform: x.row[c.Platform],
    pincode: x.row[c.Pincode], pp: x.row[c['Platform Price']], ap: x.row[c['Amazon.in Price']],
    diff: x.row[c['Difference ₹']], pct: x.row[c['Difference %']],
    purl: x.row[c['Platform URL']], aurl: x.row[c['Amazon.in URL']],
  }));
  const html = '<p>' + rows.length + ' new or changed case(s) where a platform is cheaper than Amazon.in:</p>' +
    alertTable_(rows) + amazonMissingHtml_(info.amazonMissing) + footer_();
  MailApp.sendEmail({ to: alertEmail_(), subject: '[Price Alert] ' + rows.length +
      ' SKU/platform cheaper than Amazon.in - ' + nowStr_(), htmlBody: html });

  // remember what was emailed so the same case is not re-sent every run
  const now = nowStr_();
  info.changed.forEach(x => {
    x.row[c['Last Emailed']] = now;
    x.row[c['Emailed Platform Price']] = x.row[c['Platform Price']];
    x.row[c['Emailed Amazon Price']] = x.row[c['Amazon.in Price']];
  });
  if (info.body.length) info.sheet.getRange(2, 1, info.body.length, ALERT_HEADERS.length).setValues(info.body);
  return true;
}

function alertTable_(rows) {
  const th = 'style="background:#1f3a5f;color:#fff;padding:6px 8px;text-align:left;font-size:12px"';
  const td = 'style="padding:6px 8px;border-bottom:1px solid #ddd;font-size:12px"';
  let h = '<table style="border-collapse:collapse;font-family:Arial">' +
    '<tr>' + ['', 'SKU', 'Product', 'Platform', 'Pincode', 'Platform price', 'Amazon.in price', 'Diff ₹', 'Diff %', 'Links']
      .map(x => '<th ' + th + '>' + x + '</th>').join('') + '</tr>';
  rows.forEach(r => {
    h += '<tr>' + [r.tag ? '<b>' + r.tag + '</b>' : '', r.sku, esc_(r.name), r.platform, r.pincode || '-',
      '<b style="color:#c00">' + rupee_(r.pp) + '</b>', rupee_(r.ap), rupee_(r.diff), r.pct + '%',
      '<a href="' + r.purl + '">' + r.platform + '</a> | <a href="' + r.aurl + '">Amazon</a>']
      .map(x => '<td ' + td + '>' + x + '</td>').join('') + '</tr>';
  });
  return h + '</table>';
}

function amazonMissingHtml_(list) {
  if (!list.length) return '';
  return '<p style="margin-top:18px"><b>Amazon.in price could not be read for these SKUs, so they were not compared:</b></p><ul>' +
    list.map(a => '<li>' + a.sku + ' - ' + esc_(a.name) + ': ' + esc_(a.reason) + '</li>').join('') + '</ul>';
}

function footer_() {
  return '<p style="color:#777;font-size:11px;margin-top:18px">Sheet: <a href="' +
    SpreadsheetApp.getActive().getUrl() + '">open price tracker</a></p>';
}

/* ---------------------------------------------------------------- Latest */

function buildLatest_(state, platforms, finished) {
  const sh = SpreadsheetApp.getActive().getSheetByName(TAB.LATEST);
  const ref = refPlatform_();
  const skus = trackedSkus_();
  const cols = [];
  platforms.forEach(p => {
    if (p.pincodes && p.pincodes.length) p.pincodes.forEach(pin => cols.push({ key: p.key, pin: String(pin), label: p.name + '\n' + pin }));
    else cols.push({ key: p.key, pin: '', label: p.name });
  });
  const head = ['SKU', 'Product Name', 'MRP'].concat(cols.map(c => c.label));
  const width = head.length;

  const vals = [], bgs = [], lines = [], fonts = [], notes = [];
  skus.forEach(s => {
    const amz = stateGet_(state, s.SKU, ref, '');
    const amzPrice = isPriced_(amz) ? amz['Selling Price'] : null;
    const v = [s.SKU, s['Product Name'], Number(s['MRP (INR)']) || s['MRP (INR)']];
    const b = [null, null, null], l = ['none', 'none', 'none'], f = ['#000000', '#000000', '#000000'], n = ['', '', ''];
    cols.forEach(c => {
      const st = stateGet_(state, s.SKU, c.key, c.pin);
      let val = '—', bg = null, line = 'none', font = '#999999', note = '';
      if (st) {
        const status = st['Fetch Status'];
        const url = st['Product URL'];
        note = 'Fetched: ' + fmtTs_(st['Timestamp (IST)']) + (st.Seller ? '\nSeller: ' + st.Seller : '') +
          (st.MRP ? '\nMRP: ₹' + st.MRP : '') + (st['Discount %'] ? '  (' + st['Discount %'] + '% off)' : '') +
          (st.Error ? '\nNote: ' + st.Error : '');
        if (status === 'OK' && typeof st['Selling Price'] === 'number') {
          val = url ? '=HYPERLINK("' + url + '",' + st['Selling Price'] + ')' : st['Selling Price'];
          font = '#000000';
          if (st['In Stock'] === 'N') { line = 'line-through'; font = '#777777'; note = 'OUT OF STOCK\n' + note; }
          else if (c.key !== ref && amzPrice !== null && st['Selling Price'] < amzPrice) {
            bg = COLOR.RED; note = 'Cheaper than Amazon.in by ₹' + round2_(amzPrice - st['Selling Price']) + '\n' + note;
          }
        } else if (status === 'OK') {
          val = url ? '=HYPERLINK("' + url + '","OOS")' : 'OOS';
          font = '#777777';
        } else if (status === 'NOT_FOUND') {
          val = 'Not found'; font = '#999999';
        } else {
          val = status; bg = COLOR.GREY; font = '#444444';
        }
      }
      v.push(val); b.push(bg); l.push(line); f.push(font); n.push(note);
    });
    vals.push(v); bgs.push(b); lines.push(l); fonts.push(f); notes.push(n);
  });

  sh.clear();                       // clears cells only; the Check now button (an image) stays
  sh.setRowHeight(1, 50);
  sh.getRange(1, 1).setValue('Last updated: ' + finished + ' IST').setFontWeight('bold').setFontSize(12)
    .setVerticalAlignment('middle');
  sh.getRange(2, 1).setValue('Red = cheaper than Amazon.in  |  Grey = fetch failed / blocked  |  ' +
    'Strikethrough or OOS = out of stock  |  — = no ID / not listed  |  Click a price to open the product. ' +
    'Hover a cell for seller, MRP and errors.').setFontColor('#555555');
  sh.getRange(4, 1, 1, width).setValues([head]);
  styleHeader_(sh, width, 4);
  if (vals.length) {
    const r = sh.getRange(5, 1, vals.length, width);
    r.setValues(vals).setBackgrounds(bgs).setFontLines(lines).setFontColors(fonts).setNotes(notes);
    sh.getRange(5, 3, vals.length, width - 2).setNumberFormat('₹#,##0.00').setHorizontalAlignment('right');
    sh.getRange(5, 3, vals.length, 1).setNumberFormat('₹#,##0');
  }
  sh.setFrozenRows(4);
  sh.setFrozenColumns(2);
  sh.setColumnWidth(1, 90);
  sh.setColumnWidth(2, 220);
  for (let i = 3; i <= width; i++) sh.setColumnWidth(i, 105);
}

/* -------------------------------------------------------- Run Log/health */

function writeRunLog_(run) {
  const sh = SpreadsheetApp.getActive().getSheetByName(TAB.RUNLOG);
  const rows = Object.keys(run.stats || {}).map(k => {
    const s = run.stats[k];
    const result = s.total === 0 ? 'NO ITEMS' : (s.OK > 0 ? 'OK' : 'FAILED');
    return [run.finished, run.id, run.trigger, run.duration_s, platformName_(k), s.OK, s.NOT_FOUND,
      s.BLOCKED, s.ERROR, s.total, result];
  });
  if (!rows.length) return [];
  const start = sh.getLastRow() + 1;
  sh.getRange(start, 1, rows.length, RUNLOG_HEADERS.length).setValues(rows);
  sh.getRange(start, 1, rows.length, RUNLOG_HEADERS.length)
    .setBackgrounds(rows.map(r => Array(RUNLOG_HEADERS.length).fill(r[10] === 'FAILED' ? COLOR.GREY : null)));

  // which platforms have failed the last HEALTH_FAIL_RUNS runs in a row?
  const last = sh.getRange(Math.max(2, sh.getLastRow() - 400), 1,
    Math.min(401, sh.getLastRow() - 1), RUNLOG_HEADERS.length).getValues();
  return rows.map(r => r[4]).filter(name => {
    const mine = last.filter(x => x[4] === name && x[10] !== 'NO ITEMS').slice(-HEALTH_FAIL_RUNS);
    return mine.length === HEALTH_FAIL_RUNS && mine.every(x => x[10] === 'FAILED');
  }).concat(rows.filter(r => r[10] === 'OK').map(r => '+' + r[4]));   // '+name' = recovered
}

function checkHealth_(list) {
  const props = PropertiesService.getScriptProperties();
  const toWarn = [];
  list.forEach(item => {
    if (item.charAt(0) === '+') { props.deleteProperty('HEALTH_' + item.slice(1)); return; }
    if (!props.getProperty('HEALTH_' + item)) { toWarn.push(item); props.setProperty('HEALTH_' + item, nowStr_()); }
  });
  if (!toWarn.length || MailApp.getRemainingDailyQuota() < 3) return;
  const sh = SpreadsheetApp.getActive().getSheetByName(TAB.HISTORY);
  const recent = sh.getRange(Math.max(2, sh.getLastRow() - 300), 1, Math.min(301, Math.max(sh.getLastRow() - 1, 1)),
    HISTORY_HEADERS.length).getValues();
  const html = '<p>These platforms returned <b>no prices for ' + HEALTH_FAIL_RUNS +
    ' runs in a row</b>. Their adapter likely needs fixing (site layout change or the site is blocking the fetcher):</p><ul>' +
    toWarn.map(name => {
      const errs = recent.filter(r => r[4] === name).slice(-3).map(r => r[13] + ': ' + r[14]);
      return '<li><b>' + name + '</b><br><span style="color:#555;font-size:12px">' +
        errs.map(esc_).join('<br>') + '</span></li>';
    }).join('') + '</ul><p>You will get this email once per problem; it resets when the platform works again.</p>' + footer_();
  MailApp.sendEmail({ to: alertEmail_(), subject: '[Price Tracker] Platform needs attention: ' + toWarn.join(', '),
    htmlBody: html });
}

function pruneHistoryDaily_() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('LAST_PRUNE') === today_()) return;
  props.setProperty('LAST_PRUNE', today_());
  const sh = SpreadsheetApp.getActive().getSheetByName(TAB.HISTORY);
  if (sh.getLastRow() < 3) return;
  const cutoff = Utilities.formatDate(new Date(Date.now() - HISTORY_KEEP_DAYS * 864e5), TZ, 'yyyy-MM-dd');
  const ts = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getDisplayValues();
  let n = 0;
  while (n < ts.length && ts[n][0].slice(0, 10) < cutoff) n++;
  if (n > 0) sh.deleteRows(2, n);
}

/* --------------------------------------------------------- daily summary */

function dailySummary() {
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(TAB.ALERTS);
  const data = sh.getDataRange().getValues();
  const c = {};
  ALERT_HEADERS.forEach((h, i) => { c[h] = i; });
  const active = data.slice(1).filter(r => r[c.Status] === 'ACTIVE').map(r => ({
    tag: '', sku: r[c.SKU], name: r[c['Product Name']], platform: r[c.Platform], pincode: r[c.Pincode],
    pp: r[c['Platform Price']], ap: r[c['Amazon.in Price']], diff: r[c['Difference ₹']], pct: r[c['Difference %']],
    purl: r[c['Platform URL']], aurl: r[c['Amazon.in URL']],
  }));

  const stateSh = ss.getSheetByName(TAB.STATE);
  const st = stateSh.getDataRange().getValues();
  const ref = refPlatform_();
  const amazonMissing = st.slice(1).filter(r => r[STATE_HEADERS.indexOf('Platform')] === ref &&
    !(r[STATE_HEADERS.indexOf('Fetch Status')] === 'OK' && typeof r[STATE_HEADERS.indexOf('Selling Price')] === 'number'))
    .map(r => ({ sku: r[STATE_HEADERS.indexOf('SKU')], name: r[STATE_HEADERS.indexOf('Product Name')],
      reason: r[STATE_HEADERS.indexOf('Fetch Status')] + ' ' + r[STATE_HEADERS.indexOf('Error')] }));

  const props = PropertiesService.getScriptProperties().getProperties();
  const unhealthy = Object.keys(props).filter(k => k.indexOf('HEALTH_') === 0).map(k => k.slice(7));
  const lastRun = ss.getSheetByName(TAB.LATEST).getRange(1, 1).getValue();

  let html = '<p><b>Daily summary</b> - ' + nowStr_() + ' IST<br><span style="color:#555">' + lastRun + '</span></p>';
  html += active.length
    ? '<p>' + active.length + ' active case(s) cheaper than Amazon.in:</p>' + alertTable_(active)
    : '<p>No SKU is currently cheaper than Amazon.in on any tracked platform.</p>';
  html += amazonMissingHtml_(amazonMissing);
  if (unhealthy.length) html += '<p style="color:#a00"><b>Platforms currently failing:</b> ' + unhealthy.join(', ') + '</p>';
  MailApp.sendEmail({ to: alertEmail_(), subject: '[Price Tracker] Daily summary - ' + active.length +
      ' active case(s) - ' + today_(), htmlBody: html + footer_() });
}

/* --------------------------------------------------------------- helpers */

function ensureTab_(name, headers) {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    if (headers) {
      sh.getRange(1, 1, 1, headers.length).setValues([headers]);
      styleHeader_(sh, headers.length);
      sh.setFrozenRows(1);
    }
  }
  return sh;
}

function styleHeader_(sh, width, row) {
  sh.getRange(row || 1, 1, 1, width).setFontWeight('bold').setFontColor('#ffffff')
    .setBackground(COLOR.HEADER).setWrap(true).setVerticalAlignment('middle');
}

function platforms_() {
  return JSON.parse(PropertiesService.getScriptProperties().getProperty('PLATFORMS') || '[]');
}

function platformName_(key) {
  const p = platforms_().find(x => x.key === key);
  return p ? p.name : key;
}

function alertEmail_() {
  return PropertiesService.getScriptProperties().getProperty('ALERT_EMAIL') || DEFAULT_EMAIL;
}

function num_(v) { return v === null || v === undefined ? '' : v; }
function round2_(v) { return Math.round(v * 100) / 100; }
function rupee_(v) { return typeof v === 'number' ? '₹' + v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : v; }
function esc_(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function fmtTs_(v) { return v instanceof Date ? Utilities.formatDate(v, TZ, 'yyyy-MM-dd HH:mm') : String(v); }
function nowStr_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss'); }
function today_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'); }

// Image of the green "Check prices now" button (PNG, base64).
const BUTTON_PNG = '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';
