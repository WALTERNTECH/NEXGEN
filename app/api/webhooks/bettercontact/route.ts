import { applyEnrichment } from "@/lib/pipeline";
import { result, type BcResult } from "@/lib/bettercontact";
import { logRun } from "@/lib/runs";
import { json, bad, body } from "../../_util";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request) {
  const token = new URL(req.url).searchParams.get("token");
  if (!process.env.WEBHOOK_SECRET || token !== process.env.WEBHOOK_SECRET) return bad("unauthorized", 401);
  const payload = await body<BcResult>(req);
  const id = payload.id ?? payload.request_id;
  if (!id) return bad("missing id");
  // The webhook is unsigned, so the result is re-read from BetterContact with our key when possible.
  let res: BcResult = payload;
  try {
    const fresh = await result(id);
    if (fresh.status === "terminated") res = fresh;
  } catch {}
  const found = await applyEnrichment({ ...res, id }, "webhook");
  if (!found && res.status !== "terminated") await logRun("webhook", true, `BetterContact webhook for ${id}: status ${res.status ?? "unknown"}`);
  return json({ ok: true, found });
}
