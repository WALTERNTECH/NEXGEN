# NEXGEN

Distressed US business discovery → owner contact enrichment → one-time outreach, in one dashboard.

- **Discovery**: CourtListener RECAP search, grouped into **Court** (business bankruptcies), **Tax** (federal tax suits) and **Debt** (commercial debt suits). Queries are editable in Settings.
- **Contacts**: BetterContact async enrichment (webhook + polling fallback) for the owner's email and mobile.
- **Outreach**: a new-lead email (database-enforced once per address, ever) and a follow-up email, sent from your own mailbox over SMTP, with spacing and a daily cap. Replies are read over IMAP and shown in the Inbox.
- **Alerts**: installable web app with push notifications for new leads, contacts found and replies.
- **Access**: no sign-up — open the private link (`/?key=…`) once and the browser remembers it.

The pipeline runs from `/api/cron/tick` every minute (Supabase pg_cron), and also while the dashboard is open.

Local: `node scripts/dev.mjs` (PGlite + demo leads on :5340).
