// Groq (free tier): Whisper large-v3 for speech-to-text, and an LLM for translation.
// OpenAI-compatible REST API.  https://console.groq.com/docs
import { httpRequest } from "../net.js";
import { classifyHttp, ApiError } from "../engine/errors.js";

const BASE = "https://api.groq.com/openai/v1";

/** Extra request fields some models need so they answer fast and without "thinking" text. */
export function modelQuirks(model) {
  if (/^openai\/gpt-oss/.test(model)) return { reasoning_effort: "low" };
  if (/qwen3/.test(model)) return { reasoning_effort: "none" };
  return {};
}

export class GroqProvider {
  constructor(apiKey, http = httpRequest) {
    this.name = "groq";
    this.key = (apiKey || "").trim();
    this.http = http;
  }

  get headers() {
    return { Authorization: `Bearer ${this.key}` };
  }

  async _json(url, opts) {
    const res = await this.http(url, opts);
    if (!res.ok) throw classifyHttp("groq", res.status, res.text, res.headers);
    this._captureHeaders(res.headers);
    try {
      return JSON.parse(res.text);
    } catch {
      throw new ApiError("Groq returned an unreadable response", { kind: "server", provider: "groq" });
    }
  }

  /** Groq reports the real daily request allowance in response headers (when the page is allowed to read them). */
  _captureHeaders(h) {
    const get = (k) => (h && h.get ? h.get(k) : null);
    const limit = Number(get("x-ratelimit-limit-requests"));
    const left = get("x-ratelimit-remaining-requests");
    this.lastReported = limit > 0 && left != null ? { limitRequests: limit, remainingRequests: Number(left) } : null;
  }

  async listModels(signal) {
    const j = await this._json(`${BASE}/models`, { headers: this.headers, timeoutMs: 15000, signal });
    return (j.data || []).map((m) => m.id);
  }

  /** @returns {{text:string, language:string, segments:object[], duration:number}} */
  async transcribe(wav, { model, language, prompt, signal } = {}) {
    const fd = new FormData();
    fd.append("file", wav, "chunk.wav");
    fd.append("model", model);
    fd.append("response_format", "verbose_json");
    fd.append("temperature", "0");
    if (language) fd.append("language", language);
    if (prompt) fd.append("prompt", prompt);
    const j = await this._json(`${BASE}/audio/transcriptions`, { method: "POST", headers: this.headers, body: fd, timeoutMs: 60000, signal });
    this.lastUsage = { audio: j.duration || 0 };
    return { text: j.text || "", language: j.language || "", segments: j.segments || [], duration: j.duration || 0 };
  }

  /** Chat completion -> assistant text. */
  async chat({ model, system, user, maxTokens = 900, signal }) {
    const base = {
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.2,
      max_completion_tokens: maxTokens,
      stream: false,
    };
    const send = (extra) =>
      this._json(`${BASE}/chat/completions`, {
        method: "POST",
        headers: { ...this.headers, "Content-Type": "application/json" },
        body: JSON.stringify({ ...base, ...extra }),
        timeoutMs: 45000,
        signal,
      });
    let j;
    const quirks = modelQuirks(model);
    try {
      j = await send(quirks);
    } catch (e) {
      // an unsupported extra field must never break translation: retry once without it
      if (e instanceof ApiError && e.kind === "bad_request" && Object.keys(quirks).length) j = await send({});
      else throw e;
    }
    this.lastUsage = { tokens: j.usage?.total_tokens || 0 };
    return j.choices?.[0]?.message?.content || "";
  }
}
