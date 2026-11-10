import { createClient } from "@supabase/supabase-js";

// No hardcoded project fallbacks: set VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY in .env.
export const SUPABASE_URL =
  (import.meta.env.VITE_SUPABASE_URL as string | undefined) || "https://supabase-not-configured.invalid";

export const SUPABASE_ANON_KEY =
  (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) || "not-configured";

if (!import.meta.env.VITE_SUPABASE_URL || !import.meta.env.VITE_SUPABASE_ANON_KEY) {
  console.error("[Supabase] VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY ausentes — login e sinalização na nuvem desativados.");
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    storageKey: "pulselink_supabase_auth_v1",
  },
});

export const CLOUD_CONFIGURED = Boolean(
  import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_ANON_KEY,
);

export interface CloudProfile {
  id: string;
  email: string;
  username: string;
  discriminator: string;
  plan: "free" | "warp" | "teams";
  createdAt?: string;
  updatedAt?: string;
}

