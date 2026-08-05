#!/usr/bin/env node
/**
 * Contract Radar scan.
 *
 *   node scripts/fetch.mjs            # live scan, needs API keys in the environment
 *   node scripts/fetch.mjs --dry-run  # runs the whole pipeline against fixtures, no network
 *
 * Reads config.json, queries Reed and Adzuna, scores each advert for IR35 language,
 * merges into roles.json without disturbing anything already there.
 *
 * Keys come from the environment (GitHub Actions secrets, or a local .env):
 *   REED_API_KEY, ADZUNA_APP_ID, ADZUNA_APP_KEY
 */

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { assess, band, extractDayRate, extractLength, stripHtml, roleId, titleMatches } from "./ir35.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DRY = process.argv.includes("--dry-run");

const log = (...a) => console.log("·", ...a);
const warn = (...a) => console.warn("!", ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ config */

async function loadJson(path, fallback) {
  try {
    return JSON.parse(await readFile(join(ROOT, path), "utf8"));
  } catch (e) {
    if (fallback !== undefined) return fallback;
    throw new Error(`Can't read ${path}: ${e.message}`);
  }
}

/* -------------------------------------------------------------------- reed */

async function reedSearch(cfg, keyword, key) {
  const qs = new URLSearchParams({
    keywords: keyword,
    contract: "true",
    temp: "true",
    permanent: "false",
    resultsToTake: String(cfg.resultsToTake || 100)
  });
  if (cfg.locationName) {
    qs.set("locationName", cfg.locationName);
    qs.set("distanceFromLocation", String(cfg.distanceFromLocation || 30));
  }

  const res = await fetch(`https://www.reed.co.uk/api/1.0/search?${qs}`, {
    headers: { Authorization: "Basic " + Buffer.from(key + ":").toString("base64") }
  });
  if (!res.ok) throw new Error(`Reed search ${res.status} ${res.statusText}`);
  const body = await res.json();
  return body.results || [];
}

async function reedDetail(jobId, key) {
  const res = await fetch(`https://www.reed.co.uk/api/1.0/jobs/${jobId}`, {
    headers: { Authorization: "Basic " + Buffer.from(key + ":").toString("base64") }
  });
  if (!res.ok) throw new Error(`Reed detail ${jobId}: ${res.status}`);
  return res.json();
}

/**
 * Reed search results truncate the description, and a truncated advert can't be
 * scored honestly — so pull the full text for as many as the budget allows.
 *
 * Order matters: cheap filters run against the search snippet FIRST, so the detail
 * budget is spent only on adverts that could actually make the board. Fetching
 * details before filtering wastes the budget on roles that are about to be binned,
 * and leaves the survivors scored off snippets they can't be judged on.
 */
async function collectReed(cfg, keywords, key, prefilter) {
  const seen = new Map();

  for (const kw of keywords) {
    let results = [];
    try {
      results = await reedSearch(cfg, kw, key);
    } catch (e) {
      warn(`Reed "${kw}" failed: ${e.message}`);
      continue;
    }
    log(`Reed "${kw}" → ${results.length}`);
    for (const r of results) if (!seen.has(r.jobId)) seen.set(r.jobId, r);
    await sleep(250);
  }

  let candidates = [...seen.entries()];
  const found = candidates.length;

  if (prefilter) {
    candidates = candidates.filter(([, r]) =>
      prefilter({
        title: r.jobTitle || "",
        location: r.locationName || "",
        text: stripHtml(r.jobDescription || "")
      })
    );
    log(`Reed: ${found} unique → ${candidates.length} past the pre-filter`);
  }

  const budget = cfg.maxDetailFetches || 200;
  if (candidates.length > budget) {
    log(`Reed: detail budget is ${budget}, so ${candidates.length - budget} will stay snippet-only`);
  }

  const out = [];
  let fetched = 0;

  for (const [jobId, r] of candidates) {
    let detail = null;
    if (fetched < budget) {
      try {
        detail = await reedDetail(jobId, key);
        fetched++;
        await sleep(120);
      } catch (e) {
        warn(`detail ${jobId}: ${e.message}`);
      }
    }

    const text = stripHtml(detail?.jobDescription || r.jobDescription || "");
    const snippetOnly = !detail;

    // salaryType tells us whether the salary figures are day rates or annual
    let rate = extractDayRate(`${r.jobTitle} ${text}`);
    const salaryType = String(detail?.salaryType || "").toLowerCase();
    if (!rate && salaryType === "daily") {
      rate = Number(detail.maximumSalary || detail.minimumSalary || 0) || null;
    }

    out.push({
      source: "Reed",
      title: r.jobTitle,
      company: r.employerName,
      location: r.locationName,
      url: detail?.jobUrl || `https://www.reed.co.uk/jobs/${jobId}`,
      text,
      snippetOnly,
      rate,
      length: extractLength(`${r.jobTitle} ${text}`)
    });
  }

  log(`Reed: ${out.length} candidates, ${fetched} full adverts pulled`);
  return out;
}

/* ------------------------------------------------------------------ adzuna */

async function collectAdzuna(cfg, keywords, id, key) {
  const out = [];
  const seen = new Set();

  for (const kw of keywords) {
    // `contract=1` is the request filter. `contract_type` is a RESPONSE field —
    // sending it as a query param is what made every call 400.
    const qs = new URLSearchParams({
      app_id: id,
      app_key: key,
      results_per_page: String(cfg.resultsPerPage || 50),
      what: kw,
      contract: "1",
      max_days_old: String(cfg.maxDaysOld || 2),
      "content-type": "application/json"
    });
    if (cfg.where && cfg.where !== "UK") qs.set("where", cfg.where);

    let body;
    try {
      const res = await fetch(
        `https://api.adzuna.com/v1/api/jobs/${cfg.country || "gb"}/search/1?${qs}`
      );
      if (!res.ok) {
        // the body carries the actual complaint; the status alone tells you nothing
        const detail = (await res.text().catch(() => "")).slice(0, 300);
        throw new Error(`${res.status} ${res.statusText} ${detail}`);
      }
      body = await res.json();
    } catch (e) {
      warn(`Adzuna "${kw}" failed: ${e.message}`);
      continue;
    }

    const results = body.results || [];
    log(`Adzuna "${kw}" → ${results.length}`);

    for (const r of results) {
      // belt and braces: the API filter has been known to let permanent roles through
      if (r.contract_type && r.contract_type !== "contract") continue;
      if (seen.has(r.id)) continue;
      seen.add(r.id);

      const text = stripHtml(r.description || "");
      out.push({
        source: "Adzuna",
        title: r.title,
        company: r.company?.display_name || "Unknown",
        location: r.location?.display_name || "",
        url: r.redirect_url,
        text,
        snippetOnly: true, // Adzuna only ever returns a snippet
        rate: extractDayRate(`${r.title} ${text}`),
        length: extractLength(`${r.title} ${text}`)
      });
    }
    await sleep(250);
  }

  log(`Adzuna: ${out.length} unique`);
  return out;
}

/* --------------------------------------------------------------------- rss */

function parseRss(xml) {
  const items = [];
  const re = /<item[\s\S]*?<\/item>/gi;
  const pick = (block, tag) => {
    const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
    if (!m) return "";
    return m[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim();
  };
  for (const block of xml.match(re) || []) {
    items.push({
      title: pick(block, "title"),
      link: pick(block, "link"),
      description: pick(block, "description")
    });
  }
  return items;
}

async function collectRss(cfg, keywords) {
  const out = [];
  for (const feed of cfg.feeds || []) {
    for (const kw of keywords) {
      const url = feed.url.replace("{q}", encodeURIComponent(kw));
      try {
        const res = await fetch(url, { headers: { "user-agent": "contract-radar/1.0" } });
        if (!res.ok) throw new Error(`${res.status}`);
        const items = parseRss(await res.text());
        log(`${feed.name} "${kw}" → ${items.length}`);
        for (const it of items) {
          const text = stripHtml(it.description);
          out.push({
            source: feed.name,
            title: stripHtml(it.title),
            company: "See advert",
            location: "",
            url: it.link,
            text,
            snippetOnly: true,
            rate: extractDayRate(`${it.title} ${text}`),
            length: extractLength(`${it.title} ${text}`)
          });
        }
      } catch (e) {
        warn(`${feed.name} "${kw}" failed: ${e.message}`);
      }
      await sleep(250);
    }
  }
  return out;
}

/* --------------------------------------------------------------- normalise */

function toRole(raw, filters) {
  const { rating, plus, minus, confidence } = assess(raw.text, { snippetOnly: raw.snippetOnly });

  let notes = "";
  if (raw.snippetOnly) {
    notes = "Snippet only — read the full advert before trusting this rating.";
  } else if (band(rating) === "safe") {
    notes = "Apply — wording reads as outside IR35.";
  } else if (band(rating) === "warn") {
    notes = "Call the recruiter before applying.";
  } else {
    notes = "Skip unless the recruiter contradicts the advert.";
  }

  return {
    id: roleId(raw.source, raw.company, raw.title),
    title: raw.title,
    company: raw.company,
    rate: raw.rate || 0,
    length: raw.length || "",
    location: raw.location || "",
    source: raw.source,
    url: raw.url || "",
    rating,
    evPlus: plus,
    evMinus: minus,
    confidence,
    notes,
    status: "new",
    fromFeed: true
  };
}

const REMOTE_RE = /\b(fully remote|100% remote|remote(?:ly)?|work from home|working from home|wfh|home[- ]?based|anywhere in the uk|remote first)\b/i;
const ONSITE_RE = /\b(on[- ]?site only|fully on[- ]?site|office[- ]?based|\d\s*days? (?:per week )?(?:in|on)[- ]?(?:the )?(?:office|site))\b/i;

/**
 * Is this advert actually remote?
 * "Hybrid" alone doesn't qualify, but plenty of genuinely remote adverts say
 * "remote with occasional travel" — so an explicit remote signal wins over a
 * hybrid mention, and only an explicit on-site requirement overrides it.
 */
function looksRemote(raw) {
  const hay = `${raw.title} ${raw.location} ${raw.text}`;
  if (!REMOTE_RE.test(hay)) return false;
  if (ONSITE_RE.test(hay)) return false;
  return true;
}

function applyFilters(raws, f) {
  const dropped = { offBrief: 0, notRemote: 0, belowRate: 0, incomplete: 0 };

  const kept = raws.filter((x) => {
    if (!x.role.title || !x.role.company) { dropped.incomplete++; return false; }
    if (!titleMatches(x.role.title, f.titleMustMatch)) { dropped.offBrief++; return false; }
    if (f.remoteOnly && !looksRemote(x.raw)) { dropped.notRemote++; return false; }
    if (!x.role.rate) return f.keepUnknownRate !== false;
    if (x.role.rate < (f.dropBelowRate || 0)) { dropped.belowRate++; return false; }
    return true;
  });

  // Never let a filter shrink the board silently — a quiet week and an overly
  // tight filter look identical from the dashboard.
  if (dropped.offBrief) log(`filtered out ${dropped.offBrief} not PM/BA by title`);
  if (dropped.notRemote) log(`filtered out ${dropped.notRemote} non-remote adverts`);
  if (dropped.belowRate) log(`filtered out ${dropped.belowRate} under £${f.dropBelowRate}/day`);
  if (dropped.incomplete) log(`filtered out ${dropped.incomplete} with missing title/company`);

  return kept.map((x) => x.role);
}

/* ------------------------------------------------------------------- merge */

function merge(existing, incoming, filters, nowIso) {
  const byId = new Map(existing.map((r) => [r.id, r]));

  for (const r of incoming) {
    const prev = byId.get(r.id);
    if (prev) {
      // refresh the facts, never the human's decisions
      byId.set(r.id, {
        ...prev,
        title: r.title,
        rate: r.rate || prev.rate,
        length: r.length || prev.length,
        location: r.location || prev.location,
        url: r.url || prev.url,
        rating: r.rating,
        evPlus: r.evPlus,
        evMinus: r.evMinus,
        confidence: r.confidence,
        lastSeen: nowIso
      });
    } else {
      byId.set(r.id, { ...r, firstSeen: nowIso, lastSeen: nowIso });
    }
  }

  let out = [...byId.values()];

  // drop adverts that stopped appearing a while ago, unless they're being acted on
  const cutoff = Date.now() - (filters.expireAfterDays || 21) * 864e5;
  out = out.filter((r) => {
    if (r.status && r.status !== "new") return true;
    return new Date(r.lastSeen || r.firstSeen || nowIso).getTime() >= cutoff;
  });

  out.sort((a, b) => a.rating - b.rating || (b.rate || 0) - (a.rate || 0));
  return out.slice(0, filters.maxRolesRetained || 300);
}

/* ----------------------------------------------------------------- fixture */

const FIXTURE = [
  {
    source: "Reed", title: "Contract Project Manager - Network Transformation",
    company: "Telefónica UK", location: "London (hybrid)",
    url: "https://www.reed.co.uk/jobs/000001", snippetOnly: false,
    text: "We require a Contract Project Manager for a 6 month engagement. This role has been " +
          "determined as outside IR35. You will invoice via your own limited company and a right " +
          "of substitution is included. Rate: £500 - £550 per day depending on experience.",
    rate: null, length: ""
  },
  {
    source: "Reed", title: "Senior Project Manager - Cloud Migration",
    company: "Accenture", location: "London", url: "https://www.reed.co.uk/jobs/000002",
    snippetOnly: false,
    text: "Full-time placement for a Senior Project Manager. You will be integrated into the " +
          "delivery team, line managed by the Head of PMO, working core hours with 25 days annual " +
          "leave, pension contribution and staff benefits. Inside IR35, PAYE only. £500 per day.",
    rate: null, length: ""
  },
  {
    source: "Adzuna", title: "Business Analyst - Payments (12 month contract)",
    company: "HSBC", location: "Remote", url: "https://www.adzuna.co.uk/jobs/000003",
    snippetOnly: true,
    text: "A leading bank is seeking a Business Analyst to join a payments programme. £550 per day. " +
          "You will gather requirements and…",
    rate: null, length: ""
  },
  {
    source: "Adzuna", title: "Junior Coordinator", company: "SmallCo", location: "Hull",
    url: "https://www.adzuna.co.uk/jobs/000004", snippetOnly: true,
    text: "Admin support role. £180 per day.", rate: null, length: ""
  },
  // remote-filter edge cases
  {
    source: "Reed", title: "Contract Business Analyst - Regulatory Reporting",
    company: "Aviva", location: "Remote (UK)", url: "https://www.reed.co.uk/jobs/000005",
    snippetOnly: false,
    text: "Fully remote with occasional travel to Norwich for quarterly planning. Outside IR35, " +
          "engage through your own limited company. 6 months. £575 per day.",
    rate: null, length: ""
  },
  {
    source: "Reed", title: "Programme Manager - Core Banking",
    company: "Nationwide", location: "Swindon", url: "https://www.reed.co.uk/jobs/000006",
    snippetOnly: false,
    text: "Hybrid role, 3 days per week in the office. Outside IR35 determination in place. " +
          "£600 per day, 12 months.",
    rate: null, length: ""
  },
  {
    source: "Adzuna", title: "Interim Project Manager (home-based)",
    company: "Sage", location: "Home-based, anywhere in the UK",
    url: "https://www.adzuna.co.uk/jobs/000007", snippetOnly: true,
    text: "Home-based contract role supporting a finance transformation. £500 per day…",
    rate: null, length: ""
  }
];

/* -------------------------------------------------------------------- main */

async function main() {
  const cfg = await loadJson("config.json");
  const store = await loadJson("roles.json", { roles: [] });
  const nowIso = new Date().toISOString();
  const keywords = cfg.keywords || [];

  let raw = [];

  if (DRY) {
    log("dry run — using fixtures, no network calls");
    raw = FIXTURE.map((f) => ({
      ...f,
      rate: extractDayRate(`${f.title} ${f.text}`),
      length: extractLength(`${f.title} ${f.text}`)
    }));
  } else {
    const reedKey = process.env.REED_API_KEY;
    const adzId = process.env.ADZUNA_APP_ID;
    const adzKey = process.env.ADZUNA_APP_KEY;

    // The same filters, run against the cheap search snippet, so the Reed detail
    // budget is never spent on an advert that can't make the board.
    const f = cfg.filters || {};
    const prefilter = (f.remoteOnly || f.titleMustMatch?.length)
      ? (cand) => titleMatches(cand.title, f.titleMustMatch) && (!f.remoteOnly || looksRemote(cand))
      : null;

    if (cfg.reed?.enabled) {
      if (reedKey) raw.push(...(await collectReed(cfg.reed, keywords, reedKey, prefilter)));
      else warn("REED_API_KEY not set — skipping Reed");
    }
    if (cfg.adzuna?.enabled) {
      if (adzId && adzKey) raw.push(...(await collectAdzuna(cfg.adzuna, keywords, adzId, adzKey)));
      else warn("ADZUNA_APP_ID / ADZUNA_APP_KEY not set — skipping Adzuna");
    }
    if (cfg.rss?.enabled) raw.push(...(await collectRss(cfg.rss, keywords)));

    if (!raw.length) {
      warn("no results from any source — leaving roles.json untouched");
      process.exitCode = 1;
      return;
    }
  }

  const filters = cfg.filters || {};
  const scored = applyFilters(raw.map((r) => ({ raw: r, role: toRole(r, filters) })), filters);
  const before = store.roles?.length || 0;
  const roles = merge(store.roles || [], scored, filters, nowIso);
  const fresh = roles.filter((r) => r.firstSeen === nowIso).length;

  const counts = { safe: 0, warn: 0, risk: 0 };
  for (const r of roles) counts[band(r.rating)]++;

  await writeFile(
    join(ROOT, "roles.json"),
    JSON.stringify({ generatedAt: nowIso, brief: cfg.brief, counts, roles }, null, 2) + "\n"
  );

  log(`scanned ${raw.length} adverts → ${scored.length} passed filters`);
  log(`board: ${before} → ${roles.length} (${fresh} new)`);
  log(`bands: ${counts.safe} outside · ${counts.warn} ambiguous · ${counts.risk} inside`);
}

main().catch((e) => {
  console.error("scan failed:", e);
  process.exit(1);
});
