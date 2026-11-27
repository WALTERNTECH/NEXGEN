import { q } from "@/lib/db";
import { vapid } from "@/lib/push";
import { json, bad, body } from "../_util";

export const dynamic = "force-dynamic";

export async function GET() {
  return json({ publicKey: (await vapid()).publicKey });
}

export async function POST(req: Request) {
  const b = await body<{ endpoint?: string; keys?: { p256dh?: string; auth?: string }; label?: string }>(req);
  if (!b.endpoint?.startsWith("https://") || !b.keys?.p256dh || !b.keys?.auth) return bad("Invalid subscription");
  await q(
    `insert into push_subs (endpoint, keys, label) values ($1, $2, $3)
     on conflict (endpoint) do update set keys = excluded.keys, label = excluded.label`,
    [b.endpoint, JSON.stringify(b.keys), (b.label ?? "").slice(0, 80)],
  );
  return json({ ok: true });
}

export async function DELETE(req: Request) {
  const b = await body<{ endpoint?: string }>(req);
  if (b.endpoint) await q(`delete from push_subs where endpoint = $1`, [b.endpoint]);
  return json({ ok: true });
}
