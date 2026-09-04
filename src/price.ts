/** Mid / divisor, nudged by a half-spread in the bot's favor: below mid on a taker SELL, above on a BUY. */
export function quotePrice(mid: string, direction: "SELL" | "BUY", spreadBps: number, divisor = 1): string {
  const m = Number(mid) / divisor;
  if (!Number.isFinite(m) || m <= 0) throw new Error(`bad reference mid: "${mid}"`);
  const factor = direction === "SELL" ? 1 - spreadBps / 10_000 : 1 + spreadBps / 10_000;
  return toDecimalString(m * factor);
}

/** What the maker delivers if the quote settles. The desk fee is always in the quote asset. */
export function makerSpend(
  direction: "SELL" | "BUY",
  qty: string,
  price: string,
  feeBps: number,
): { base: number; quote: number } {
  const notional = Number(qty) * Number(price);
  const fee = (notional * feeBps) / 10_000;
  return direction === "SELL" ? { base: 0, quote: notional + fee } : { base: Number(qty), quote: fee };
}

/** Ledger Decimal string: positive, plain digits, at most 10 fraction digits, no trailing zeros. */
export function toDecimalString(n: number): string {
  if (!Number.isFinite(n) || n <= 0) throw new Error(`not a positive finite number: ${n}`);
  const s = n.toFixed(10).replace(/0+$/, "").replace(/\.$/, "");
  if (s === "0") throw new Error(`${n} rounds to zero at 10 fraction digits`);
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`${n} is not representable as a plain decimal`); // toFixed goes exponent at 1e21
  return s;
}
