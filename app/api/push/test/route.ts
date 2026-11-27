import { notify } from "@/lib/push";
import { json } from "../../_util";

export const dynamic = "force-dynamic";

export async function POST() {
  const n = await notify({ title: "NEXGEN alerts are on", body: "You'll get a ping for new leads, found contacts and replies.", url: "/", tag: "test" });
  return json({ ok: n > 0, devices: n });
}
