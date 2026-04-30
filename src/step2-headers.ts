// Step 2 — Side-by-side header diff with the same API key + request
//
// Hits the chat-completions endpoint on each host with a tiny request and
// captures rate-limit headers. If the limits are *shared* across hosts, the
// `remaining` counter on the second call should be one less than the first.
// If they are *split per Host header*, both calls will report nearly the same
// `remaining` value.
//
// Run: TOGETHER_API_KEY=... bun run src/step2-headers.ts

import { writeFileSync, mkdirSync } from "node:fs";
import {
  HOSTS,
  DEFAULT_MODEL,
  requireApiKey,
  allHeaders,
  INTERESTING_HEADERS,
  timestamp,
} from "./shared.ts";

type Probe = {
  host: string;
  status: number;
  latencyMs: number;
  headers: Record<string, string>;
};

async function probe(host: string, apiKey: string): Promise<Probe> {
  const start = performance.now();
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
  // Drain so the connection can close cleanly.
  await res.text().catch(() => "");
  return {
    host,
    status: res.status,
    latencyMs: Math.round(performance.now() - start),
    headers: allHeaders(res),
  };
}

async function main() {
  const apiKey = requireApiKey();
  const probes: Probe[] = [];

  // Alternate xyz, ai, xyz, ai so a shared bucket would show a clear
  // monotonic decrease in `remaining`.
  const sequence = [HOSTS[0], HOSTS[1], HOSTS[0], HOSTS[1]];
  for (const host of sequence) {
    process.stdout.write(`Probing ${host}... `);
    const p = await probe(host, apiKey);
    probes.push(p);
    console.log(`${p.status} (${p.latencyMs} ms)`);
  }

  console.log("\n=== Rate-limit header diff ===");
  console.table(
    probes.map((p, i) => ({
      "#": i,
      host: p.host,
      status: p.status,
      latencyMs: p.latencyMs,
      ...Object.fromEntries(
        INTERESTING_HEADERS.filter((h) => h.startsWith("x-ratelimit") || h === "retry-after").map(
          (h) => [h, p.headers[h] ?? ""],
        ),
      ),
    })),
  );

  console.log("\n=== Edge fingerprint diff ===");
  console.table(
    probes.map((p, i) => ({
      "#": i,
      host: p.host,
      server: p.headers["server"] ?? "",
      "cf-ray": p.headers["cf-ray"] ?? "",
      "x-served-by": p.headers["x-served-by"] ?? "",
      via: p.headers["via"] ?? "",
    })),
  );

  mkdirSync("results", { recursive: true });
  const outPath = `results/step2-headers-${timestamp()}.json`;
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        runAt: new Date().toISOString(),
        model: DEFAULT_MODEL,
        sequence,
        probes,
      },
      null,
      2,
    ),
  );
  console.log(`\nSaved: ${outPath}`);
}

await main();
