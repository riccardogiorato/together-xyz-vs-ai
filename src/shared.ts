export const HOSTS = ["api.together.xyz", "api.together.ai"] as const;
export type Host = (typeof HOSTS)[number];

export const DEFAULT_MODEL =
  process.env.TOGETHER_MODEL ?? "meta-llama/Llama-3.2-3B-Instruct-Turbo";

export function requireApiKey(): string {
  const key = process.env.TOGETHER_API_KEY;
  if (!key) {
    console.error(
      "TOGETHER_API_KEY env var is required. Export it or put it in .env",
    );
    process.exit(1);
  }
  return key;
}

// Headers worth comparing across the two hosts. Together's API exposes
// rate-limit info via X-RateLimit-* headers; the cf-* / x-served-by headers
// reveal which edge served the request.
export const INTERESTING_HEADERS = [
  "server",
  "via",
  "x-served-by",
  "x-cache",
  "x-amz-cf-id",
  "x-amz-cf-pop",
  "cf-ray",
  "cf-cache-status",
  "x-vercel-id",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
  "x-ratelimit-limit-requests",
  "x-ratelimit-remaining-requests",
  "x-ratelimit-reset-requests",
  "x-ratelimit-limit-tokens",
  "x-ratelimit-remaining-tokens",
  "x-ratelimit-reset-tokens",
  "retry-after",
] as const;

export function snapshotHeaders(res: Response): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const h of INTERESTING_HEADERS) out[h] = res.headers.get(h);
  return out;
}

export function allHeaders(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

export function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}
