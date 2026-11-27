import { q, one } from "@/lib/db";
import { logRun } from "@/lib/runs";

export const dynamic = "force-dynamic";

async function handle(req: Request) {
  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (/^[0-9a-f-]{36}$/i.test(id)) {
    const l = await one<{ direct_email: string | null }>(`update leads set status = 'unsubscribed', updated_at = now() where id = $1 returning direct_email`, [id]);
    if (l) {
      await q(`update email_log set status = 'cancelled', error = 'Unsubscribed' where lead_id = $1 and status = 'queued'`, [id]);
      await logRun("send", true, `${l.direct_email ?? "A lead"} unsubscribed`);
    }
  }
  if (req.method === "POST") return new Response("ok");
  return new Response(
    `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unsubscribed</title>
<body style="font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;color:#1f2937">
<div style="text-align:center"><h1 style="font-size:20px">You're unsubscribed</h1><p style="color:#6b7280">You won't receive any more emails from us.</p></div></body>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}
export const GET = handle;
export const POST = handle;
