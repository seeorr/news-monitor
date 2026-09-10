/** Vocabulario cerrado. Se valida antes de abrir estado, fuentes o transportes. */
export const PROFILES = ["fast", "full", "process"] as const;
export type Profile = typeof PROFILES[number];
export const TRIGGERS = ["external", "schedule", "manual"] as const;
export type Trigger = typeof TRIGGERS[number];
export function executionProfile(env: Record<string, string | undefined>) {
  const profile = env.MONITOR_PROFILE?.trim() || "full";
  const mode = env.MONITOR_MODE?.trim() || "full";
  const origin = env.MONITOR_ORIGIN?.trim() || "manual";
  if (!(PROFILES as readonly string[]).includes(profile)) throw new Error("invalid_monitor_profile");
  if (!["full", "capture-only", "process-only"].includes(mode)) throw new Error("invalid_cycle_mode");
  if (!(TRIGGERS as readonly string[]).includes(origin)) throw new Error("invalid_monitor_origin");
  if (profile === "process" && mode === "capture-only") throw new Error("incompatible_cycle_modes");
  return { profile: profile as Profile, mode, trigger: origin as Trigger,
    processOnly: profile === "process" || mode === "process-only" };
}
// Solo feeds con catálogo RSS oficial; Investing conserva el perfil completo.
// Los bancos opcionales entran únicamente si su lote/feed está habilitado.
// CNBC: catálogo bloqueado en esta auditoría; no aumentar su frecuencia rápida
// sin verificación. Yahoo conserva atribución/enlace y uso personal existente.
export const FAST_FEEDS = ["ecb-press", "fed-press", "boe-news", "boe-publications", "boj-news", "yahoo-finance"] as const;
