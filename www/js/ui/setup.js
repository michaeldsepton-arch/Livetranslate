// First-run flow: get a free key, paste it, done.
import { h } from "../util.js";
import { icon } from "./icons.js";
import { openSheet, toast } from "./overlay.js";
import { GroqProvider } from "../providers/groq.js";
import { GeminiProvider } from "../providers/gemini.js";
import { OpenAIProvider } from "../providers/openai.js";

export const GROQ_KEYS_URL = "https://console.groq.com/keys";
export const GEMINI_KEYS_URL = "https://aistudio.google.com/apikey";
export const OPENAI_KEYS_URL = "https://platform.openai.com/api-keys";
// where to add credit / switch on a paid plan
export const GROQ_BILLING_URL = "https://console.groq.com/settings/billing/plans";
export const GEMINI_BILLING_URL = "https://ai.google.dev/gemini-api/docs/billing";
export const OPENAI_BILLING_URL = "https://platform.openai.com/settings/organization/billing/overview";

/** Checks a key against the service.  Resolves {ok, message}. */
export async function testKey(provider, key) {
  const k = (key || "").trim();
  if (!k) return { ok: false, message: "Paste a key first" };
  try {
    const p = provider === "gemini" ? new GeminiProvider(k) : provider === "openai" ? new OpenAIProvider(k) : new GroqProvider(k);
    const models = await p.listModels();
    if (provider === "openai") {
      // listing models works even on "Read only" keys, so make one tiny real request (a fraction of a cent) to prove it can be used
      const cheap = ["gpt-4.1-mini", "gpt-4o-mini", "gpt-4.1", "gpt-4o"].find((m) => models.includes(m)) || models.find((m) => /^gpt-/.test(m) && !/transcribe|tts|audio|realtime|image|search|embed|instruct|codex|preview/.test(m));
      if (cheap) await p.chat({ model: cheap, system: "Reply with OK.", user: "OK", maxTokens: 16 });
      return { ok: true, message: `Key works and can make requests · ${models.length} models available` };
    }
    return { ok: true, message: `Key works · ${models.length} models available` };
  } catch (e) {
    if (e.kind === "quota" && provider === "openai") return { ok: false, message: "The key is valid but the account has no credit — add credit on OpenAI's billing page" };
    if (e.kind === "auth") return { ok: false, message: provider === "openai" && /permission|read only/i.test(e.message || "") ? e.message : "That key was rejected — check you copied all of it" };
    if (e.kind === "network") return { ok: false, message: "No internet connection" };
    return { ok: false, message: e.message || "Couldn't check the key" };
  }
}

export function openKeySetup(app, { thenStart = true } = {}) {
  const input = h("input", { class: "input", placeholder: "Paste your Groq key here (starts with gsk_)", autocapitalize: "off", autocomplete: "off", spellcheck: "false", "aria-label": "Groq API key" });
  const status = h("div", { class: "status-line" });
  const save = h("button", { class: "btn primary block" }, "Save and continue");
  openSheet((close) => {
    save.onclick = async () => {
      save.disabled = true;
      status.className = "status-line";
      status.textContent = "Checking…";
      const r = await testKey("groq", input.value);
      status.className = "status-line " + (r.ok ? "ok" : "bad");
      status.textContent = r.message;
      save.disabled = false;
      if (!r.ok) return;
      app.update({ groqKey: input.value.trim() });
      close();
      toast("All set — press the microphone to begin.", { kind: "ok" });
      if (thenStart) setTimeout(() => app.start(), 300);
    };
    return [
      h("h3", {}, "Connect a speech engine"),
      h("p", {}, "Lisan works with a Groq, Gemini or OpenAI key. The quickest start is a Groq key (about a minute, no card needed for its free plan). Free plans run out quickly, so for long lectures add a paid key in Settings."),
      h("ol", { class: "steps" },
        h("li", {}, h("b", {}, "Open the Groq Console"), " and sign in with Google or email.", h("div", { style: "margin-top:8px" }, h("a", { class: "btn small", href: GROQ_KEYS_URL, target: "_blank", rel: "noopener" }, icon("key"), "Open Groq Console"))),
        h("li", {}, h("b", {}, "Create API key"), " — give it any name, then copy the key."),
        h("li", {}, h("b", {}, "Paste it below.")),
      ),
      h("div", { class: "field" }, input, status),
      save,
      h("p", { style: "margin:14px 0 0;font-size:12.5px;color:var(--text-faint)" }, "Prefer OpenAI or Gemini? Get a key here, then paste it in Settings → Connection: ",
        h("a", { href: OPENAI_KEYS_URL, target: "_blank", rel: "noopener" }, "OpenAI key"), " · ", h("a", { href: GEMINI_KEYS_URL, target: "_blank", rel: "noopener" }, "Gemini key"), "."),
      h("p", { style: "margin:10px 0 0;font-size:12.5px;color:var(--text-faint)" }, "Your audio goes directly from your phone to the service you choose. Keys stay on this phone only."),
    ];
  });
}
