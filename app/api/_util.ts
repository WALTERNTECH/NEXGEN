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

export async function cronAuthorized(req: Request) {
  const h = req.headers.get("authorization") ?? "";
  const u = new URL(req.url).searchParams.get("secret");
  const given = h.startsWith("Bearer ") ? h.slice(7) : u;
  if (!given) return !process.env.CRON_SECRET && !process.env.VERCEL;
  if (process.env.CRON_SECRET && given === process.env.CRON_SECRET) return true;
  const { getSetting } = await import("@/lib/config");
  const t = await getSetting<string>("cron_token");
  return Boolean(t && given === t);
}
