# Booking Radar

Rank a shortlist of touring acts by public attention trend before making offers.

Student project for MIS 480S Strategic Technology Management (Project 2), Binghamton University, Fall 2026.

- **Live site:** https://venue-booker.vercel.app/
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
| F6 CSV export | One row per artist with numbers, decision, reason, venue-history and source columns |
| F7 Data-source status | A banner saying whether data is live or from the cached copy, a run log, and a fallback to `data/snapshot.json` when the live service fails |
| F8 Local history and label check | Optional: load the venue's past shows (CSV). Each row shows how the act sold here before, and a label check sets the label each act would have had 90 days before each past show next to how that show sold |

## How to use it

1. Paste up to 10 Wikipedia article titles, one per line (article web addresses work too).
2. Click **Check trends**. Titles are checked first; misspelled titles and disambiguation pages get a message saying what to fix.
3. Read the ranked table. Open spike links to see what happened before deciding.
4. Record Offer, Watch or Pass with a short reason. Click **Export CSV** to keep a copy.
5. Optional: open **Venue history**, load your past shows (or the constructed sample), and read the **Here before** column and the label check under the table.

## How the numbers are calculated

All thresholds are design assumptions, not fitted values. The ones marked *editable* can be changed under **Settings**.

- **Data:** daily English Wikipedia page views by people (`agent=user`, so known bots and crawlers are excluded), all access methods. Days missing from the API response count as zero.
- **Windows:** the latest 90 days of data, and the same 90 days 52 weeks (364 days) earlier, so weekdays line up.
- **Trend label:** percent change in the **median** daily views between the two windows. Rising at +20% or more, Fading at −20% or less (both editable), Steady in between. The median keeps one viral day from moving the label.
- **No label:** "too little traffic" when both medians are under 20 views a day (editable); "not enough history" when the earlier window has fewer than 60 days of data.
- **Seasonal peak:** for each of the last three complete years with at least 300 days of data, the month with the highest average daily views counts if it is at least 25% above that year's average day. The same month counting in two or more years gives "Peaks in [month]".
- **Spikes:** in the last 365 days, a day with at least 3× (editable) the median day of that period. Spike days within 3 days of each other form one event. Not checked for articles under the traffic floor.
- **Suggested next step:** Rising → "Move early: make an offer before the fee climbs." Steady → "Offer on your usual terms." Fading → "Watch, or offer a lower guarantee." No label → "No usable signal: decide on other evidence." A spike in the last 90 days adds "Check what caused the [date] spike first."

- **Label check (F8):** for each past show, the trend label is recalculated from page views up to 90 days before the show (an assumption for when offers go out), using the same rule and thresholds, and grouped with the show's sell-through (tickets sold ÷ capacity). Shows too early for two years of data are listed as "too early to check".

`trend.js` holds all of these rules as plain functions with no network access, so each one can be checked by hand; `history.js` does the same for the venue history.

## Data source and permission

- Wikimedia Analytics API, per-article page views: `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia.org/all-access/user/{title}/daily/{start}/{end}`. Free, no key, data available under CC0 1.0.
- MediaWiki Action API (`https://en.wikipedia.org/w/api.php`) to resolve redirects and catch missing and disambiguation titles in one batched request.
- Requests go one at a time and send an `Api-User-Agent` header, following Wikimedia's access policy for browser apps.
- `data/snapshot.json` is a dated cached copy of real page views saved from the live site. It ships empty.

## Venue history file (F8)

A CSV file with a header row. Lines starting with `#` are ignored.

| Column | Required | Meaning |
|---|---|---|
| `act` | yes | The artist's English Wikipedia title, as on the shortlist |
| `show_date` | yes | Date of the past show, `YYYY-MM-DD` (future dates are refused) |
| `capacity` | yes | Tickets available, whole number |
| `tickets_sold` | yes | Tickets sold, whole number, not more than capacity |
| `guarantee_usd` | no | Fee paid to the act |

Rows with a problem are skipped and listed with their line number; valid rows still load. Files over 200 KB or 500 shows are refused or cut off. `data/sample_history.csv` is **constructed** for the fictional venue: its ticket counts are random numbers, not real sales.

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
| `history.js` | Venue history: CSV reading and checks, matching shows to artists, label check |
| `app.js` | Input checks, API calls with an 8-second timeout, cached fallback, table, decisions, venue history, CSV and snapshot export |
| `data/snapshot.json` | Cached copy used when live data fails |
| `data/sample_history.csv` | Constructed sample venue history (random ticket counts) |
| `vercel.json` | Security headers: Content-Security-Policy, nosniff, referrer policy |
| `docs/architecture.png`, `docs/architecture.dot` | Architecture diagram and its Graphviz source |

## Privacy and security

- No accounts, no tracking, no server code and no API keys.
- The shortlist, settings, decisions, venue history and the last run log are stored only in this browser (`localStorage`). Clearing browser data deletes them. The history file is read in the browser and never uploaded.
- Only public article titles are sent to Wikimedia.
- Everything typed or received from an API is placed on the page as text, never as HTML.
- CSV text cells that start with `=`, `+`, `-` or `@` get a leading apostrophe so a spreadsheet will not run them as formulas.
- The Content-Security-Policy header allows scripts only from this site and network calls only to Wikimedia.

## Known limits

- Page views measure public attention, not ticket demand, and English Wikipedia under-represents some audiences and regions.
- An artist needs an English Wikipedia article with steady traffic. The 1,200-capacity persona was chosen so most shortlisted acts should have one, but smaller or newer acts may still come back unlabeled.
- It is a free first screen, not a replacement for paid music analytics (for example Chartmetric or Soundcharts) or past ticket sales, which a venue this size may also use.
- Views of redirect pages are not added to the target article.
- An article that was created or renamed recently has a shorter history, because views from before a rename stay under the old title (for example, MJ Lenderman's data starts in October 2023).
- Exact titles are needed; there is no fuzzy artist search.
- The cached copy is refreshed by hand and can be weeks old; the banner and data-through dates show its age.
- Decisions and venue history live in one browser and do not sync between devices or people. The CSV export is the backup.
- The label check rests on few shows, a fixed 90-day lead time and the venue's own records; it shows a pattern, not proof.

## Build history

Built in seven feature steps on Nov 12, 2026 and committed through GitHub's web upload. Commit titles are GitHub's default "Add files via upload"; from 4:08 PM on, each commit's description names the change. Times are Eastern.

| Commit | Time | What it added |
|---|---|---|
| `7de0430` | 3:11 PM | Step 1: shortlist box, input checks, Wikipedia title lookup (a 3:09 PM upload into a subfolder was deleted at 3:10 PM) |
| `a862daa` | 3:18 PM | Step 2: page-view fetch, median trend label (F1), year-ago comparison (F2), ranking, settings |
| `ae4d1da` | 3:46 PM | Step 3: seasonal peak flag (F3) |
| `50614ca` | 3:47 PM | Step 4: spike detector with edit-history and Pageviews links (F4) |
| `2062eb6` | 3:48 PM | Step 5: suggested next step and saved Offer / Watch / Pass decisions (F5) |
| `b58fb15` | 3:48 PM | Step 6: CSV export with formula guard (F6); `2d56e2c` re-uploaded the same files with no changes |
| `bdaaf94` | 3:50 PM | Step 7: status banner, run log, cached-copy fallback, offline-copy button, outage test switch (F7) |
| `ef0b36d` | 4:08 PM | Scope change: persona moved to a 1,200-capacity independent venue |
| `9007c82` | 4:24 PM | Cached copy of real page views for a 10-artist shortlist |
| `c9785ab` | 4:27 PM | Security headers (`vercel.json`); this upload came from an older copy of the files and put back the old header text |
| `fbab0f0` | 4:32 PM | Restored the 1,200-capacity header; added this README and the architecture diagram |

Steps 3–7 were uploaded within four minutes (3:46 to 3:50 PM) and checked together on the live site afterwards, not one at a time. The reverted header in `c9785ab` was caught by checking the live page after deploying.

## Tools

Plain HTML, CSS and JavaScript; GitHub; Vercel (Hobby plan). Code drafted with an AI assistant (Claude, Anthropic) and reviewed, tested and deployed by Sean Honeywell. See the report's AI-use disclosure for details.
