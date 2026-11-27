import { tick } from "@/lib/pipeline";
import { json } from "../_util";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST() {
  return json(await tick({ forceIngest: true }));
}
