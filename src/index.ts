import WebSocket from "ws";
import {
  HttpError,
  makeApi,
  type BalancesDto,
  type FaucetDripResult,
  type FaucetInfo,
  type IncomingTransferDto,
  type MakerQuoteResponse,
  type MakerStatusResponse,
  type QuoteDto,
  type RfqDto,
  type SignActionDto,
  type TradeDto,
  type TxExecuteBatchResponse,
  type WsEvent,
} from "./api.ts";
import { loadConfig } from "./config.ts";
import { loadIdentity, recoverApiKey, register, type Identity } from "./identity.ts";
import { makerSpend, quotePrice } from "./price.ts";

const log = (msg: string): void => console.log(`[${new Date().toISOString()}] ${msg}`);

const heldOf = (b: BalancesDto, symbol: string): number =>
  Number(b.holdings.find((h) => h.symbol === symbol)?.amount ?? "0");

async function main(): Promise<void> {
  const cfg = loadConfig(process.env);
  let identity: Identity | undefined = loadIdentity(cfg.stateFile);
  const api = makeApi(cfg.apiUrl, () => identity?.apiKey ?? "");

  if (identity !== undefined && identity.apiKey === "") {
    log("identity has no API key — recovering via challenge + rotate");
    identity = await recoverApiKey(api, cfg.stateFile);
  }
  if (identity === undefined) {
    log(`no identity at ${cfg.stateFile} — registering "${cfg.displayName}" at ${cfg.apiUrl}`);
    identity = await register(api, cfg.displayName, cfg.stateFile);
    log(`registered as ${identity.hint} (${identity.partyId})`);
  }
  const id = identity;
  log(`maker ${id.hint} — desk ${cfg.apiUrl}, spread ${cfg.spreadBps} bps`);

  /** RFQs quoted this run, so a stream snapshot does not re-quote and an expired quote can be renewed. */
  const live = new Map<string, RfqDto>();
  /** Action ids already signed; an id is released again on transport failure or a retryable error. */
  const signed = new Set<string>();

  async function signAndExecute(actions: SignActionDto[]): Promise<void> {
    if (signed.size > 5000) signed.clear();
    for (const a of actions) {
      if (a.purpose === "transfer-out" && !signed.has(a.id)) {
        log(`REFUSING unexpected transfer-out: ${a.description}`); // the bot never withdraws
        signed.add(a.id);
      }
    }
    const fresh = actions.filter((a) => !signed.has(a.id));
    for (let i = 0; i < fresh.length; i += 10) {
      const chunk = fresh.slice(i, i + 10); // the desk caps a batch at 50
      for (const a of chunk) {
        signed.add(a.id);
        log(`signing: ${a.description}`);
      }
      try {
        const res = await api.post<TxExecuteBatchResponse>(
          "/tx/execute",
          { signatures: chunk.map((a) => ({ actionId: a.id, signature: id.signHash(a.hash) })) },
          60_000,
        );
        for (const r of res.results) {
          if (r.status !== "error") continue;
          log(`action ${r.actionId} failed (retryable=${r.retryable ?? false}): ${r.error}`);
          if (r.retryable === true) signed.delete(r.actionId);
        }
      } catch (e) {
        for (const a of chunk) signed.delete(a.id);
        throw e;
      }
    }
  }

  /** Quote every RFQ at mid ± spread; no mid means no quote. */
  async function quote(rfq: RfqDto, requote = false): Promise<void> {
    if (!requote && live.has(rfq.rfqId)) return;
    live.set(rfq.rfqId, rfq);
    try {
      const ref = await api.get<{ price: string | null }>(
        `/maker/reference-price?base=${encodeURIComponent(rfq.base)}&quote=${encodeURIComponent(rfq.quote)}`,
      );
      const mid = ref.price ?? cfg.staticPrices[`${rfq.base}/${rfq.quote}`];
      if (mid === undefined) {
        log(`no price for ${rfq.base}/${rfq.quote} — skipping ${rfq.rfqId}`);
        live.delete(rfq.rfqId);
        return;
      }
      const price = quotePrice(mid, rfq.direction, cfg.spreadBps, cfg.priceDivisor);
      // Never quote what settlement cannot take: a failed trade is worse than no quote.
      const spend = makerSpend(rfq.direction, rfq.qty, price, rfq.feeBps);
      const balances = await api.get<BalancesDto>("/wallet/holdings");
      if (
        spend.base > cfg.maxSpendShare * heldOf(balances, rfq.base) ||
        spend.quote > cfg.maxSpendShare * heldOf(balances, rfq.quote)
      ) {
        log(`skipping ${rfq.rfqId}: ${spend.base} ${rfq.base} + ${spend.quote} ${rfq.quote} exceeds ${cfg.maxSpendShare * 100}% of holdings`);
        live.delete(rfq.rfqId);
        return;
      }
      // A validUntil past the RFQ deadline is a 409.
      const validUntil = new Date(Math.min(Date.now() + cfg.quoteTtlSeconds * 1_000, Date.parse(rfq.deadline))).toISOString();
      const q = await api.post<MakerQuoteResponse>("/maker/quotes", { rfqId: rfq.rfqId, price, validUntil });
      const verb = rfq.direction === "SELL" ? "sells" : "buys";
      const midSource = ref.price === null ? "static" : "reference";
      const scale = cfg.priceDivisor === 1 ? "" : ` /${cfg.priceDivisor}`;
      log(`quoted ${rfq.rfqId}: taker ${verb} ${rfq.qty} ${rfq.base} @ ${price} ${rfq.quote} (${midSource} mid ${mid}${scale})`);
      await signAndExecute(q.actions); // the allocations ARE the quote; the taker sees it once they land
    } catch (e) {
      live.delete(rfq.rfqId); // a snapshot replay retries
      if (e instanceof HttpError && (e.status === 404 || e.status === 409)) log(`quote ${rfq.rfqId} skipped: ${e.body}`);
      else log(`quote ${rfq.rfqId} error: ${String(e)}`);
    }
  }

  async function handleEvent(ev: WsEvent): Promise<void> {
    switch (ev.type) {
      case "rfq.created":
        return quote(ev.payload as RfqDto);
      case "rfq.closed":
      case "rfq.expired":
        live.delete((ev.payload as { rfqId: string }).rfqId);
        return;
      case "quote.status": {
        const p = ev.payload as { quoteId: string; rfqId: string; status: QuoteDto["status"] };
        if (p.status === "pending") return;
        log(`quote ${p.quoteId} on ${p.rfqId}: ${p.status}`);
        const rfq = live.get(p.rfqId);
        if (p.status === "expired" && rfq !== undefined) return quote(rfq, true); // the RFQ itself is still open
        return;
      }
      case "trade.settled": {
        const t = ev.payload as TradeDto;
        log(`SETTLED trade ${t.tradeId}: ${t.qty} ${t.base} @ ${t.price} ${t.quote} (fee ${t.fee})`);
        return;
      }
      case "trade.failed": {
        const p = ev.payload as { tradeId: string; reason: string };
        log(`trade ${p.tradeId} FAILED: ${p.reason}`);
        return;
      }
      case "resync":
        live.clear(); // the snapshot replays whatever is still open
        return;
      default:
        return;
    }
  }

  /** One socket, reconnected forever; the connect-time snapshot is the resync. */
  let stream: WebSocket | undefined;
  function connectStream(): void {
    const options = api.streamOptions();
    const ws = new WebSocket(options.url, { headers: options.headers });
    stream = ws;
    ws.on("open", () => {
      log("stream connected");
      live.clear(); // start from the snapshot's truth: quotes expired and RFQs closed while offline
    });
    ws.on("message", (data) => {
      let parsed: WsEvent;
      try {
        parsed = JSON.parse(String(data)) as WsEvent;
      } catch {
        return log(`unparseable stream frame: ${String(data).slice(0, 120)}`);
      }
      void handleEvent(parsed).catch((e) => log(`event ${parsed.type} error: ${String(e)}`));
    });
    ws.on("close", () => {
      log("stream closed — reconnecting in 5s");
      setTimeout(connectStream, 5_000);
    });
    ws.on("error", () => {}); // close follows
  }

  /** Periodic chores: retry unsigned actions, accept deposits, top up from the DevNet faucet. */
  async function housekeeping(): Promise<void> {
    const pending = await api.get<{ actions: SignActionDto[] }>("/tx/pending");
    await signAndExecute(pending.actions);

    const inbox = await api.get<{ transfers: IncomingTransferDto[] }>("/wallet/incoming");
    for (const t of inbox.transfers) {
      try {
        log(`accepting deposit: ${t.amount} ${t.symbol} from ${t.sender}`);
        const r = await api.post<{ actions: SignActionDto[] }>(`/wallet/incoming/${encodeURIComponent(t.cid)}/accept`);
        await signAndExecute(r.actions);
      } catch (e) {
        log(`deposit ${t.cid} accept failed: ${String(e)}`);
      }
    }

    // The faucet is shared with human demo users: draw only when a token runs low.
    const faucet = await api.get<FaucetInfo>("/faucet");
    if (faucet.enabled && faucet.retryAfterSeconds === 0) {
      const balances = await api.get<BalancesDto>("/wallet/holdings");
      if (faucet.drip.some((d) => heldOf(balances, d.symbol) < 10 * Number(d.amount))) {
        const drip = await api.post<FaucetDripResult>("/faucet", undefined, 60_000);
        if (drip.sent.length > 0) log(`faucet drip: ${drip.sent.map((d) => `${d.amount} ${d.symbol}`).join(", ")}`);
      }
    }
  }

  await housekeeping().catch((e) => log(`housekeeping error: ${String(e)}`));
  const status = await api.get<MakerStatusResponse>("/maker/status");
  log(`status: party ${status.hint}, pendingActions=${status.pendingActions}`);
  connectStream();

  let busy = false;
  setInterval(() => {
    if (busy) return;
    busy = true;
    void housekeeping()
      .catch((e) => log(`housekeeping error: ${String(e)}`))
      .finally(() => {
        busy = false;
      });
  }, cfg.pollSeconds * 1_000);

  // The desk advertises only makers with a live stream; a zombie socket still looks open here. Recycle it.
  setInterval(() => {
    void api
      .get<MakerStatusResponse>("/maker/status")
      .then((s) => {
        if (!s.invitable && stream?.readyState === WebSocket.OPEN) {
          log("desk sees us offline — recycling the stream");
          stream.close();
        }
      })
      .catch(() => {});
  }, 60_000);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
