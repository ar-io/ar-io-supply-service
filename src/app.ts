//! Express application factory. Separated from index.ts so that
//! integration tests can import the app, mount it on a random port, and
//! tear it down cleanly between tests.

import express, { type Express, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import pino from "pino";

import { loadConfig, type Config } from "./config.js";
import { createTtlCache } from "./cache.js";
import { getSupply, type SupplyResponse } from "./supply.js";

const config: Config = loadConfig();
const log = pino({ level: config.logLevel });

const cache = createTtlCache<SupplyResponse>(
  (signal) => getSupply(config.rpcUrl, signal),
  config.cacheTtlMs,
  config.rpcTimeoutMs,
);

const app: Express = express();
// Deployed behind nginx on the same host (loopback). Without this, Express's
// req.ip is always nginx's own address, so express-rate-limit buckets every
// client on earth into one shared counter instead of limiting per real
// client. "loopback" trusts X-Forwarded-For only from a directly-connected
// loopback peer — exactly nginx's position — so a remote client can't spoof
// their way past it by sending their own X-Forwarded-For.
app.set("trust proxy", "loopback");
app.use(
  rateLimit({
    windowMs: 60_000,
    limit: config.rateLimitPerMinute,
    standardHeaders: true,
    legacyHeaders: false,
  }),
);

/// GET /health — ops endpoint. Does not hit Solana; reports cache state so
/// you can tell "service is up" from "service is up but Solana reads have
/// been failing for an hour" at a glance.
app.get("/health", (_req: Request, res: Response) => {
  const status = cache.status();
  res.json({
    ok: status.hasValue,
    cache: status,
  });
});

/// GET /token/supply — full supply object, denominated in ARIO.
/// GET /token/supply/:attribute — a single field (e.g. /circulating), bare
/// value. Path matches the original API Gateway resource exactly.
app.get(
  ["/token/supply", "/token/supply/:attribute"],
  async (req: Request<{ attribute?: string }>, res: Response) => {
    let supply: SupplyResponse;
    try {
      supply = await cache.get();
    } catch (error) {
      // Full detail goes to the server log only. SOLANA_RPC_URL may carry an
      // API key (e.g. a paid RPC provider's URL with a query-string token),
      // and some fetch failure messages embed the request URL — echoing
      // `error.message` to an unauthenticated public client would risk
      // leaking it.
      log.error({ error }, "Error retrieving supply data");
      res.status(500).json({
        message: "Error retrieving supply data",
      });
      return;
    }

    res.set("Cache-Control", `max-age=${config.cacheTtlMs / 1000}`);

    const attribute = req.params.attribute;
    if (attribute === undefined) {
      res.json(supply);
      return;
    }

    const value = (supply as unknown as Record<string, number>)[attribute];
    if (value === undefined) {
      res.status(404).json({
        message: `Attribute '${attribute}' not found in supply data`,
      });
      return;
    }
    res.json(value);
  },
);

export default app;
export { config };
