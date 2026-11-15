# README.md updates (paste in GitHub's web editor: open README.md, pencil icon, edit, commit)

## 1. In "Data source and permission", replace this line

- `data/snapshot.json` is a dated cached copy of real page views saved from the live site. It ships empty.

with:

- `data/snapshot.json` is a dated cached copy of real page views for the 10-act test shortlist, saved from the live site on Nov 12, 2026.

## 2. In "Build history", add these rows to the end of the table (after the `fbab0f0` row)

| `32b2302` | 4:40 PM | Live URL and build history added to this README |
| `b5c5d93` | Nov 13, 3:57 PM | Venue history and label check (F8): `history.js`, "Here before" column, 3 CSV columns, constructed `data/sample_history.csv`, updated diagram |
| `7516739` | Nov 13, 4:36 PM | Fix for T6: shows each article's Wikipedia short description and a "Check title" warning when it does not mention music |
| `1abcaea` | Nov 15, 5:07 PM | User-trial fix: purple Spike tag under the trend label for spikes in the latest 90 days, and a note that the table is ranked by change, not size |

## 2b. Correct two existing rows (the README itself arrived in c9785ab, not fbab0f0)

| `c9785ab` | 4:27 PM | README and security headers (`vercel.json`); this upload came from an older copy of the files and put back the old header text |
| `fbab0f0` | 4:32 PM | Restored the 1,200-capacity header; added the architecture diagram |

## 3. Optional: in "What it does", add to the end of the F4 Spike detector row

A spike in the latest 90 days also shows a purple Spike tag under the trend label.

Suggested commit message: Update README build history and cached-copy note
