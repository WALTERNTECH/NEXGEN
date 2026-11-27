import { getTemplate, saveTemplate, getSettings, CATEGORIES, type Category, type TemplateKind } from "@/lib/config";
import { logRun } from "@/lib/runs";
import { json, bad, body } from "../_util";

export const dynamic = "force-dynamic";

export async function GET() {
  const s = await getSettings();
  const out: Record<string, unknown> = {};
  for (const c of CATEGORIES) out[c] = { initial: await getTemplate("initial", c), followup: await getTemplate("followup", c), auto_send: s.categories[c].auto_send };
  return json({ templates: out, sender_name: s.sender_name, physical_address: s.physical_address });
}

export async function PUT(req: Request) {
  const b = await body<{ kind?: TemplateKind; category?: Category; subject?: string; body?: string }>(req);
  if (b.kind !== "initial" && b.kind !== "followup") return bad("Unknown template");
  if (!b.category || !(CATEGORIES as string[]).includes(b.category)) return bad("Unknown category");
  const subject = (b.subject ?? "").trim();
  const text = (b.body ?? "").trim();
  if (!subject || !text) return bad("Subject and message are both needed");
  await saveTemplate({ kind: b.kind, category: b.category, subject, body: text });
  await logRun("system", true, `${b.category} ${b.kind === "initial" ? "new-lead" : "follow-up"} template saved`);
  return json({ ok: true, template: await getTemplate(b.kind, b.category) });
}
