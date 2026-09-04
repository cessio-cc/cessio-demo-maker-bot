/** The slice of the public Maker API (docs/openapi.yaml) the bot uses. */

export interface SignActionDto {
  id: string;
  purpose: "allocate" | "transfer-accept" | "transfer-out";
  description: string;
  /** base64 hash of a prepared transaction — sign the RAW bytes. */
  hash: string;
}

export interface RfqDto {
  rfqId: string;
  taker: string;
  /** The taker's side: SELL = the taker sells the base asset to us. */
  direction: "SELL" | "BUY";
  qty: string;
  base: string;
  quote: string;
  deadline: string;
  /** Desk fee in bps, charged to the maker in the quote asset. */
  feeBps: number;
}

export interface BalancesDto {
  party: string;
  holdings: { symbol: string; displaySymbol: string; amount: string }[];
}

export interface QuoteDto {
  quoteId: string;
  rfqId: string;
  price: string;
  status: "pending" | "won" | "lost" | "expired" | "revoked" | "cancelled";
}

/** The quote plus its allocations to sign; the taker sees nothing until they land. */
export interface MakerQuoteResponse extends QuoteDto {
  actions: SignActionDto[];
}

export interface TradeDto {
  tradeId: string;
  direction: "SELL" | "BUY";
  qty: string;
  base: string;
  quote: string;
  price: string;
  fee: string;
}

export interface TxExecuteBatchResponse {
  results: { actionId: string; status: "executed" | "in-flight" | "error"; error?: string; retryable?: boolean }[];
}

export interface IncomingTransferDto {
  cid: string;
  symbol: string;
  amount: string;
  sender: string;
}

export interface FaucetInfo {
  enabled: boolean;
  retryAfterSeconds: number;
  drip: { symbol: string; displaySymbol: string; amount: string }[];
}

export interface FaucetDripResult {
  sent: { symbol: string; amount: string }[];
  skipped: { symbol: string; reason: string }[];
}

export interface MakerStatusResponse {
  partyId: string;
  hint: string;
  invitable: boolean;
  pendingActions: number;
}

export interface MakerRegisterStartResponse {
  registrationId: string;
  partyId: string;
  topology: { hash: string; description: string }[];
}

export interface MakerRegisterCompleteResponse {
  partyId: string;
  hint: string;
  apiKey: string;
}

/** One /maker/stream message; the payload shape depends on `type`. */
export interface WsEvent {
  type: string;
  payload: unknown;
}

export class HttpError extends Error {
  // No TS parameter properties: Node's strip-only TS mode cannot run them.
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string, call: string) {
    super(`${call} -> ${status}: ${body}`);
    this.status = status;
    this.body = body;
  }
}

export interface Api {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown, timeoutMs?: number): Promise<T>;
  streamOptions(): { url: string; headers: Record<string, string> };
}

/** fetch with X-API-Key, JSON bodies and a timeout on every call. Non-2xx throws HttpError. */
export function makeApi(baseUrl: string, apiKey: () => string): Api {
  async function call<T>(method: string, path: string, body?: unknown, timeoutMs = 15_000): Promise<T> {
    const key = apiKey();
    const res = await fetch(baseUrl + path, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }), // fastify 400s a typed empty body
        ...(key === "" ? {} : { "x-api-key": key }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) throw new HttpError(res.status, text, `${method} ${path}`);
    return (text === "" ? undefined : JSON.parse(text)) as T;
  }
  return {
    get: (path) => call("GET", path),
    post: (path, body, timeoutMs) => call("POST", path, body, timeoutMs),
    streamOptions: () => ({
      url: `${baseUrl.replace(/^http/, "ws")}/maker/stream`,
      headers: { "x-api-key": apiKey() },
    }),
  };
}
