/**
 * ICE configuration. STUN alone fails behind symmetric NAT / CGNAT (common on mobile and many
 * Brazilian ISPs); a TURN relay fixes that. Configure one in .env:
 *
 *   VITE_TURN_URLS=turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349
 *   VITE_TURN_USERNAME=...
 *   VITE_TURN_CREDENTIAL=...
 *
 * Any standard TURN works (coturn self-hosted, Cloudflare Realtime TURN, Metered, Twilio…).
 */

const env = import.meta.env;

const turnUrls = String(env.VITE_TURN_URLS ?? "")
  .split(",")
  .map((u) => u.trim())
  .filter((u) => /^turns?:/.test(u));

export const TURN_CONFIGURED = turnUrls.length > 0;

export const TURN_SUMMARY = TURN_CONFIGURED
  ? turnUrls.map((u) => u.replace(/^turns?:/, "").split("?")[0]).join(", ")
  : null;

export function buildIceServers(): RTCIceServer[] {
  const servers: RTCIceServer[] = [
    { urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] },
  ];
  if (TURN_CONFIGURED) {
    servers.push({
      urls: turnUrls,
      username: String(env.VITE_TURN_USERNAME ?? ""),
      credential: String(env.VITE_TURN_CREDENTIAL ?? ""),
    });
  }
  return servers;
}
