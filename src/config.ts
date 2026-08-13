/** Pure env -> typed config (same convention as apps/api: no dotenv, no I/O).
 * All variables are BOT_-prefixed so the bot can share a host .env with the
 * desk without collisions. Empty values count as unset (`||` after trim, not
 * `??`): a blank line in a .env file must not silently become spread 0. */
export interface Config {
  /** Desk REST base URL, e.g. https://api.devnet.cessio.cc */
  apiUrl: string;
  /** Display name sent at registration; the desk derives the party hint from it. */
  displayName: string;
  /** Half-spread in basis points applied to the reference mid in the bot's favor. */
  spreadBps: number;
  /** Where the identity (party key + API key) persists between runs. */
  stateFile: string;
  /** Housekeeping cadence: /tx/pending, /wallet/incoming, /faucet. */
  pollSeconds: number;
  /** Fallback mids by "base/quote" for when the desk has no reference price
   * (oracle off locally, or its upstream quota dies on DevNet). */
  staticPrices: Record<string, string>;
  /** Largest share of a holding one trade may commit (0..1]. Keeps a whale RFQ
   * from draining the inventory and never quotes what settlement cannot take. */
  maxSpendShare: number;
  /** Demo pricing: every mid (oracle or static) is divided by this before the
   * spread. 1 = real market prices; 100 = prices faucet money can afford. */
  priceDivisor: number;
  /** How long a quote stands (capped by the RFQ deadline). Far above the
   * desk's 30s default: a human browsing the demo needs time to click accept. */
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

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const spreadBps = Number(env.BOT_SPREAD_BPS?.trim() || "20");
  // 10000 bps would price a taker SELL at exactly zero.
  if (!Number.isFinite(spreadBps) || spreadBps < 0 || spreadBps >= 10_000) {
    throw new Error("BOT_SPREAD_BPS must be a number in [0, 10000)");
  }
  const pollSeconds = Number(env.BOT_POLL_SECONDS?.trim() || "10");
  if (!Number.isFinite(pollSeconds) || pollSeconds < 1) throw new Error("BOT_POLL_SECONDS must be a number >= 1");
  const apiUrl = (env.BOT_API_URL?.trim() || "http://localhost:4000").replace(/\/+$/, "");
  // A missing scheme would silently derive a broken ws:// stream URL.
  if (!/^https?:\/\//.test(apiUrl)) throw new Error(`BOT_API_URL must start with http:// or https:// — got "${apiUrl}"`);
  const maxSpendShare = Number(env.BOT_MAX_SPEND_SHARE?.trim() || "0.5");
  if (!Number.isFinite(maxSpendShare) || maxSpendShare <= 0 || maxSpendShare > 1) {
    throw new Error("BOT_MAX_SPEND_SHARE must be a number in (0, 1]");
  }
  const priceDivisor = Number(env.BOT_PRICE_DIVISOR?.trim() || "1");
  if (!Number.isFinite(priceDivisor) || priceDivisor <= 0) throw new Error("BOT_PRICE_DIVISOR must be a number > 0");
  const quoteTtlSeconds = Number(env.BOT_QUOTE_TTL_SECONDS?.trim() || "300");
  if (!Number.isFinite(quoteTtlSeconds) || quoteTtlSeconds < 5) {
    throw new Error("BOT_QUOTE_TTL_SECONDS must be a number >= 5");
  }
  return {
    apiUrl,
    displayName: env.BOT_DISPLAY_NAME?.trim() || "Cessio Demo Maker",
    spreadBps,
    stateFile: env.BOT_STATE_FILE?.trim() || "state/identity.json",
    pollSeconds,
    staticPrices: parseStaticPrices(env.BOT_STATIC_PRICES ?? ""),
    maxSpendShare,
    priceDivisor,
    quoteTtlSeconds,
  };
}
