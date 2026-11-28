import "server-only";
import { getSetting, setSetting, getSettings } from "./config";
import { lease, release } from "./db";
import { logRun } from "./runs";
import { notify } from "./push";
import { parseDelaware, parseFlorida, parseFtbCorp, parseSouthDakota, parseWyoming, type PdfItem, type TaxRecord } from "./taxparse";
import { saveRows, type ImportRow } from "./importers";

/**
 * State delinquent-tax publications that can be read automatically (checked 2026-11-27).
 * Not automatable: MA and RI block automated access, WI and SC don't respond to scripts, OR shows its list only
 * inside an interactive portal, CT sends it by email on request, GA and LA stopped publishing.
 */
export const TAX_STATES = {
  ca_ftb: { label: "California (FTB corporate tax)", agency: "California Franchise Tax Board", page: "https://www.ftb.ca.gov/about-ftb/newsroom/top-500-past-due-balances/corporate-income-tax-list.html" },
  fl: { label: "Florida (tax warrants)", agency: "Florida Department of Revenue", page: "https://floridarevenue.com/taxes/compliance/Pages/delinquent_taxpayer.aspx" },
  de: { label: "Delaware (business tax delinquents)", agency: "Delaware Division of Revenue", page: "https://revenue.delaware.gov/delawares-delinquent-taxpayers" },
  sd: { label: "South Dakota (business tax liens)", agency: "South Dakota Department of Revenue", page: "https://dor.sd.gov/businesses/taxes/" },
  wy: { label: "Wyoming (sales & use tax)", agency: "Wyoming Department of Revenue", page: "https://excise-tax-div.wyo.gov/general-administrative/delinquent-taxpayer-list" },
} as const;
export type TaxState = keyof typeof TAX_STATES;
export const TAX_STATE_CODES = Object.keys(TAX_STATES) as TaxState[];

const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36" };

async function get(url: string) {
  const r = await fetch(url, { headers: UA, redirect: "follow", signal: AbortSignal.timeout(45_000), cache: "no-store" });
  if (!r.ok) throw new Error(`${new URL(url).hostname} ${r.status}`);
  return r;
}

async function pdfItems(buf: ArrayBuffer): Promise<PdfItem[]> {
  const { getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const out: PdfItem[] = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const tc = await (await pdf.getPage(p)).getTextContent();
    for (const it of tc.items) if ("str" in it) out.push({ str: it.str, x: it.transform[4], y: it.transform[5], page: p });
  }
  return out;
}

function absolute(base: string, href: string) {
  return new URL(href.replace(/&amp;/g, "&"), base).toString();
}

async function fetchRecords(code: TaxState): Promise<{ records: TaxRecord[]; file: string }> {
  const today = new Date().toISOString().slice(0, 10);
  switch (code) {
    case "ca_ftb": {
      const file = "https://www.ftb.ca.gov/about-ftb/newsroom/top-500-past-due-balances/delinquents-Corp.txt";
      return { records: parseFtbCorp(await (await get(file)).text()), file };
    }
    case "fl": {
      const file = "https://floridarevenue.com/taxes/Documents/delinquent_taxes.xlsx";
      const ExcelJS = (await import("exceljs")).default;
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(await (await get(file)).arrayBuffer());
      const ws = wb.worksheets[0];
      const rows: (string | number | null)[][] = [];
      ws.eachRow({ includeEmpty: false }, (r) => {
        const vals = (r.values as unknown[]).slice(1).map((v) => (v && typeof v === "object" && "result" in (v as object) ? (v as { result: unknown }).result : v));
        rows.push(vals as (string | number | null)[]);
      });
      const asOf = /as of (\d{1,2}\/\d{1,2}\/\d{4})/i.exec(rows.map((r) => r.join(" ")).join(" "))?.[1];
      const m = asOf ? /(\d+)\/(\d+)\/(\d+)/.exec(asOf) : null;
      return { records: parseFlorida(rows, m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : today), file };
    }
    case "de": {
      const page = await (await get(TAX_STATES.de.page)).text();
      const href = /href="([^"]*Business_List_[^"]*\.pdf)"/i.exec(page)?.[1];
      if (!href) throw new Error("Delaware business list link not found");
      const file = absolute(TAX_STATES.de.page, href);
      return { records: parseDelaware(await pdfItems(await (await get(file)).arrayBuffer()), today), file };
    }
    case "sd": {
      const page = await (await get(TAX_STATES.sd.page)).text();
      const href = /href="([^"]*top-delinquent-report[^"]*\.pdf)"/i.exec(page)?.[1];
      if (!href) throw new Error("South Dakota report link not found");
      const file = absolute(TAX_STATES.sd.page, href);
      return { records: parseSouthDakota(await pdfItems(await (await get(file)).arrayBuffer()), today), file };
    }
    case "wy": {
      const page = await (await get(TAX_STATES.wy.page)).text();
      const ids = [...new Set([...page.matchAll(/drive\.google\.com\/file\/d\/([A-Za-z0-9_-]+)/g)].map((m) => m[1]))];
      const records: TaxRecord[] = [];
      for (const id of ids.slice(0, 8)) {
        try {
          const buf = await (await get(`https://drive.google.com/uc?export=download&id=${id}`)).arrayBuffer();
          if (String.fromCharCode(...new Uint8Array(buf.slice(0, 4))) !== "%PDF") continue;
          records.push(...parseWyoming(await pdfItems(buf), today)); // non-list PDFs simply yield no rows
        } catch {}
      }
      return { records, file: TAX_STATES.wy.page };
    }
  }
}

function toRow(code: TaxState, r: TaxRecord): ImportRow {
  const label = TAX_STATES[code].label;
  return {
    key: `tax_${code}:${r.name.toUpperCase()}|${(r.address ?? "").toUpperCase().slice(0, 40)}`,
    category: "tax",
    source: `tax_${code}`,
    company: r.name,
    dba: r.dba,
    address: r.address,
    city: r.city,
    state: r.state,
    amount: Math.round(r.amount * 100) / 100,
    date: r.date,
    creditor: TAX_STATES[code].agency,
    distress: `State tax delinquency — ${label}`,
    stage: "On the state's published delinquent-tax list",
    caseName: `${label}: ${r.name}`,
    url: TAX_STATES[code].page,
    raw: { ref: r.ref, owner: r.owner, ownerTitle: r.ownerTitle },
    owner: r.owner ? { name: r.owner, title: r.ownerTitle } : null,
    figuresSource: `${label} published list`,
  };
}

/** One state per call, each checked at most once a day. */
export async function importStateTaxes(): Promise<string> {
  const s = await getSettings();
  const enabled = TAX_STATE_CODES.filter((c) => s.tax_states.includes(c));
  if (!enabled.length) return "off";
  const state = (await getSetting<Partial<Record<TaxState, { at: string; rows: number; added: number; error?: string }>>>("tax_states_status")) ?? {};
  const due = enabled.find((c) => !state[c] || Date.now() - Date.parse(state[c]!.at) > 24 * 3600_000);
  if (!due) return "up to date";
  if (!(await lease("import_state_tax", 150))) return "already running";
  try {
    const { records, file } = await fetchRecords(due);
    const rows = records.filter((r) => r.amount >= s.tax_min_amount).map((r) => toRow(due, r));
    const added = await saveRows(rows, s.individual_min_amount);
    state[due] = { at: new Date().toISOString(), rows: rows.length, added };
    await setSetting("tax_states_status", state);
    await logRun("ingest", true, `Tax arrears — ${TAX_STATES[due].label}: ${records.length} listed, ${rows.length} owe at least $${s.tax_min_amount.toLocaleString()}, ${added} new queued for email search`, { file });
    if (added) await notify({ title: `${added} businesses with unpaid ${due === "ca_ftb" ? "California" : TAX_STATES[due].label.split(" ")[0]} tax`, body: "Searching for their owners' emails", url: "/leads?cat=tax", tag: `tax-${due}` });
    return `${due}: ${rows.length} listed, ${added} new`;
  } catch (e) {
    state[due] = { at: new Date().toISOString(), rows: 0, added: 0, error: (e as Error).message };
    await setSetting("tax_states_status", state);
    await logRun("ingest", false, `Tax arrears — ${TAX_STATES[due].label}: ${(e as Error).message}`);
    return `${due}: ${(e as Error).message}`;
  } finally {
    await release("import_state_tax");
  }
}
