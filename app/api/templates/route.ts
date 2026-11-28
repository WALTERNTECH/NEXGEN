import { getTemplate, saveTemplate, getSettings, CATEGORIES, DEFAULT_TEMPLATES, type Category, type TemplateKind } from "@/lib/config";
import { PLACEHOLDERS } from "@/lib/render";
import { logRun } from "@/lib/runs";
import { json, bad, body } from "../_util";

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

const KNOWN = new Set<string>([...PLACEHOLDERS, "debt_amount", "court_name"]);

/** Catch template slips before they reach a lead: unknown details, a detail pasted twice in a row, unclosed brackets. */
function check(t: string): string | null {
  for (const m of t.matchAll(/\{\{\s*([^}]*?)\s*\}\}/g)) if (!KNOWN.has(m[1])) return `{{${m[1]}}} is not a detail NEXGEN knows — use the buttons above the subject`;
  const twice = /\{\{\s*([a-z_]+)\s*\}\}[\s,.]*\{\{\s*\1\s*\}\}/.exec(t);
  if (twice) return `{{${twice[1]}}} appears twice in a row — remove one`;
  if ((t.match(/\[\[/g) ?? []).length !== (t.match(/\]\]/g) ?? []).length) return "A [[ is missing its closing ]] (or the other way round)";
  if ((t.match(/\{\{/g) ?? []).length !== (t.match(/\}\}/g) ?? []).length) return "A {{ is missing its closing }}";
  return null;
}
