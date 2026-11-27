import { tick } from "@/lib/pipeline";
import { json, bad, cronAuthorized } from "../../_util";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function run(req: Request) {
  if (!(await cronAuthorized(req))) return bad("unauthorized", 401);
  return json(await tick());
}
export const GET = run;
export const POST = run;
