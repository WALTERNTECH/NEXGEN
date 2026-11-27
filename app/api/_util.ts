import "server-only";
import { NextResponse } from "next/server";

export function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

export function bad(message: string, status = 400) {
  return json({ error: message }, status);
}

export async function body<T = Record<string, unknown>>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    return {} as T;
  }
}

export function cronAuthorized(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const h = req.headers.get("authorization");
  const u = new URL(req.url).searchParams.get("secret");
  return h === `Bearer ${secret}` || u === secret;
}
