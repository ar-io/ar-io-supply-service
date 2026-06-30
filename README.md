# ar.io supply service

Serves the AR.IO network token supply as JSON at `ario.permaweb.services`.
Reads live supply directly from Solana (three fixed on-chain accounts) on
every cache miss — no SDK dependency, just native `fetch` JSON-RPC.

This replaces a previous AWS Lambda + API Gateway + CloudFront deployment
of the same logic with a single small Node.js service, run in Docker behind
nginx on a plain VPS.

## API

- `GET /` — full supply object, denominated in ARIO:
  ```json
  {
    "total": 1000000000,
    "circulating": 654623847.25,
    "locked": 356623224.87,
    "staked": 12556416.01,
    "delegated": 14347927.83,
    "withdrawn": 2382665.3,
    "protocolBalance": 53797079.83,
    "liquid": 561204651.46
  }
  ```
- `GET /:attribute` — a single field as a bare JSON scalar, e.g.
  `GET /circulating` -> `654623847.25`. 404 if the field doesn't exist.
- `GET /health` — `{ ok, cache: { hasValue, ageMs, lastErrorMessage } }`.
  Does not hit Solana; reports whether the in-process cache has a value and
  how stale it is, so you can tell "service is up" from "service is up but
  Solana reads have been failing" at a glance.

## How this differs from the original Lambda

The Lambda (`supply.mjs`) is preserved logic-for-logic in `src/supply.ts`
(account addresses, byte offsets, plausibility checks, and the pre-cutoff
vault lock-bucket snapshot are unchanged). Two things changed because the
deployment shape changed:

1. **In-process caching (`src/cache.ts`).** The Lambda set
   `Cache-Control: max-age=60` and relied on CloudFront to actually cache
   responses. There's no CDN in front of this service, so it now caches the
   decoded supply object in memory for `CACHE_TTL_SECONDS` (default 60,
   same default as before) itself. Concurrent requests during a cache miss
   share a single in-flight Solana RPC call (no thundering herd).

2. **Stale-on-error fallback.** If a refresh fails (RPC timeout, rate
   limit, etc) but a previous value exists, the service serves the last
   known-good value instead of a 500. The Lambda always returned 500 on any
   RPC failure. This trades a small amount of staleness for much higher
   uptime on a public endpoint that price aggregators poll — appropriate
   here since the only failure mode that matters (a real program-layout
   change) is also caught by `assertPlausible`, not by surfacing transient
   RPC errors to callers. Only the very first request after a cold start,
   with no cached value yet, can still 500.

Everything else — account addresses, offsets, the plausibility bounds, the
`circulating`/`liquid` distinction, the lock-bucket math — is a direct port.

## Develop

```bash
npm install
npm run dev     # tsx watch, listens on :3031
npm test        # node:test, no network required (RPC calls are mocked)
npm run lint     # tsc --noEmit
```

## Configuration

Everything is optional; see [`.env.example`](./.env.example). The one
worth setting deliberately in production is `SOLANA_RPC_URL` — the public
default (`api.mainnet-beta.solana.com`) is rate-limited and not intended
for production traffic on a public-facing endpoint. Point it at a
dedicated RPC provider (Helius, Triton, QuickNode, etc) before cutover.

## Deploy (this host)

Stack: Docker container, reverse-proxied by the host's existing nginx,
TLS via certbot, supervised by systemd — the same pattern already used for
`/opt/ar-io-solana-attestor`.

1. Build and sanity-check locally:
   ```bash
   cd /opt/ar-io-supply-service
   docker compose build
   docker compose up   # Ctrl-C once you've confirmed curl localhost:3031/ works
   ```

2. Point DNS for `ario.permaweb.services` at this host (A + AAAA) before
   continuing — both the certbot HTTP-01 challenge and live traffic depend
   on it resolving here.

3. Install the nginx site (HTTP-only first, so certbot's HTTP-01 challenge
   has somewhere to land):
   ```bash
   cp deploy/ario-supply.nginx.conf /etc/nginx/sites-available/ario-supply
   # Comment out (or temporarily remove) the `server { listen 443 ... }`
   # block — the cert it references doesn't exist yet.
   ln -s /etc/nginx/sites-available/ario-supply /etc/nginx/sites-enabled/ario-supply
   nginx -t && systemctl reload nginx
   ```

4. Issue the cert (HTTP-01, via the `nginx` plugin — auto-renews through
   the host's existing `certbot.timer`, no manual steps after this):
   ```bash
   certbot --nginx -d ario.permaweb.services
   ```
   This both obtains the cert and rewrites the nginx config's `server_name`
   block to add the 443 server and redirect — review the diff against
   `deploy/ario-supply.nginx.conf` afterwards and reconcile if you'd rather
   keep them in sync manually.

5. Install and start the systemd unit:
   ```bash
   cp deploy/ario-supply.service /etc/systemd/system/ario-supply.service
   systemctl daemon-reload
   systemctl enable --now ario-supply.service
   ```

6. Verify:
   ```bash
   curl https://ario.permaweb.services/
   curl https://ario.permaweb.services/circulating
   curl https://ario.permaweb.services/health
   ```

### Operating

- Logs: `journalctl -u ario-supply -f` (or `docker logs -f ario-supply-service-supply-1`).
- Restart: `systemctl restart ario-supply`.
- The container has a Docker `HEALTHCHECK` against `/health`; `docker ps`
  shows `(healthy)`/`(unhealthy)`.
- Cert renewal is fully automatic (HTTP-01 + the host's `certbot.timer`) —
  nothing to do.

## License

AGPL-3.0-or-later (see [LICENSE](./LICENSE)), matching the original
Arweave Gateway Lambda this was ported from.
