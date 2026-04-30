// Step 1 — DNS + edge fingerprinting
//
// Resolve api.together.xyz and api.together.ai and inspect what edge serves
// each one. If the two hostnames front the same backend (same A/AAAA records,
// same cf-ray/x-served-by signature), then any rate-limit difference is
// almost certainly policy-driven (Host-header based) rather than
// infrastructure-based.
//
// Run: bun run src/step1-dns.ts

import { promises as dns } from "node:dns";
import { writeFileSync, mkdirSync } from "node:fs";
import { HOSTS, allHeaders, timestamp } from "./shared.ts";

type HostReport = {
  host: string;
  dns: {
    a: string[];
    aaaa: string[];
    cname: string[];
  };
  head: {
    status: number | null;
    headers: Record<string, string>;
    error?: string;
  };
};

async function resolveDns(host: string): Promise<HostReport["dns"]> {
  const [a, aaaa, cname] = await Promise.all([
    dns.resolve4(host).catch(() => []),
    dns.resolve6(host).catch(() => []),
    dns.resolveCname(host).catch(() => []),
  ]);
  return { a, aaaa, cname };
}

async function probeHead(host: string): Promise<HostReport["head"]> {
  try {
    const res = await fetch(`https://${host}/`, { method: "HEAD" });
    return { status: res.status, headers: allHeaders(res) };
  } catch (err) {
    return { status: null, headers: {}, error: String(err) };
  }
}

async function main() {
  const reports: HostReport[] = [];
  for (const host of HOSTS) {
    console.log(`\n=== ${host} ===`);
    const [d, h] = await Promise.all([resolveDns(host), probeHead(host)]);
    const report: HostReport = { host, dns: d, head: h };
    reports.push(report);
    console.log("DNS A   :", d.a);
    console.log("DNS AAAA:", d.aaaa);
    console.log("DNS CNAME:", d.cname);
    console.log("HEAD status:", h.status);
    if (h.error) console.log("HEAD error :", h.error);
    console.log("HEAD headers:");
    for (const [k, v] of Object.entries(h.headers).sort()) {
      console.log(`  ${k}: ${v}`);
    }
  }

  // Quick verdict
  const xyz = reports[0]!;
  const ai = reports[1]!;
  const sameA =
    xyz.dns.a.length > 0 &&
    JSON.stringify([...xyz.dns.a].sort()) ===
      JSON.stringify([...ai.dns.a].sort());
  const sameCname =
    xyz.dns.cname.length > 0 &&
    JSON.stringify(xyz.dns.cname) === JSON.stringify(ai.dns.cname);
  console.log("\n=== Verdict ===");
  console.log("Same A records :", sameA);
  console.log("Same CNAME     :", sameCname);
  console.log(
    "Same `server` header:",
    xyz.head.headers["server"] === ai.head.headers["server"],
  );

  mkdirSync("results", { recursive: true });
  const outPath = `results/step1-dns-${timestamp()}.json`;
  writeFileSync(
    outPath,
    JSON.stringify({ runAt: new Date().toISOString(), reports }, null, 2),
  );
  console.log(`\nSaved: ${outPath}`);
}

await main();
