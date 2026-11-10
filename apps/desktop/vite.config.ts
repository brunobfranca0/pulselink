import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// Content-Security-Policy for the packaged app. Applied only to production builds because the
// Vite dev server injects inline scripts for HMR / React Refresh.
// connect-src stays broad on http(s)/ws(s) because the signal server URL is user-configurable;
// the important restriction is script-src 'self' (no inline or remote code).
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob: mediastream:",
  "font-src 'self' data:",
  "connect-src 'self' http: https: ws: wss:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
  "form-action 'none'",
].join("; ");

function cspPlugin(): Plugin {
  return {
    name: "pulselink-csp",
    apply: "build",
    transformIndexHtml(html) {
      return html.replace(
        "<head>",
        `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`,
      );
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [react(), cspPlugin()],
  server: {
    port: 5173,
    strictPort: true,
  },
});
