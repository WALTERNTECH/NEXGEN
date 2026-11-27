import { getTemplate, saveTemplate, getSettings, type TemplateId } from "@/lib/config";
import { json, bad, body } from "../_util";

export const dynamic = "force-dynamic";

export async function GET() {
  const [initial, followup, s] = await Promise.all([getTemplate("initial"), getTemplate("followup"), getSettings()]);
  return json({ initial, followup, sender_name: s.sender_name, physical_address: s.physical_address });
}

export async function PUT(req: Request) {
  const b = await body<{ id?: TemplateId; subject?: string; body?: string }>(req);
  if (b.id !== "initial" && b.id !== "followup") return bad("Unknown template");
  const subject = (b.subject ?? "").trim();
  const text = (b.body ?? "").trim();
  if (!subject || !text) return bad("Subject and message are both needed");
  await saveTemplate({ id: b.id, subject, body: text });
  return json({ ok: true });
}
