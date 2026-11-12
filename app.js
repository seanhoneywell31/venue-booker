/* Booking Radar: app.js
   Runs in the browser. Reads the shortlist, checks the titles with Wikipedia,
   and shows the results. All text from the user or from an API is placed on the
   page with textContent (never innerHTML), so typed text cannot run as code. */
(function () {
  'use strict';

  // ---------- Settings that rarely change ----------
  var MAX_ARTISTS = 10;
  var TIMEOUT_MS = 8000;                       // give up on a request after 8 seconds
  var WIKI = 'https://en.wikipedia.org';
  var ACTION_API = WIKI + '/w/api.php';
  var PAGEVIEWS_API = 'https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia.org/all-access/user/';
  var STORE = { shortlist: 'bookingRadar.shortlist', settings: 'bookingRadar.settings' };

  // Editable thresholds (design assumptions, not fitted values).
  var DEFAULTS = { risingPct: 20, fadingPct: 20, minViews: 20 };
  var LIMITS = {
    risingPct: { min: 1, max: 500, label: 'Rising threshold' },
    fadingPct: { min: 1, max: 99, label: 'Fading threshold' },
    minViews: { min: 0, max: 100000, label: 'Minimum traffic' }
  };

  var state = { rows: [], busy: false, settings: null };

  // ---------- Small helpers ----------
  function $(id) { return document.getElementById(id); }

  // Build an element. Strings become text nodes, so they are never parsed as HTML.
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (attrs[k] === null || attrs[k] === undefined || attrs[k] === false) return;
        if (k === 'text') node.textContent = attrs[k];
        else if (k === 'className') node.className = attrs[k];
        else node.setAttribute(k, attrs[k]);
      });
    }
    (children || []).forEach(function (c) {
      if (c === null || c === undefined) return;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }

  function link(href, text) {
    return el('a', { href: href, target: '_blank', rel: 'noopener noreferrer', text: text });
  }

  function load(key, fallback) {
    try { var v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); }
    catch (e) { return fallback; }
  }
  function save(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch (e) { return false; }   // private mode or storage full: the tool still works, it just won't remember
  }

  function articleUrl(title) {
    return WIKI + '/wiki/' + encodeURIComponent(title.replace(/ /g, '_'));
  }

  // Wikimedia's own Pageviews tool, so the booker can check our numbers.
  function pageviewsToolUrl(title, startMs, endMs) {
    return 'https://pageviews.wmcloud.org/?' + new URLSearchParams({
      project: 'en.wikipedia.org', platform: 'all-access', agent: 'user',
      start: Trend.isoDay(startMs), end: Trend.isoDay(endMs), pages: title.replace(/ /g, '_')
    }).toString();
  }

  function fmtNum(x) {
    return Number(x).toLocaleString('en-US', { maximumFractionDigits: Number.isInteger(x) ? 0 : 1 });
  }
  function fmtPct(x) { return (x > 0 ? '+' : '') + x.toFixed(1) + '%'; }

  // ---------- Settings ----------
  function loadSettings() {
    var s = load(STORE.settings, {}) || {};
    var out = {};
    Object.keys(DEFAULTS).forEach(function (k) {
      var v = Number(s[k]);
      out[k] = (isFinite(v) && v >= LIMITS[k].min && v <= LIMITS[k].max) ? v : DEFAULTS[k];
    });
    return out;
  }

  function showSettings() {
    Object.keys(DEFAULTS).forEach(function (k) { $('set-' + k).value = state.settings[k]; });
  }

  function readSettingsForm() {
    var problems = [], next = {};
    Object.keys(DEFAULTS).forEach(function (k) {
      var raw = $('set-' + k).value.trim(), v = Number(raw), lim = LIMITS[k];
      if (raw === '' || !isFinite(v) || v < lim.min || v > lim.max) {
        problems.push(lim.label + ' must be a number from ' + lim.min + ' to ' + lim.max + '.');
        next[k] = state.settings[k];
      } else next[k] = v;
    });
    var box = $('settings-msg');
    box.textContent = problems.length ? problems.join(' ') + ' Kept the previous value.' : 'Saved. Results updated.';
    box.className = problems.length ? 'small row-error' : 'small';
    state.settings = next;
    save(STORE.settings, next);
    renderTable();
  }

  // Wikimedia asks browser apps to identify themselves with this header.
  function apiUserAgent() {
    return 'BookingRadar/1.0 (MIS 480S student project; ' + location.origin + ')';
  }

  // ---------- Input checks (no network needed) ----------
  var FORBIDDEN = /[#<>\[\]|{}\u0000-\u001f\u007f]/;

  // Turn one line of the box into a candidate title, or explain why it can't be one.
  function cleanLine(line) {
    var s = line.trim();
    if (!s) return null;
    var m = s.match(/^https?:\/\/en\.(?:m\.)?wikipedia\.org\/wiki\/([^?#]+)/i);
    if (m) {
      try { s = decodeURIComponent(m[1]); } catch (e) { s = m[1]; }
    } else if (/^https?:\/\//i.test(s)) {
      return { error: 'is a web address, but not an English Wikipedia article. Paste the article title or its en.wikipedia.org address.' };
    }
    s = s.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
    if (FORBIDDEN.test(s)) return { error: 'is not a valid Wikipedia title (titles cannot contain # < > [ ] | { }). Remove those characters.' };
    if (s.length > 255) return { error: 'is longer than any Wikipedia title (255 characters). Check what was pasted.' };
    // Wikipedia treats the first letter as a capital.
    return { title: s.charAt(0).toUpperCase() + s.slice(1) };
  }

  function parseShortlist(text) {
    var lines = text.split(/\r?\n/);
    var titles = [], messages = [], seen = {};
    lines.forEach(function (line, i) {
      var c = cleanLine(line);
      if (!c) return;
      var shown = line.trim().length > 60 ? line.trim().slice(0, 57) + '...' : line.trim();
      if (c.error) { messages.push({ type: 'error', text: 'Line ' + (i + 1) + ': "' + shown + '" ' + c.error }); return; }
      var key = c.title.toLowerCase();
      if (seen[key]) { messages.push({ type: 'note', text: 'Line ' + (i + 1) + ': "' + c.title + '" is already on the list, so it was skipped.' }); return; }
      seen[key] = true;
      titles.push({ input: line.trim(), title: c.title });
    });
    return { titles: titles, messages: messages, tooMany: titles.length > MAX_ARTISTS };
  }

  function showMessages(list) {
    var ul = $('input-messages');
    ul.textContent = '';
    list.forEach(function (m) { ul.appendChild(el('li', { className: m.type, text: m.text })); });
  }

  function updateCount() {
    var parsed = parseShortlist($('artists').value);
    var n = parsed.titles.length;
    var count = $('count');
    count.textContent = n + ' / ' + MAX_ARTISTS + (parsed.tooMany ? ': remove ' + (n - MAX_ARTISTS) + ' to continue' : '');
    count.className = parsed.tooMany ? 'count over' : 'count';
    $('check').disabled = state.busy || n === 0 || parsed.tooMany;
    return parsed;
  }

  // ---------- Network: one helper for every request ----------
  function LiveError(kind, message) { this.kind = kind; this.message = message; }

  function fetchWithTimeout(url, withHeader) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, TIMEOUT_MS);
    var opts = { signal: ctrl.signal };
    if (withHeader) opts.headers = { 'Api-User-Agent': apiUserAgent() };
    return fetch(url, opts).finally(function () { clearTimeout(timer); });
  }

  // Returns {data} or {notFound:true}; throws LiveError when the service cannot be used.
  async function fetchJson(url) {
    var res;
    try {
      res = await fetchWithTimeout(url, true);
    } catch (e) {
      if (e && e.name === 'AbortError') throw new LiveError('timeout', 'no answer within ' + (TIMEOUT_MS / 1000) + ' seconds');
      try {
        res = await fetchWithTimeout(url, false);   // retry once without the custom header
      } catch (e2) {
        throw new LiveError(e2 && e2.name === 'AbortError' ? 'timeout' : 'network',
          e2 && e2.name === 'AbortError' ? 'no answer within ' + (TIMEOUT_MS / 1000) + ' seconds' : 'service unreachable');
      }
    }
    if (res.status === 404) return { notFound: true };
    if (!res.ok) throw new LiveError('http', 'service answered with error ' + res.status);
    try { return { data: await res.json() }; }
    catch (e) { throw new LiveError('format', 'service sent data in an unexpected format'); }
  }

  // ---------- Step 2 of the workflow: resolve titles with one batched request ----------
  async function resolveTitles(items) {
    var params = new URLSearchParams({
      action: 'query', format: 'json', formatversion: '2', origin: '*',
      redirects: '1', prop: 'pageprops', ppprop: 'disambiguation',
      titles: items.map(function (i) { return i.title; }).join('|')
    });
    var r;
    try {
      r = await fetchJson(ACTION_API + '?' + params.toString());
    } catch (e) {
      // Fail safely: keep going with the titles as typed and say so.
      return { verified: false, reason: e.message, items: items.map(function (i) {
        return { input: i.input, title: i.title, resolved: i.title, redirectedFrom: null, status: 'unverified' };
      }) };
    }
    var q = (r.data && r.data.query) || {};
    var norm = {}, redir = {}, pages = {};
    (q.normalized || []).forEach(function (n) { norm[n.from] = n.to; });
    (q.redirects || []).forEach(function (n) { redir[n.from] = n.to; });
    (q.pages || []).forEach(function (p) { pages[p.title] = p; });

    return { verified: true, items: items.map(function (i) {
      var t = norm[i.title] || i.title;
      var target = redir[t];
      var resolved = target || t;
      var p = pages[resolved];
      var status = 'ok';
      if (!p || p.missing) status = 'missing';
      else if (p.invalid) status = 'invalid';
      else if (p.ns !== 0) status = 'notarticle';
      else if (p.pageprops && Object.prototype.hasOwnProperty.call(p.pageprops, 'disambiguation')) status = 'disambiguation';
      return { input: i.input, title: i.title, resolved: resolved, redirectedFrom: target ? t : null, status: status };
    }) };
  }

  function titleProblem(row) {
    switch (row.status) {
      case 'missing': return 'No English Wikipedia article has this exact title. Check the spelling, or copy the title from the article\'s address bar.';
      case 'invalid': return 'Wikipedia says this is not a valid title.';
      case 'notarticle': return 'This page is not an article (it belongs to another part of Wikipedia). Use the artist\'s article title.';
      case 'disambiguation': return 'This is a disambiguation page: several topics share the name. Open it and pick the artist\'s article, for example a title ending in "(band)" or "(musician)".';
      default: return null;
    }
  }

  // ---------- Step 3 of the workflow: fetch daily page views for one artist ----------
  function fetchWindow() {
    var now = Date.now();
    var today = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
    var end = today - Trend.DAY;                                   // yesterday (UTC)
    var startYear = new Date(today - 7 * Trend.DAY).getUTCFullYear() - 3;
    return { start: Trend.dayMs(startYear, 1, 1), end: end };      // three full years plus this year
  }

  async function fetchSeries(title) {
    var w = fetchWindow();
    var url = PAGEVIEWS_API + encodeURIComponent(title.replace(/ /g, '_')) +
      '/daily/' + Trend.compactDay(w.start) + '/' + Trend.compactDay(w.end);
    var r = await fetchJson(url);              // throws LiveError if the service is down
    if (r.notFound) return { series: null };
    return { series: Trend.seriesFromItems((r.data && r.data.items) || [], w.start) };
  }

  // ---------- Rendering ----------
  var COLUMNS = ['#', 'Artist', 'Trend (F1)', 'Median views per day (F2)', 'Seasonal peak (F3)', 'Data'];

  function seasonCell(row) {
    if (!row.analysis) return [];
    var s = row.analysis.season;
    var detail = s.years.map(function (y) {
      return y.year + ': ' + (y.qualifies ? Trend.MONTHS[y.month].slice(0, 3) : 'no clear peak');
    }).join(', ');
    if (s.status === 'short') return [el('span', { className: 'small', text: 'Not enough full years of data' })];
    if (s.status === 'none') return [el('span', { text: 'No repeating peak month' }), el('div', { className: 'small', text: detail })];
    return [el('strong', { text: 'Peaks in ' + Trend.MONTHS[s.month] }),
      el('div', { className: 'small', text: s.count + ' of ' + s.of + ' years. ' + detail })];
  }

  function analyzeRow(row) {
    row.analysis = row.series ? Trend.analyze(row.series, state.settings) : null;
    return row;
  }

  // Labeled rows first, highest change on top; everything else keeps its input order.
  function sortedRows() {
    var labeled = [], other = [];
    state.rows.forEach(function (r, i) {
      r.order = i;
      if (r.analysis && r.analysis.trend.label) labeled.push(r); else other.push(r);
    });
    labeled.sort(function (a, b) { return b.analysis.trend.changePct - a.analysis.trend.changePct || a.order - b.order; });
    return { labeled: labeled, other: other };
  }

  var BADGE = { Rising: 'ok', Steady: 'flat', Fading: 'warn' };

  function trendCell(row) {
    if (titleProblem(row)) return [el('span', { className: 'badge bad', text: 'Title problem' }), el('div', { className: 'row-error', text: titleProblem(row) })];
    if (row.dataError) return [el('span', { className: 'badge bad', text: 'No data' }), el('div', { className: 'row-error', text: row.dataError })];
    if (!row.analysis) return [el('span', { className: 'small', text: 'Waiting...' })];
    var t = row.analysis.trend;
    if (t.status === 'low') return [el('span', { className: 'badge flat', text: 'No label' }),
      el('div', { className: 'small', text: 'Too little traffic: under ' + state.settings.minViews + ' views a day in both periods.' })];
    if (t.status === 'new') return [el('span', { className: 'badge flat', text: 'No label' }),
      el('div', { className: 'small', text: 'Not enough history: fewer than ' + Trend.MIN_HISTORY + ' days of data a year ago (the article may be new).' })];
    return [el('span', { className: 'badge ' + BADGE[t.label], text: t.label }), ' ', el('strong', { text: fmtPct(t.changePct) })];
  }

  function mediansCell(row) {
    if (!row.analysis) return [];
    var t = row.analysis.trend;
    return [
      el('div', null, [el('strong', { text: fmtNum(t.medRecent) }), ' now vs ', el('strong', { text: fmtNum(t.medPrior) }), ' a year ago']),
      el('div', { className: 'small', text: Trend.niceRange(t.recentStart, t.recentEnd) + ' vs ' + Trend.niceRange(t.priorStart, t.priorEnd) })
    ];
  }

  function dataCell(row) {
    if (!row.analysis) return [];
    var t = row.analysis.trend;
    return [
      el('div', { text: 'Live, through ' + Trend.niceDay(t.dataThrough) }),
      el('div', { className: 'small' }, [link(pageviewsToolUrl(row.resolved, t.priorStart, t.dataThrough), 'Verify in Pageviews tool')])
    ];
  }

  function renderTable() {
    var thead = $('results').tHead, tbody = $('results').tBodies[0];
    thead.textContent = ''; tbody.textContent = '';
    if (!state.rows.length) return;
    state.rows.forEach(function (r) { if (r.series) analyzeRow(r); });
    thead.appendChild(el('tr', null, COLUMNS.map(function (c) { return el('th', { scope: 'col', text: c }); })));
    var groups = sortedRows();
    groups.labeled.concat(groups.other).forEach(function (row) {
      var rank = groups.labeled.indexOf(row);
      var titleOk = !titleProblem(row);
      var artist = [
        titleOk ? link(articleUrl(row.resolved), row.resolved) : el('span', { text: row.input }),
        row.redirectedFrom ? el('div', { className: 'small', text: 'Redirected from "' + row.redirectedFrom + '"' }) : null,
        row.status === 'unverified' ? el('div', { className: 'small', text: 'Title not verified; used as typed.' }) : null
      ];
      tbody.appendChild(el('tr', null, [
        el('td', { 'data-label': '#', className: 'num', text: rank >= 0 ? String(rank + 1) : '' }),
        el('td', { 'data-label': COLUMNS[1] }, artist),
        el('td', { 'data-label': COLUMNS[2] }, trendCell(row)),
        el('td', { 'data-label': COLUMNS[3], className: 'num' }, mediansCell(row)),
        el('td', { 'data-label': COLUMNS[4] }, seasonCell(row)),
        el('td', { 'data-label': COLUMNS[5] }, dataCell(row))
      ]));
    });
  }

  function setBusy(b) {
    state.busy = b;
    $('artists').readOnly = b;
    updateCount();
  }

  // ---------- Main action ----------
  async function runCheck() {
    var parsed = updateCount();
    showMessages(parsed.messages);
    if (parsed.tooMany || !parsed.titles.length) return;

    setBusy(true);
    $('progress').textContent = 'Checking titles with Wikipedia...';
    try {
      var res = await resolveTitles(parsed.titles);
      // Two lines that lead to the same article are checked once.
      var seen = {}, rows = [], notes = parsed.messages.slice();
      res.items.forEach(function (r) {
        if (seen[r.resolved] && r.status === 'ok') {
          notes.push({ type: 'note', text: '"' + r.input + '" leads to the same article as "' + seen[r.resolved] + '", so it was checked once.' });
          return;
        }
        if (r.status === 'ok') seen[r.resolved] = r.input;
        rows.push(r);
      });
      showMessages(notes);
      state.rows = rows;
      renderTable();

      // Fetch one artist at a time (Wikimedia asks clients to wait for each request).
      var todo = rows.filter(function (r) { return r.status === 'ok' || r.status === 'unverified'; });
      for (var k = 0; k < todo.length; k++) {
        var row = todo[k];
        $('progress').textContent = 'Checking ' + (k + 1) + ' of ' + todo.length + ': ' + row.resolved + '...';
        try {
          var got = await fetchSeries(row.resolved);
          if (got.series) { row.series = got.series; row.source = 'live'; row.retrievedAt = new Date().toISOString(); }
          else row.dataError = 'Wikimedia has no page-view data for this exact title.';
        } catch (e) {
          row.dataError = 'Live data unavailable (' + e.message + ').';
        }
        renderTable();
      }
      var labeled = rows.filter(function (r) { return r.analysis && r.analysis.trend.label; }).length;
      $('progress').textContent = 'Done: ' + labeled + ' of ' + rows.length + ' artists labeled' +
        (res.verified ? '.' : '. The Wikipedia title service could not be reached (' + res.reason + '), so titles were used as typed.');
    } finally {
      setBusy(false);
    }
  }

  // ---------- Start-up ----------
  function init() {
    var box = $('artists');
    box.value = load(STORE.shortlist, '');
    box.addEventListener('input', function () { updateCount(); save(STORE.shortlist, box.value); });
    $('check').addEventListener('click', runCheck);
    state.settings = loadSettings();
    showSettings();
    $('save-settings').addEventListener('click', readSettingsForm);
    $('reset-settings').addEventListener('click', function () {
      state.settings = Object.assign({}, DEFAULTS);
      save(STORE.settings, state.settings);
      showSettings();
      $('settings-msg').textContent = 'Defaults restored. Results updated.';
      $('settings-msg').className = 'small';
      renderTable();
    });
    updateCount();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
