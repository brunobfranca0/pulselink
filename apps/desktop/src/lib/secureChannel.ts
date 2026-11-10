/**
 * Authenticated encryption for signaling that travels over the public Supabase Realtime channel.
 *
 * Every session has a 256-bit key that the signal server only hands to session members. Messages
 * are sealed with AES-GCM; receivers drop anything that fails authentication, is older than
 * MAX_SKEW_MS, or reuses an IV (replay). Outsiders who know the channel name can neither read the
 * SDP/ICE data nor inject offers.
 */

const MAX_SKEW_MS = 30_000;

export type SealedEnvelope = { v: 1; iv: string; ct: string };

type Inner<T> = { m: T; from: string; ts: number };

const toB64 = (buf: ArrayBuffer | Uint8Array) => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};

const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function importSessionKey(hex: string): Promise<CryptoKey> {
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error("Chave de sessão inválida");
  const raw = new Uint8Array(hex.match(/../g)!.map((h) => parseInt(h, 16)));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export function createSecureChannel<T>(key: CryptoKey, selfId: string, sessionId: string) {
  const seenIvs = new Set<string>();
  const aad = new TextEncoder().encode(`pulselink:${sessionId}`);

  return {
    async seal(message: T): Promise<SealedEnvelope> {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const inner: Inner<T> = { m: message, from: selfId, ts: Date.now() };
      const ct = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: aad },
        key,
        new TextEncoder().encode(JSON.stringify(inner)),
      );
      return { v: 1, iv: toB64(iv), ct: toB64(ct) };
    },

    /** Returns the message and sender, or null when the envelope is forged, stale or replayed. */
    async open(env: unknown): Promise<{ message: T; from: string } | null> {
      if (!env || typeof env !== "object") return null;
      const e = env as Partial<SealedEnvelope>;
      if (e.v !== 1 || typeof e.iv !== "string" || typeof e.ct !== "string") return null;
      if (seenIvs.has(e.iv)) return null;
      try {
        const plain = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: fromB64(e.iv), additionalData: aad },
          key,
          fromB64(e.ct),
        );
        const inner = JSON.parse(new TextDecoder().decode(plain)) as Inner<T>;
        if (Math.abs(Date.now() - inner.ts) > MAX_SKEW_MS) return null;
        if (inner.from === selfId) return null;
        seenIvs.add(e.iv);
        if (seenIvs.size > 5000) seenIvs.clear();
        return { message: inner.m, from: inner.from };
      } catch {
        return null;
      }
    },
  };
}
