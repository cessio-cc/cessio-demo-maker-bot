/** Pure env -> config. Empty values count as unset. */
export interface Config {
  apiUrl: string;
  displayName: string;
  /** Half-spread in bps, applied to the mid in the bot's favor. */
  spreadBps: number;
  stateFile: string;
  pollSeconds: number;
  /** Fallback mids by "base/quote" for when the desk has no reference price. */
  staticPrices: Record<string, string>;
  /** Largest share of a holding one trade may commit (0..1]. */
  maxSpendShare: number;
  /** Every mid is divided by this before the spread (demo pricing). */
  priceDivisor: number;
  /** Quote validity, capped by the RFQ deadline. */
  quoteTtlSeconds: number;
}

/** "cbtc/usdcx:97000,ceth/cc:1200" -> { "cbtc/usdcx": "97000", ... } */
function parseStaticPrices(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of raw.split(",").map((e) => e.trim()).filter(Boolean)) {
    const m = /^([a-z0-9]+\/[a-z0-9]+):(\d+(?:\.\d+)?)$/i.exec(entry);
    if (m === null || Number(m[2]) <= 0) {
      throw new Error(`bad BOT_STATIC_PRICES entry: "${entry}" (expected base/quote:positive-price)`);
    }
    out[m[1]!.toLowerCase()] = m[2]!;
  }
  return out;
}

function num(env: NodeJS.ProcessEnv, key: string, fallback: string, ok: (n: number) => boolean, rule: string): number {
  const n = Number(env[key]?.trim() || fallback);
  if (!Number.isFinite(n) || !ok(n)) throw new Error(`${key} must be a number ${rule}`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const apiUrl = (env.BOT_API_URL?.trim() || "http://localhost:4000").replace(/\/+$/, "");
  if (!/^https?:\/\//.test(apiUrl)) throw new Error(`BOT_API_URL must start with http:// or https:// — got "${apiUrl}"`);
  return {
    apiUrl,
    displayName: env.BOT_DISPLAY_NAME?.trim() || "Cessio Demo Maker",
    spreadBps: num(env, "BOT_SPREAD_BPS", "20", (n) => n >= 0 && n < 10_000, "in [0, 10000)"),
    stateFile: env.BOT_STATE_FILE?.trim() || "state/identity.json",
    pollSeconds: num(env, "BOT_POLL_SECONDS", "10", (n) => n >= 1, ">= 1"),
    staticPrices: parseStaticPrices(env.BOT_STATIC_PRICES ?? ""),
    maxSpendShare: num(env, "BOT_MAX_SPEND_SHARE", "0.5", (n) => n > 0 && n <= 1, "in (0, 1]"),
    priceDivisor: num(env, "BOT_PRICE_DIVISOR", "1", (n) => n > 0, "> 0"),
    quoteTtlSeconds: num(env, "BOT_QUOTE_TTL_SECONDS", "300", (n) => n >= 5, ">= 5"),
  };
}
