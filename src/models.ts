// Model definitions, ported from gemini-web2api's models.py.
// Maps friendly names to Gemini's MODE_CATEGORY enum + default thinking depth.
//   1=FAST, 2=THINKING, 3=PRO, 4=AUTO, 5=FAST_DYNAMIC_THINKING, 6=FLASH_LITE

export interface ModelConfig {
  mode: number;
  think: number;
  desc: string;
  /** Extra payload fields merged by positional index (see buildPayload). */
  extra?: Record<number, unknown>;
}

export const MODELS: Record<string, ModelConfig> = {
  "gemini-3.5-flash": { mode: 1, think: 4, desc: "Fast general-purpose model" },
  "gemini-3.5-flash-thinking": { mode: 2, think: 0, desc: "Deep thinking mode, longest output (~20k chars)" },
  "gemini-3.1-pro": { mode: 3, think: 4, desc: "Pro model (requires cookie for real routing)" },
  "gemini-3.1-pro-enhanced": { mode: 3, think: 4, extra: { 31: 2, 80: 3 }, desc: "Pro with enhanced output (experimental)" },
  "gemini-auto": { mode: 4, think: 4, desc: "Auto model selection" },
  "gemini-3.5-flash-thinking-lite": { mode: 5, think: 0, desc: "Dynamic thinking with adaptive depth" },
  "gemini-flash-lite": { mode: 6, think: 4, desc: "Lightweight fast model" },
};

export interface ResolvedModel {
  name: string;
  modeId: number;
  thinkMode: number;
  extra?: Record<number, unknown>;
  error?: string;
}

const DEFAULT_MODEL = "gemini-3.5-flash";

/**
 * Resolve a requested model name into routing parameters.
 * Supports the `@think=N` suffix; unknown names fall back to the default
 * rather than erroring (clients may send arbitrary identifiers).
 */
export function resolveModel(modelName: string, fallback = DEFAULT_MODEL): ResolvedModel {
  let name = modelName;
  let thinkOverride: number | null = null;

  if (name.includes("@think=")) {
    const idx = name.lastIndexOf("@think=");
    const thinkStr = name.slice(idx + "@think=".length);
    name = name.slice(0, idx);
    const parsed = Number(thinkStr);
    if (!Number.isInteger(parsed)) {
      return { name, modeId: 0, thinkMode: 0, error: `Invalid think level: ${thinkStr}` };
    }
    thinkOverride = parsed;
  }

  let cfg = MODELS[name];
  if (!cfg) {
    name = fallback;
    cfg = MODELS[fallback];
  }

  return {
    name,
    modeId: cfg.mode,
    thinkMode: thinkOverride !== null ? thinkOverride : cfg.think,
    extra: cfg.extra,
  };
}
