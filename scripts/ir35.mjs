// IR35 language scoring — canonical copy.
// The dashboard (index.html) carries an inline duplicate of OUTSIDE/INSIDE so it
// can score pasted adverts offline. Change one, change the other.

export const OUTSIDE = [
  "outside ir35", "outside of ir35", "own invoice", "invoice via", "limited company",
  "ltd company", "psc", "umbrella company", "self-employed", "self employed",
  "independent contractor", "own vehicle", "substitute", "substitution",
  "right of substitution", "day rate contract", "statement of work",
  "deliverable based", "no notice period", "outside determination"
];

export const INSIDE = [
  "inside ir35", "full-time placement", "full time placement", "integrated into",
  "part of the team", "staff benefits", "employee benefits", "holiday pay",
  "pension contribution", "exclusive services", "company induction", "line managed",
  "reports directly to", "manage your schedule", "fixed hours", "core hours",
  "annual leave", "performance review", "probation", "paye", "deemed employee",
  "40 hours per week", "sick pay"
];

export function stripHtml(s) {
  return String(s || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&pound;/gi, "£")
    .replace(/&#163;/g, "£")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .trim();
}

/**
 * Score advert wording for IR35 risk.
 * @param {string} text  full advert text (HTML is tolerated)
 * @param {object} opts  { snippetOnly } — true when only a truncated snippet was available
 * @returns {{rating:number, plus:string[], minus:string[], mentions:boolean, confidence:string}}
 */
export function assess(text, opts = {}) {
  const clean = stripHtml(text);
  const t = " " + clean.toLowerCase().replace(/\s+/g, " ") + " ";

  const plus = OUTSIDE.filter((k) => t.includes(k));
  const minus = INSIDE.filter((k) => t.includes(k));

  let score = 5;
  if (t.includes("outside ir35") || t.includes("outside of ir35")) score -= 2.5;
  if (t.includes("inside ir35") || t.includes("paye")) score += 2.5;
  score -= plus.length * 0.9;
  score += minus.length * 0.9;
  if (!plus.length && !minus.length) score = 5;

  // A truncated snippet can't be trusted to clear a role. Absence of red flags in
  // 200 characters is not evidence of anything, so never let a snippet score
  // into the "apply to these" band on its own.
  let confidence = opts.snippetOnly ? "low" : "normal";
  if (opts.snippetOnly && score < 4) score = 4;

  score = Math.max(1, Math.min(10, Math.round(score)));
  return { rating: score, plus, minus, mentions: t.includes("ir35"), confidence };
}

export function band(rating) {
  return rating <= 3 ? "safe" : rating <= 6 ? "warn" : "risk";
}

// £45,000 becomes £45000 once commas go, and \d{3,4} would happily match "4500"
// inside it. The lookarounds keep a match to a whole number.
const N = "(?<!\\d)(\\d{3,4})(?!\\d)";
const PER_DAY = "(?:per day|per\\s?day|p\\/?d\\b|pd\\b|a day|daily|\\/\\s?day|day rate)";
const DAY_CONTEXT = /per day|day rate|\/\s?day|\bp\/?d\b|\ba day\b|daily rate/i;
const PLAUSIBLE = (n) => n >= 150 && n <= 2500;

/** Pull a day rate out of advert text. Returns the top of any range, or null. */
export function extractDayRate(text) {
  const t = stripHtml(text).replace(/,/g, "");
  const pick = (...ns) => {
    const best = Math.max(...ns.map(Number).filter((n) => n && PLAUSIBLE(n)), 0);
    return best || null;
  };

  // "£500 - £550 per day"
  const m1 = t.match(new RegExp(`£\\s?${N}(?:\\.\\d+)?\\s*(?:-|–|—|to)\\s*£?\\s?${N}(?:\\.\\d+)?[^.\\n]{0,25}?${PER_DAY}`, "i"));
  if (m1) return pick(m1[1], m1[2]);

  // "£500 per day"
  const m2 = t.match(new RegExp(`£\\s?${N}(?:\\.\\d+)?[^.\\n]{0,25}?${PER_DAY}`, "i"));
  if (m2) return pick(m2[1]);

  // "Day rate: £500" / "day rate of up to £650" — the marker leads
  const m3 = t.match(new RegExp(`day rate[^£\\n]{0,25}£\\s?${N}(?:\\s*(?:-|–|—|to)\\s*£?\\s?${N})?`, "i"));
  if (m3) return pick(m3[1], m3[2] || 0);

  // "up to 650 per day", £ omitted. The optional second number must be wrapped —
  // `${N}?` would only make the lookahead optional, not the digits.
  const m4 = t.match(new RegExp(`${N}\\s*(?:-|–|to)?\\s*(?:${N})?[^.\\n]{0,15}?${PER_DAY}`, "i"));
  if (m4) return pick(m4[1], m4[2] || 0);

  // Last resort: a bare "£400 – £500" with no marker attached, as in
  // "Salesforce Consultant | £400 – £500 | Outside IR35". A 3–4 digit figure on a
  // contract board is a day rate — annual salaries are 5–6 digits and can't match
  // N anyway. Only reject if the words right after it say otherwise.
  const m5 = t.match(new RegExp(`£\\s?${N}(?:\\s*(?:-|–|—|to)\\s*£?\\s?${N})?`, "i"));
  if (m5) {
    const after = t.slice(m5.index + m5[0].length, m5.index + m5[0].length + 40);
    if (!/annum|year|salary|per week|weekly|per hour|hourly|per month|monthly|k\b/i.test(after)) {
      return pick(m5[1], m5[2] || 0);
    }
  }

  return null;
}

/**
 * Is this advert for the kind of role we're looking for?
 * Reed's keyword matching is loose — searching "contract project manager" returns
 * Sitecore developers and data scientists — so the title gets checked directly.
 */
export function titleMatches(title, terms) {
  if (!terms || !terms.length) return true;
  const t = " " + String(title || "").toLowerCase().replace(/[^a-z0-9]+/g, " ") + " ";
  return terms.some((term) => {
    const clean = String(term).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    return clean && t.includes(" " + clean + " ");
  });
}

/** Pull a contract length out of advert text. */
export function extractLength(text) {
  const t = stripHtml(text);
  const m = t.match(/\b(\d{1,2})\s*(?:\+)?\s*[-–]?\s*(?:to\s*(\d{1,2})\s*)?month/i);
  if (m) {
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : null;
    return b ? `${a}–${b} months` : `${a} months`;
  }
  const w = t.match(/\b(\d{1,2})\s*week/i);
  if (w) return `${w[1]} weeks`;
  return "";
}

/** Stable id so the same advert doesn't re-appear as new on every scan. */
export function roleId(source, company, title) {
  const key = [source, company, title]
    .map((s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim())
    .join("|");
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = ((h * 33) ^ key.charCodeAt(i)) >>> 0;
  return "f" + h.toString(36);
}
