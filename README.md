# Contract Radar

A UK contract PM/BA job board with IR35 language assessment. A scheduled scan queries
Reed and Adzuna three times a day, scores each advert, and commits the results; the
dashboard is a single static page that reads them.

Nothing runs on your machine. Nothing needs installing to use it — the person it's
for just opens the URL.

```
GitHub Actions (07:00 / 13:00 / 18:00)
        │  node scripts/fetch.mjs
        ▼
   roles.json  ──commit──▶  GitHub Pages  ──▶  index.html reads ./roles.json
```

## Setup

**1. Get the two API keys** (both free, self-serve, about two minutes each)

- Reed: <https://www.reed.co.uk/developers/jobseeker> → one API key
- Adzuna: <https://developer.adzuna.com> → an `app_id` and an `app_key`

**2. Add them as repository secrets**

Settings → Secrets and variables → Actions → New repository secret:

| Secret | Value |
|---|---|
| `REED_API_KEY` | your Reed key |
| `ADZUNA_APP_ID` | Adzuna app id |
| `ADZUNA_APP_KEY` | Adzuna app key |

Keys belong here and nowhere else. Anything placed in `index.html` or `config.json`
is served publicly the moment Pages builds.

**3. Turn on Pages**

Settings → Pages → Source: *Deploy from a branch* → `main` / `(root)`.

**4. Run the first scan**

Actions → *Contract scan* → *Run workflow*. It commits `roles.json`, Pages redeploys,
and the board fills up.

## Tuning the search

Everything lives in [`config.json`](config.json) — no code changes needed.

| Key | What it does |
|---|---|
| `keywords` | The search phrases. Each one is queried against every enabled source |
| `brief` | Rate range, location and sectors shown in the dashboard header |
| `reed.locationName` / `distanceFromLocation` | Geographic filter. **Currently unset — UK-wide.** Add both back to narrow it |
| `reed.maxDetailFetches` | How many full adverts to pull per scan. Higher is more accurate and slower |
| `adzuna.maxDaysOld` | How far back to look. `2` suits a three-times-a-day cadence |
| `filters.remoteOnly` | **On.** Drops anything without an explicit remote signal — see below |
| `filters.dropBelowRate` | Bin anything under this day rate |
| `filters.keepUnknownRate` | Keep adverts with no stated rate (most of them) |
| `filters.expireAfterDays` | Drop stale adverts, unless a status has been set on them |

## The remote filter

The brief is UK-wide *remote*, so `filters.remoteOnly` is on. An advert is kept when
it carries an explicit remote signal — "fully remote", "work from home", "home-based",
"anywhere in the UK" — and dropped when it doesn't.

Two deliberate calls:

- **"Remote with occasional travel" is kept.** A remote signal beats a travel mention;
  only an explicit on-site requirement ("3 days per week in the office") overrides it.
- **"Hybrid" alone is dropped.** This does bin good roles — a £600/day outside-IR35
  hybrid contract goes in the bin the same as anything else. If that's too strict,
  set `remoteOnly` to `false` and filter by eye on the board instead.

Every scan logs what it dropped and why, so a tight filter never masquerades as a
quiet market. Check the Actions run log if the board looks thin.

## How the IR35 rating works

`scripts/ir35.mjs` matches advert wording against two lists — outside-IR35 indicators
and inside-IR35 red flags — and scores 1 (clearly outside) to 10 (clearly inside).
Bands: **1–3 apply**, **4–6 clarify first**, **7–10 skip**.

Two things worth knowing:

- **Reed adverts are read in full; Adzuna only returns a snippet.** A snippet that
  doesn't mention IR35 proves nothing, so snippet-scored roles are floored at 4 and
  flagged `confidence: "low"` — they can never land in the apply band on wording alone.
- **This reads language, not employment status.** It's a triage filter for deciding
  what to chase. The client's Status Determination Statement and an accountant decide
  the real thing.

## The dashboard

`index.html` is standalone — no build, no dependencies. On load it fetches
`./roles.json` and merges it into whatever is already in the browser.

The split that matters: **facts come from the feed, decisions stay in the browser.**
A rescan refreshes titles, rates and ratings, but never touches a status or a note.
Removing a role records its id in a dismissed list, so the next scan doesn't put it
back. All of it lives in `localStorage`, which means it's per-browser — open it on a
laptop and a phone and you get two independent boards. Export/import (Search &
settings) bridges them manually.

## Local development

```bash
node scripts/fetch.mjs --dry-run   # full pipeline against fixtures, no network, no keys
python3 -m http.server 8181        # then open http://localhost:8181
```

A live local scan needs the keys in the environment:

```bash
REED_API_KEY=… ADZUNA_APP_ID=… ADZUNA_APP_KEY=… node scripts/fetch.mjs
```

## Sources

Reed and Adzuna both publish official free APIs, which is why they're used here.
Adzuna aggregates Totaljobs and CWJobs listings, so those boards are covered
indirectly — neither has a public API, and both prohibit scraping.

LinkedIn is deliberately absent: no jobs API, scraping is against their terms, and
they fingerprint aggressively. Use LinkedIn's own email job alerts alongside this.

Technojobs has been offline since late 2025 following the Free-Work acquisition.
`config.json` carries a disabled generic RSS adapter — point `rss.feeds[].url` at any
working feed (`{q}` is substituted with each keyword) and set `rss.enabled` to true.

## Gotchas

- **Cron is UTC.** The workflow is set for BST — 06:00/12:00/17:00 UTC gives 07:00/13:00/18:00
  local. After the October clock change, shift them to 07/13/17… (i.e. 07:00/13:00/18:00 UTC).
- **Actions cron is approximate.** Runs are queued and can start 5–15 minutes late.
- **GitHub disables scheduled workflows after 60 days of repo inactivity.** The scan
  commits on most days, which counts — but if the board goes quiet, check that first.
- **The header shows scan age.** "last scan 3d ago — check the workflow" means the
  cron stopped, not that the market went quiet.
