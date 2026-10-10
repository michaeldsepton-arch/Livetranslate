// OpenAI (pay-as-you-go): speech-to-text (gpt-4o-transcribe / whisper-1) and chat models for translation.
// There is no free tier, so nothing here is rationed; it is used when you choose it, or when the free services run out.
import { httpRequest } from "../net.js";
import { classifyHttp, ApiError } from "../engine/errors.js";

const BASE = "https://api.openai.com/v1";

/** The gpt-5 / o-series are reasoning models: they reject a custom temperature and think before answering unless told not to. */
export const isReasoningModel = (model) => /^(gpt-5|o\d)/.test(model);

export class OpenAIProvider {
  constructor(apiKey, http = httpRequest) {
    this.name = "openai";
    this.key = (apiKey || "").trim();
    this.http = http;
  }

  get headers() {
    return { Authorization: `Bearer ${this.key}` };
  }

  async _json(url, opts) {
    const res = await this.http(url, opts);
    if (!res.ok) throw classifyHttp("openai", res.status, res.text, res.headers);
    try {
      return JSON.parse(res.text);
    } catch {
      throw new ApiError("OpenAI returned an unreadable response", { kind: "server", provider: "openai" });
    }
  }

  async listModels(signal) {
    const j = await this._json(`${BASE}/models`, { headers: this.headers, timeoutMs: 15000, signal });
    return (j.data || []).map((m) => m.id);
  }

  /** @returns {{text:string, language:string, segments:object[], duration:number}} (gpt-4o models give no language label or segments) */
  async transcribe(wav, { model, language, prompt, signal } = {}) {
    const fd = new FormData();
    fd.append("file", wav, "chunk.wav");
    fd.append("model", model);
    fd.append("response_format", /^whisper/.test(model) ? "verbose_json" : "json");
    fd.append("temperature", "0");
    if (language) fd.append("language", language);
    if (prompt) fd.append("prompt", prompt);
    const j = await this._json(`${BASE}/audio/transcriptions`, { method: "POST", headers: this.headers, body: fd, timeoutMs: 60000, signal });
    this.lastUsage = { audio: j.duration || 0 };
    return { text: j.text || "", language: j.language || "", segments: j.segments || [], duration: j.duration || 0 };
  }

  /** Chat completion -> assistant text. */
  async chat({ model, system, user, maxTokens = 900, signal }) {
    const reasoning = isReasoningModel(model);
    const body = (extra) =>
      JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        max_completion_tokens: reasoning ? maxTokens + 1500 : maxTokens, // reasoning tokens count against the cap
        ...extra,
      });
    const send = (extra) =>
      this._json(`${BASE}/chat/completions`, { method: "POST", headers: { ...this.headers, "Content-Type": "application/json" }, body: body(extra), timeoutMs: 45000, signal });
    // newer models reject fields older ones need (and vice versa): try the best settings, then plainer ones
    const attempts = reasoning ? [{ reasoning_effort: "minimal" }, { reasoning_effort: "low" }, {}] : [{ temperature: 0.2 }, {}];
    let j;
    for (let i = 0; ; i++) {
      try {
        j = await send(attempts[i]);
        break;
      } catch (e) {
        if (e instanceof ApiError && e.kind === "bad_request" && i < attempts.length - 1) continue;
        throw e;
      }
    }
    this.lastUsage = { tokens: j.usage?.total_tokens || 0 };
    return j.choices?.[0]?.message?.content || "";
  }
}
