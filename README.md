# together-xyz-vs-ai

Reproducible audit of whether `api.together.xyz` and `api.together.ai` apply
**different rate limits to the same API key**, and whether customers using
the TS SDK (which defaults to `.xyz`) are being throttled more aggressively
than they would be on `.ai`.

---

## TL;DR for whoever is running this

1. Install `bun` (any 1.x): `curl -fsSL https://bun.sh/install | bash`
2. Clone, then in the repo:
   ```sh
   bun install
   cp .env.example .env
   # edit .env and set TOGETHER_API_KEY=<your key>
   ```
3. Run the four steps:
   ```sh
   bun run step1   # DNS + edge fingerprint        (no key needed)
   bun run step4   # SDK default base URL          (no key needed)
   bun run step2   # 4-request header diff         (key needed, ~$0)
   bun run step3   # load test                     (key needed, see cost note)
   ```
4. Each step prints a verdict to the terminal **and** writes a timestamped
   JSON snapshot to `results/`. Commit those JSON files (or paste the
   verdicts into the audit thread) so the result is reproducible.

**What we're trying to learn** — for each step, the question to answer:

| Step | Question |
| ---- | -------- |
| 1    | Are `.xyz` and `.ai` the same backend, or independent infrastructure? |
| 2    | Does the same API key see one shared rate-limit bucket across both hosts, or two separate buckets? |
| 3    | If they're separate buckets, are the *limits* different (e.g. `.xyz` throttled more aggressively)? |
| 4    | Does the official TS SDK default to `.xyz`? (i.e. how many customers does this affect) |

**What's already known from the initial run** (this checkout):
- Step 4 confirmed: `together-ai@0.21.1` defaults to `.xyz`, 14 hard-coded
  references to `api.together.xyz`, **0** to `api.together.ai`. So yes,
  most TS SDK customers are on `.xyz`.
- Step 1 confirmed: both hosts are Cloudflare-fronted but live in
  **separate Cloudflare zones** (different HSTS, different security
  headers), so Cloudflare-level rate-limit policies *could* differ even if
  the backend bucket is shared. Steps 2 and 3 are what tells us whether
  they actually do.

---

## Prerequisites

- `bun` 1.0+ (tested on 1.3.12). Install:
  `curl -fsSL https://bun.sh/install | bash`
- A Together API key with normal production tier limits (don't use a free
  tier key — the limits are too low to be representative).
- Internet access from wherever you're running the scripts (the load test
  in step 3 is the only one that costs anything; estimate below).

---

## Setup

```sh
bun install
cp .env.example .env
$EDITOR .env       # set TOGETHER_API_KEY=<your key>
```

`.env` is gitignored. Bun loads it automatically — no `dotenv` needed.

You can also pass env vars inline instead of using `.env`:

```sh
TOGETHER_API_KEY=sk-... bun run step2
```

---

## Step 1 — DNS + edge fingerprint

**What it does:** resolves both hostnames (A, AAAA, CNAME), then sends a
`HEAD /` to each and dumps the response headers. Tells us whether the two
hosts share infrastructure or are independently served.

**Run:**
```sh
bun run step1
```

**Cost:** none. No API key needed.

**What you should see:**
- A records in Cloudflare ranges (`104.18.*` / `172.64.*` / `2606:4700:*`)
- `server: cloudflare` on both
- An `AWSALBCORS=...` cookie on both (= AWS ALB behind Cloudflare)
- A "Verdict" block summarising whether the two hosts share A records and
  `server` headers
- A `results/step1-dns-<timestamp>.json` file with the full snapshot

**What to report:** if the A records or `server` headers diverge from the
above, flag it — the infrastructure may have changed since this README was
written.

---

## Step 2 — Single-request header diff (the cheap, decisive one)

**What it does:** sends 4 alternating chat-completion requests
(`xyz, ai, xyz, ai`) with the same key, model, and prompt, then prints a
table of rate-limit headers side-by-side.

**Run:**
```sh
# uses .env
bun run step2

# or inline
TOGETHER_API_KEY=sk-... bun run step2

# pin a specific model (must be one your key has access to)
TOGETHER_MODEL=meta-llama/Llama-3.3-70B-Instruct-Turbo bun run step2
```

**Cost:** 4 chat-completion requests with `max_tokens=1` against a cheap
model. Sub-cent.

**How to read the output table:**

The script prints a table where each row is one of the 4 calls. Look at the
`x-ratelimit-remaining-requests` and `x-ratelimit-remaining-tokens` columns:

- **Monotonically decreasing across all 4 rows** (e.g. 5999, 5998, 5997,
  5996) → the bucket is **shared** across hosts. Host doesn't matter for
  rate limiting. Customers on `.xyz` and `.ai` are treated identically.
- **Two independent series** (e.g. xyz: 5999, 5998; ai: 4999, 4998) → the
  buckets are **split per host**. The *limit ceilings* in
  `x-ratelimit-limit-requests` will tell you whether `.xyz` has a lower
  ceiling than `.ai` for the same key — that's the actual smoking gun.
- **Same `remaining` on both pairs but different `limit`** → also a smoking
  gun. Different limits per host.

**What to report:** copy the rate-limit table (or attach the JSON
snapshot in `results/`).

---

## Step 3 — Controlled load test

**What it does:** two rounds.

1. **Burst per host.** Fires `REQUESTS_PER_HOST` requests at each host with
   `CONCURRENCY` parallel workers. Records first 429, p50/p95/p99 latency,
   and how the `remaining` counters decay.
2. **Interleaved.** Alternates one request to `.xyz`, one to `.ai`. If 429s
   on one host correlate with 429s on the other, the bucket is shared.

**Run (start small!):**
```sh
# Conservative defaults: 10 concurrent, 50 req/host, 50 interleaved
bun run step3

# Bump it up if defaults don't trigger 429s
CONCURRENCY=25 REQUESTS_PER_HOST=200 INTERLEAVED_TOTAL=200 bun run step3

# Pin model
TOGETHER_MODEL=meta-llama/Llama-3.2-3B-Instruct-Turbo bun run step3
```

**Cost estimate (default config, default model):**
- 50 + 50 + 50 = 150 requests, all `max_tokens=1`, against a 3B model.
- At Llama-3.2-3B-Instruct-Turbo pricing this is well under $0.01.
- If you bump to 200/200/200 = 600 requests, still trivial.

**Critical safety notes:**
- **Do NOT use GLM 5.1** — it's already at capacity for everyone, so any
  429 is noise, not a host-policy signal. This is what kicked off the
  audit; we explicitly want to control for that.
- Use the **same key** for both hosts. Different keys would obviously have
  different buckets and tell us nothing.
- Start with the defaults. If you don't see 429s, double the concurrency
  and try again. Don't open with 100 concurrent workers — you may
  legitimately exhaust your quota and disrupt other workloads on that key.
- Run during a low-traffic window if possible, especially if the key is
  shared with production.

**How to read the output:**

Each round prints a summary like:

```
--- api.together.xyz ---
total=50 ok=47 429=3 err=0
latency p50=210ms p95=480ms p99=520ms max=540ms
first 429 at request #34 (t=2810ms), retry-after=10
```

Then the **interleaved** summary, plus a per-host breakdown of the
interleaved round.

What you're looking for:
- Different `first 429 at request #N` between `.xyz` and `.ai` (one host
  hits the limit much earlier) → policy difference.
- Different `retry-after` values → policy difference.
- In the interleaved round: if `.xyz` shows 429s but `.ai` doesn't (in the
  *same alternating sequence* with the same key), the buckets are split
  and `.xyz` has a tighter limit.

**What to report:** the per-round summaries from the terminal, plus the
JSON snapshots in `results/step3-burst-*.json` and
`results/step3-interleaved-*.json`.

---

## Step 4 — Confirm SDK default base URL

**What it does:** instantiates the official `together-ai` SDK with no
override and reads `client.baseURL`. Also greps the installed package for
all hard-coded base URL references.

**Run:**
```sh
bun run step4
```

**Cost:** none. No API key, no network calls (the SDK's constructor doesn't
make requests).

**What you should see:**
```
together-ai installed version: 0.21.1
Default baseURL (no override): https://api.together.xyz/v1
Env TOGETHER_BASE_URL override: set=https://api.together.ai/v1 -> resolved=https://api.together.ai/v1

References to api.together.xyz: 14
References to api.together.ai : 0

=== Verdict ===
Confirmed: the TS SDK defaults to api.together.xyz. ...
```

**What to report:** the SDK version, the default baseURL, and the
xyz-vs-ai reference counts. If the SDK has been updated to default to
`.ai`, the counts will flip — that's important to know.

---

## Reproducing / re-running later

Every step is deterministic given the same env vars. After any change on
Together's side (Cloudflare config, rate-limit policy update, SDK release):

```sh
bun install        # picks up newer together-ai if available
bun run all        # runs all 4 steps in order; each writes a new snapshot
ls -lt results/    # newest snapshot at top
```

Diff a new snapshot against an earlier one to spot what changed:
```sh
diff results/step1-dns-<old>.json results/step1-dns-<new>.json
```

---

## Tunable env vars

| Var | Used by | Default | Notes |
| --- | ------- | ------- | ----- |
| `TOGETHER_API_KEY`   | step2, step3 | (required) | Same key for both hosts. |
| `TOGETHER_MODEL`     | step2, step3 | `meta-llama/Llama-3.2-3B-Instruct-Turbo` | Cheap, plentiful. **Don't use GLM 5.1.** |
| `CONCURRENCY`        | step3 | `10` | Parallel workers per round. |
| `REQUESTS_PER_HOST`  | step3 | `50` | Requests fired in each per-host burst. |
| `INTERLEAVED_TOTAL`  | step3 | `50` | Requests in the alternating round. |

---

## Layout

```
src/
  shared.ts            # HOSTS, model default, env helpers, header constants
  step1-dns.ts         # DNS + HEAD edge fingerprint
  step2-headers.ts     # alternating xyz/ai header diff
  step3-loadtest.ts    # burst per host + interleaved load test
  step4-sdk-baseurl.ts # SDK default base URL probe
results/               # timestamped JSON snapshots from each run
.env.example           # copy to .env and fill in TOGETHER_API_KEY
```

---

## Handing off the result

After running steps 1–4, the audit thread should get:
1. A one-line verdict per step (the "Verdict" blocks the scripts print).
2. The four JSON snapshots from `results/` (or a commit pointing at them).
3. Specifically for step 2: the rate-limit header table — that's the most
   decisive single piece of evidence.
4. For step 3: whether 429s appeared, on which host first, and at what
   request count.

If all four steps say "shared bucket, same limits, same edge behaviour" →
the boss's hypothesis is wrong and the GLM-5.1 throttling is purely
capacity-driven. If step 2 or 3 shows divergent limits or buckets → that's
the finding to take to whoever owns the gateway config.
