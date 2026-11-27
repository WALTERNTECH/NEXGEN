import "server-only";
import type { Category } from "./config";
import { secret } from "./config";
import { docketEntries, documentText, type ClDocket, type ClEntry } from "./courtlistener";
import { looksLikePerson } from "./extract";

/**
 * Update C — exact figures. Amounts are only ever taken from text that is actually in the public record
 * (RECAP copies of the bankruptcy schedules, the petition, or the complaint). Nothing is estimated:
 * when the documents are not public yet, the field stays empty and the case is re-checked later.
 */
export interface CaseFigures {
  total: number | null;
  tax: number | null;
  secured: number | null;
  unsecured: number | null;
  priority: number | null;
  range: string | null;
  source: string | null;
}

export interface CaseDetails extends CaseFigures {
  judge: string | null;
  trustee: string | null;
  dba: string | null;
  summary: string;
  notes: { date: string | null; no: string | null; text: string }[];
  entries: ClEntry[];
  signer: { name: string; title: string | null; source: string } | null;
}

const AMT = String.raw`\$\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})?|[0-9]+(?:\.[0-9]{2})?)`;

function num(s: string | undefined | null) {
  if (!s) return null;
  const n = Number(s.replace(/[$,\s]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function firstAmountAfter(text: string, label: RegExp, window = 400): number | null {
  const m = label.exec(text);
  if (!m) return null;
  const tail = text.slice(m.index + m[0].length, m.index + m[0].length + window);
  const a = new RegExp(AMT).exec(tail);
  return a ? num(a[1]) : null;
}

const TAX_CREDITORS =
  /(Internal Revenue Service|\bIRS\b|Department of (?:Revenue|Taxation)|Franchise Tax Board|Comptroller|Tax Collector|Department of Treasury|Employment Development Department|Board of Equalization|Workforce Commission|Tax Commission)/gi;

/** Official Form 106Sum / 206Sum (Summary of Assets and Liabilities) and Schedule E/F. */
export function parseSchedules(text: string): Partial<CaseFigures> {
  const t = text.replace(/\s+/g, " ");
  const out: Partial<CaseFigures> = {};
  const total =
    firstAmountAfter(t, /Total liabilities/i) ?? firstAmountAfter(t, /Your total liabilities/i) ?? firstAmountAfter(t, /Total of all (?:claims|liabilities)/i);
  const secured =
    firstAmountAfter(t, /Schedule D:? Creditors Who Have Claims Secured by Property/i) ??
    firstAmountAfter(t, /Total (?:claim amounts? )?(?:of )?secured claims/i);
  const priority =
    firstAmountAfter(t, /Total claim amounts of priority unsecured claims/i) ?? firstAmountAfter(t, /3a\.\s*Total claim amounts of priority/i) ?? firstAmountAfter(t, /Total (?:of )?priority unsecured claims/i);
  const nonpriority =
    firstAmountAfter(t, /Total amount of claims of nonpriority amount of unsecured claims/i) ??
    firstAmountAfter(t, /3b\.\s*Total amount of claims of nonpriority/i) ??
    firstAmountAfter(t, /Total (?:of )?nonpriority unsecured claims/i);
  if (total) out.total = total;
  if (secured) out.secured = secured;
  if (priority) out.priority = priority;
  if (priority || nonpriority) out.unsecured = (priority ?? 0) + (nonpriority ?? 0);
  if (!out.total && out.secured !== undefined && out.unsecured !== undefined) out.total = (out.secured ?? 0) + (out.unsecured ?? 0);

  // Tax claims: amounts listed against tax authorities in Schedule E/F (Part 1 is mostly taxes).
  // Each tax creditor counts once per distinct amount, and only an amount close to its name.
  const taxAmounts = new Set<number>();
  for (const m of t.matchAll(TAX_CREDITORS)) {
    const tail = t.slice(m.index! + m[0].length, m.index! + m[0].length + 260);
    const cut = tail.search(/\b\d\.\d{1,2}\s+[A-Z]/); // next numbered creditor line, e.g. "2.4 Acme"
    const a = new RegExp(AMT).exec(cut > 0 ? tail.slice(0, cut) : tail);
    const v = a ? num(a[1]) : null;
    if (v) taxAmounts.add(v);
  }
  const tax = [...taxAmounts].reduce((x, y) => x + y, 0);
  if (tax > 0) out.tax = Math.round(tax * 100) / 100;
  return out;
}

/** Voluntary petition (Form 201): estimated liabilities are ranges, never exact. */
export function parsePetitionRange(text: string): string | null {
  const t = text.replace(/\s+/g, " ");
  const i = t.search(/Estimated liabilities/i);
  if (i < 0) return null;
  const seg = t.slice(i, i + 600);
  const marked = /(?:☒|\[x\]|■|X)\s*(\$[0-9,]+(?:\s*million|\s*billion)?\s*-\s*\$[0-9,]+(?:\s*million|\s*billion)?|More than \$[0-9,]+ billion)/i.exec(seg);
  return marked ? marked[1].replace(/\s+/g, " ") : null;
}

/**
 * Who signed for the company: Official Form 201 (voluntary petition, "Signature of authorized representative")
 * and Form 202 (declaration for non-individual debtors) print the signer's name and title.
 */
export function parseSigner(text: string): { name: string; title: string | null } | null {
  const t = text.replace(/\s+/g, " ");
  const stop = String.raw`(?=\s+(?:Signature|Date|Title|X\s|Executed|18\.|19\.|Position|Part\s|Official Form)|\s*$)`;
  const pats = [
    new RegExp(String.raw`authorized representative of (?:the )?debtor[\s\S]{0,700}?Printed name:?\s+([A-Z][A-Za-z.'’\- ]{3,50}?)\s+Title:?\s+([A-Za-z ,&\/\-]{2,50}?)` + stop, "i"),
    new RegExp(String.raw`Printed name:?\s+([A-Z][A-Za-z.'’\- ]{3,50}?)\s+Position or relationship to debtor:?\s+([A-Za-z ,&\/\-]{2,50}?)` + stop, "i"),
    new RegExp(String.raw`\/s\/\s*([A-Z][A-Za-z.'’\-]+(?:\s+[A-Z][A-Za-z.'’\-]+){1,3}),?\s+(President|CEO|Chief Executive Officer|Managing Member|Sole Member|Member|Manager|Owner|Director|Chief Restructuring Officer)`, "i"),
  ];
  for (const re of pats) {
    const m = re.exec(t);
    if (!m) continue;
    const name = m[1].trim().replace(/\s+/g, " ");
    if (looksLikePerson(name)) return { name, title: m[2]?.trim() || null };
  }
  return null;
}

/** Complaints in tax and debt suits state the amount sued for. */
export function parseComplaint(text: string, category: Category): Partial<CaseFigures> {
  const t = text.replace(/\s+/g, " ");
  const patterns = [
    /(?:in the (?:total )?amount of|sum of|totaling|total(?:s)? of|balance (?:due )?of|unpaid balance of|indebted .{0,40}?in the amount of|damages (?:in the amount )?of|judgment (?:in the amount )?of)\s*/gi,
  ];
  let best: number | null = null;
  for (const p of patterns) {
    for (const m of t.matchAll(p)) {
      const tail = t.slice(m.index! + m[0].length, m.index! + m[0].length + 40);
      const a = new RegExp("^" + AMT).exec(tail.trim());
      const v = a ? num(a[1]) : null;
      if (v && v >= 1000 && (best === null || v > best)) best = v;
    }
  }
  if (!best) return {};
  return category === "tax" ? { total: best, tax: best } : { total: best };
}

function buildSummary(category: Category, d: ClDocket, f: CaseFigures, entries: ClEntry[]) {
  const parts: string[] = [];
  if (category === "court") {
    parts.push(`Chapter ${d.chapter ?? "11"} case filed ${d.dateFiled ?? ""} in ${d.court ?? "bankruptcy court"}.`);
  } else {
    parts.push(`${d.suitNature ? d.suitNature.replace(/^\d+\s*/, "") + " suit" : "Civil suit"} filed ${d.dateFiled ?? ""} in ${d.court ?? "district court"}.`);
    if (d.cause) parts.push(`Cause: ${d.cause}.`);
  }
  if (d.assignedTo) parts.push(`Judge: ${d.assignedTo}.`);
  if (d.trustee_str) parts.push(`Trustee: ${d.trustee_str}.`);
  if (f.total) parts.push(`Total liabilities on file: $${f.total.toLocaleString("en-US")}${f.source ? ` (${f.source})` : ""}.`);
  else if (f.range) parts.push(`Estimated liabilities on the petition: ${f.range}.`);
  if (f.tax) parts.push(`Tax claims: $${f.tax.toLocaleString("en-US")}.`);
  const others = (d.party ?? []).filter((p) => p !== d.caseName).slice(0, 8);
  if (others.length) parts.push(`Parties: ${others.join("; ")}.`);
  parts.push(`${entries.length} docket entr${entries.length === 1 ? "y" : "ies"} public so far.`);
  return parts.join(" ");
}

function dbaOf(d: ClDocket) {
  const all = [d.caseName, ...(d.party ?? [])].join(" | ");
  const m = /\b(?:d\/b\/a|dba|doing business as)\s+([^|,;()]+)/i.exec(all);
  return m ? m[1].trim().slice(0, 120) : null;
}

const SCHEDULE_DOC = /summary of (?:your )?assets and liabilities|schedules? (?:a\/b|d|e\/f|of assets)|schedules|206sum|106sum/i;
const PETITION_DOC = /voluntary petition|chapter 11 petition|petition for relief/i;
const COMPLAINT_DOC = /complaint/i;
const SIGNER_DOC = /declaration|resolution|corporate ownership|statement of financial affairs|list of (?:creditors|equity)|202/i;

export async function caseDetails(category: Category, d: ClDocket, needSigner = false): Promise<CaseDetails> {
  let signer: CaseDetails["signer"] = null;
  const entries = await docketEntries(d.docket_id);
  const f: CaseFigures = { total: null, tax: null, secured: null, unsecured: null, priority: null, range: null, source: null };
  const avail = entries.filter((e) => e.is_available && e.id);
  const pick = (re: RegExp) => avail.filter((e) => re.test(`${e.description ?? ""} ${e.short_description ?? ""}`));
  let reads = 0;
  const texts: string[] = [];

  if (category === "court") {
    for (const e of pick(SCHEDULE_DOC).slice(0, 3)) {
      if (reads++ >= 3) break;
      const txt = await documentText(e.id!);
      if (!txt) continue;
      texts.push(txt);
      const p = parseSchedules(txt);
      if (p.total && !f.total) {
        f.total = p.total;
        f.source = `Schedules, doc ${e.document_number ?? ""}`.trim();
      }
      f.secured ??= p.secured ?? null;
      f.unsecured ??= p.unsecured ?? null;
      f.priority ??= p.priority ?? null;
      f.tax ??= p.tax ?? null;
    }
    // The petition gives the signer (owner/officer) and, until schedules exist, the liabilities range.
    if (!f.total || needSigner) {
      for (const e of pick(PETITION_DOC).slice(0, 1)) {
        const txt = await documentText(e.id!);
        if (!txt) continue;
        texts.push(txt);
        if (!f.total) {
          f.range = parsePetitionRange(txt);
          if (f.range) f.source = `Petition, doc ${e.document_number ?? "1"} (range)`;
        }
        const sg = parseSigner(txt);
        if (sg) signer = { ...sg, source: `petition signature, doc ${e.document_number ?? "1"}` };
      }
    }
    if (needSigner && !signer) {
      for (const e of pick(SIGNER_DOC).slice(0, 2)) {
        const txt = await documentText(e.id!);
        if (!txt) continue;
        const sg = parseSigner(txt);
        if (sg) {
          signer = { ...sg, source: `signed filing, doc ${e.document_number ?? ""}`.trim() };
          break;
        }
      }
    }
    for (const t of texts) {
      if (signer) break;
      const sg = parseSigner(t);
      if (sg) signer = { ...sg, source: "schedules signature" };
    }
  } else {
    for (const e of pick(COMPLAINT_DOC).slice(0, 2)) {
      const txt = await documentText(e.id!);
      if (!txt) continue;
      texts.push(txt);
      const p = parseComplaint(txt, category);
      if (p.total) {
        f.total = p.total;
        f.tax = p.tax ?? null;
        f.source = `Complaint, doc ${e.document_number ?? "1"}`;
        break;
      }
    }
  }

  if (!f.total && texts.length) await aiFigures(category, texts, f);

  const notes = entries
    .slice()
    .sort((a, b) => String(b.entry_date_filed ?? "").localeCompare(String(a.entry_date_filed ?? "")))
    .slice(0, 25)
    .map((e) => ({ date: e.entry_date_filed ?? null, no: e.document_number ? String(e.document_number) : null, text: (e.description || e.short_description || "").replace(/\s+/g, " ").slice(0, 400) }))
    .filter((n) => n.text);

  return {
    ...f,
    judge: d.assignedTo || null,
    trustee: d.trustee_str || null,
    dba: dbaOf(d),
    summary: buildSummary(category, d, f, entries),
    notes,
    entries,
    signer,
  };
}

/** Optional: with an OpenAI key, read exact figures out of the same public text when the patterns miss. */
async function aiFigures(category: Category, texts: string[], f: CaseFigures) {
  const key = await secret("OPENAI_API_KEY");
  if (!key) return;
  const material = texts.map((t) => t.replace(/\s+/g, " ").slice(0, 12000)).join("\n---\n").slice(0, 30000);
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["total", "tax", "secured", "unsecured"],
    properties: {
      total: { type: ["number", "null"] },
      tax: { type: ["number", "null"] },
      secured: { type: ["number", "null"] },
      unsecured: { type: ["number", "null"] },
    },
  };
  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(25_000),
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0,
        response_format: { type: "json_schema", json_schema: { name: "figures", strict: true, schema } },
        messages: [
          {
            role: "system",
            content:
              "Read US court filing text and return exact dollar figures that are written in it: total liabilities or amount sued for, tax owed to IRS/state tax authorities, secured debt, unsecured debt. Only copy numbers that appear in the text. Use null when a figure is not stated. Never estimate.",
          },
          { role: "user", content: `Category: ${category}\n${material}` },
        ],
      }),
    });
    if (!r.ok) return;
    const j = await r.json();
    const o = JSON.parse(j.choices?.[0]?.message?.content ?? "{}");
    // Accept a number only if it literally appears in the source text.
    const appears = (n: number | null) => {
      if (!n || n <= 0) return null;
      const fmt = n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
      return material.includes(fmt) || material.includes(n.toFixed(2)) || material.includes(String(n)) ? n : null;
    };
    f.total ??= appears(o.total);
    f.tax ??= appears(o.tax);
    f.secured ??= appears(o.secured);
    f.unsecured ??= appears(o.unsecured);
    if (f.total) f.source = (f.source ? f.source + "; " : "") + "read by AI from public filing text";
  } catch {}
}
