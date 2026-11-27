// Parsers for state delinquent-tax publications. Pure functions (no network, no database) so they can be tested on saved files.

export interface TaxRecord {
  name: string; // legal/owner name of the business (or person)
  dba: string | null;
  owner: string | null; // a person named as owner/officer, when the list gives one
  ownerTitle: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  amount: number;
  date: string | null; // lien / warrant / report date (YYYY-MM-DD)
  ref: string | null; // warrant / license / revenue id
}

const money = (s: string | undefined | null) => {
  const n = Number(String(s ?? "").replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
};

const iso = (s: string | undefined | null) => {
  const m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(String(s ?? ""));
  return m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : null;
};

/** "PERRY, DAVID R" → "David R Perry"; anything else returned as-is. */
export function lastFirst(s: string) {
  const m = /^([A-Z][A-Z'’\- ]+),\s*([A-Z][A-Z'’\- .]+)$/i.exec(s.trim());
  return m ? `${m[2].trim()} ${m[1].trim()}` : s.trim();
}

// ---------------- California FTB: corporate income tax Top 500 (tab-separated text) ----------------
export function parseFtbCorp(text: string): TaxRecord[] {
  const lines = text.split(/\r?\n/);
  const head = lines[0].split("\t");
  const col = (n: string) => head.findIndex((h) => h.trim().toLowerCase() === n.toLowerCase());
  const [iName, iAddr, iTotal, iLien, iOff] = [col("Name"), col("Address"), col("Total"), col("Lien Filed"), col("Officers")];
  const out: TaxRecord[] = [];
  for (const l of lines.slice(1)) {
    const f = l.split("\t");
    const name = (f[iName] ?? "").trim();
    if (!name || name === "Total") continue;
    const addr = (f[iAddr] ?? "").trim(); // "Los Angeles, CA 90069"
    const m = /^(.*?),\s*([A-Z]{2})\s+\d{5}/.exec(addr);
    const officer = (f[iOff] ?? "").split(/;|\|/)[0].trim(); // "Billy Cheung, CFO"
    const om = /^([^,]+),\s*(.+)$/.exec(officer);
    out.push({
      name,
      dba: null,
      owner: om ? om[1].trim() : officer || null,
      ownerTitle: om ? om[2].trim() : null,
      address: addr || null,
      city: m ? m[1] : null,
      state: m ? m[2] : "CA",
      amount: money(f[iTotal]),
      date: iso(f[iLien]),
      ref: null,
    });
  }
  return out;
}

// ---------------- Florida: delinquent taxpayers workbook (one row per tax warrant) ----------------
/** rows: header row first (DBA/Business Name, Owner Name, Location Address, County, Warrant Number, Warrant Amount). */
export function parseFlorida(rows: (string | number | null)[][], asOf: string | null): TaxRecord[] {
  const hi = rows.findIndex((r) => r.some((c) => /owner name/i.test(String(c ?? ""))));
  if (hi < 0) return [];
  const h = rows[hi].map((c) => String(c ?? "").trim().toLowerCase());
  const at = (re: RegExp) => h.findIndex((x) => re.test(x));
  const [iDba, iOwner, iAddr, iWarrant, iAmt] = [at(/dba|business name/), at(/owner name/), at(/address/), at(/warrant number/), at(/amount/)];
  // One business can have several warrants: add them up.
  const byKey = new Map<string, TaxRecord>();
  for (const r of rows.slice(hi + 1)) {
    const dba = String(r[iDba] ?? "").trim();
    const owner = String(r[iOwner] ?? "").trim();
    const amount = money(String(r[iAmt] ?? ""));
    if ((!dba && !owner) || !amount) continue;
    const addr = String(r[iAddr] ?? "").replace(/\s*\/\s*/g, ", ").trim(); // "2623 NW 74TH PL / GAINESVILLE FL 32653"
    const cm = /,\s*([A-Z .'-]+?)\s+([A-Z]{2})\s+\d{5}/.exec(addr);
    const key = `${owner}|${addr}`.toUpperCase();
    const cur = byKey.get(key);
    if (cur) {
      cur.amount += amount;
      continue;
    }
    byKey.set(key, {
      name: owner || dba,
      dba: dba && dba.toUpperCase() !== owner.toUpperCase() ? dba : null,
      owner: null,
      ownerTitle: null,
      address: addr || null,
      city: cm ? cm[1] : null,
      state: cm ? cm[2] : "FL",
      amount,
      date: asOf,
      ref: String(r[iWarrant] ?? "") || null,
    });
  }
  return [...byKey.values()];
}

// ---------------- PDF tables: rebuild rows from text positions ----------------

export interface PdfItem {
  str: string;
  x: number;
  y: number;
  page: number;
}

/** Group text items into lines (same y), sorted left to right. */
export function pdfLines(items: PdfItem[]): PdfItem[][] {
  const lines: PdfItem[][] = [];
  const sorted = items.filter((i) => i.str.trim()).sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x);
  for (const it of sorted) {
    const last = lines[lines.length - 1];
    if (last && last[0].page === it.page && Math.abs(last[0].y - it.y) <= 2.5) last.push(it);
    else lines.push([it]);
  }
  return lines.map((l) => l.sort((a, b) => a.x - b.x));
}

/** Split each line into columns using the header line's x positions. */
export function pdfTable(items: PdfItem[], headerTest: (line: string) => boolean): { header: string[]; rows: string[][] } {
  const lines = pdfLines(items);
  let header: PdfItem[] | null = null;
  const rows: string[][] = [];
  for (const l of lines) {
    const text = l.map((i) => i.str).join(" ");
    if (headerTest(text)) {
      header = l;
      continue;
    }
    if (!header) continue;
    const cols = header.map(() => [] as string[]);
    for (const it of l) {
      let k = 0;
      // Nearest column heading (amounts are right-aligned and can start left of their heading).
      let best = Infinity;
      for (let c = 0; c < header.length; c++) {
        const d = Math.abs(header[c].x - it.x);
        if (d < best) {
          best = d;
          k = c;
        }
      }
      cols[k].push(it.str.trim());
    }
    rows.push(cols.map((c) => c.join(" ").replace(/\s+/g, " ").trim()));
  }
  return { header: header ? header.map((h) => h.str.trim()) : [], rows };
}

const findCol = (header: string[], re: RegExp) => header.findIndex((h) => re.test(h));

// ---------------- Delaware: business tax delinquents (PDF) ----------------
export function parseDelaware(items: PdfItem[], asOf: string | null): TaxRecord[] {
  const { header, rows } = pdfTable(items, (t) => /Taxpayer Name/i.test(t) && /Liability/i.test(t));
  const [iName, iAddr, iCity, iSt, iAmt] = [findCol(header, /Taxpayer Name/i), findCol(header, /^Address$/i), findCol(header, /City/i), findCol(header, /^ST$/i), findCol(header, /Liability/i)];
  return rows
    .filter((r) => /\$[\d,]+\.\d{2}/.test(r[iAmt] ?? ""))
    .map((r) => ({
      name: r[iName],
      dba: null,
      owner: null,
      ownerTitle: null,
      address: [r[iAddr], r[iCity], r[iSt]].filter(Boolean).join(", "),
      city: r[iCity] || null,
      state: r[iSt] || null,
      amount: money(r[iAmt]),
      date: asOf,
      ref: null,
    }))
    .filter((r) => r.name);
}

// ---------------- South Dakota: business tax delinquent report (PDF) ----------------
export function parseSouthDakota(items: PdfItem[], asOf: string | null): TaxRecord[] {
  // Layout: "Owner Name" above "DBA Name" in the first column. Each business takes two lines:
  // line 1 = owner name + address + amounts, line 2 = DBA (trade) name.
  const { header, rows } = pdfTable(items, (t) => /Total Due/i.test(t) && /Address/i.test(t));
  const [iAddr, iCity, iSt, iTotal] = [findCol(header, /^Address$/i), findCol(header, /^City$/i), findCol(header, /^State$/i), findCol(header, /Total Due/i)];
  const out: TaxRecord[] = [];
  let expectDba = false;
  for (const r of rows) {
    if (!/\$[\d,]+\.\d{2}/.test(r[iTotal] ?? "")) {
      const prev = out[out.length - 1];
      if (prev && expectDba && r[0] && !/^(Owner Name|DBA Name)$/i.test(r[0])) {
        if (r[0].toUpperCase() !== prev.name.toUpperCase()) prev.dba = r[0];
        // A person owning a trade name: the business is the trade name, the person is the owner.
        if (prev.dba && /^[A-Z]+(\s+[A-Z]\.?)?\s+[A-Z'’-]+$/i.test(prev.name) && !/\b(LLC|INC|CORP|CO|LTD|COMPANY)\b/i.test(prev.name)) {
          prev.owner = prev.name;
          prev.ownerTitle = "Owner (South Dakota DOR)";
          prev.name = prev.dba;
          prev.dba = null;
        }
      }
      expectDba = false;
      continue;
    }
    expectDba = true;
    const owner = r[0] ?? "";
    out.push({
      name: owner,
      dba: null,
      owner: null,
      ownerTitle: null,
      address: [r[iAddr], r[iCity], r[iSt]].filter(Boolean).join(", "),
      city: r[iCity] || null,
      state: r[iSt] || null,
      amount: money(r[iTotal]),
      date: asOf,
      ref: null,
    });
  }
  return out.filter((r) => r.name);
}

// ---------------- Wyoming: delinquent taxpayers / vendors (PDF, sales & use tax) ----------------
export function parseWyoming(items: PdfItem[], asOf: string | null): TaxRecord[] {
  const { header, rows } = pdfTable(items, (t) => /Unpaid/i.test(t) && /Owner Name/i.test(t));
  const [iDba, iOwner, iAddr, iCity, iSt, iAmt, iRef] = [
    findCol(header, /DBA Name/i),
    findCol(header, /Owner Name/i),
    findCol(header, /^Address$/i),
    findCol(header, /^City$/i),
    findCol(header, /^State$/i),
    findCol(header, /Unpaid/i),
    findCol(header, /License No|Revenue ID/i),
  ];
  // Long names wrap onto the lines below the amount line: join them back first.
  const raw: string[][] = [];
  for (const r of rows) {
    if (/\$[\d,]+\.\d{2}/.test(r[iAmt] ?? "")) raw.push([...r]);
    else if (raw.length && !/^(No|Balance)$/i.test((r[iRef] ?? "").trim())) {
      const prev = raw[raw.length - 1];
      for (const c of [iDba, iOwner, iAddr]) if (c >= 0 && r[c]) prev[c] = `${prev[c] ?? ""} ${r[c]}`.trim();
    }
  }
  const out: TaxRecord[] = [];
  for (const r of raw) {
    let owner = (r[iOwner] ?? "").trim();
    let dba = iDba >= 0 ? (r[iDba] ?? "").trim() : "";
    // "CRUZ, KATIE (HANDMADE BY KATIE CRUZ)" — person with a trade name in brackets
    const br = /^(.*?)\s*\(([^)]+)\)?$/.exec(owner);
    if (br && !dba) {
      owner = br[1].trim();
      dba = br[2].trim();
    }
    const personOwner = /^[A-Z'’\- ]+,\s*[A-Z'’\- .]+$/i.test(owner) && !/\b(LLC|INC|CORP|CO|LTD)\b/i.test(owner);
    out.push({
      name: personOwner ? dba || lastFirst(owner) : owner || dba,
      dba: personOwner ? null : dba && dba !== owner ? dba : null,
      owner: personOwner ? lastFirst(owner) : null,
      ownerTitle: personOwner ? "Owner (Wyoming DOR)" : null,
      address: [r[iAddr], r[iCity], r[iSt]].filter(Boolean).join(", "),
      city: r[iCity] || null,
      state: r[iSt] || "WY",
      amount: money(r[iAmt]),
      date: asOf,
      ref: iRef >= 0 ? r[iRef] || null : null,
    });
  }
  return out.filter((r) => r.name);
}
