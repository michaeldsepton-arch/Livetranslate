// Uniform API error type so the router can decide: retry, wait, switch model, or give up.

export class ApiError extends Error {
  /**
   * kind: auth | rate | quota | server | network | model | bad_request | too_large | aborted | unknown
   */
  constructor(message, { status = 0, kind = "unknown", retryAfterMs = 0, provider = "" } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.kind = kind;
    this.retryAfterMs = retryAfterMs;
    this.provider = provider;
  }

  static from(e, provider = "") {
    if (e instanceof ApiError) return e;
    if (e && e.name === "AbortError") return new ApiError("Cancelled", { kind: "aborted", provider });
    return new ApiError(e && e.message ? e.message : String(e), { kind: "unknown", provider });
  }
}

/** "2m3.5s", "520ms", "34s", "1h2m" -> milliseconds (0 when unparseable). */
export function parseDurationMs(s) {
  if (s == null) return 0;
  if (typeof s === "number") return Math.round(s * 1000);
  const str = String(s).trim();
  if (/^\d+(\.\d+)?$/.test(str)) return Math.round(parseFloat(str) * 1000);
  const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  let ms = 0, m, any = false;
  while ((m = re.exec(str))) {
    any = true;
    const v = parseFloat(m[1]);
    ms += m[2] === "ms" ? v : m[2] === "s" ? v * 1000 : m[2] === "m" ? v * 60000 : v * 3600000;
  }
  return any ? Math.round(ms) : 0;
}

function errorMessage(bodyText) {
  try {
    const j = JSON.parse(bodyText);
    const e = j.error || j;
    return (typeof e === "string" ? e : e.message) || bodyText;
  } catch {
    return (bodyText || "").slice(0, 300);
  }
}

/** Turn an HTTP failure into an ApiError. `headers` is a Headers-like (has .get) or null. */
export function classifyHttp(provider, status, bodyText, headers) {
  const message = errorMessage(bodyText);
  let retryAfterMs = parseDurationMs(headers && headers.get && headers.get("retry-after"));
  if (!retryAfterMs) {
    const m = /try again in ([0-9hms.]+)/i.exec(message) || /"retryDelay"\s*:\s*"([0-9.]+s)"/.exec(bodyText || "");
    if (m) retryAfterMs = parseDurationMs(m[1]);
  }
  const opts = { status, retryAfterMs, provider };
  // OpenAI: out of credit is a billing problem, not a speed limit; a model your project can't use is just skipped
  if (/insufficient_quota|exceeded your current quota/i.test(bodyText || "")) return new ApiError(`${label(provider)} credit has run out. Add credit in your ${label(provider)} billing page.`, { ...opts, kind: "quota", retryAfterMs: 30 * 60000 });
  if (status === 403 && /access to model|model_not_found/i.test(message + (bodyText || ""))) return new ApiError(`Model unavailable: ${message}`, { ...opts, kind: "model" });
  if (status === 401) return new ApiError(`${label(provider)} rejected the API key. ${message}`, { ...opts, kind: "auth" });
  if (status === 403) return new ApiError(`${label(provider)} refused access (key or region). ${message}`, { ...opts, kind: "auth" });
  if (status === 404 || /model_not_found|decommissioned|no longer supported|does not exist/i.test(message))
    return new ApiError(`Model unavailable: ${message}`, { ...opts, kind: "model" });
  if (status === 413) return new ApiError("Audio chunk too large", { ...opts, kind: "too_large" });
  if (status === 429 || /RESOURCE_EXHAUSTED/.test(bodyText || "")) {
    const daily = /per day|PerDay|\bdaily\b|\b(TPD|RPD|ASD)\b/i.test(message + (bodyText || ""));
    const long = retryAfterMs > 120000;
    return new ApiError(`${label(provider)} limit reached. ${message}`, { ...opts, kind: daily || long ? "quota" : "rate", retryAfterMs: retryAfterMs || (daily ? 30 * 60000 : 4000) });
  }
  if (status === 408 || status >= 500) return new ApiError(`${label(provider)} is having trouble (${status}).`, { ...opts, kind: "server" });
  if (status === 400) return new ApiError(`Bad request: ${message}`, { ...opts, kind: "bad_request" });
  return new ApiError(`${label(provider)} error ${status}: ${message}`, { ...opts, kind: "unknown" });
}

export function label(provider) {
  return provider === "groq" ? "Groq" : provider === "gemini" ? "Gemini" : provider === "openai" ? "OpenAI" : provider || "Service";
}
