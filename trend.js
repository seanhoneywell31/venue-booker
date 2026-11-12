/* Booking Radar: trend.js
   Pure calculation functions. No network, no page access, so every rule can be
   checked by hand or tested on its own. A "series" is daily page views:
   { start: <UTC milliseconds of the first day>, views: [number or null, ...] }
   where null means the day was missing from the Wikimedia response. */
(function (root) {
  'use strict';

  var DAY = 86400000;
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
                'August', 'September', 'October', 'November', 'December'];

  // ---------- Dates (all UTC, because Wikimedia days are UTC days) ----------
  function dayMs(y, m, d) { return Date.UTC(y, m - 1, d); }
  function parseDay(s) {            // 'YYYYMMDD', 'YYYYMMDDHH' or 'YYYY-MM-DD'
    var t = String(s).replace(/-/g, '');
    return Date.UTC(+t.slice(0, 4), +t.slice(4, 6) - 1, +t.slice(6, 8));
  }
  function isoDay(ms) { return new Date(ms).toISOString().slice(0, 10); }
  function compactDay(ms) { return isoDay(ms).replace(/-/g, ''); }
  function niceDay(ms) {
    var d = new Date(ms);
    return MONTHS[d.getUTCMonth()].slice(0, 3) + ' ' + d.getUTCDate() + ', ' + d.getUTCFullYear();
  }
  function niceRange(a, b) {         // 'Aug 13 to Nov 10, 2026' or 'Dec 1, 2025 to Feb 28, 2026'
    var da = new Date(a), db = new Date(b);
    var left = da.getUTCFullYear() === db.getUTCFullYear()
      ? MONTHS[da.getUTCMonth()].slice(0, 3) + ' ' + da.getUTCDate() : niceDay(a);
    return left + ' to ' + niceDay(b);
  }

  // ---------- Building a series ----------
  // From the API's items: [{timestamp:'2025010100', views: 123}, ...]
  function seriesFromItems(items, startMs) {
    if (!items || !items.length) return null;
    var byDay = {}, last = startMs;
    items.forEach(function (it) {
      var t = parseDay(it.timestamp);
      byDay[t] = (byDay[t] || 0) + Number(it.views || 0);
      if (t > last) last = t;
    });
    var n = Math.round((last - startMs) / DAY) + 1, views = new Array(n);
    for (var i = 0; i < n; i++) {
      var v = byDay[startMs + i * DAY];
      views[i] = v === undefined ? null : v;
    }
    return { start: startMs, views: views };
  }

  function lastDay(series) { return series.start + (series.views.length - 1) * DAY; }

  // Values for the `days` days ending at endMs. Missing days count as 0;
  // `coverage` says how many days actually had data.
  function windowValues(series, endMs, days) {
    var endIdx = Math.round((endMs - series.start) / DAY);
    var values = [], coverage = 0;
    for (var i = endIdx - days + 1; i <= endIdx; i++) {
      var v = (i >= 0 && i < series.views.length) ? series.views[i] : null;
      if (v !== null) coverage++;
      values.push(v === null ? 0 : v);
    }
    return { values: values, coverage: coverage, start: endMs - (days - 1) * DAY, end: endMs };
  }

  function median(arr) {
    if (!arr.length) return 0;
    var s = arr.slice().sort(function (a, b) { return a - b; });
    var mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  // ---------- F1 + F2: trend label and one-year-ago comparison ----------
  var WINDOW = 90, SHIFT = 364, MIN_HISTORY = 60;

  function trend(series, opts) {
    var through = lastDay(series);
    var recent = windowValues(series, through, WINDOW);
    var prior = windowValues(series, through - SHIFT * DAY, WINDOW);
    var r = {
      dataThrough: through,
      recentStart: recent.start, recentEnd: recent.end,
      priorStart: prior.start, priorEnd: prior.end,
      medRecent: median(recent.values), medPrior: median(prior.values),
      priorCoverage: prior.coverage, changePct: null, label: null, status: 'ok'
    };
    if (Math.max(r.medRecent, r.medPrior) < opts.minViews) { r.status = 'low'; return r; }
    if (prior.coverage < MIN_HISTORY || r.medPrior === 0) { r.status = 'new'; return r; }
    r.changePct = (r.medRecent - r.medPrior) / r.medPrior * 100;
    r.label = r.changePct >= opts.risingPct ? 'Rising'
            : r.changePct <= -opts.fadingPct ? 'Fading' : 'Steady';
    return r;
  }

  // ---------- F3: seasonality ----------
  // For each of the last three complete calendar years, find the month with the
  // highest average daily views. A year counts only if that month is at least 25%
  // above the year's average day and the year has 300+ days of data. If the same
  // month qualifies in two or more years, the artist "peaks in" that month.
  var SEASON_MIN_DAYS = 300, SEASON_LIFT = 1.25;

  function seasonality(series) {
    var lastYear = new Date(lastDay(series)).getUTCFullYear();
    var years = [];
    for (var y = lastYear - 3; y <= lastYear - 1; y++) {
      var totals = [], days = [], cover = 0, sum = 0, n = 0;
      for (var m = 0; m < 12; m++) { totals.push(0); days.push(0); }
      for (var t = Date.UTC(y, 0, 1); t <= Date.UTC(y, 11, 31); t += DAY) {
        var i = Math.round((t - series.start) / DAY);
        var v = (i >= 0 && i < series.views.length) ? series.views[i] : null;
        var mo = new Date(t).getUTCMonth();
        days[mo]++; n++;
        if (v !== null) { cover++; totals[mo] += v; sum += v; }
      }
      if (cover < SEASON_MIN_DAYS) continue;
      var avgDay = sum / n, peak = 0, best = -1;
      for (var k = 0; k < 12; k++) {
        var perDay = totals[k] / days[k];
        if (perDay > best) { best = perDay; peak = k; }
      }
      var lift = avgDay > 0 ? best / avgDay : 0;
      years.push({ year: y, month: peak, lift: lift, qualifies: lift >= SEASON_LIFT });
    }
    if (years.length < 2) return { status: 'short', years: years };
    var counts = {};
    years.forEach(function (yr) { if (yr.qualifies) counts[yr.month] = (counts[yr.month] || 0) + 1; });
    var top = null;
    Object.keys(counts).forEach(function (mKey) {
      if (counts[mKey] >= 2 && (top === null || counts[mKey] > counts[top])) top = +mKey;
    });
    if (top === null) return { status: 'none', years: years };
    return { status: 'peak', month: top, count: counts[top], of: years.length, years: years };
  }

  function analyze(series, opts) {
    return { trend: trend(series, opts), season: seasonality(series) };
  }

  var api = {
    DAY: DAY, MONTHS: MONTHS, WINDOW: WINDOW, SHIFT: SHIFT, MIN_HISTORY: MIN_HISTORY,
    dayMs: dayMs, parseDay: parseDay, isoDay: isoDay, compactDay: compactDay, niceDay: niceDay, niceRange: niceRange,
    seriesFromItems: seriesFromItems, lastDay: lastDay, windowValues: windowValues, median: median,
    trend: trend, seasonality: seasonality, SEASON_LIFT: SEASON_LIFT, SEASON_MIN_DAYS: SEASON_MIN_DAYS,
    analyze: analyze
  };
  root.Trend = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
