// Quick cross-model probe: for each model, fire N alternating requests
// against xyz and ai. Tells us whether the .xyz vs .ai asymmetry seen on
// GLM-5.1 also shows up on other (potentially capacity-stressed) models.

import { writeFileSync, mkdirSync } from "node:fs";
import { HOSTS, requireApiKey, timestamp } from "./shared.ts";

const MODELS = [
  "zai-org/GLM-5.1",
  "MiniMaxAI/MiniMax-M2.7",
  "moonshotai/Kimi-K2.6",
];
const N_PER_HOST = Number(process.env.N_PER_HOST ?? 10);
const CONCURRENCY = Number(process.env.PROBE_CONCURRENCY ?? 4);

type R = {
  model: string;
  host: string;
  i: number;
  status: number;
  latencyMs: number;
  retryAfter: string | null;
  remaining: string | null;
  error?: string;
};

async function fire(model: string, host: string, i: number, apiKey: string): Promise<R> {
  const t0 = performance.now();
  try {
    const res = await fetch(`https://${host}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
      }),
    });
    await res.text().catch(() => "");
    return {
      model,
      host,
      i,
      status: res.status,
      latencyMs: Math.round(performance.now() - t0),
      retryAfter: res.headers.get("retry-after"),
      remaining:
        res.headers.get("x-ratelimit-remaining-requests") ??
        res.headers.get("x-ratelimit-remaining"),
    };
  } catch (err) {
    return {
      model,
      host,
      i,
      status: 0,
      latencyMs: Math.round(performance.now() - t0),
      retryAfter: null,
      remaining: null,
      error: String(err),
    };
  }
}

async function pool<T>(tasks: Array<() => Promise<T>>, concurrency: number) {
  const out: T[] = [];
  let cursor = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (cursor < tasks.length) {
        const idx = cursor++;
        out.push(await tasks[idx]!());
      }
    }),
  );
  return out;
}

function summarize(label: string, rs: R[]) {
  const total = rs.length;
  const ok2xx = rs.filter((r) => r.status >= 200 && r.status < 300).length;
  const r400 = rs.filter((r) => r.status === 400).length;
  const r404 = rs.filter((r) => r.status === 404).length;
  const r429 = rs.filter((r) => r.status === 429).length;
  const r5xx = rs.filter((r) => r.status >= 500 && r.status < 600).length;
  const err = rs.filter((r) => !r.status).length;
  const lats = rs.map((r) => r.latencyMs).sort((a, b) => a - b);
  const p = (q: number) =>
    lats.length ? lats[Math.min(lats.length - 1, Math.floor(lats.length * q))] : null;
  console.log(
    `${label.padEnd(50)} n=${total} 2xx=${ok2xx} 400=${r400} 404=${r404} 429=${r429} 5xx=${r5xx} err=${err}  p50=${p(0.5)}ms p95=${p(0.95)}ms max=${p(1)}ms`,
  );
}

async function main() {
  const apiKey = requireApiKey();
  console.log(`models=${MODELS.length} N_PER_HOST=${N_PER_HOST} concurrency=${CONCURRENCY}\n`);
  const all: R[] = [];

  for (const model of MODELS) {
    console.log(`\n>>> ${model}`);
    // Build interleaved task list xyz/ai/xyz/ai... so order is fair within model
    const tasks: Array<() => Promise<R>> = [];
    for (let i = 0; i < N_PER_HOST * 2; i++) {
      const host = HOSTS[i % HOSTS.length]!;
      tasks.push(() => fire(model, host, i, apiKey));
    }
    const results = await pool(tasks, CONCURRENCY);
    all.push(...results);
    summarize(`  ${model} / xyz`, results.filter((r) => r.host === "api.together.xyz"));
    summarize(`  ${model} / ai `, results.filter((r) => r.host === "api.together.ai"));

    // Sample first error/non-2xx for debugging unknown-model cases
    const sample = results.find((r) => !(r.status >= 200 && r.status < 300));
    if (sample) {
      console.log(`  sample non-2xx: status=${sample.status} retry-after=${sample.retryAfter} remaining=${sample.remaining} error=${sample.error ?? ""}`);
    }
  }

  mkdirSync("results", { recursive: true });
  const out = `results/probe-models-${timestamp()}.json`;
  writeFileSync(out, JSON.stringify({ runAt: new Date().toISOString(), models: MODELS, N_PER_HOST, CONCURRENCY, results: all }, null, 2));
  console.log(`\nSaved: ${out}`);
}

await main();
