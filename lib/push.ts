import "server-only";
import webpush from "web-push";
import { getSetting, setSetting, seal, unseal } from "./config";
import { q } from "./db";

interface Vapid {
  publicKey: string;
  privateKey: string;
}

let cached: Vapid | null = null;

export async function vapid(): Promise<Vapid> {
  if (cached) return cached;
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    cached = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
    return cached;
  }
  const s = await getSetting<{ publicKey: string; privateKey: string }>("vapid");
  if (s) {
    cached = { publicKey: s.publicKey, privateKey: unseal(s.privateKey) };
    return cached;
  }
  const k = webpush.generateVAPIDKeys();
  await setSetting("vapid", { publicKey: k.publicKey, privateKey: seal(k.privateKey) });
  cached = k;
  return k;
}

export interface Alert {
  title: string;
  body: string;
  url?: string;
  tag?: string;
}

export async function notify(a: Alert): Promise<number> {
  const subs = await q<{ endpoint: string; keys: { p256dh: string; auth: string } }>(`select endpoint, keys from push_subs`);
  if (!subs.length) return 0;
  const v = await vapid();
  webpush.setVapidDetails("mailto:alerts@nexgen.app", v.publicKey, v.privateKey);
  let sent = 0;
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, JSON.stringify(a), { TTL: 3600, urgency: "high" });
        sent++;
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) await q(`delete from push_subs where endpoint = $1`, [s.endpoint]);
      }
    }),
  );
  return sent;
}
