import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";

describe("loadConfig", () => {
  it("applies defaults", () => {
    expect(loadConfig({})).toEqual({
      apiUrl: "http://localhost:4000",
      displayName: "Cessio Demo Maker",
      spreadBps: 20,
      stateFile: "state/identity.json",
      pollSeconds: 10,
      staticPrices: {},
      maxSpendShare: 0.5,
      priceDivisor: 1,
      quoteTtlSeconds: 300,
    });
  });

  it("reads BOT_QUOTE_TTL_SECONDS and rejects sub-5s windows", () => {
    expect(loadConfig({ BOT_QUOTE_TTL_SECONDS: "600" }).quoteTtlSeconds).toBe(600);
    expect(() => loadConfig({ BOT_QUOTE_TTL_SECONDS: "3" })).toThrow(/BOT_QUOTE_TTL_SECONDS/);
  });

  it("reads BOT_PRICE_DIVISOR and rejects non-positive values", () => {
    expect(loadConfig({}).priceDivisor).toBe(1);
    expect(loadConfig({ BOT_PRICE_DIVISOR: "100" }).priceDivisor).toBe(100);
    expect(() => loadConfig({ BOT_PRICE_DIVISOR: "0" })).toThrow(/BOT_PRICE_DIVISOR/);
    expect(() => loadConfig({ BOT_PRICE_DIVISOR: "-100" })).toThrow(/BOT_PRICE_DIVISOR/);
  });

  it("bounds BOT_MAX_SPEND_SHARE to (0, 1]", () => {
    expect(loadConfig({ BOT_MAX_SPEND_SHARE: "1" }).maxSpendShare).toBe(1);
    expect(() => loadConfig({ BOT_MAX_SPEND_SHARE: "0" })).toThrow(/BOT_MAX_SPEND_SHARE/);
    expect(() => loadConfig({ BOT_MAX_SPEND_SHARE: "1.5" })).toThrow(/BOT_MAX_SPEND_SHARE/);
  });

  it("parses static fallback prices keyed by lower-cased pair", () => {
    expect(loadConfig({ BOT_STATIC_PRICES: "cBTC/USDCx:97000.5, ceth/cc:1200" }).staticPrices).toEqual({
      "cbtc/usdcx": "97000.5",
      "ceth/cc": "1200",
    });
    expect(() => loadConfig({ BOT_STATIC_PRICES: "cbtc:97000" })).toThrow(/BOT_STATIC_PRICES/);
  });

  it("reads BOT_-prefixed overrides and strips a trailing slash off the URL", () => {
    const cfg = loadConfig({
      BOT_API_URL: "https://api.devnet.cessio.cc/",
      BOT_DISPLAY_NAME: "Bot MM",
      BOT_SPREAD_BPS: "50",
      BOT_STATE_FILE: "/data/identity.json",
      BOT_POLL_SECONDS: "5",
    });
    expect(cfg).toEqual({
      apiUrl: "https://api.devnet.cessio.cc",
      displayName: "Bot MM",
      spreadBps: 50,
      stateFile: "/data/identity.json",
      pollSeconds: 5,
      staticPrices: {},
      maxSpendShare: 0.5,
      priceDivisor: 1,
      quoteTtlSeconds: 300,
    });
  });

  it("treats empty values as unset instead of Number('') === 0", () => {
    const cfg = loadConfig({ BOT_SPREAD_BPS: "", BOT_API_URL: "  ", BOT_POLL_SECONDS: "" });
    expect(cfg.spreadBps).toBe(20);
    expect(cfg.apiUrl).toBe("http://localhost:4000");
    expect(cfg.pollSeconds).toBe(10);
  });

  it("rejects a non-numeric or >= 100% spread and a sub-second poll", () => {
    expect(() => loadConfig({ BOT_SPREAD_BPS: "cheap" })).toThrow(/BOT_SPREAD_BPS/);
    expect(() => loadConfig({ BOT_SPREAD_BPS: "10000" })).toThrow(/BOT_SPREAD_BPS/);
    expect(() => loadConfig({ BOT_POLL_SECONDS: "0" })).toThrow(/BOT_POLL_SECONDS/);
  });

  it("rejects a scheme-less URL and a zero static price", () => {
    expect(() => loadConfig({ BOT_API_URL: "localhost:4000" })).toThrow(/BOT_API_URL/);
    expect(() => loadConfig({ BOT_STATIC_PRICES: "cbtc/usdcx:0" })).toThrow(/BOT_STATIC_PRICES/);
  });
});
