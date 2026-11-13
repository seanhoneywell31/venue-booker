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
  var STORE = { shortlist: 'bookingRadar.shortlist', settings: 'bookingRadar.settings', decisions: 'bookingRadar.decisions', lastRun: 'bookingRadar.lastRun', history: 'bookingRadar.history' };
  var SAMPLE_HISTORY_URL = 'data/sample_history.csv';
  var SNAPSHOT_URL = 'data/snapshot.json';
  var DECISIONS = [['', 'Choose...'], ['offer', 'Offer'], ['watch', 'Watch'], ['pass', 'Pass']];
  var REASON_MAX = 200;

  // Editable thresholds (design assumptions, not fitted values).
  var DEFAULTS = { risingPct: 20, fadingPct: 20, minViews: 20, spikeMultiple: 3 };
  var LIMITS = {
    risingPct: { min: 1, max: 500, label: 'Rising threshold' },
    fadingPct: { min: 1, max: 99, label: 'Fading threshold' },
    minViews: { min: 0, max: 100000, label: 'Minimum traffic' },
    spikeMultiple: { min: 1.5, max: 50, label: 'Spike multiple' }
  };

  var state = { rows: [], busy: false, settings: null, decisions: {}, snapshot: null, snapshotNote: null,
                lastRun: null, simulateOutage: false, history: null };

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

  // Edit history listed backwards from one week after the spike, so the edits
  // made around the spike are at the top. The booker reads what happened there.
  function historyUrl(title, peakDay) {
    return WIKI + '/w/index.php?' + new URLSearchParams({
      title: title.replace(/ /g, '_'), action: 'history', limit: '50',
      offset: Trend.compactDay(peakDay + 7 * Trend.DAY) + '000000'
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
    if (state.simulateOutage) throw new LiveError('test', 'test mode: live data switched off');
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
      redirects: '1', prop: 'pageprops|description', ppprop: 'disambiguation',
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

    // If no article in the batch has a short description, the service did not send them:
    // say nothing rather than warn on every row.
    var haveDescriptions = (q.pages || []).some(function (p) { return typeof p.description === 'string'; });

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
      var description = (status === 'ok' && typeof p.description === 'string' && p.description.trim()) ? p.description.trim() : null;
      var topic = null;
      if (status === 'ok' && haveDescriptions) topic = !description ? 'nodesc' : (MUSIC_WORDS.test(description) ? null : 'notmusic');
      return { input: i.input, title: i.title, resolved: resolved, redirectedFrom: target ? t : null, status: status,
               description: description, topic: topic };
    }) };
  }

  // Words that show a short description is about a musical act. A word list, so it can miss
  // or over-warn; the description itself is always shown so the booker can judge.
  var MUSIC_WORDS = /\b(band|bands|musician|musicians|music|musical|singer|singers|songwriter|rapper|vocalist|guitarist|bassist|drummer|pianist|composer|producer|dj|disc jockey|duo|trio|quartet|group|ensemble|orchestra|choir|collective|artist)\b/i;

  function topicWarning(row) {
    if (row.topic === 'notmusic') return 'Wikipedia describes this article as "' + row.description + '", which does not mention music. ' +
      'It may be a different topic with the same name. Open the link to check, or use the artist\'s full title, for example one ending in "(band)" or "(musician)".';
    if (row.topic === 'nodesc') return 'Wikipedia gives no short description for this article. Open the link to confirm it is about the artist.';
    return null;
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

  // ---------- F7: cached copy (data/snapshot.json) and data-source status ----------
  // The snapshot is a dated copy of real page views saved from the live site.
  // Each entry is checked before use, so a damaged file cannot break the page.
  function readSnapshot(json) {
    var out = { savedAt: null, artists: {} };
    if (!json || typeof json !== 'object' || typeof json.artists !== 'object' || json.artists === null) return out;
    out.savedAt = typeof json.savedAt === 'string' && !isNaN(Date.parse(json.savedAt)) ? json.savedAt : null;
    Object.keys(json.artists).forEach(function (title) {
      var a = json.artists[title];
      if (!a || typeof a.start !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(a.start) || !Array.isArray(a.views)) return;
      if (a.views.length < 1 || a.views.length > 4000) return;
      var okValues = a.views.every(function (v) { return v === null || (typeof v === 'number' && isFinite(v) && v >= 0); });
      if (!okValues) return;
      out.artists[title] = { start: a.start, views: a.views, retrievedAt: typeof a.retrievedAt === 'string' ? a.retrievedAt : null };
    });
    return out;
  }

  async function loadSnapshot() {
    try {
      var res = await fetch(SNAPSHOT_URL, { cache: 'no-cache' });
      if (!res.ok) throw new Error('missing');
      state.snapshot = readSnapshot(await res.json());
      state.snapshotNote = null;
    } catch (e) {
      state.snapshot = { savedAt: null, artists: {} };
      state.snapshotNote = location.protocol === 'file:'
        ? 'The cached copy cannot load when the page is opened as a file. Use the live site.'
        : 'The cached copy could not be loaded.';
    }
    renderStatus();
  }

  function cachedSeries(title) {
    var a = state.snapshot && state.snapshot.artists[title];
    if (!a) return null;
    return { start: Trend.parseDay(a.start), views: a.views.slice() };
  }

  function snapshotSummary() {
    if (state.snapshotNote) return state.snapshotNote;
    if (!state.snapshot) return 'Looking for a cached copy...';
    var n = Object.keys(state.snapshot.artists).length;
    if (!n) return 'No cached copy saved yet.';
    return 'Cached copy: ' + n + ' artist' + (n === 1 ? '' : 's') + (state.snapshot.savedAt ? ', saved ' + Trend.niceDay(Date.parse(state.snapshot.savedAt)) : '') + '.';
  }

  function renderStatus() {
    var box = $('status'), main = $('status-main'), sub = $('status-sub');
    var run = state.lastRun;
    var cls = 'status', text;
    if (state.busy) { text = 'Checking...'; }
    else if (!run) { text = 'Live data not checked yet.'; }
    else {
      var live = run.entries.filter(function (e) { return e.source === 'live'; }).length;
      var cached = run.entries.filter(function (e) { return e.source === 'cached'; }).length;
      var failed = run.entries.filter(function (e) { return e.liveError; }).length;
      var noData = run.entries.filter(function (e) { return !e.source; }).length;
      if (failed) {
        cls += ' warn';
        text = 'Live data unavailable for ' + failed + ' artist' + (failed === 1 ? '' : 's') + ' (' + run.firstError + '). ' +
          (cached ? 'Showing the cached copy' + (state.snapshot && state.snapshot.savedAt ? ' saved ' + Trend.niceDay(Date.parse(state.snapshot.savedAt)) : '') + ' for ' + cached + ' of them.' : 'No cached copy was available for them.');
      } else if (live) {
        cls += ' ok';
        text = 'Live data from Wikimedia, retrieved ' + fmtTime(run.at) + '. Data through ' + Trend.niceDay(run.dataThrough) + '.';
      } else {
        cls += noData ? ' bad' : '';
        text = 'No page-view data was loaded in the last check.';
      }
    }
    if (state.simulateOutage) { cls = 'status warn'; text = 'Test mode is on: live data is switched off. ' + (text || ''); }
    box.className = cls;
    main.textContent = text;
    sub.textContent = snapshotSummary();
    var log = $('run-log');
    log.textContent = '';
    (run ? run.entries : []).forEach(function (e) { log.appendChild(el('li', { text: e.text })); });
    $('run-log-wrap').hidden = !run;
    if (run) $('run-log-time').textContent = 'Last check: ' + fmtTime(run.at);
    $('save-snapshot').disabled = state.busy || !state.rows.some(function (r) { return r.source === 'live'; });
  }

  function logEntry(row) {
    var t = row.analysis && row.analysis.trend;
    var name = row.resolved || row.input, text;
    if (titleProblem(row)) text = name + ': title problem (' + row.status + '); not checked.';
    else if (row.source === 'live') text = name + ': live data, through ' + Trend.isoDay(t.dataThrough) + '.';
    else if (row.source === 'cached') text = name + ': live data failed (' + row.liveError + '); used cached copy, through ' + Trend.isoDay(t.dataThrough) + '.';
    else text = name + ': ' + (row.dataError || 'no data') ;
    if (row.topic === 'notmusic') text += ' Check title: its description does not mention music.';
    return { title: name, source: row.source || null, liveError: row.liveError || null, text: text };
  }

  function saveSnapshotFile() {
    var artists = {};
    Object.keys((state.snapshot && state.snapshot.artists) || {}).forEach(function (k) { artists[k] = state.snapshot.artists[k]; });
    var added = 0;
    state.rows.forEach(function (r) {
      if (r.source !== 'live' || !r.series) return;
      artists[r.resolved] = { start: Trend.isoDay(r.series.start), retrievedAt: r.retrievedAt, views: r.series.views };
      added++;
    });
    var file = {
      format: 1,
      note: 'Cached copy of real page views saved from Booking Radar. Used only when the live service cannot be reached.',
      source: SOURCE_TEXT,
      savedAt: new Date().toISOString(),
      artists: artists
    };
    var blob = new Blob([JSON.stringify(file)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = el('a', { href: url, download: 'snapshot.json' });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
    $('snapshot-msg').textContent = 'Downloaded snapshot.json (' + Object.keys(artists).length + ' artists, ' + added + ' from this check). ' +
      'Upload it to the data folder of the GitHub repo to update the cached copy.';
  }

  // ---------- Rendering ----------
  var COLUMNS = ['#', 'Artist', 'Trend (F1)', 'Median views per day (F2)', 'Seasonal peak (F3)', 'Spikes, last 12 months (F4)', 'Here before (F8)', 'Next step and your decision (F5)', 'Data'];

  // ---------- F5: the booker's decision, saved only in this browser ----------
  function fmtTime(iso) {
    var d = new Date(iso);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ', ' +
      d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }

  function saveDecision(title, patch, stamp) {
    var all = state.decisions;
    var cur = all[title] || { decision: '', reason: '' };
    Object.keys(patch).forEach(function (k) { cur[k] = patch[k]; });
    cur.at = new Date().toISOString();
    all[title] = cur;
    var ok = save(STORE.decisions, all);
    stamp.textContent = ok ? 'Saved ' + fmtTime(cur.at) : 'Could not save in this browser (storage blocked). Export a CSV to keep it.';
  }

  function decisionCell(row, idx) {
    if (titleProblem(row)) return [];
    var title = row.resolved, saved = state.decisions[title] || { decision: '', reason: '' };
    var suggestion = row.analysis ? el('div', { className: 'suggest', text: row.analysis.nextStep }) : null;
    var selId = 'dec-' + idx, reasonId = 'why-' + idx;
    var select = el('select', { id: selId }, DECISIONS.map(function (d) {
      return el('option', { value: d[0], text: d[1], selected: saved.decision === d[0] ? 'selected' : null });
    }));
    var reason = el('input', { id: reasonId, type: 'text', maxlength: String(REASON_MAX), value: saved.reason || '',
      placeholder: 'Reason (no personal details)', autocomplete: 'off' });
    var stamp = el('div', { className: 'small', text: saved.at ? 'Saved ' + fmtTime(saved.at) : '' });
    select.disabled = reason.disabled = state.busy;
    select.addEventListener('change', function () { saveDecision(title, { decision: select.value }, stamp); });
    var timer = null;
    reason.addEventListener('input', function () {
      clearTimeout(timer);
      timer = setTimeout(function () { saveDecision(title, { reason: reason.value.slice(0, REASON_MAX) }, stamp); }, 400);
    });
    return [suggestion, el('div', { className: 'decision' }, [
      el('label', { 'for': selId, className: 'visually-hidden', text: 'Decision for ' + title }), select,
      el('label', { 'for': reasonId, className: 'visually-hidden', text: 'Reason for ' + title }), reason
    ]), stamp];
  }

  function spikesCell(row) {
    if (!row.analysis) return [];
    var sp = row.analysis.spikes;
    if (sp.skipped) return [el('span', { className: 'small', text: 'Not checked: too little traffic or history.' })];
    if (!sp.events.length) return [el('span', { text: 'None' }), el('div', { className: 'small', text: 'No day reached ' + sp.multiple + '× the usual ' + fmtNum(sp.baseline) + ' views.' })];
    var list = el('ul', { className: 'spikes' }, sp.events.slice(0, 3).map(function (e) {
      return el('li', null, [
        el('strong', { text: Trend.niceDay(e.peakDay) }),
        ' ' + fmtNum(e.peakViews) + ' views (' + e.multiple.toFixed(1) + '×)',
        el('div', { className: 'small' }, [
          link(historyUrl(row.resolved, e.peakDay), 'Edit history'), ' · ',
          link(pageviewsToolUrl(row.resolved, e.peakDay - 14 * Trend.DAY, Math.min(e.peakDay + 14 * Trend.DAY, row.analysis.trend.dataThrough)), 'Views that month')
        ])
      ]);
    }));
    var more = sp.events.length > 3 ? el('div', { className: 'small', text: sp.events.length + ' events in 12 months; newest 3 shown.' }) : null;
    return [list, more];
  }

  function seasonCell(row) {
    if (!row.analysis) return [];
    var s = row.analysis.season;
    var anyPeak = s.years.some(function (y) { return y.qualifies; });
    var detail = anyPeak
      ? s.years.map(function (y) { return y.year + ': ' + (y.qualifies ? Trend.MONTHS[y.month].slice(0, 3) : 'no clear peak'); }).join(', ')
      : 'No month stood out in ' + s.years.map(function (y) { return y.year; }).join(', ') + '.';
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
    if (row.source === 'cached') return [
      el('span', { className: 'badge warn', text: 'Cached copy' }),
      el('div', { text: 'Through ' + Trend.niceDay(t.dataThrough) }),
      el('div', { className: 'small', text: 'Live data failed: ' + row.liveError + '.' }),
      el('div', { className: 'small' }, [link(pageviewsToolUrl(row.resolved, t.priorStart, t.dataThrough), 'Verify in Pageviews tool')])
    ];
    return [
      el('div', { text: 'Live, through ' + Trend.niceDay(t.dataThrough) }),
      el('div', { className: 'small' }, [link(pageviewsToolUrl(row.resolved, t.priorStart, t.dataThrough), 'Verify in Pageviews tool')])
    ];
  }

  // ---------- F6: CSV export ----------
  var SOURCE_TEXT = 'Wikimedia Analytics API, per-article daily page views, en.wikipedia.org, all-access, user (CC0)';

  // A text cell that starts with = + - @ (or tab/return) could run as a formula in a
  // spreadsheet. A leading apostrophe makes the spreadsheet treat it as plain text.
  function guardText(s) {
    s = String(s === null || s === undefined ? '' : s);
    return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
  }
  function csvCell(v) {
    if (typeof v === 'number') return isFinite(v) ? String(v) : '';
    return '"' + guardText(v).replace(/"/g, '""') + '"';
  }

  function labelText(row) {
    if (titleProblem(row)) return 'Title problem';
    if (row.dataError) return 'No data';
    if (!row.analysis) return '';
    var t = row.analysis.trend;
    return t.label || (t.status === 'low' ? 'No label: too little traffic' : 'No label: not enough history');
  }

  function exportRecords() {
    state.rows.forEach(function (r) { if (r.series) analyzeRow(r); });
    var g = sortedRows();
    return g.labeled.concat(g.other).map(function (row) {
      var a = row.analysis, t = a && a.trend, s = a && a.season, sp = a && a.spikes;
      var d = state.decisions[row.resolved] || {};
      var round1 = function (x) { return Math.round(x * 10) / 10; };
      return {
        rank: g.labeled.indexOf(row) >= 0 ? g.labeled.indexOf(row) + 1 : '',
        artist_input: row.input,
        wikipedia_title: row.resolved,
        label: labelText(row),
        change_pct: t && t.changePct !== null ? round1(t.changePct) : '',
        median_last_90_days: t ? t.medRecent : '',
        median_same_90_days_52_weeks_earlier: t ? t.medPrior : '',
        last_90_days: t ? Trend.isoDay(t.recentStart) + ' to ' + Trend.isoDay(t.recentEnd) : '',
        comparison_90_days: t ? Trend.isoDay(t.priorStart) + ' to ' + Trend.isoDay(t.priorEnd) : '',
        seasonal_peak: s ? (s.status === 'peak' ? Trend.MONTHS[s.month] : s.status === 'none' ? 'none' : 'not enough full years') : '',
        spike_events_12_months: sp ? (sp.skipped ? 'not checked' : sp.events.length) : '',
        spike_peaks: sp && !sp.skipped ? sp.events.map(function (e) {
          return Trend.isoDay(e.peakDay) + ' (' + e.peakViews + ' views, ' + e.multiple.toFixed(1) + 'x)';
        }).join('; ') : '',
        suggested_next_step: a ? a.nextStep : '',
        decision: d.decision || '',
        reason: d.reason || '',
        decided_at: d.at || '',
        shows_here: state.history && !titleProblem(row) ? rowShows(row).length : '',
        last_show_here: rowShows(row).length ? Trend.isoDay(rowShows(row)[0].date) : '',
        avg_sell_through_pct: rowShows(row).length ? Math.round(rowShows(row).reduce(function (s, x) { return s + History.sellThrough(x); }, 0) / rowShows(row).length * 10) / 10 : '',
        data_source: row.source === 'cached'
          ? 'cached copy' + (state.snapshot && state.snapshot.savedAt ? ' saved ' + Trend.isoDay(Date.parse(state.snapshot.savedAt)) : '')
          : (row.source || ''),
        data_through: t ? Trend.isoDay(t.dataThrough) : '',
        retrieved_at: row.retrievedAt || '',
        source: row.series ? SOURCE_TEXT : '',
        article_url: titleProblem(row) ? '' : articleUrl(row.resolved),
        note: titleProblem(row) || [topicWarning(row), row.dataError].filter(Boolean).join(' ')
      };
    });
  }

  function exportCsv() {
    var recs = exportRecords();
    if (!recs.length) return;
    var cols = Object.keys(recs[0]);
    var lines = [cols.join(',')].concat(recs.map(function (r) { return cols.map(function (c) { return csvCell(r[c]); }).join(','); }));
    var blob = new Blob(['﻿' + lines.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = el('a', { href: url, download: 'booking-radar-' + Trend.isoDay(Date.now()) + '.csv' });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
    $('export-msg').textContent = 'Exported ' + recs.length + ' rows.';
  }

  // ---------- F8: local history (the venue's past shows) and label check ----------
  function rowNames(row) { return [row.resolved, row.title, row.input, row.redirectedFrom]; }

  function rowShows(row) {
    if (!state.history || titleProblem(row)) return [];
    return History.showsFor(state.history.shows, rowNames(row));
  }

  function pct(x) { return Math.round(x) + '%'; }

  function checkText(c) {
    if (c.status === 'ok') return 'label then: ' + c.label;
    if (c.status === 'low') return 'label then: too little traffic';
    return 'label then: too early to check';
  }

  function historyCell(row) {
    if (titleProblem(row)) return [];
    if (!state.history) return [el('span', { className: 'small', text: 'No venue history loaded' })];
    var shows = rowShows(row);
    if (!shows.length) return [el('span', { className: 'small', text: 'Not in your venue history' })];
    var avg = shows.reduce(function (s, x) { return s + History.sellThrough(x); }, 0) / shows.length;
    var list = el('ul', { className: 'history-list' }, shows.slice(0, 2).map(function (sh) {
      var parts = Trend.niceDay(sh.date) + ': ' + pct(History.sellThrough(sh)) + ' sold';
      if (row.series) parts += '; ' + checkText(History.labelBefore(row.series, sh.date, state.settings));
      return el('li', { text: parts });
    }));
    return [
      el('div', { text: shows.length + (shows.length === 1 ? ' show here, ' : ' shows here, average ') + pct(avg) + ' sold' }),
      list,
      shows.length > 2 ? el('div', { className: 'small', text: (shows.length - 2) + ' older show' + (shows.length - 2 === 1 ? '' : 's') + ' not listed.' }) : null
    ];
  }

  // Every past show of an artist on this shortlist, with the label it would have had
  // when offers went out, grouped by that label.
  function labelCheckItems() {
    var items = [];
    state.rows.forEach(function (row) {
      if (!row.series) return;
      rowShows(row).forEach(function (sh) {
        items.push({ row: row, show: sh, check: History.labelBefore(row.series, sh.date, state.settings) });
      });
    });
    return items;
  }

  function renderLabelCheck() {
    var box = $('label-check'), body = $('label-check-body');
    body.textContent = '';
    if (!state.history || !state.rows.length || state.busy) { box.hidden = true; return; }
    var items = labelCheckItems();
    box.hidden = false;
    if (!items.length) {
      body.appendChild(el('p', { className: 'small', text: 'None of the artists on this shortlist appear in your venue history.' }));
      return;
    }
    var groups = History.summarize(items);
    var table = el('table', { className: 'mini' }, [
      el('thead', null, [el('tr', null, [
        el('th', { scope: 'col', text: 'Label ' + History.LEAD_DAYS + ' days before the show' }),
        el('th', { scope: 'col', text: 'Shows' }),
        el('th', { scope: 'col', text: 'Average sold' })
      ])]),
      el('tbody', null, groups.map(function (g) {
        return el('tr', null, [
          el('td', { text: g.name }),
          el('td', { className: 'num', text: String(g.n) }),
          el('td', { className: 'num', text: g.avg === null ? '' : pct(g.avg) })
        ]);
      }))
    ]);
    var checked = items.filter(function (it) { return it.check.status === 'ok'; }).length;
    body.appendChild(table);
    body.appendChild(el('p', { className: 'small', text:
      checked + ' of ' + items.length + ' past shows by artists on this shortlist could be checked. Each label is recalculated from page views up to ' +
      History.LEAD_DAYS + ' days before the show, roughly when offers go out. A handful of shows gives a pattern, not proof; if Rising acts did not sell better here, do not lean on the label.' }));
    if (state.history.source === 'sample') {
      body.appendChild(el('p', { className: 'row-error', text: 'Sample history: constructed for a fictional venue. The ticket counts are made up, so this check shows how the feature works, not whether the labels are right.' }));
    }
  }

  function historyStatus() {
    var h = state.history;
    if (!h) { $('history-status').textContent = 'No venue history loaded.'; return; }
    var acts = {};
    h.shows.forEach(function (s) { acts[History.key(s.act)] = true; });
    $('history-status').textContent = 'Loaded ' + h.shows.length + ' past show' + (h.shows.length === 1 ? '' : 's') + ' for ' +
      Object.keys(acts).length + ' act' + (Object.keys(acts).length === 1 ? '' : 's') + ' from ' +
      (h.source === 'sample' ? 'the sample file (constructed, not real sales)' : '"' + h.name + '"') +
      '. Saved in this browser only.';
  }

  function historyMessages(list) {
    var ul = $('history-messages');
    ul.textContent = '';
    list.forEach(function (m) { ul.appendChild(el('li', { className: m.type, text: m.text })); });
  }

  function todayUtc() {
    var d = new Date();
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  }

  // Reads a history file's text, keeps the valid rows, and lists the rest with line numbers.
  function acceptHistory(text, source, name) {
    var res = History.parse(text, todayUtc());
    var msgs = res.errors.slice(0, 5).map(function (e) {
      return { type: 'error', text: (e.line ? 'Line ' + e.line + ': ' : '') + e.text + (e.line ? '. Row skipped.' : '') };
    });
    if (res.errors.length > 5) msgs.push({ type: 'error', text: (res.errors.length - 5) + ' more rows had problems and were skipped.' });
    if (res.extra) msgs.push({ type: 'note', text: 'Only the first ' + History.MAX_ROWS + ' shows were loaded; ' + res.extra + ' more were ignored.' });
    if (!res.shows.length) {
      msgs.unshift({ type: 'error', text: 'No usable shows in this file, so nothing was loaded.' + (state.history ? ' Your earlier history is still in use.' : '') });
      historyMessages(msgs);
      return;
    }
    state.history = { source: source, name: name, loadedAt: new Date().toISOString(),
                      shows: res.shows.map(function (s) { return { act: s.act, date: s.date, capacity: s.capacity, sold: s.sold, guarantee: s.guarantee }; }) };
    if (!save(STORE.history, state.history)) msgs.push({ type: 'note', text: 'This browser would not save the history, so it will be gone after a reload.' });
    historyMessages(msgs);
    historyStatus();
    renderTable();
  }

  function loadHistoryFile(file) {
    if (!file) return;
    if (file.size > History.MAX_BYTES) {
      historyMessages([{ type: 'error', text: 'That file is larger than ' + Math.round(History.MAX_BYTES / 1024) + ' KB, so it was not read. A venue history should be a small CSV file.' }]);
      return;
    }
    var reader = new FileReader();
    reader.onload = function () { acceptHistory(String(reader.result), 'file', file.name.slice(0, 80)); };
    reader.onerror = function () { historyMessages([{ type: 'error', text: 'The file could not be read.' }]); };
    reader.readAsText(file);
  }

  async function loadSampleHistory() {
    try {
      var r = await fetch(SAMPLE_HISTORY_URL, { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      acceptHistory(await r.text(), 'sample', 'sample_history.csv');
    } catch (e) {
      historyMessages([{ type: 'error', text: 'The sample history could not be loaded (' + e.message + ').' }]);
    }
  }

  function clearHistory() {
    state.history = null;
    try { localStorage.removeItem(STORE.history); } catch (e) { /* nothing saved */ }
    $('history-file').value = '';
    historyMessages([{ type: 'note', text: 'Venue history cleared from this browser.' }]);
    historyStatus();
    renderTable();
  }

  function loadSavedHistory() {
    var h = load(STORE.history, null);
    if (!h || !Array.isArray(h.shows)) return null;
    var shows = h.shows.filter(function (s) {
      return s && typeof s.act === 'string' && isFinite(s.date) && isFinite(s.capacity) && isFinite(s.sold) && s.capacity > 0 && s.sold <= s.capacity;
    });
    return shows.length ? { source: h.source === 'sample' ? 'sample' : 'file', name: String(h.name || 'saved file').slice(0, 80), loadedAt: h.loadedAt, shows: shows } : null;
  }

  function renderTable() {
    $('export').disabled = state.busy || !state.rows.length;
    var thead = $('results').tHead, tbody = $('results').tBodies[0];
    thead.textContent = ''; tbody.textContent = '';
    renderLabelCheck();
    if (!state.rows.length) return;
    state.rows.forEach(function (r) { if (r.series) analyzeRow(r); });
    thead.appendChild(el('tr', null, COLUMNS.map(function (c) { return el('th', { scope: 'col', text: c }); })));
    var groups = sortedRows();
    groups.labeled.concat(groups.other).forEach(function (row, idx) {
      var rank = groups.labeled.indexOf(row);
      var titleOk = !titleProblem(row);
      var artist = [
        titleOk ? link(articleUrl(row.resolved), row.resolved) : el('span', { text: row.input }),
        row.redirectedFrom ? el('div', { className: 'small', text: 'Redirected from "' + row.redirectedFrom + '"' }) : null,
        row.status === 'unverified' ? el('div', { className: 'small', text: 'Title not verified; used as typed.' }) : null,
        row.description ? el('div', { className: 'small', text: 'Wikipedia: ' + row.description }) : null,
        row.topic ? el('div', { className: 'row-warn' }, [el('span', { className: 'badge warn', text: 'Check title' }),
          row.topic === 'notmusic' ? ' The description does not mention music, so this may be a different topic.' : ' No short description on Wikipedia; open the link to confirm.']) : null
      ];
      tbody.appendChild(el('tr', null, [
        el('td', { 'data-label': '#', className: 'num', text: rank >= 0 ? String(rank + 1) : '' }),
        el('td', { 'data-label': COLUMNS[1] }, artist),
        el('td', { 'data-label': COLUMNS[2] }, trendCell(row)),
        el('td', { 'data-label': COLUMNS[3], className: 'num' }, mediansCell(row)),
        el('td', { 'data-label': COLUMNS[4] }, seasonCell(row)),
        el('td', { 'data-label': COLUMNS[5] }, spikesCell(row)),
        el('td', { 'data-label': COLUMNS[6] }, historyCell(row)),
        el('td', { 'data-label': COLUMNS[7] }, decisionCell(row, idx)),
        el('td', { 'data-label': COLUMNS[8] }, dataCell(row))
      ]));
    });
  }

  function setBusy(b) {
    state.busy = b;
    $('artists').readOnly = b;
    updateCount();
    if (!b) renderTable();        // re-enable the decision controls
    renderStatus();
  }

  // ---------- Main action ----------
  async function runCheck() {
    var parsed = updateCount();
    showMessages(parsed.messages);
    if (parsed.tooMany || !parsed.titles.length) return;

    setBusy(true);
    $('export-msg').textContent = '';
    $('snapshot-msg').textContent = '';
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
      rows.forEach(function (r) {
        var w = topicWarning(r);
        if (w) notes.push({ type: 'warn', text: '"' + r.input + '": ' + w });
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
          // Fail safely: fall back to the cached copy for this artist, if there is one.
          row.liveError = e.message;
          var cached = cachedSeries(row.resolved);
          if (cached) { row.series = cached; row.source = 'cached'; row.retrievedAt = (state.snapshot.artists[row.resolved].retrievedAt || ''); }
          else row.dataError = 'No data available: live data failed (' + e.message + ') and there is no cached copy for this artist.';
        }
        renderTable();
      }
      var labeled = rows.filter(function (r) { return r.analysis && r.analysis.trend.label; }).length;
      $('progress').textContent = 'Done: ' + labeled + ' of ' + rows.length + ' artists labeled' +
        (res.verified ? '.' : '. The Wikipedia title service could not be reached (' + res.reason + '), so titles were used as typed.');

      // Log this run (kept in this browser only): source and data date per artist.
      var entries = rows.map(function (r) { if (r.series) analyzeRow(r); return logEntry(r); });
      var withData = rows.filter(function (r) { return r.analysis; });
      var firstFail = rows.filter(function (r) { return r.liveError; })[0];
      state.lastRun = {
        at: new Date().toISOString(),
        dataThrough: withData.length ? Math.max.apply(null, withData.map(function (r) { return r.analysis.trend.dataThrough; })) : null,
        firstError: firstFail ? firstFail.liveError : null,
        entries: entries
      };
      save(STORE.lastRun, state.lastRun);
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
    $('export').addEventListener('click', exportCsv);
    $('save-snapshot').addEventListener('click', saveSnapshotFile);
    $('set-outage').checked = false;            // test switch is never remembered
    $('set-outage').addEventListener('change', function () {
      state.simulateOutage = $('set-outage').checked;
      renderStatus();
    });
    state.lastRun = load(STORE.lastRun, null);
    if (!state.lastRun || !Array.isArray(state.lastRun.entries)) state.lastRun = null;
    state.settings = loadSettings();
    state.decisions = load(STORE.decisions, {}) || {};
    state.history = loadSavedHistory();
    $('history-file').addEventListener('change', function () { loadHistoryFile(this.files && this.files[0]); });
    $('history-sample').addEventListener('click', loadSampleHistory);
    $('history-clear').addEventListener('click', clearHistory);
    historyStatus();
    var nSaved = Object.keys(state.decisions).filter(function (k) { return state.decisions[k].decision || state.decisions[k].reason; }).length;
    if (nSaved) $('progress').textContent = 'You have saved decisions for ' + nSaved + ' artist' + (nSaved === 1 ? '' : 's') +
      '. Click Check trends to see them next to fresh data.';
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
    renderStatus();
    loadSnapshot();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
