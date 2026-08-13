import { describe, expect, it } from "vitest";
import { makerSpend, quotePrice, toDecimalString } from "../src/price.ts";

describe("makerSpend", () => {
  it("taker SELL: maker pays notional + fee, all in the quote asset", () => {
    // 0.25 * 96806 = 24201.5 notional, 25 bps fee = 60.50375 (the live-run numbers)
    expect(makerSpend("SELL", "0.25", "96806", 25)).toEqual({ base: 0, quote: 24262.00375 });
  });

  it("taker BUY: maker delivers the base qty and owes only the fee in quote", () => {
    expect(makerSpend("BUY", "2", "100", 25)).toEqual({ base: 2, quote: 0.5 });
  });
});

describe("quotePrice", () => {
  it("bids below mid when the taker sells", () => {
    expect(quotePrice("100000", "SELL", 20)).toBe("99800");
  });

  it("asks above mid when the taker buys", () => {
    expect(quotePrice("100000", "BUY", 20)).toBe("100200");
  });

  it("returns the mid untouched at zero spread", () => {
    expect(quotePrice("97300.5", "SELL", 0)).toBe("97300.5");
  });

  it("divides the mid by the demo divisor before the spread", () => {
    expect(quotePrice("97000", "SELL", 0, 100)).toBe("970");
    expect(quotePrice("100000", "BUY", 20, 100)).toBe("1002");
  });

  it("rejects a non-numeric or non-positive mid", () => {
    expect(() => quotePrice("", "SELL", 20)).toThrow(/bad reference mid/);
    expect(() => quotePrice("0", "SELL", 20)).toThrow(/bad reference mid/);
    expect(() => quotePrice("-5", "BUY", 20)).toThrow(/bad reference mid/);
  });
});

describe("toDecimalString", () => {
  it("caps at 10 fraction digits and trims trailing zeros", () => {
    expect(toDecimalString(0.1 + 0.2)).toBe("0.3");
    expect(toDecimalString(97300)).toBe("97300");
    expect(toDecimalString(1.05)).toBe("1.05");
  });

  it("never produces exponent notation for small values", () => {
    expect(toDecimalString(0.0000001)).toBe("0.0000001");
  });

  it("rejects values that round to zero at 10 digits", () => {
    expect(() => toDecimalString(1e-12)).toThrow(/rounds to zero/);
  });

  it("rejects values toFixed renders in exponent notation (>= 1e21)", () => {
    expect(() => toDecimalString(1e21)).toThrow(/not representable/);
  });

  it("rejects non-finite and non-positive values", () => {
    expect(() => toDecimalString(Number.NaN)).toThrow();
    expect(() => toDecimalString(-1)).toThrow();
    expect(() => toDecimalString(0)).toThrow();
  });
});
