import { cookies } from "next/headers";

export const dynamic = "force-dynamic";

// The installed app keeps its own cookie jar (iPhone especially), so the start address carries the private key
// for whoever already has it. Visitors without the key get a manifest that opens the locked page.
export async function GET() {
  const key = process.env.ACCESS_KEY;
  const c = (await cookies()).get("nx_key")?.value;
  const start = key && c === key ? `/?key=${encodeURIComponent(key)}` : "/";
  const manifest = {
    name: "NEXGEN Leads",
    short_name: "NEXGEN",
    description: "Distressed business leads, contacts and outreach",
    id: "/",
    start_url: start,
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: "#eef1f6",
    theme_color: "#ffffff",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
  return new Response(JSON.stringify(manifest), {
    headers: { "Content-Type": "application/manifest+json", "Cache-Control": "private, no-store" },
  });
}
