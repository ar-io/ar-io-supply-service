//! Runtime configuration for the supply service.
//!
//! All values are optional with sane defaults — this service has no
//! secrets, so there is nothing that must be set before it will boot.
//!
//!   SOLANA_RPC_URL       — JSON-RPC endpoint to read accounts from
//!                          (default: public api.mainnet-beta.solana.com).
//!                          A dedicated/paid RPC endpoint is strongly
//!                          recommended for production: the public endpoint
//!                          rate-limits aggressively and is not intended
//!                          for production traffic.
//!   PORT                  — HTTP port (default 3031)
//!   CACHE_TTL_SECONDS      — how long a successful Solana read is reused
//!                          before the next request triggers a refetch
//!                          (default 60, matches the original Lambda's
//!                          Cache-Control max-age)
//!   RPC_TIMEOUT_MS        — abort the upstream RPC call after this long
//!                          (default 30000, matches the original Lambda)
//!   RATE_LIMIT_PER_MIN    — per-IP request budget per minute (default 300)
//!   LOG_LEVEL             — pino log level (default "info")

export interface Config {
  port: number;
  rpcUrl: string;
  cacheTtlMs: number;
  rpcTimeoutMs: number;
  rateLimitPerMinute: number;
  logLevel: string;
}

export function loadConfig(): Config {
  return {
    port: parseInt(process.env.PORT ?? "3031", 10),
    rpcUrl: process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com",
    cacheTtlMs: parseInt(process.env.CACHE_TTL_SECONDS ?? "60", 10) * 1000,
    rpcTimeoutMs: parseInt(process.env.RPC_TIMEOUT_MS ?? "30000", 10),
    rateLimitPerMinute: parseInt(process.env.RATE_LIMIT_PER_MIN ?? "300", 10),
    logLevel: process.env.LOG_LEVEL ?? "info",
  };
}
