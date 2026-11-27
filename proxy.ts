import { NextResponse, type NextRequest } from "next/server";

// Private-link access: no sign-up. The link carries ?key=…; the first visit stores it in a long-lived cookie.
const PUBLIC = [/^\/api\/cron\//, /^\/api\/webhooks\//, /^\/api\/unsubscribe/, /^\/locked$/, /^\/sw\.js$/, /^\/icons\//, /^\/manifest\.webmanifest$/, /^\/favicon/];
const COOKIE = "nx_key";

function same(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export function proxy(req: NextRequest) {
  const key = process.env.ACCESS_KEY;
  const { pathname, searchParams } = req.nextUrl;
  if (!key || PUBLIC.some((r) => r.test(pathname))) return NextResponse.next();

  const given = searchParams.get("key");
  if (given && same(given, key)) {
    const url = req.nextUrl.clone();
    url.searchParams.delete("key");
    const res = NextResponse.redirect(url);
    res.cookies.set(COOKIE, key, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 400 });
    return res;
  }
  const c = req.cookies.get(COOKIE)?.value;
  if (c && same(c, key)) return NextResponse.next();

  if (pathname.startsWith("/api/")) return NextResponse.json({ error: "Open NEXGEN with your private link." }, { status: 401 });
  const url = req.nextUrl.clone();
  url.pathname = "/locked";
  url.search = "";
  return NextResponse.rewrite(url);
}

export const config = { matcher: ["/((?!_next/static|_next/image).*)"] };
