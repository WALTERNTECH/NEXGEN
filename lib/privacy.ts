import "server-only";
import { seal, unseal } from "./config";

/**
 * Email content (what you send and what leads reply) is confidential:
 *  - stored encrypted (AES-256-GCM with this deployment's MASTER_KEY), so the database never holds it readable;
 *  - opened only when your private-link dashboard asks for it;
 *  - never passed to OpenAI or any other AI or outside service — the AI helpers only ever see public court text.
 */
const TAG = "enc1:";

export function sealText(t: string | null | undefined): string | null {
  if (t === null || t === undefined) return null;
  return TAG + seal(t);
}

export function openText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v);
  if (!s.startsWith(TAG)) return s; // written before encryption was added
  try {
    return unseal(s.slice(TAG.length));
  } catch {
    return "(can't be decrypted — MASTER_KEY changed)";
  }
}

/** Decrypt subject/body on rows headed for the dashboard. */
export function openRows<T extends Record<string, unknown>>(rows: T[]): T[] {
  return rows.map((r) => ({ ...r, ...("subject" in r ? { subject: openText(r.subject) } : {}), ...("body" in r ? { body: openText(r.body) } : {}) }));
}
