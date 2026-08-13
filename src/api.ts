/** The subset of docs/openapi.yaml the bot touches. Deliberately local types:
 * the bot plays a third-party integrator coded against the public spec, not
 * against the desk's internal @rfq/shared schemas. */

export interface SignActionDto {
  id: string;
  purpose: string;
  description: string;
  /** base64 bytes of a Canton prepared-transaction hash — sign the RAW bytes. */
  hash: string;
}

export interface RfqDto {
  rfqId: string;
  taker: string;
  /** From the taker's side: SELL = the taker sells the base asset to us. */
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
  status: "pending" | "won" | "lost" | "expired" | "revoked";
}

export interface MakerQuoteResponse extends QuoteDto {
  /** The DvpProposal pair (fee + swap) to sign; the quote is invisible to the taker until both are. */
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
  serviceActivated: boolean;
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
  actions: SignActionDto[];
}

/** One /maker/stream message; payload shape depends on `type` (see openapi). */
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
  /** Raise `timeoutMs` only for calls that do many ledger round-trips. */
  post<T>(path: string, body?: unknown, timeoutMs?: number): Promise<T>;
  /** Node WebSocket upgrade options for the authenticated maker stream. */
  streamOptions(): { url: string; headers: Record<string, string> };
}

/** Thin fetch client. `apiKey` is read per call so the client can be created
 * before registration has produced a key. Non-2xx throws HttpError. Every call
 * is time-bounded: one hung keep-alive socket must not stall the sign loop for
 * the minutes undici's defaults would allow. */
export function makeApi(baseUrl: string, apiKey: () => string): Api {
  async function call<T>(method: string, path: string, body?: unknown, timeoutMs = 15_000): Promise<T> {
    const key = apiKey();
    const res = await fetch(baseUrl + path, {
      method,
      headers: {
        // content-type only WITH a body: fastify 400s an empty json-typed body.
        ...(body === undefined ? {} : { "content-type": "application/json" }),
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
