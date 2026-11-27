import "server-only";
import type { Category } from "./config";
import { secret } from "./config";
import { isBankruptcyCourt, type ClDoc, type ClDocket } from "./courtlistener";

export interface Extracted {
  companyName: string;
  founderFullName: string | null;
  founderFirstName: string | null;
  founderLastName: string | null;
  founderTitle: string | null;
  founderSource: string | null;
  debtAmountText: string | null;
  debtAmount: number | null;
  creditorSummary: string | null;
  distressType: string;
  insolvencyStage: string;
}

const BUSINESS =
  /\b(L\.?L\.?C|Inc|Incorporated|Corp|Corporation|Co|Company|Ltd|Limited|L\.?P|L\.?L\.?P|P\.?L\.?L\.?C|P\.?C|Group|Holdings?|Enterprises?|Partners|Industries|Services|Solutions|Logistics|Trucking|Radio|Broadcasting|Auto|Automotive|Repair|Bar|Grill|Pizza|Pizzeria|Church|Ministries|Academy|School|Shop|Boutique|Garage|Hotel|Motel|Inn|Lounge|Club|Tavern|Bistro|Kitchen|Deli|Barber|Ranch|Nursery|Electric|Plumbing|Roofing|Landscaping|Painting|Cleaning|Flooring|Homes|Rentals|Apartments|Towing|Express|Freight|Imports|Wholesale|Distributors?|Distribution|Productions|Entertainment|Records|Publishing|Printing|Designs?|Labs?|Software|Networks|Communications|Wireless|Energy|Oil|Petroleum|Mining|Gym|Yoga|Care|Hospice|Veterinary|Bakery|Catering|Coffee|Brewery|Winery|Motorsports|Cars|Trucks|Equipment|Rental|Storage|Moving|Security|Staffing|Marketing|Insurance|Realty|Real Estate|Mortgage|Title|Law|Legal|Accounting|Tax|Consultants|Contracting|Mechanical|HVAC|Heating|Cooling|Solar|Steel|Metal|Glass|Wood|Furniture|Fashion|Apparel|Jewelry|Beauty|Nails|Tattoo|Massage|Therapy|Rehab|Daycare|Preschool|Learning|Tutoring|Travel|Tours|Aviation|Marine|Boats|Pets|Grooming|Restaurants?|Construction|Properties|Ventures|Capital|Systems|Technologies|Manufacturing|Hospitality|Medical|Healthcare|Dental|Clinic|Farms?|Transport(ation)?|Associates|Builders|Contractors|Motors|Foods?|Stores?|Market|Realty|Development|Management|Investments?|Supply|Studios?|Media|Brewing|Bakery|Cafe|Salon|Spa|Fitness|Center|Pharmacy|Agency|Consulting|DBA|d\/b\/a)\b\.?/i;

const NOT_PERSON =
  /\b(United States|America|Internal Revenue|IRS|Trustee|Bank|Department|Dept|Office|Court|State of|County|City of|Commonwealth|Commissioner|Secretary|Administration|Agency|Authority|Board|Commission|Federal|National|Association|Union|Fund|Trust|Estate of|Unknown|Does?\b|et al|Creditors?|Committee|Debtors?|Plaintiffs?|Defendants?|Inc|LLC|Corp)\b/i;

const TITLE_WORDS =
  "President|Chief Executive Officer|CEO|Managing Member|Sole Member|Member|Manager|Owner|Founder|Co-Founder|Principal|Director|Chief Restructuring Officer|CRO|Chief Financial Officer|CFO|Officer|Partner|General Partner|Vice President|Authorized Representative|Authorized Signatory|Shareholder";

function clean(s: string) {
  return s.replace(/\s+/g, " ").replace(/<[^>]+>/g, "").trim();
}

export function stripInRe(name: string) {
  return clean(name)
    .replace(/^(in re:?|in the matter of:?|re:)\s*/i, "")
    .replace(/,?\s*(debtors?|debtor-in-possession|et al\.?)\s*$/i, "")
    .trim();
}

export function isBusiness(name: string) {
  return BUSINESS.test(name) && !/^United States\b/i.test(name);
}

const NAME_TOKEN = "[A-Z][a-zA-Z'’\\-]+";
const PERSON_RE = new RegExp(`^(${NAME_TOKEN})(?:\\s+[A-Z]\\.?|\\s+${NAME_TOKEN}){1,3}$`);

export function looksLikePerson(name: string) {
  const n = clean(name).replace(/,?\s*(Jr|Sr|II|III|IV)\.?$/i, "");
  if (!n || n.length > 40 || NOT_PERSON.test(n) || BUSINESS.test(n)) return false;
  return PERSON_RE.test(n);
}

function splitName(full: string) {
  const parts = clean(full).replace(/,?\s*(Jr|Sr|II|III|IV)\.?$/i, "").split(" ");
  const first = parts[0];
  const last = parts.length > 1 ? parts[parts.length - 1] : "";
  return { first, last };
}

function titleCase(s: string) {
  if (s !== s.toUpperCase()) return s;
  return s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/\bLlc\b/g, "LLC").replace(/\bInc\b/g, "Inc");
}

const SUFFIX_ONLY = /^(inc|incorporated|llc|l\.l\.c|ltd|limited|corp|corporation|co|company|lp|l\.p|llp|l\.l\.p|pllc|p\.l\.l\.c|pc|p\.c|n\.a|na|sa|plc)\.?$/i;

/** Split one side of a caption into parties, keeping "UMR, Inc." together. */
function splitSide(side: string): string[] {
  const parts = side
    .replace(/\bet al\.?/gi, "")
    .split(/,|;|\s+and\s+|\s+&\s+(?=[A-Z][a-z]+\s+[A-Z])/)
    .map((s) => clean(s).replace(/^(the)\s+/i, ""))
    .filter(Boolean);
  const out: string[] = [];
  for (const p of parts) {
    if (SUFFIX_ONLY.test(p) && out.length) out[out.length - 1] = `${out[out.length - 1]}, ${p}`;
    else out.push(p);
  }
  return out;
}

function sides(caseName: string): { plaintiff: string; defendants: string[]; etAl: boolean } | null {
  const m = caseName.split(/\s+v\.?\s+|\s+vs\.?\s+/i);
  if (m.length < 2) return null;
  const def = m.slice(1).join(" v. ");
  return { plaintiff: clean(m[0]), defendants: splitSide(def), etAl: /\bet al\b/i.test(def) };
}

/**
 * A person (not a company) in distress: sued by the United States for taxes, sued by a lender/funder for a debt,
 * or filing Chapter 11 personally. Handles "Bradshaw, Bruce" style captions. Surname-only captions are skipped.
 */
export function individualFor(category: Category, d: { caseName: string; chapter?: string | number | null }): { name: string; first: string; last: string } | null {
  const asPerson = (raw: string) => {
    const n = titleCase(clean(raw).replace(/,?\s*(et al\.?)$/i, ""));
    if (!looksLikePerson(n)) return null;
    const { first, last } = splitName(n);
    return first && last ? { name: n, first, last } : null;
  };
  if (category === "court") {
    const n = stripInRe(d.caseName);
    return String(d.chapter ?? "11") === "11" && !isBusiness(n) ? asPerson(n) : null;
  }
  const s = sides(d.caseName);
  if (!s || s.defendants.some(isBusiness)) return null;
  const okPlaintiff =
    category === "tax" ? US_PLAINTIFF.test(s.plaintiff) : LENDER.test(s.plaintiff) && !US_PLAINTIFF.test(s.plaintiff) && !looksLikePerson(s.plaintiff);
  if (!okPlaintiff) return null;
  const defs = s.defendants;
  // "Bradshaw, Bruce" → "Bruce Bradshaw"
  if (defs.length >= 2 && !/\s/.test(defs[0]) && /^[A-Za-z'’-]+(\s+[A-Z]\.?)?$/.test(defs[1])) {
    const p = asPerson(`${defs[1]} ${defs[0]}`);
    if (p) return p;
  }
  for (const x of defs) {
    const p = asPerson(x);
    if (p) return p;
  }
  return null;
}

/** Parties named on the defending side of "X v. Y". */
function defendants(caseName: string): string[] {
  return sides(caseName)?.defendants ?? [];
}

function plaintiff(caseName: string) {
  return sides(caseName)?.plaintiff ?? null;
}

/** Lenders, merchant-cash-advance funders, lessors and collectors — the plaintiffs of a real debt-collection suit. */
const LENDER =
  /\b(capital|funding|funder|financial|finance|bank|bancorp|credit|lending|lender|loans?|leasing|advance|factoring|receivables|acceptance|ventures|merchant|N\.?A\.?|savings|SBA|Small Business Administration|collections?|recovery|servicing)\b/i;

const US_PLAINTIFF = /^(the\s+)?(United States|U\.S\.A?\.?|USA)\b/i;

/**
 * Tax: the United States sues the business. Debt: a lender/funder sues the business.
 * Anything else (a person suing a big company, refund suits, insurer disputes) is not a distress lead.
 */
export function suitQualifies(category: Category, caseName: string) {
  const s = sides(caseName);
  if (!s || !s.defendants.some(isBusiness)) return false;
  if (category === "tax") return US_PLAINTIFF.test(s.plaintiff);
  if (category === "debt") return LENDER.test(s.plaintiff) && !US_PLAINTIFF.test(s.plaintiff) && !looksLikePerson(s.plaintiff);
  return true;
}

const SIGNER_RES: RegExp[] = [
  new RegExp(`Declaration of (${NAME_TOKEN}(?:\\s+[A-Z]\\.)?(?:\\s+${NAME_TOKEN}){1,2})(?:,|\\s+in\\b|\\s+as\\b|\\s+pursuant)`, "g"),
  new RegExp(`(${NAME_TOKEN}(?:\\s+[A-Z]\\.)?(?:\\s+${NAME_TOKEN}){1,2}),?\\s+(?:the\\s+|its\\s+|as\\s+)?(${TITLE_WORDS})\\b`, "g"),
  new RegExp(`(${TITLE_WORDS}),?\\s+(${NAME_TOKEN}(?:\\s+[A-Z]\\.)?(?:\\s+${NAME_TOKEN}){1,2})`, "g"),
  new RegExp(`[Ss]igned by (${NAME_TOKEN}(?:\\s+[A-Z]\\.)?(?:\\s+${NAME_TOKEN}){1,2})`, "g"),
];

function signerFromDocs(docs: ClDoc[]): { name: string; title: string | null } | null {
  const texts = docs.map((d) => clean(`${d.description ?? ""} ${d.short_description ?? ""} ${d.snippet ?? ""}`));
  for (const t of texts) {
    for (const re of SIGNER_RES) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(t))) {
        const [a, b] = [m[1], m[2]];
        const titleFirst = b && new RegExp(`^(${TITLE_WORDS})$`).test(a);
        const name = titleFirst ? b : a;
        const title = titleFirst ? a : b && new RegExp(`^(${TITLE_WORDS})$`).test(b) ? b : null;
        if (name && looksLikePerson(name) && !/^(Chapter|Debtor|Motion|Order|Notice|Voluntary|Petition)/.test(name)) {
          return { name: clean(name), title };
        }
      }
    }
  }
  return null;
}

const MONEY = /\$\s?([0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]{2})?|[0-9]+(?:\.[0-9]+)?\s?(?:million|billion|m\b|k\b))/gi;

function moneyValue(s: string) {
  const t = s.replace(/[$,\s]/g, "").toLowerCase();
  const n = parseFloat(t);
  if (!Number.isFinite(n)) return null;
  if (/billion/.test(t)) return n * 1e9;
  if (/million|m$/.test(t)) return n * 1e6;
  if (/k$/.test(t)) return n * 1e3;
  return n;
}

function debtFromText(texts: string[]) {
  let best: number | null = null;
  for (const t of texts) {
    for (const m of t.matchAll(MONEY)) {
      const v = moneyValue(m[0]);
      if (v && v >= 1000 && (best === null || v > best)) best = v;
    }
  }
  return best;
}

export function fmtMoney(n: number) {
  return "$" + Math.round(n).toLocaleString("en-US");
}

export function stageFor(category: Category, filed: string | undefined, chapter?: string | number | null) {
  const days = filed ? Math.max(0, Math.floor((Date.now() - Date.parse(filed)) / 86_400_000)) : 0;
  if (category === "court") {
    if (String(chapter) === "7") return "Chapter 7 — liquidation";
    if (days <= 30) return "Petition filed — early restructuring";
    if (days <= 90) return "Plan negotiation";
    return "Plan / confirmation stage";
  }
  if (category === "tax") return days <= 21 ? "Tax suit filed — answer due" : "Tax suit pending";
  return days <= 21 ? "Collection suit filed — answer due" : "Collection suit pending";
}

/** Pick the company in distress from a docket, or null when it is not a business. */
export function companyFor(category: Category, d: ClDocket): string | null {
  if (category === "court" || isBankruptcyCourt(d.court_id)) {
    const n = stripInRe(d.caseName);
    if (isBusiness(n)) return titleCase(n);
    const p = (d.party ?? []).find((x) => isBusiness(x) && !/trustee|bank|internal revenue/i.test(x));
    return p ? titleCase(stripInRe(p)) : null;
  }
  // Tax and debt: only the business being sued, taken from the caption itself.
  if (!suitQualifies(category, d.caseName)) return null;
  const biz = defendants(d.caseName).find(isBusiness);
  return biz ? titleCase(biz) : null;
}

export function heuristicExtract(category: Category, d: ClDocket, company: string, docs: ClDoc[]): Extracted {
  const allDocs = [...(d.recap_documents ?? []), ...docs];
  const texts = allDocs.map((x) => clean(`${x.description ?? ""} ${x.snippet ?? ""}`));
  let founder: { name: string; title: string | null; source: string } | null = null;

  // Tax and debt suits often sue the owner personally next to the company (guarantor / responsible person).
  // Only people on the DEFENDANT side count — never the plaintiff.
  if (category !== "court") {
    const person = defendants(d.caseName).find(looksLikePerson);
    if (person) founder = { name: titleCase(person), title: category === "tax" ? "Owner / responsible person (defendant)" : "Owner / guarantor (defendant)", source: "case caption" };
  }
  if (!founder) {
    const s = signerFromDocs(allDocs);
    if (s) founder = { name: s.name, title: s.title, source: "court document" };
  }
  // "Lender v. Company, et al.": when the plaintiff is a company, the people in the party list are the other defendants.
  const sd = sides(d.caseName);
  if (!founder && category !== "court" && sd?.etAl && !looksLikePerson(sd.plaintiff)) {
    const plain = sd.plaintiff.toLowerCase();
    const p = (d.party ?? []).find((x) => looksLikePerson(x) && !plain.includes(x.toLowerCase().split(" ").pop() ?? "~"));
    if (p) founder = { name: titleCase(p), title: "Owner / guarantor (defendant)", source: "party list (et al.)" };
  }

  const debt = debtFromText(texts);
  const allText = `${d.caseName} ${texts.join(" ")}`;
  let distressType: string;
  let creditor: string | null = null;
  if (category === "court") {
    const subV = /subchapter v|subchapter 5|small business debtor/i.test(allText);
    const ch = d.chapter ? String(d.chapter) : /chapter 7\b/i.test(allText) ? "7" : "11";
    distressType = ch === "11" && subV ? "Chapter 11 — Subchapter V" : `Chapter ${ch}`;
    const parts: string[] = [];
    if ((d.party ?? []).some((p) => /internal revenue|\bIRS\b/i.test(p)) || /internal revenue|\bIRS\b/i.test(allText)) parts.push("IRS tax priority");
    if ((d.party ?? []).some((p) => /bank|capital|funding|financial|lending|credit/i.test(p))) parts.push("Commercial lenders");
    creditor = parts.length ? parts.join(" + ") : null;
  } else if (category === "tax") {
    distressType = "Federal tax suit";
    creditor = /state of|department of revenue|franchise tax/i.test(allText) ? "State tax authority" : "IRS / United States";
  } else {
    distressType = d.suitNature ? `Debt suit — ${d.suitNature.replace(/^\d+\s*/, "")}` : "Commercial debt suit";
    creditor = plaintiff(d.caseName);
  }

  const name = founder ? splitName(founder.name) : null;
  return {
    companyName: company,
    founderFullName: founder?.name ?? null,
    founderFirstName: name?.first ?? null,
    founderLastName: name?.last ?? null,
    founderTitle: founder?.title ?? null,
    founderSource: founder?.source ?? null,
    debtAmount: debt,
    debtAmountText: debt ? fmtMoney(debt) : null,
    creditorSummary: creditor,
    distressType,
    insolvencyStage: stageFor(category, d.dateFiled, d.chapter),
  };
}

/** Optional: when an OpenAI key is present, let gpt-4o-mini fill in what the patterns missed. */
export async function llmRefine(category: Category, d: ClDocket, docs: ClDoc[], base: Extracted): Promise<Extracted> {
  const key = await secret("OPENAI_API_KEY");
  if (!key) return base;
  const material = {
    caseName: d.caseName,
    court: d.court,
    dateFiled: d.dateFiled,
    chapter: d.chapter,
    suitNature: d.suitNature,
    parties: (d.party ?? []).slice(0, 40),
    documents: [...(d.recap_documents ?? []), ...docs].slice(0, 25).map((x) => clean(`${x.description ?? ""} — ${x.snippet ?? ""}`).slice(0, 600)),
  };
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["companyName", "founderFullName", "founderTitle", "debtAmountNumeric", "creditorSummary"],
    properties: {
      companyName: { type: "string" },
      founderFullName: { type: ["string", "null"] },
      founderTitle: { type: ["string", "null"] },
      debtAmountNumeric: { type: ["number", "null"] },
      creditorSummary: { type: ["string", "null"] },
    },
  };
  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0,
        response_format: { type: "json_schema", json_schema: { name: "lead", strict: true, schema } },
        messages: [
          {
            role: "system",
            content:
              "Extract facts from a US court docket about a business in financial distress. founderFullName must be a real human who owns, runs or signed for the business (CEO, president, managing member, owner, guarantor) and appears in the material; never an attorney, judge, trustee, creditor or government official. Use null when not present. debtAmountNumeric is the total debt or amount sued for, in USD, or null.",
          },
          { role: "user", content: `Category: ${category}\n${JSON.stringify(material)}` },
        ],
      }),
    });
    if (!r.ok) return base;
    const j = await r.json();
    const out = JSON.parse(j.choices?.[0]?.message?.content ?? "{}");
    const next = { ...base };
    if (out.companyName && isBusiness(out.companyName)) next.companyName = out.companyName;
    if (!base.founderFullName && out.founderFullName && looksLikePerson(out.founderFullName)) {
      const n = splitName(out.founderFullName);
      next.founderFullName = out.founderFullName;
      next.founderFirstName = n.first;
      next.founderLastName = n.last;
      next.founderTitle = out.founderTitle ?? null;
      next.founderSource = "AI from court documents";
    }
    if (!base.debtAmount && typeof out.debtAmountNumeric === "number" && out.debtAmountNumeric > 0) {
      next.debtAmount = out.debtAmountNumeric;
      next.debtAmountText = fmtMoney(out.debtAmountNumeric);
    }
    if (!base.creditorSummary && out.creditorSummary) next.creditorSummary = out.creditorSummary;
    return next;
  } catch {
    return base;
  }
}

export function splitFullName(full: string) {
  return splitName(full);
}
