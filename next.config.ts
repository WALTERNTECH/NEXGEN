import type { NextConfig } from "next";

// One stamp per build, baked into both the server and the browser code, so an open page can tell when a newer version is live.
const BUILD_STAMP = process.env.VERCEL_DEPLOYMENT_ID || process.env.VERCEL_GIT_COMMIT_SHA || String(Date.now());

const config: NextConfig = {
  poweredByHeader: false,
  env: { NEXT_PUBLIC_BUILD_STAMP: BUILD_STAMP },
  serverExternalPackages: ["@electric-sql/pglite", "pg", "imapflow", "mailparser", "web-push", "exceljs"],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
          { key: "Strict-Transport-Security", value: "max-age=31536000" },
        ],
      },
      { source: "/sw.js", headers: [{ key: "Cache-Control", value: "no-cache" }, { key: "Service-Worker-Allowed", value: "/" }] },
    ];
  },
};

export default config;
