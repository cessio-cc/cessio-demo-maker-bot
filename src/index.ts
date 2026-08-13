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
    // Half-finished registration: the key survived, the complete answer didn't.
    log("identity has no API key (lost register/complete answer) — recovering via challenge + rotate");
    identity = await recoverApiKey(api, cfg.stateFile);
  }
  let initialActions: SignActionDto[] = [];
  if (identity === undefined) {
    log(`no identity at ${cfg.stateFile} — registering "${cfg.displayName}" at ${cfg.apiUrl}`);
    ({ identity, actions: initialActions } = await register(api, cfg.displayName, cfg.stateFile));
    log(`registered as ${identity.hint} (${identity.partyId})`);
  }
  const id = identity;
  log(`maker ${id.hint} — desk ${cfg.apiUrl}, spread ${cfg.spreadBps} bps`);

  /** RFQs quoted this run, keyed by rfqId: keeps stream-reconnect snapshots
   * from churning the on-ledger proposal pair, and remembers the RFQ so an
   * expired quote can be re-quoted while the RFQ is still open. A restart
   * re-quotes once — replace is documented. */
  const live = new Map<string, RfqDto>();
  /** Action ids already handled, so housekeeping doesn't re-sign what an
   * inline response signed a moment ago. Ids are REMOVED again on transport
   * failure and on retryable per-action errors — an entry here must never
   * outlive a retriable action (it would expire unsigned and fail the trade).
   * Expiry is 10 min, so capping the set is enough. */
  const signed = new Set<string>();

  async function signAndExecute(actions: SignActionDto[]): Promise<void> {
    if (signed.size > 5000) signed.clear();
    // The bot never withdraws: a transfer-out here is something the desk made
    // up, and signing it would move funds out. Refuse once, loudly.
    for (const a of actions) {
      if (a.purpose === "transfer-out" && !signed.has(a.id)) {
        log(`REFUSING unexpected transfer-out: ${a.description}`);
        signed.add(a.id);
      }
    }
    const fresh = actions.filter((a) => !signed.has(a.id));
    // Chunked: the server caps a batch at 50, and a smaller chunk keeps the
    // call's sequential ledger work inside its request timeout.
    for (let i = 0; i < fresh.length; i += 10) {
      const chunk = fresh.slice(i, i + 10);
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
          if (r.status !== "error") continue; // in-flight: already running elsewhere
          log(`action ${r.actionId} failed (retryable=${r.retryable ?? false}): ${r.error}`);
          if (r.retryable === true) signed.delete(r.actionId); // next housekeeping re-signs
        }
      } catch (e) {
        // Transport failure — nothing certain happened; let housekeeping retry.
        for (const a of chunk) signed.delete(a.id);
        throw e;
      }
    }
  }

  /** The demo policy: quote EVERY RFQ at mid ± spread, mid being the desk's
   * reference price with BOT_STATIC_PRICES as the fallback. No mid at all
   * means no quote — the bot has no other opinion of fair value. */
  async function quote(rfq: RfqDto, requote = false): Promise<void> {
    if (!requote && live.has(rfq.rfqId)) return;
    live.set(rfq.rfqId, rfq);
    try {
      const ref = await api.get<{ price: string | null }>(
        `/maker/reference-price?base=${encodeURIComponent(rfq.base)}&quote=${encodeURIComponent(rfq.quote)}`,
      );
      const mid = ref.price ?? cfg.staticPrices[`${rfq.base}/${rfq.quote}`];
      if (mid === undefined) {
        log(`no price for ${rfq.base}/${rfq.quote} (no reference, no static) — skipping ${rfq.rfqId}`);
        live.delete(rfq.rfqId); // a snapshot replay retries once the oracle is back
        return;
      }
      const price = quotePrice(mid, rfq.direction, cfg.spreadBps, cfg.priceDivisor);
      // Never promise what settlement cannot take: an accepted-then-failed
      // trade is the worst demo outcome, and one whale RFQ must not commit
      // more than maxSpendShare of any holding.
      const spend = makerSpend(rfq.direction, rfq.qty, price, rfq.feeBps);
      const balances = await api.get<BalancesDto>("/wallet/holdings");
      if (
        spend.base > cfg.maxSpendShare * heldOf(balances, rfq.base) ||
        spend.quote > cfg.maxSpendShare * heldOf(balances, rfq.quote)
      ) {
        log(
          `skipping ${rfq.rfqId}: settling would take ${spend.base} ${rfq.base} + ${spend.quote} ${rfq.quote}, ` +
            `over ${cfg.maxSpendShare * 100}% of holdings`,
        );
        live.delete(rfq.rfqId); // a snapshot replay retries once funds arrive
        return;
      }
      // Explicit validity window, capped by the RFQ deadline (an explicit
      // validUntil past the deadline is a 409 by design).
      const validUntil = new Date(
        Math.min(Date.now() + cfg.quoteTtlSeconds * 1_000, Date.parse(rfq.deadline)),
      ).toISOString();
      const q = await api.post<MakerQuoteResponse>("/maker/quotes", { rfqId: rfq.rfqId, price, validUntil });
      const verb = rfq.direction === "SELL" ? "sells" : "buys";
      const midSource = ref.price === null ? "static" : "reference";
      const scale = cfg.priceDivisor === 1 ? "" : ` /${cfg.priceDivisor}`;
      log(`quoted ${rfq.rfqId}: taker ${verb} ${rfq.qty} ${rfq.base} @ ${price} ${rfq.quote} (${midSource} mid ${mid}${scale})`);
      await signAndExecute(q.actions);
    } catch (e) {
      // Any failure un-books the RFQ so a snapshot replay can retry; if it was
      // 404/409 (closed or deadline passed) no replay will come — no harm.
      live.delete(rfq.rfqId);
      if (e instanceof HttpError && (e.status === 404 || e.status === 409)) log(`quote ${rfq.rfqId} skipped: ${e.body}`);
      else log(`quote ${rfq.rfqId} error: ${String(e)}`);
    }
  }

  async function handleEvent(ev: WsEvent): Promise<void> {
    switch (ev.type) {
      case "rfq.created":
        return quote(ev.payload as RfqDto);
      case "rfq.closed":
      case "rfq.expired": {
        live.delete((ev.payload as { rfqId: string }).rfqId);
        return;
      }
      case "quote.status": {
        const p = ev.payload as { quoteId: string; rfqId: string; status: QuoteDto["status"] };
        if (p.status === "pending") return;
        log(`quote ${p.quoteId} on ${p.rfqId}: ${p.status}`);
        // The quote timed out but the RFQ is still open (its close arrives as a
        // separate event): put a fresh one up — this bot always has a price.
        if (p.status === "expired") {
          const rfq = live.get(p.rfqId);
          if (rfq !== undefined) return quote(rfq, true);
        }
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
        // Server state reset: our quote bookkeeping is stale; the snapshot
        // replays rfq.created for whatever is still live, so requote it all.
        live.clear();
        return;
      default:
        return; // quote.created, trade.step, balances.updated, ... — informational
    }
  }

  /** One socket, reconnected forever with a flat 5s backoff. The connect-time
   * snapshot replays open RFQs and doubles as the resync. */
  let stream: WebSocket | undefined;
  function connectStream(): void {
    const options = api.streamOptions();
    const ws = new WebSocket(options.url, { headers: options.headers });
    stream = ws;
    ws.on("open", () => {
      log("stream connected");
      // Start from the snapshot's truth: a quote that expired while we were
      // offline arrives with myQuote=null and must be re-quoted, and entries
      // for RFQs that closed offline would otherwise linger forever. Costs one
      // quote replace per open RFQ per reconnect — reconnects are rare.
      live.clear();
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
    ws.on("error", () => {}); // close always follows; the retry lives there
  }

  /** Everything that is polling by nature: actions the desk enqueued without
   * asking us (allocations after an accept), the deposit inbox, the faucet. */
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
        // One rotten transfer must not block the rest of the inbox or the faucet.
        log(`deposit ${t.cid} accept failed: ${String(e)}`);
      }
    }

    // Self-funding on DevNet (`enabled` is false everywhere else) — politely:
    // the reservoir is shared with human demo users, so draw only when some
    // offered token is genuinely low (under ~10 drips of it), not every cooldown.
    const faucet = await api.get<FaucetInfo>("/faucet");
    if (faucet.enabled && faucet.retryAfterSeconds === 0) {
      const balances = await api.get<BalancesDto>("/wallet/holdings");
      if (faucet.drip.some((d) => heldOf(balances, d.symbol) < 10 * Number(d.amount))) {
        const drip = await api.post<FaucetDripResult>("/faucet", undefined, 60_000); // one transfer per token
        if (drip.sent.length > 0) log(`faucet drip: ${drip.sent.map((d) => `${d.amount} ${d.symbol}`).join(", ")}`);
      }
    }
  }

  // Startup order: sign what registration handed us (a failure is retried via
  // /tx/pending), drain anything parked while we were down, then go live.
  await signAndExecute(initialActions).catch((e) => log(`initial sign failed (will retry): ${String(e)}`));
  await housekeeping().catch((e) => log(`housekeeping error: ${String(e)}`));
  const status = await api.get<MakerStatusResponse>("/maker/status");
  log(`status: serviceActivated=${status.serviceActivated} pendingActions=${status.pendingActions}`);
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

  // Dead-socket watchdog: the desk only advertises makers with a live stream,
  // and a silently-dropped TCP link can look open here for many minutes. If
  // the desk says we are not invitable while we think we are connected, the
  // socket is a zombie — recycle it. Once a minute: /maker/status reads the
  // ledger, the spec asks for a human cadence.
  setInterval(() => {
    void api
      .get<MakerStatusResponse>("/maker/status")
      .then((s) => {
        if (!s.invitable && stream?.readyState === WebSocket.OPEN) {
          log("desk sees us offline — recycling the stream");
          stream.close();
        }
      })
      .catch(() => {}); // transient; the next probe will tell
  }, 60_000);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
