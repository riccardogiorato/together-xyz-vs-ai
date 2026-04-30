// Step 4 — Confirm what base URL the official Together TS SDK ships with.
//
// The boss's hypothesis is "most customers are on .xyz because that's what
// the SDKs use." This script verifies that empirically by:
//   1. Instantiating the `together-ai` SDK with no baseURL override, and
//      reading the `baseURL` field directly off the client.
//   2. Greppping the installed SDK's source/dist for any hard-coded base URL
//      strings, so we know exactly what fallback string the package ships.
//   3. Checking the package version in node_modules so a stale install
//      doesn't mislead us.
//
// Run: bun run src/step4-sdk-baseurl.ts

import { writeFileSync, readFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import Together from "together-ai";
import { timestamp } from "./shared.ts";

type Finding = {
  installedVersion: string;
  clientDefaultBaseURL: string;
  envOverrideRespected: { setTo: string; resolvedTo: string };
  hardcodedBaseURLs: Array<{ file: string; line: number; text: string }>;
};

function readPkgVersion(): string {
  const pkg = JSON.parse(
    readFileSync("node_modules/together-ai/package.json", "utf8"),
  );
  return pkg.version;
}

function probeClientBaseURL(): string {
  // No baseURL override, no env var — what does the SDK pick?
  const prev = process.env.TOGETHER_BASE_URL;
  delete process.env.TOGETHER_BASE_URL;
  // The SDK requires an apiKey, but won't actually make a request just to
  // construct the client. Use a placeholder.
  const client = new Together({ apiKey: "sk-placeholder-not-used" });
  const url = (client as unknown as { baseURL: string }).baseURL;
  if (prev !== undefined) process.env.TOGETHER_BASE_URL = prev;
  return url;
}

function probeEnvOverride(): { setTo: string; resolvedTo: string } {
  const setTo = "https://api.together.ai/v1";
  process.env.TOGETHER_BASE_URL = setTo;
  const client = new Together({ apiKey: "sk-placeholder-not-used" });
  const resolvedTo = (client as unknown as { baseURL: string }).baseURL;
  delete process.env.TOGETHER_BASE_URL;
  return { setTo, resolvedTo };
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (/\.(m?js|m?ts|d\.ts|d\.mts)$/.test(entry.name)) out.push(p);
  }
  return out;
}

function findHardcodedBaseURLs(): Finding["hardcodedBaseURLs"] {
  const files = walk("node_modules/together-ai");
  const matches: Finding["hardcodedBaseURLs"] = [];
  const re = /api\.together\.(xyz|ai)/;
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((text, i) => {
      if (re.test(text)) {
        matches.push({ file: file.replace(/^node_modules\//, ""), line: i + 1, text: text.trim() });
      }
    });
  }
  return matches;
}

function main() {
  const finding: Finding = {
    installedVersion: readPkgVersion(),
    clientDefaultBaseURL: probeClientBaseURL(),
    envOverrideRespected: probeEnvOverride(),
    hardcodedBaseURLs: findHardcodedBaseURLs(),
  };

  console.log(`together-ai installed version: ${finding.installedVersion}`);
  console.log(`Default baseURL (no override): ${finding.clientDefaultBaseURL}`);
  console.log(
    `Env TOGETHER_BASE_URL override: set=${finding.envOverrideRespected.setTo} -> resolved=${finding.envOverrideRespected.resolvedTo}`,
  );

  console.log(`\nHard-coded base URL references (${finding.hardcodedBaseURLs.length}):`);
  for (const m of finding.hardcodedBaseURLs) {
    console.log(`  ${m.file}:${m.line}  ${m.text}`);
  }

  const xyzCount = finding.hardcodedBaseURLs.filter((m) => m.text.includes("api.together.xyz")).length;
  const aiCount = finding.hardcodedBaseURLs.filter((m) => m.text.includes("api.together.ai")).length;
  console.log(`\nReferences to api.together.xyz: ${xyzCount}`);
  console.log(`References to api.together.ai : ${aiCount}`);

  console.log("\n=== Verdict ===");
  if (finding.clientDefaultBaseURL.includes("together.xyz")) {
    console.log(
      "Confirmed: the TS SDK defaults to api.together.xyz. Customers using",
    );
    console.log(
      "the SDK without overriding baseURL or TOGETHER_BASE_URL hit .xyz.",
    );
  } else if (finding.clientDefaultBaseURL.includes("together.ai")) {
    console.log("The TS SDK defaults to api.together.ai.");
  } else {
    console.log("Unexpected default baseURL — investigate.");
  }

  mkdirSync("results", { recursive: true });
  const outPath = `results/step4-sdk-baseurl-${timestamp()}.json`;
  writeFileSync(outPath, JSON.stringify(finding, null, 2));
  console.log(`\nSaved: ${outPath}`);
}

main();
