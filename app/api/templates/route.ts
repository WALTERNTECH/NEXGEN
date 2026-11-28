import { getTemplate, saveTemplate, getSettings, CATEGORIES, DEFAULT_TEMPLATES, type Category, type TemplateKind } from "@/lib/config";
import { PLACEHOLDERS, unknownTokens, resolveKey, render, type RenderLead } from "@/lib/render";
import { sendMail, mailReady } from "@/lib/mailer";
import { logRun } from "@/lib/runs";
import { json, bad, body } from "../_util";

/** Made-up details used for test emails — a test never uses a real lead. */
const SAMPLE: Record<Category, RenderLead> = {
  tax: {
    company_name: "Sample Test Company LLC", category: "tax", source: "test", founder_full_name: "Jane Sample", founder_first_name: "Jane", founder_last_name: "Sample",
    founder_title: "Owner", debt_amount: 50000, tax_debt: 50000, filing_date: new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10),
    creditor_summary: "Florida Department of Revenue", court_name: "Florida Department of Revenue", biz_city: "Miami", biz_state: "FL", biz_address: "100 Sample St, Miami, FL",
  },
  debt: {
    company_name: "Sample Test Company LLC", category: "debt", source: "courtlistener", founder_full_name: "Jane Sample", founder_first_name: "Jane", founder_last_name: "Sample",
    founder_title: "Owner", debt_amount: 50000, filing_date: new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10), case_number: "1:26-cv-00000",
    court_name: "District Court, S.D. Florida", creditor_summary: "Sample Capital Funding LLC", judge: "Judge Sample", biz_city: "Miami", biz_state: "FL",
  },
  court: {
    company_name: "Sample Test Company LLC", category: "court", source: "courtlistener", founder_full_name: "Jane Sample", founder_first_name: "Jane", founder_last_name: "Sample",
    founder_title: "Owner", debt_amount: 50000, tax_debt: 5000, secured_debt: 30000, unsecured_debt: 20000, distress_type: "Chapter 11",
    filing_date: new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10), case_number: "26-00000", court_name: "United States Bankruptcy Court, S.D. Florida",
    judge: "Judge Sample", trustee: "Trustee Sample", biz_city: "Miami", biz_state: "FL",
  },
};

/** Send the current draft (saved or not), filled with the made-up sample details, to an address you choose. */
export async function POST(req: Request) {
  const b = await body<{ category?: Category; subject?: string; body?: string; to?: string }>(req);
  if (!b.category || !(CATEGORIES as string[]).includes(b.category)) return bad("Unknown category");
  const to = String(b.to ?? "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return bad("Enter the address to send the test to");
  const subject = (b.subject ?? "").trim();
  const text = (b.body ?? "").trim();
  if (!subject || !text) return bad("Subject and message are both needed");
  const problem = check(subject) ?? check(text);
  if (problem) return bad(problem);
  if (!(await mailReady()).ok) return bad("Connect a mailbox in Settings first");
  const s = await getSettings();
  try {
    await sendMail({
      to,
      subject: render(subject, SAMPLE[b.category], s.sender_name),
      body: render(text, SAMPLE[b.category], s.sender_name),
      leadId: "00000000-0000-0000-0000-000000000000",
    });
  } catch (e) {
    return bad(`Sending failed: ${(e as Error).message}`);
  }
  await logRun("send", true, `Test email (${b.category}) sent to ${to}`);
  return json({ ok: true });
}

export const dynamic = "force-dynamic";

export async function GET() {
  const s = await getSettings();
  const out: Record<string, unknown> = {};
  for (const c of CATEGORIES) out[c] = { initial: await getTemplate("initial", c), followup: await getTemplate("followup", c), auto_send: s.categories[c].auto_send };
  return json({ templates: out, defaults: DEFAULT_TEMPLATES, sender_name: s.sender_name, physical_address: s.physical_address });
}

export async function PUT(req: Request) {
  const b = await body<{ kind?: TemplateKind; category?: Category; subject?: string; body?: string }>(req);
  if (b.kind !== "initial" && b.kind !== "followup") return bad("Unknown template");
  if (!b.category || !(CATEGORIES as string[]).includes(b.category)) return bad("Unknown category");
  const subject = (b.subject ?? "").trim();
  const text = (b.body ?? "").trim();
  if (!subject || !text) return bad("Subject and message are both needed");
  const problem = check(subject) ?? check(text);
  if (problem) return bad(problem);
  await saveTemplate({ kind: b.kind, category: b.category, subject, body: text });
  await logRun("system", true, `${b.category} ${b.kind === "initial" ? "new-lead" : "follow-up"} template saved`);
  return json({ ok: true, template: await getTemplate(b.kind, b.category) });
}

/** Catch template slips before they reach a lead: unknown details, a detail pasted twice in a row, unclosed brackets. */
function check(t: string): string | null {
  const unknown = unknownTokens(t);
  if (unknown.length)
    return `NEXGEN doesn't recognise ${unknown.join(", ")}. Use one of: ${PLACEHOLDERS.map((p) => `{{${p}}}`).join(" ")}`;
  const twice = /\{\{\s*([^{}]+?)\s*\}\}[\s,.]*\{\{\s*([^{}]+?)\s*\}\}/g;
  for (const m of t.matchAll(twice)) if (resolveKey(m[1]) && resolveKey(m[1]) === resolveKey(m[2])) return `{{${m[1]}}} appears twice in a row — remove one`;
  if ((t.match(/\[\[/g) ?? []).length !== (t.match(/\]\]/g) ?? []).length) return "A [[ is missing its closing ]] (or the other way round)";
  if ((t.match(/\{\{/g) ?? []).length !== (t.match(/\}\}/g) ?? []).length) return "A {{ is missing its closing }}";
  return null;
}
