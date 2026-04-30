# together-xyz-vs-ai

Reproducible audit of whether `api.together.xyz` and `api.together.ai` apply
different rate limits to the same API key.

## Why

The TS SDK ships with `api.together.xyz` as its default base URL (see step 4),
so most TS SDK customers — and any internal tooling that hasn't been
explicitly pointed at `.ai` — are talking to `.xyz`. If the two hostnames are
served by separate Cloudflare zones with different rate-limit policies, those
customers could be getting throttled more aggressively than customers using
`.ai` via the same API key.

## Setup

```sh
bun install
cp .env.example .env   # then edit and set TOGETHER_API_KEY
```

## Run

Each step writes a timestamped JSON snapshot to `results/` so re-runs are
preserved for diffing.

```sh
bun run step1   # DNS + edge fingerprint (no API key needed)
bun run step2   # single-request header diff (needs TOGETHER_API_KEY)
bun run step3   # controlled load test (needs TOGETHER_API_KEY)
bun run step4   # confirm SDK default base URL (no API key needed)
bun run all     # run everything in order
```

## Steps

### 1. DNS + edge fingerprint — `src/step1-dns.ts`

Resolves both hostnames and sends a `HEAD /`. Tells us whether the two hosts
share infrastructure (same A records, same `cf-ray` POP, same `server`
header) or are independently served — which determines whether any rate-limit
difference is policy-driven (Host-header based) or infrastructure-driven.

**Findings from initial run** (see `results/step1-dns-*.json`):
- Both hosts return `server: cloudflare` and Cloudflare-range A records.
- A records differ (`172.64.144.98 / 104.18.43.158` for `.xyz` vs
  `104.18.37.81 / 172.64.150.175` for `.ai`) — expected for two different
  Cloudflare zones.
- Both responses include an `AWSALBCORS` cookie, so both terminate at AWS
  ALBs behind Cloudflare. Likely same backend cluster.
- Response headers are *almost* identical but **not the same**:
  `strict-transport-security` `max-age` differs (15552000 vs 2592000), and
  only `.ai` sets `x-content-type-options: nosniff`. That's strong evidence
  the two hostnames are configured as **separate Cloudflare zones with
  independent transform/rule sets**, which means Cloudflare-level WAF and
  rate-limit rules could plausibly differ even if the backend rate limiter
  is shared.

### 2. Single-request header diff — `src/step2-headers.ts`

Sends 4 alternating chat-completion requests (xyz, ai, xyz, ai) with the
same key + model + prompt and dumps the rate-limit headers side-by-side.

**Read the output like this:**
- If `x-ratelimit-remaining-*` decreases monotonically across all 4 calls,
  the bucket is shared and Host header doesn't matter.
- If both calls to `.xyz` see one set of `remaining` values and both calls to
  `.ai` see another (independent) set, the buckets are split per host — and
  the question becomes "are the limit *ceilings* different too."
- If `.xyz` returns lower `x-ratelimit-limit-*` than `.ai` for the same
  account/model, that's the smoking gun.

### 3. Controlled load test — `src/step3-loadtest.ts`

Two rounds:
1. Burst `REQUESTS_PER_HOST` (default 50) requests at each host with
   `CONCURRENCY` (default 10) parallel workers. Records first 429, p50/p95
   latency, and remaining-request counters as they decay.
2. Interleaved round: alternate one request to xyz, one to ai. If
   429s on `.xyz` correlate with 429s on `.ai`, the bucket is shared.

Tunable via env: `CONCURRENCY`, `REQUESTS_PER_HOST`, `INTERLEAVED_TOTAL`,
`TOGETHER_MODEL`. **Don't use GLM 5.1** — it's already at capacity, so 429s
there are noise. Use a cheap, plentiful model like Llama 3.2 3B Instruct
Turbo (the default).

### 4. SDK default base URL — `src/step4-sdk-baseurl.ts`

Imports the installed `together-ai` SDK, instantiates a client with no
override, and reads `client.baseURL`. Also greps the SDK's source/dist for
all hard-coded base URL references and counts xyz vs ai occurrences.

**Findings from initial run** (`together-ai@0.21.1`):
- Default `baseURL`: `https://api.together.xyz/v1` — **confirms boss's
  hypothesis.**
- Hard-coded references: 14 to `api.together.xyz`, 0 to `api.together.ai`.
- `TOGETHER_BASE_URL` env var is honoured as an override, so customers can
  point the SDK at `.ai` without code changes — but they have to know to do
  it, and the docs' default example shows `.xyz`.

## Reproducing later

All scripts are deterministic given the same env. To re-audit after a
config change on Together's side:

```sh
bun run all
ls -lt results/   # newest snapshot at top, diff against an earlier one
```

## Layout

```
src/
  shared.ts            # HOSTS, model default, env helpers, header constants
  step1-dns.ts         # DNS + HEAD edge fingerprint
  step2-headers.ts     # alternating header diff
  step3-loadtest.ts    # burst + interleaved load test
  step4-sdk-baseurl.ts # SDK default base URL probe
results/               # timestamped JSON snapshots from each run
```
