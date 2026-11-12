# Booking Radar

Rank a shortlist of touring acts by public attention trend before making offers.

Student project for MIS 480S Strategic Technology Management (Project 2), Binghamton University, Fall 2026.

- **Live site:** ADD THE PRODUCTION URL FROM VERCEL HERE (the short `*.vercel.app` address, not a preview link)
- **User:** a talent buyer at a 1,200-capacity independent venue in upstate New York that books about 10 touring acts a month. This is a **constructed persona**: the venue is fictional and is assumed to have no paid music-analytics subscription.
- **Decision supported:** which acts on a shortlist of 5–10 get offers, and how aggressively.

## What it does

| Feature | What the booker sees |
|---|---|
| F1 Trend label | Rising, Steady or Fading for each artist, ranked by change |
| F2 One-year-ago comparison | Median daily views for the latest 90 days next to the same 90 days 52 weeks earlier |
| F3 Seasonality flag | "Peaks in June" when the same month stands out in two or more of the last three full years |
| F4 Spike detector | Days far above the artist's usual level, with links to the article's edit history and Wikimedia's Pageviews tool for that week. The tool shows dates, never a cause. |
| F5 Next step and decision | A suggested next step for each label, plus the booker's own Offer / Watch / Pass and reason, saved in this browser |
| F6 CSV export | One row per artist with numbers, decision, reason and source columns |
| F7 Data-source status | A banner saying whether data is live or from the cached copy, a run log, and a fallback to `data/snapshot.json` when the live service fails |

## How to use it

1. Paste up to 10 Wikipedia article titles, one per line (article web addresses work too).
2. Click **Check trends**. Titles are checked first; misspelled titles and disambiguation pages get a message saying what to fix.
3. Read the ranked table. Open spike links to see what happened before deciding.
4. Record Offer, Watch or Pass with a short reason. Click **Export CSV** to keep a copy.

## How the numbers are calculated

All thresholds are design assumptions, not fitted values. The ones marked *editable* can be changed under **Settings**.

- **Data:** daily English Wikipedia page views by people (`agent=user`, so known bots and crawlers are excluded), all access methods. Days missing from the API response count as zero.
- **Windows:** the latest 90 days of data, and the same 90 days 52 weeks (364 days) earlier, so weekdays line up.
- **Trend label:** percent change in the **median** daily views between the two windows. Rising at +20% or more, Fading at −20% or less (both editable), Steady in between. The median keeps one viral day from moving the label.
- **No label:** "too little traffic" when both medians are under 20 views a day (editable); "not enough history" when the earlier window has fewer than 60 days of data.
- **Seasonal peak:** for each of the last three complete years with at least 300 days of data, the month with the highest average daily views counts if it is at least 25% above that year's average day. The same month counting in two or more years gives "Peaks in [month]".
- **Spikes:** in the last 365 days, a day with at least 3× (editable) the median day of that period. Spike days within 3 days of each other form one event. Not checked for articles under the traffic floor.
- **Suggested next step:** Rising → "Move early: make an offer before the fee climbs." Steady → "Offer on your usual terms." Fading → "Watch, or offer a lower guarantee." No label → "No usable signal: decide on other evidence." A spike in the last 90 days adds "Check what caused the [date] spike first."

`trend.js` holds all of these rules as plain functions with no network access, so each one can be checked by hand.

## Data source and permission

- Wikimedia Analytics API, per-article page views: `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia.org/all-access/user/{title}/daily/{start}/{end}`. Free, no key, data available under CC0 1.0.
- MediaWiki Action API (`https://en.wikipedia.org/w/api.php`) to resolve redirects and catch missing and disambiguation titles in one batched request.
- Requests go one at a time and send an `Api-User-Agent` header, following Wikimedia's access policy for browser apps.
- `data/snapshot.json` is a dated cached copy of real page views saved from the live site. It ships empty.

## Run it locally

Opening `index.html` directly from disk works for live data, but the browser blocks the cached copy on `file://`. To test everything locally, serve the folder:

```
python -m http.server 8000
```

then open `http://localhost:8000`.

## Deploy

GitHub repository → Vercel → Add New Project → import the repo → Framework preset **Other** → Deploy. There is no build step. `index.html` must stay at the top level of the repo. Every commit redeploys the site.

## Update the cached copy

1. On the live site, check the shortlist with live data.
2. Click **Save offline copy**. The browser downloads `snapshot.json` (it keeps any artists already in the cached copy and adds today's live ones).
3. In GitHub, open the `data` folder, upload the file to replace `snapshot.json`, and commit.

## Testing the fallback

Settings → tick **Test mode: simulate a live-data outage**. The tool skips all live requests and uses the cached copy, with a warning banner. The switch is never saved and turns off on reload. Blocking `wikimedia.org` in the browser's DevTools (Network → request blocking) gives the same result with a real network failure.

## Files

| File | Purpose |
|---|---|
| `index.html` | Page structure |
| `style.css` | Layout, including the phone layout (rows become cards) |
| `trend.js` | Calculation rules: windows, medians, labels, seasonality, spikes, next step |
| `app.js` | Input checks, API calls with an 8-second timeout, cached fallback, table, decisions, CSV and snapshot export |
| `data/snapshot.json` | Cached copy used when live data fails |
| `vercel.json` | Security headers: Content-Security-Policy, nosniff, referrer policy |
| `docs/architecture.png`, `docs/architecture.dot` | Architecture diagram and its Graphviz source |

## Privacy and security

- No accounts, no tracking, no server code and no API keys.
- The shortlist, settings, decisions and the last run log are stored only in this browser (`localStorage`). Clearing browser data deletes them.
- Only public article titles are sent to Wikimedia.
- Everything typed or received from an API is placed on the page as text, never as HTML.
- CSV text cells that start with `=`, `+`, `-` or `@` get a leading apostrophe so a spreadsheet will not run them as formulas.
- The Content-Security-Policy header allows scripts only from this site and network calls only to Wikimedia.

## Known limits

- Page views measure public attention, not ticket demand, and English Wikipedia under-represents some audiences and regions.
- An artist needs an English Wikipedia article with steady traffic. The 1,200-capacity persona was chosen so most shortlisted acts should have one, but smaller or newer acts may still come back unlabeled.
- It is a free first screen, not a replacement for paid music analytics (for example Chartmetric or Soundcharts) or past ticket sales, which a venue this size may also use.
- Views of redirect pages are not added to the target article.
- Exact titles are needed; there is no fuzzy artist search.
- The cached copy is refreshed by hand and can be weeks old; the banner and data-through dates show its age.
- Decisions live in one browser and do not sync between devices or people. The CSV export is the backup.

## Tools

Plain HTML, CSS and JavaScript; GitHub; Vercel (Hobby plan). Code drafted with an AI assistant (Claude, Anthropic) and reviewed, tested and deployed by Sean Honeywell. See the report's AI-use disclosure for details.
