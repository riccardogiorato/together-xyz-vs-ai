// Step 3 — Controlled load test against each host
//
// Fires REQUESTS_PER_HOST requests at each host with CONCURRENCY workers and
// records the response status, rate-limit headers, and latency. Then runs an
// *interleaved* round to test for a shared rate-limit bucket: alternate one
// request to xyz, one to ai. If buckets are shared, 429s on one host should
// cause 429s on the other; if split, each host has its own quota.
//
// Defaults are conservative — bump CONCURRENCY/REQUESTS_PER_HOST to push
// harder. Use a cheap model (NOT GLM 5.1, which is already at capacity).
//
// Run: TOGETHER_API_KEY=... [CONCURRENCY=20 REQUESTS_PER_HOST=100] \
//      bun run src/step3-loadtest.ts

import { writeFileSync, mkdirSync } from "node:fs";
import {
  HOSTS,
  type Host,
  DEFAULT_MODEL,
  requireApiKey,
  timestamp,
} from "./shared.ts";

type Result = {
  host: Host;
  i: number;
  status: number;
  latencyMs: number;
  remainingRequests: string | null;
  remainingTokens: string | null;
  retryAfter: string | null;
  startedAt: number;
  endedAt: number;
  error?: string;
};

const CONCURRENCY = Number(process.env.CONCURRENCY ?? 10);
const REQUESTS_PER_HOST = Number(process.env.REQUESTS_PER_HOST ?? 50);
const INTERLEAVED_TOTAL = Number(process.env.INTERLEAVED_TOTAL ?? 50);

async function fire(
  host: Host,
  i: number,
  apiKey: string,
  t0: number,
): Promise<Result> {
  const startedAt = performance.now() - t0;
  try {
    const res = await fetch(`https://${host}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
      }),
    });
    await res.text().catch(() => "");
    const endedAt = performance.now() - t0;
    return {
      host,
      i,
      status: res.status,
      latencyMs: Math.round(endedAt - startedAt),
      remainingRequests:
        res.headers.get("x-ratelimit-remaining-requests") ??
        res.headers.get("x-ratelimit-remaining"),
      remainingTokens: res.headers.get("x-ratelimit-remaining-tokens"),
      retryAfter: res.headers.get("retry-after"),
      startedAt,
      endedAt,
    };
  } catch (err) {
    const endedAt = performance.now() - t0;
    return {
      host,
      i,
      status: 0,
      latencyMs: Math.round(endedAt - startedAt),
      remainingRequests: null,
      remainingTokens: null,
      retryAfter: null,
      startedAt,
      endedAt,
      error: String(err),
    };
  }
}

async function pool(tasks: Array<() => Promise<Result>>, concurrency: number) {
  const results: Result[] = [];
  let cursor = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (cursor < tasks.length) {
      const idx = cursor++;
      const task = tasks[idx]!;
      results.push(await task());
    }
  });
  await Promise.all(workers);
  return results.sort((a, b) => a.startedAt - b.startedAt);
}

function summarize(label: string, results: Result[]) {
  const total = results.length;
  const ok = results.filter((r) => r.status >= 200 && r.status < 300).length;
  const rateLimited = results.filter((r) => r.status === 429).length;
  const errors = results.filter(
    (r) => r.status === 0 || (r.status >= 500 && r.status < 600),
  ).length;
  const firstRl = results.find((r) => r.status === 429);
  const lats = results
    .filter((r) => r.status >= 200 && r.status < 400)
    .map((r) => r.latencyMs)
    .sort((a, b) => a - b);
  const p = (q: number) =>
    lats.length ? lats[Math.floor((lats.length - 1) * q)] : null;

  console.log(`\n--- ${label} ---`);
  console.log(`total=${total} ok=${ok} 429=${rateLimited} err=${errors}`);
  console.log(
    `latency p50=${p(0.5)}ms p95=${p(0.95)}ms p99=${p(0.99)}ms max=${p(1)}ms`,
  );
  if (firstRl) {
    console.log(
      `first 429 at request #${firstRl.i} (t=${Math.round(firstRl.startedAt)}ms), retry-after=${firstRl.retryAfter}`,
    );
  }
}

async function main() {
  const apiKey = requireApiKey();
  const t0 = performance.now();

  console.log(
    `Config: model=${DEFAULT_MODEL} concurrency=${CONCURRENCY} requestsPerHost=${REQUESTS_PER_HOST}`,
  );

  // Round 1: hammer each host independently
  for (const host of HOSTS) {
    console.log(`\n=== Round 1: burst against ${host} ===`);
    const tasks = Array.from({ length: REQUESTS_PER_HOST }, (_, i) => () =>
      fire(host, i, apiKey, t0),
    );
    const results = await pool(tasks, CONCURRENCY);
    summarize(host, results);
    mkdirSync("results", { recursive: true });
    writeFileSync(
      `results/step3-burst-${host}-${timestamp()}.json`,
      JSON.stringify({ host, config: { CONCURRENCY, REQUESTS_PER_HOST }, results }, null, 2),
    );
  }

  // Round 2: interleaved — alternate hosts
  console.log(
    `\n=== Round 2: interleaved (alternating) total=${INTERLEAVED_TOTAL} ===`,
  );
  const interleavedTasks = Array.from(
    { length: INTERLEAVED_TOTAL },
    (_, i) => () => fire(HOSTS[i % HOSTS.length]!, i, apiKey, t0),
  );
  const interleaved = await pool(interleavedTasks, CONCURRENCY);
  summarize("interleaved", interleaved);
  // Per-host breakdown
  for (const host of HOSTS) {
    summarize(`interleaved/${host}`, interleaved.filter((r) => r.host === host));
  }
  writeFileSync(
    `results/step3-interleaved-${timestamp()}.json`,
    JSON.stringify(
      { config: { CONCURRENCY, INTERLEAVED_TOTAL }, results: interleaved },
      null,
      2,
    ),
  );

  console.log(`\nDone in ${Math.round((performance.now() - t0) / 1000)}s.`);
}

await main();
