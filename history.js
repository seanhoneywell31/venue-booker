/* Booking Radar: history.js (F8, local history and label check)
   Pure functions, no network and no page access. The buyer loads the venue's
   past shows as a CSV file; this file reads and checks it, matches shows to the
   artists on the shortlist, and recalculates each label as it would have read
   when offers for that show went out. Needs trend.js (the Trend object). */
(function (root) {
  'use strict';

  var Trend = root.Trend;
  var DAY = 86400000;
  var MAX_BYTES = 200 * 1024;          // a venue's history is small; refuse anything bigger
  var MAX_ROWS = 500;
  var LEAD_DAYS = 90;                  // assumption: offers go out about 90 days before a show
  var REQUIRED = ['act', 'show_date', 'capacity', 'tickets_sold'];
  var OPTIONAL = ['guarantee_usd'];
  var BAD_TITLE = /[#<>\[\]|{}\u0000-\u001f\u007f]/;

  // ---------- CSV reading ----------
  // Splits CSV text into rows of fields. Handles quoted fields, doubled quotes,
  // commas and line breaks inside quotes, CRLF line ends and a leading BOM.
  // Each row keeps the file line number it started on.
  function splitCsv(text) {
    var rows = [], field = '', row = [], inQuotes = false, line = 1, rowLine = 1;
    text = String(text).replace(/^﻿/, '');
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
        } else { if (c === '\n') line++; field += c; }
      } else if (c === '"') { inQuotes = true; }
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\r') { /* ignore; \n ends the row */ }
      else if (c === '\n') { row.push(field); rows.push({ line: rowLine, fields: row }); row = []; field = ''; line++; rowLine = line; }
      else field += c;
    }
    if (field !== '' || row.length) { row.push(field); rows.push({ line: rowLine, fields: row }); }
    return rows;
  }

  function key(title) {
    return String(title || '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function parseDate(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s).trim());
    if (!m) return null;
    var ms = Date.UTC(+m[1], +m[2] - 1, +m[3]);
    var d = new Date(ms);
    if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) return null;
    return ms;
  }

  function wholeNumber(s) {
    var t = String(s).trim().replace(/,/g, '');
    return /^\d+$/.test(t) ? Number(t) : null;
  }

  // Reads the buyer's file. Returns valid shows plus a message for every row
  // that was skipped, with its line number, so the buyer can fix the file.
  function parse(text, todayMs) {
    var out = { shows: [], errors: [], extra: 0 };
    var rows = splitCsv(text).filter(function (r) {
      var first = (r.fields[0] || '').trim();
      return !(r.fields.length === 1 && first === '') && first.charAt(0) !== '#';
    });
    if (!rows.length) { out.errors.push({ line: 0, text: 'The file is empty.' }); return out; }

    var header = rows[0].fields.map(function (h) { return h.trim().toLowerCase(); });
    var col = {};
    REQUIRED.concat(OPTIONAL).forEach(function (name) { col[name] = header.indexOf(name); });
    var missing = REQUIRED.filter(function (name) { return col[name] < 0; });
    if (missing.length) {
      out.errors.push({ line: rows[0].line, text: 'The first row must name the columns. Missing: ' + missing.join(', ') + '.' });
      return out;
    }

    rows.slice(1).forEach(function (r) {
      if (out.shows.length >= MAX_ROWS) { out.extra++; return; }
      var get = function (name) { return col[name] >= 0 ? String(r.fields[col[name]] || '').trim() : ''; };
      var act = get('act').replace(/_/g, ' ').replace(/\s+/g, ' ');
      var problem = null;
      var date = parseDate(get('show_date'));
      var capacity = wholeNumber(get('capacity'));
      var sold = wholeNumber(get('tickets_sold'));
      var gRaw = get('guarantee_usd').replace(/[$,\s]/g, '');
      var guarantee = gRaw === '' ? null : (/^\d+(\.\d+)?$/.test(gRaw) ? Number(gRaw) : NaN);

      if (!act) problem = 'the act is blank';
      else if (act.length > 255 || BAD_TITLE.test(act)) problem = 'the act is not a valid Wikipedia title';
      else if (date === null) problem = 'show_date must be a real date written YYYY-MM-DD';
      else if (todayMs !== undefined && date > todayMs) problem = 'show_date is in the future; only past shows can be checked';
      else if (capacity === null || capacity < 1 || capacity > 100000) problem = 'capacity must be a whole number from 1 to 100,000';
      else if (sold === null) problem = 'tickets_sold must be a whole number';
      else if (sold > capacity) problem = 'tickets_sold is more than capacity';
      else if (isNaN(guarantee)) problem = 'guarantee_usd must be a number or left blank';

      if (problem) out.errors.push({ line: r.line, text: problem });
      else out.shows.push({ act: act, date: date, capacity: capacity, sold: sold, guarantee: guarantee });
    });
    return out;
  }

  // ---------- Matching shows to a shortlist row ----------
  // `names` holds every name the row goes by (typed line, resolved title, redirect source).
  function showsFor(shows, names) {
    var keys = {};
    names.forEach(function (n) { if (n) keys[key(n)] = true; });
    return shows.filter(function (s) { return keys[key(s.act)]; })
                .sort(function (a, b) { return b.date - a.date; });
  }

  function sellThrough(show) { return show.capacity ? show.sold / show.capacity * 100 : 0; }

  // ---------- Label check ----------
  // The label as it would have read LEAD_DAYS before the show, using only data up
  // to that day. Same rule and thresholds as today's label.
  function labelBefore(series, showMs, settings) {
    var asOf = showMs - LEAD_DAYS * DAY;
    var idx = Math.round((asOf - series.start) / DAY);
    if (idx < 0) return { status: 'early', asOf: asOf };
    var cut = { start: series.start, views: series.views.slice(0, Math.min(idx + 1, series.views.length)) };
    var t = Trend.trend(cut, settings);
    if (t.status === 'new') return { status: 'early', asOf: asOf };
    if (t.status === 'low') return { status: 'low', asOf: asOf };
    return { status: 'ok', asOf: asOf, label: t.label, changePct: t.changePct };
  }

  // Groups checked shows by the label they would have had, with average sell-through.
  function summarize(items) {
    var groups = {}, order = ['Rising', 'Steady', 'Fading', 'Too little traffic', 'Too early to check'];
    order.forEach(function (g) { groups[g] = { name: g, n: 0, total: 0 }; });
    items.forEach(function (it) {
      var g = it.check.status === 'ok' ? it.check.label : it.check.status === 'low' ? 'Too little traffic' : 'Too early to check';
      groups[g].n++;
      groups[g].total += sellThrough(it.show);
    });
    return order.map(function (g) {
      var x = groups[g];
      return { name: g, n: x.n, avg: x.n ? x.total / x.n : null };
    }).filter(function (x) { return x.n > 0; });
  }

  root.History = {
    MAX_BYTES: MAX_BYTES, MAX_ROWS: MAX_ROWS, LEAD_DAYS: LEAD_DAYS, REQUIRED: REQUIRED, OPTIONAL: OPTIONAL,
    splitCsv: splitCsv, parse: parse, key: key, showsFor: showsFor, sellThrough: sellThrough,
    labelBefore: labelBefore, summarize: summarize
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.History;
})(typeof window !== 'undefined' ? window : globalThis);
