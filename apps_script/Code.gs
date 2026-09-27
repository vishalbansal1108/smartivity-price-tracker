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
    .addItem('1. Set up tabs & daily summary', 'setup')
    .addItem('2. Show connection details (for GitHub)', 'showConnectionDetails')
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

/** IDs found by name search are written into the SKUs tab (yellow) so you can check them. */
function writeDiscoveredIds_(results, platforms) {
  const found = results.filter(r => r.id_discovered && r.platform_id);
  if (!found.length) return;
  const sh = SpreadsheetApp.getActive().getSheetByName(TAB.SKUS);
  const data = sh.getDataRange().getDisplayValues();
  const head = data[0];
  found.forEach(r => {
    const pl = platforms.find(x => x.key === r.platform);
    const col = pl ? head.indexOf(pl.id_column) : -1;
    const row = data.findIndex((d, i) => i > 0 && d[0] === r.sku);
    if (col < 0 || row < 0 || data[row][col]) return;
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

  sh.clear();
  sh.getRange(1, 1).setValue('Last updated: ' + finished + ' IST').setFontWeight('bold').setFontSize(12);
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
