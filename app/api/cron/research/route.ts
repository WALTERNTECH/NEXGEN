import { findOwners } from "@/lib/pipeline";
import { json, bad, cronAuthorized } from "../../_util";

export const dynamic = "force-dynamic";
export const maxDuration = 150;

/** Dedicated research job (every minute, alongside the main heartbeat): many companies, several at a time. */
async function run(req: Request) {
  if (!(await cronAuthorized(req))) return bad("unauthorized", 401);
  return json({ research: await findOwners(undefined, 110_000, { batch: 48, concurrency: 8 }) });
}
export const GET = run;
export const POST = run;
