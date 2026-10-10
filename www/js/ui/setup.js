// First-run flow: get a free key, paste it, done.
import { h } from "../util.js";
import { icon } from "./icons.js";
import { openSheet, toast } from "./overlay.js";
import { GroqProvider } from "../providers/groq.js";
import { GeminiProvider } from "../providers/gemini.js";

export const GROQ_KEYS_URL = "https://console.groq.com/keys";
export const GEMINI_KEYS_URL = "https://aistudio.google.com/apikey";

/** Checks a key against the service.  Resolves {ok, message}. */
export async function testKey(provider, key) {
  const k = (key || "").trim();
  if (!k) return { ok: false, message: "Paste a key first" };
  try {
    const p = provider === "gemini" ? new GeminiProvider(k) : new GroqProvider(k);
    const models = await p.listModels();
    return { ok: true, message: `Key works · ${models.length} models available` };
  } catch (e) {
    if (e.kind === "auth") return { ok: false, message: "That key was rejected — check you copied all of it" };
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
      h("h3", {}, "Connect a free speech engine"),
      h("p", {}, "Live Translate uses Groq's free Whisper speech recognition. It takes about a minute and needs no payment card."),
      h("ol", { class: "steps" },
        h("li", {}, h("b", {}, "Open the Groq Console"), " and sign in with Google or email.", h("div", { style: "margin-top:8px" }, h("a", { class: "btn small", href: GROQ_KEYS_URL, target: "_blank", rel: "noopener" }, icon("key"), "Open Groq Console"))),
        h("li", {}, h("b", {}, "Create API key"), " — give it any name, then copy the key."),
        h("li", {}, h("b", {}, "Paste it below.")),
      ),
      h("div", { class: "field" }, input, status),
      save,
      h("p", { style: "margin:14px 0 0;font-size:12.5px;color:var(--text-faint)" }, "Your audio goes directly from your phone to Groq. The key stays on this phone only."),
    ];
  });
}
