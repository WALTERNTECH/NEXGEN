import "server-only";
import type { Q } from "./db";

// Local development only (no DATABASE_URL and NEXGEN_DEMO=1): a handful of sample leads to look at the UI.
export async function seedDemo(db: Q) {
  const { rows } = await db.query<{ n: number }>(`select count(*)::int as n from leads`);
  if (rows[0].n > 0) return;
  const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
  const leads = [
    ["court", "Saadia Distribution LLC", "Saadia Distribution LLC", "1-26-45012", "U.S. Bankruptcy Court, E.D. New York", "Chapter 11 — Subchapter V", "$1,240,000", 1240000, "IRS tax priority + Commercial lenders", day(2), "Petition filed — early restructuring", "David Saadia", "Managing Member", "david@saadiadist.com", "+17185550142", "enriched", false],
    ["court", "CNS Search Group Inc.", "CNS Search Group Inc.", "8:26-bk-07781", "U.S. Bankruptcy Court, M.D. Florida", "Chapter 11", null, null, null, day(2), "Petition filed — early restructuring", null, null, null, null, "enrichment_failed", false],
    ["tax", "Bradshaw Roofing LLC", "United States v. Bradshaw Roofing LLC and Bruce Bradshaw", "3:26-cv-00912", "W.D. Wisconsin", "Federal tax suit", "$386,410", 386410, "IRS / United States", day(6), "Tax suit filed — answer due", "Bruce Bradshaw", "Owner (named defendant)", "bruce@bradshawroofing.com", "6085550199", "contacted", true],
    ["debt", "Keystone Freight Inc.", "Pearl Capital Rivis Ventures LLC v. Keystone Freight Inc. and Mark Ruiz", "2:26-cv-04431", "E.D. Pennsylvania", "Debt suit — Contract: Other", "$212,900", 212900, "Pearl Capital Rivis Ventures LLC", day(9), "Collection suit filed — answer due", "Mark Ruiz", "Owner (named defendant)", "mruiz@keystonefreight.com", null, "replied", true],
    ["debt", "Harbor Point Dental PLLC", "Itria Ventures LLC v. Harbor Point Dental PLLC", "1:26-cv-09120", "S.D. New York", "Debt suit — Negotiable Instrument", "$98,500", 98500, "Itria Ventures LLC", day(1), "Collection suit filed — answer due", "Anita Shah", "Owner", null, "+12125550173", "enriched", false],
    ["court", "O & K Alexander Co. Inc.", "O & K Alexander Co. Inc.", "26-17721", "U.S. Bankruptcy Court, N.D. Illinois", "Chapter 11 — Subchapter V", "$640,000", 640000, "Commercial lenders", day(3), "Petition filed — early restructuring", "Omar Alexander", "President", null, null, "enriching", false],
  ];
  let i = 0;
  for (const l of leads) {
    const [first, ...rest] = String(l[11] ?? "").split(" ");
    await db.query(
      `insert into leads (external_case_id, category, company_name, case_name, case_number, court_name, distress_type, debt_amount_text, debt_amount,
         creditor_summary, filing_date, insolvency_stage, founder_full_name, founder_first_name, founder_last_name, founder_title, direct_email, direct_mobile,
         status, auto_email_sent, contacted_at, replied_at, unread_replies, seen_at, created_at, cl_url, founder_source)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20, case when $20 then now() - interval '2 days' end,
         case when $19 = 'replied' then now() - interval '3 hours' end, case when $19 = 'replied' then 1 else 0 end,
         case when $21 < 3 then now() end, now() - make_interval(hours => $21 * 5), 'https://www.courtlistener.com/', 'case caption')`,
      [`demo-${i}`, ...l.slice(0, 12), l[11] ? first : null, l[11] ? rest.pop() : null, l[12], l[13], l[14], l[15], l[16], i++],
    );
  }
  await db.query(`update leads set tax_debt = 184220.17, secured_debt = 702000, unsecured_debt = 538000, priority_debt = 184220.17, figures_source = 'Schedules, doc 14', judge = 'Hon. Elizabeth S. Stong', trustee = 'Gerard R. Luckman', case_summary = 'Chapter 11 case filed in the Eastern District of New York. Subchapter V small business debtor.', case_notes = '[{"date":"2026-11-25","no":"1","text":"Voluntary Petition (Chapter 11) Subchapter V"},{"date":"2026-11-26","no":"14","text":"Summary of Assets and Liabilities, Schedules A/B, D, E/F"}]'::jsonb, details_checked_at = now() where external_case_id = 'demo-0'`);
  await db.query(`update leads set tax_debt = 386410, debt_amount = 386410, figures_source = 'Complaint, doc 1', details_checked_at = now() where external_case_id = 'demo-2'`);
  await db.query(`insert into leads (external_case_id, category, company_name, case_name, case_number, court_name, distress_type, filing_date, insolvency_stage, founder_full_name, founder_first_name, founder_last_name, status, is_historical_backfill, seen_at, debt_amount, debt_amount_text, details_checked_at) values ('demo-bf', 'debt', 'Lakeside Builders Inc.', 'Fora Financial v. Lakeside Builders Inc. and Tom Reyes', '2:26-cv-01102', 'D. New Jersey', 'Debt suit — Contract: Other', current_date - 40, 'Collection suit pending', 'Tom Reyes', 'Tom', 'Reyes', 'not_enriched_backfill', true, now(), 154000, '$154,000', now())`);
  const { rows: r } = await db.query<{ id: string; direct_email: string }>(`select id, direct_email from leads where status = 'replied'`);
  if (r[0]) {
    await db.query(`insert into email_log (lead_id, kind, recipient_email, subject, body, status, origin, sent_at) values ($1,'initial',$2,'Keystone Freight — a question','Hi Mark, …','sent','auto', now() - interval '2 days')`, [r[0].id, r[0].direct_email]);
    await db.query(`insert into replies (lead_id, from_email, from_name, subject, body, message_id) values ($1,$2,'Mark Ruiz','Re: Keystone Freight — a question','Yes, we could use some help. Can you call me Thursday afternoon?','<demo-1@x>')`, [r[0].id, r[0].direct_email]);
  }
}
