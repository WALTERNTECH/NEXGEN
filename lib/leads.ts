export const LEAD_COLS = `id, category, company_name, case_name, case_number, court_name, distress_type, debt_amount_text, debt_amount,
  creditor_summary, filing_date, insolvency_stage, founder_full_name, founder_first_name, founder_last_name, founder_title, founder_source,
  company_domain, direct_email, email_status, direct_mobile, linkedin_url, status, auto_email_sent, contacted_at, last_email_at,
  followups_sent, replied_at, unread_replies, seen_at, cl_url, created_at, is_historical_backfill, tax_debt, secured_debt,
  unsecured_debt, priority_debt, liabilities_range, figures_source, judge, trustee, dba, details_checked_at, owner_lookup_note, owner_lookup_at,
  (select e.status from email_log e where e.lead_id = leads.id and e.status in ('queued','sending') limit 1) as queued`;
