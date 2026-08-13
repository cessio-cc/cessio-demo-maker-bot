# cessio-demo-maker-bot

A working market-maker bot for the [Cessio](https://cessio.cc) RFQ desk — a
confidential request-for-quote desk for large swaps on Canton Network.

It plays a third-party integrator: **everything it does goes through the public
Maker API**. No internal packages, one runtime dependency (`ws`, for
authenticated upgrade headers), Node 24 native TypeScript, global `fetch`.
Under 900 lines including tests.

Fork it, change the pricing, run your own maker.

- Maker API reference & guides: **[docs.devnet.cessio.cc](https://docs.devnet.cessio.cc)**
- Live DevNet desk: **[devnet.cessio.cc](https://devnet.cessio.cc)**

## What it does, forever

1. **Registers itself** on first run (`/maker/register/start` + `/complete`):
   generates an Ed25519 party key, signs the topology, stores the identity
   (party key + API key) in `state/identity.json` (mode 0600, gitignored).
2. **Signs everything** it is handed — activation, quote proposal pairs,
   allocations after a taker accepts, deposit accepts — via `GET /tx/pending` +
   batch `POST /tx/execute`. The one exception: it refuses `transfer-out`
   actions, because it never initiates a withdrawal.
3. **Quotes every incoming RFQ it can settle** from `/maker/stream` at the
   desk's reference price (`/maker/reference-price`) ± `BOT_SPREAD_BPS` in its
   favor, falling back to `BOT_STATIC_PRICES` when the oracle has none. No
   mid → no quote; and an RFQ whose settlement would take more than
   `BOT_MAX_SPEND_SHARE` of a holding is skipped — a quote that fails at
   settlement is worse for the taker than no quote.
4. **Keeps itself funded** on DevNet: accepts every pending deposit, and draws
   from the desk faucet only when a holding runs low (the reservoir is shared
   with human demo users).

The stream reconnects with a flat 5s backoff; the connect-time snapshot replays
open RFQs, so a reconnect is a resync.

## Run

Node 24+ (it runs the `.ts` sources directly — no build step).

```sh
npm install

# against the public DevNet desk
BOT_API_URL=https://api.devnet.cessio.cc npm start

# against a desk running on localhost:4000 (default), reloading on edits
npm run dev
```

Or with a `.env` file:

```sh
cp .env.example .env && node --env-file=.env src/index.ts
```

Docker:

```sh
docker build -t my-maker-bot .
docker run -d --name my-maker-bot \
  -e BOT_API_URL=https://api.devnet.cessio.cc \
  -v my-maker-bot-state:/data \
  my-maker-bot
```

First run registers a fresh maker party and prints its party hint. Give it a
minute: registration, activation, and the first faucet draw all settle
on-ledger.

## Config (env)

| Variable                | Default                 | Meaning                                        |
| ----------------------- | ----------------------- | ---------------------------------------------- |
| `BOT_API_URL`           | `http://localhost:4000` | Desk REST base URL                             |
| `BOT_DISPLAY_NAME`      | `Cessio Demo Maker`     | Registration display name (hint derives)       |
| `BOT_SPREAD_BPS`        | `20`                    | Half-spread vs the reference mid, in bps       |
| `BOT_STATE_FILE`        | `state/identity.json`   | Identity persistence (keep it, it's money)     |
| `BOT_POLL_SECONDS`      | `10`                    | Housekeeping cadence (pending/inbox/faucet)    |
| `BOT_STATIC_PRICES`     | _(empty)_               | Fallback mids, `cbtc/usdcx:97000,ceth/cc:1200` |
| `BOT_MAX_SPEND_SHARE`   | `0.5`                   | Max share of a holding one trade may commit    |
| `BOT_PRICE_DIVISOR`     | `1`                     | Divide every mid by this (demo pricing)        |
| `BOT_QUOTE_TTL_SECONDS` | `300`                   | Quote validity, capped by the RFQ deadline     |

Losing `state/identity.json` loses the party: a re-run registers a fresh maker
and whatever the old party held stays with it. A lost **API key** (key file
intact) is recovered automatically at startup via `/maker/challenge` +
`/maker/api-key/rotate` — the key is persisted before `register/complete`, so
even a crash mid-registration self-heals.

## Making it yours

| File              | What lives there                                                                      |
| ----------------- | ------------------------------------------------------------------------------------- |
| `src/price.ts`    | **The strategy.** `quotePrice` (mid → your price) and `makerSpend` (what settlement costs you). Start here. |
| `src/index.ts`    | The loop: `quote()` decides whether to answer an RFQ, `handleEvent()` reacts to the stream, `housekeeping()` runs the periodic chores. |
| `src/api.ts`      | Typed client for the slice of the Maker API the bot touches, plus the stream event shapes. |
| `src/identity.ts` | Self-serve registration, key persistence, API-key recovery. Rarely needs changing.    |
| `src/config.ts`   | Pure `env → typed config`. Add your knobs here; validate them here.                    |

The bot signs with a key it generated and never uploads; the desk only ever
holds the public half. Whatever you change, keep it that way.

Tests are [vitest](https://vitest.dev):

```sh
npm run typecheck && npm test
```

## Disclaimer

Demo software for Canton DevNet. It quotes with a naive fixed spread off a
single reference price and has no inventory, risk, or adverse-selection
management. Do not point it at real money without replacing the strategy.

## License

MIT — see [LICENSE](LICENSE).
