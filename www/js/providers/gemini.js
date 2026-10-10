// Google Gemini (free tier): audio transcription + translation through generateContent.
// Used as a backup when the Groq allowance runs out (or as the main engine if preferred).
import { httpRequest } from "../net.js";
import { classifyHttp, ApiError } from "../engine/errors.js";
import { blobToBase64 } from "../platform.js";

const BASE = "https://generativelanguage.googleapis.com/v1beta";

const STT_INSTRUCTION = (hints, tail) =>
  `Transcribe this audio exactly as spoken, in the language spoken (Arabic in Arabic script, English in English). Do not translate, summarise or add commentary. ` +
  `If there is no clear speech, return empty text. The speaker is giving an Islamic lecture, so expect Qur'anic verses, hadith, Islamic terms and names. ` +
  (hints ? `Vocabulary hints: ${hints}\n` : "") +
  (tail ? `Text spoken just before this clip (for continuity — do not repeat it): ${tail}\n` : "") +
  `Respond as JSON: {"language": "<ISO 639-1 code>", "text": "<verbatim transcript>"}`;

export class GeminiProvider {
  constructor(apiKey, http = httpRequest) {
    this.name = "gemini";
    this.key = (apiKey || "").trim();
    this.http = http;
  }

  get headers() {
    return { "x-goog-api-key": this.key, "Content-Type": "application/json" };
  }

  async _json(url, opts) {
    const res = await this.http(url, opts);
    if (!res.ok) throw classifyHttp("gemini", res.status, res.text, res.headers);
    try {
      return JSON.parse(res.text);
    } catch {
      throw new ApiError("Gemini returned an unreadable response", { kind: "server", provider: "gemini" });
    }
  }

  /** Model ids that support generateContent, e.g. "gemini-2.5-flash". */
  async listModels(signal) {
    const j = await this._json(`${BASE}/models?pageSize=200`, { headers: this.headers, timeoutMs: 15000, signal });
    return (j.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
      .map((m) => String(m.name).replace(/^models\//, ""));
  }

  async _generate(model, body, signal) {
    const url = `${BASE}/models/${encodeURIComponent(model)}:generateContent`;
    const send = (b) => this._json(url, { method: "POST", headers: this.headers, body: JSON.stringify(b), timeoutMs: 60000, signal });
    let j;
    try {
      j = await send(body);
    } catch (e) {
      // older models reject thinkingConfig; retry once without it
      if (e instanceof ApiError && e.kind === "bad_request" && body.generationConfig?.thinkingConfig) {
        const g = { ...body.generationConfig };
        delete g.thinkingConfig;
        j = await send({ ...body, generationConfig: g });
      } else throw e;
    }
    const parts = j.candidates?.[0]?.content?.parts || [];
    return parts.map((p) => p.text || "").join("").trim();
  }

  async transcribe(wav, { model, language, prompt, signal } = {}) {
    const data = await blobToBase64(wav);
    const hints = ""; // (Whisper-style prompt carries previous text; Gemini gets it as continuity)
    const text = await this._generate(
      model,
      {
        contents: [{ role: "user", parts: [{ text: STT_INSTRUCTION(hints, prompt) + (language === "ar" ? "\nThe speech is Arabic." : "") }, { inlineData: { mimeType: "audio/wav", data } }] }],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 2048,
          responseMimeType: "application/json",
          responseSchema: { type: "OBJECT", properties: { language: { type: "STRING" }, text: { type: "STRING" } }, required: ["language", "text"] },
          thinkingConfig: { thinkingBudget: 0 },
        },
      },
      signal
    );
    let parsed = null;
    try {
      parsed = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ""));
    } catch {}
    if (parsed && typeof parsed.text === "string") return { text: parsed.text, language: parsed.language || "", segments: [], duration: 0 };
    return { text, language: "", segments: [], duration: 0 };
  }

  async chat({ model, system, user, maxTokens = 900, signal }) {
    return this._generate(
      model,
      {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: maxTokens, thinkingConfig: { thinkingBudget: 0 } },
      },
      signal
    );
  }
}
