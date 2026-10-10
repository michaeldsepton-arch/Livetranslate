// Settings screen.
import { h } from "../util.js";
import { icon } from "./icons.js";
import { backButton, toggleRow, segmented } from "./common.js";
import { testKey, GROQ_KEYS_URL, GEMINI_KEYS_URL, OPENAI_KEYS_URL } from "./setup.js";
import { DELAY_PRESETS } from "../settings.js";
import { builtinGlossary } from "../engine/glossary.js";
import { MicCapture } from "../audio/capture.js";
import { Chunker } from "../audio/chunker.js";
import { toast } from "./overlay.js";
import { usagePanel, officialLinks } from "./usage.js";
import { speechTest } from "./speech-test.js";
import { APP_VERSION } from "../version.js";

function keyField(app, { provider, label, field, placeholder, link, linkText, hint }) {
  const input = h("input", { class: "input", type: "password", value: app.settings[field], placeholder, autocapitalize: "off", autocomplete: "off", spellcheck: "false", "aria-label": label });
  const eye = h("button", { class: "icon-btn", "aria-label": "Show key", onclick: () => {
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      eye.replaceChildren(icon(show ? "eyeOff" : "eye"));
    } }, icon("eye"));
  const status = h("div", { class: "status-line" });
  const test = h("button", { class: "btn small", onclick: async () => {
      status.className = "status-line";
      status.textContent = "Checking…";
      const r = await testKey(provider, input.value);
      status.className = "status-line " + (r.ok ? "ok" : "bad");
      status.textContent = r.message;
      if (r.ok) app.update({ [field]: input.value.trim() });
    } }, "Test");
  input.addEventListener("change", () => app.update({ [field]: input.value.trim() }));
  return h("div", { class: "field" },
    h("label", {}, label),
    h("div", { class: "keyrow" }, input, eye, test),
    status,
    h("p", { class: "hint", style: "margin:0" }, hint, " ", h("a", { href: link, target: "_blank", rel: "noopener" }, linkText))
  );
}

function glossaryEditor(app) {
  const box = h("div");
  const rows = () => app.settings.customGlossary;
  const save = () => app.update({ customGlossary: rows().filter((r) => r.ar.trim() || r.en.trim()) });
  function render() {
    box.replaceChildren();
    rows().forEach((r, i) => {
      const ar = h("input", { class: "input ar", value: r.ar, placeholder: "العربية", lang: "ar", dir: "rtl", "aria-label": "Arabic" });
      const en = h("input", { class: "input", value: r.en, placeholder: "English spelling", "aria-label": "English" });
      ar.addEventListener("change", () => { rows()[i].ar = ar.value; save(); });
      en.addEventListener("change", () => { rows()[i].en = en.value; save(); });
      box.append(h("div", { class: "gloss-row" }, ar, en, h("button", { class: "icon-btn", "aria-label": "Remove", onclick: () => { rows().splice(i, 1); save(); render(); } }, icon("x"))));
    });
    box.append(h("button", { class: "btn small", onclick: () => { rows().push({ ar: "", en: "" }); render(); box.querySelectorAll(".gloss-row .input.ar")[rows().length - 1]?.focus(); } }, icon("plus"), "Add a name or term"));
  }
  render();
  return box;
}

function micTest(app) {
  const meter = h("div", { class: "meter" }, h("i"));
  const btn = h("button", { class: "btn small" }, icon("mic"), "Test microphone");
  const status = h("div", { class: "status-line", style: "margin-top:8px" });
  let cap = null;
  btn.onclick = async () => {
    if (cap) return;
    status.className = "status-line";
    status.textContent = "Speak normally — the bar should move.";
    let lvl = 0;
    cap = new MicCapture({
      noiseSuppression: app.settings.noiseSuppression,
      autoGain: app.settings.autoGain,
      onSamples: (s) => (lvl = lvl * 0.6 + Math.max(0, Math.min(1, (Chunker.dbOf(s) + 60) / 45)) * 0.4, meter.style.setProperty("--lvl", lvl)),
    });
    try {
      await cap.start();
    } catch (e) {
      status.className = "status-line bad";
      status.textContent = e.message;
      cap = null;
      return;
    }
    setTimeout(() => { cap && cap.stop(); cap = null; meter.style.setProperty("--lvl", 0); status.className = "status-line ok"; status.textContent = "Microphone works."; }, 6000);
  };
  return h("div", { class: "field" }, h("div", {}, btn), meter, status);
}

/** Which service handles a stage first.  A missing key just falls through to the other service. */
function enginePicker(app, { label, field, options, notes }) {
  const note = h("div", { class: "seg-note" });
  const show = (v) => {
    const s = app.settings;
    const need = v === "gemini" && !s.geminiKey.trim() ? " Add a Gemini key above to use it." : v === "openai" && !s.openaiKey.trim() ? " Add an OpenAI key above to use it." : v !== "gemini" && v !== "openai" && v !== "auto" && !s.groqKey.trim() ? " Add a Groq key above to use it." : "";
    note.textContent = (notes[v] || "") + need;
  };
  show(app.settings[field]);
  app.on("settings", (p) => ("geminiKey" in p || "groqKey" in p || "openaiKey" in p) && show(app.settings[field]));
  return h("div", { class: "field" }, h("label", {}, label),
    segmented(options, app.settings[field], (v) => { app.update({ [field]: v }); show(v); }),
    note);
}

export function buildSettings(app, screen) {
  const s = app.settings;
  const usageEl = usagePanel(app);
  const usageRefresh = () => usageEl.refresh();
  const sens = h("input", { type: "range", min: "-6", max: "12", step: "1", value: String(s.sensitivity), "aria-label": "Microphone sensitivity" });
  const sensLabel = h("span", { class: "label" });
  const showSens = () => (sensLabel.textContent = s.sensitivity === 0 ? "Normal" : s.sensitivity > 0 ? `More sensitive (+${s.sensitivity})` : `Less sensitive (${s.sensitivity})`);
  sens.oninput = () => { app.update({ sensitivity: +sens.value }); showSens(); };
  showSens();

  const delayNote = h("div", { class: "seg-note" });
  const showDelay = (k) => (delayNote.textContent = `${DELAY_PRESETS[k].approx}. ` + { instant: "Shortest delay: translates every couple of seconds. A little more fragmentary, and it uses your free allowance about three times faster — watch the allowance chip.", quick: "Fast, with a little less context. Uses your free allowance faster.", balanced: "Waits a few seconds for the next phrase so sentences flow naturally.", smooth: "Most polished: waits longest to see the whole thought. Best for complex talks." }[k]);
  showDelay(s.delay);

  const textSize = h("input", { type: "range", min: "0.8", max: "1.6", step: "0.05", value: String(s.textSize), "aria-label": "Text size" });
  textSize.oninput = () => app.update({ textSize: +textSize.value });
  app.on("settings", (p) => "textSize" in p && (textSize.value = String(app.settings.textSize)));

  const ctx = h("textarea", { class: "input", placeholder: "e.g. Shaykh Yasir — Seerah class at Masjid Al-Noor. Topics: the Hijrah, Abu Bakr, Umar.", "aria-label": "Lecture context" }, s.context);
  ctx.addEventListener("change", () => app.update({ context: ctx.value.trim() }));

  const adv = (label, field, ph) => {
    const i = h("input", { class: "input", value: s[field], placeholder: ph, autocapitalize: "off", spellcheck: "false", "aria-label": label });
    i.addEventListener("change", () => app.update({ [field]: i.value.trim() }));
    return h("div", { class: "field" }, h("label", {}, label), i);
  };

  screen.append(
    h("header", { class: "bar title-bar" }, backButton(() => app.go("live"), "Back"), h("h2", {}, "Settings")),
    h("div", { class: "scroll" },
      h("div", { class: "page" },
        h("section", { class: "card" },
          h("h3", {}, icon("key"), "Connection"),
          h("p", { class: "hint" }, "Keys are stored only on this phone. One is enough. Groq and Gemini are free; a second key acts as a backup if the first runs out for the day. OpenAI is optional and paid."),
          keyField(app, { provider: "groq", label: "Groq key — speech recognition + translation", field: "groqKey", placeholder: "gsk_…", link: GROQ_KEYS_URL, linkText: "Get a free key →", hint: "Recommended. Runs Whisper large-v3." }),
          keyField(app, { provider: "gemini", label: "Google Gemini key — optional backup", field: "geminiKey", placeholder: "AIza…", link: GEMINI_KEYS_URL, linkText: "Get a free key →", hint: "Takes over automatically if Groq's free allowance is used up." }),
          keyField(app, { provider: "openai", label: "OpenAI key — optional, pay-as-you-go", field: "openaiKey", placeholder: "sk-…", link: OPENAI_KEYS_URL, linkText: "Get a key →", hint: "No free tier: you add a few dollars of credit and pay for what you use (roughly $0.3–1.5 per lecture hour). Choose it below, or it steps in when the free services run out." }),
          enginePicker(app, {
            label: "Speech recognition (hearing the Arabic)",
            field: "sttEngine",
            options: [["auto", "Auto"], ["groq", "Whisper"], ["groq-turbo", "Turbo"], ["gemini", "Gemini"], ["openai", "OpenAI"]],
            notes: {
              auto: "Whisper large-v3 first (the most accurate), then Turbo, then Gemini if the free allowance runs out.",
              groq: "Whisper large-v3 on Groq, then the others if it runs out.",
              "groq-turbo": "Whisper large-v3 turbo first: about twice as fast and a bit less accurate on difficult Arabic. Falls back to the others if its allowance runs out.",
              gemini: "Google's model listens to the audio directly. Needs the Gemini key.",
              openai: "OpenAI's gpt-4o-transcribe, then Whisper-1. Paid per minute of audio. Needs the OpenAI key.",
            },
          }),
          enginePicker(app, {
            label: "Translation (Arabic → English)",
            field: "llmEngine",
            options: [["auto", "Auto"], ["groq", "Groq"], ["gemini", "Gemini"], ["openai", "OpenAI"]],
            notes: {
              auto: "Groq's open models first, then Gemini if the free allowance runs out.",
              groq: "Groq's open models first (gpt-oss-120b…), then Gemini if they run out.",
              gemini: "Gemini first, then Groq if it runs out. Needs the Gemini key.",
              openai: "OpenAI first (gpt-4.1 by default), then the free services if your credit runs out. Needs the OpenAI key.",
            },
          })),

        h("section", { class: "card" },
          h("h3", {}, icon("headphones"), "Speech test"),
          h("p", { class: "hint" }, "Not happy with the results? Record a few seconds of the lecture (or play a recording near the phone). Lisan plays it back so you can hear exactly what it hears, then shows what each speech engine makes of the same clip, so you can tell whether the problem is the microphone, an engine, or the setting. Uses a little of your free allowance."),
          speechTest(app)),

        h("section", { class: "card" },
          h("h3", {}, icon("spark"), "This lecture"),
          h("p", { class: "hint" }, "Tell the translator who is speaking and what about. Names and topics here improve spelling and meaning."),
          h("div", { class: "field" }, ctx),
          h("div", { class: "field" }, h("label", {}, "The speaker's Arabic"),
            segmented([["fusha", "Fusha"], ["saudi", "Fusha + Saudi"], ["other", "Other dialect"]], s.dialect, (v) => app.update({ dialect: v })),
            h("div", { class: "seg-note" }, "Standard Arabic is the default; \"Fusha + Saudi\" also understands everyday Saudi words that slip in.")),
          toggleRow("Recognise Qur'an recitation", "When verses are recited, shows the exact Arabic text from the Mushaf, tags the surah and verse, and translates their true meaning.", s.quranMatching, (v) => app.update({ quranMatching: v })),
          h("div", { class: "field" }, h("label", {}, "Who is speaking?"),
            segmented([["auto", "Sheikh + English interpreter"], ["ar", "Arabic only"]], s.lectureLang, (v) => app.update({ lectureLang: v })),
            h("div", { class: "seg-note" }, "With an interpreter, English speech is detected automatically and shown as their words — it is never re-translated."))),

        h("section", { class: "card" },
          h("h3", {}, icon("headphones"), "Smoothness"),
          h("p", { class: "hint" }, "A little delay gives the translator context, so sentences read as one thought instead of fragments. Each line appears once and is never rewritten."),
          segmented(Object.entries(DELAY_PRESETS).map(([k, v]) => [k, v.label]), s.delay, (v) => { app.update({ delay: v }); showDelay(v); }),
          delayNote),

        h("section", { class: "card" },
          h("h3", {}, icon("battery"), "Free allowance"),
          h("p", { class: "hint" }, "How much of the free Groq / Gemini limits you've used. A chip with the most-used limit also shows while recording; tap it for this screen."),
          usageEl,
          officialLinks(),
          toggleRow("My Groq account is on a paid plan", "Hides the free-tier limits, warnings and request pacing (paid plans have much higher limits).", s.groqPaid, (v) => { app.update({ groqPaid: v }); usageRefresh(); }),
          toggleRow("My Gemini account is on a paid plan", "Same, for Gemini.", s.geminiPaid, (v) => { app.update({ geminiPaid: v }); usageRefresh(); }),
          h("div", { style: "margin-top:12px" }, h("button", { class: "btn small", onclick: () => { app.usage.clear(); toast("Counters reset on this phone"); } }, "Reset counters"))),

        h("section", { class: "card" },
          h("h3", {}, icon("library"), "My names & terms"),
          h("p", { class: "hint" }, `Already knows ${builtinGlossary().length}+ Islamic terms, prophets, Companions, scholars, places and surahs. Add anything it gets wrong: the Arabic as spoken, and how you want it written.`),
          glossaryEditor(app)),

        h("section", { class: "card" },
          h("h3", {}, icon("globe"), "Translation style"),
          h("div", { class: "field" }, h("label", {}, "Islamic terms"),
            segmented([["keep", "Keep terms (salah, taqwa)"], ["english", "Plain English"]], s.termStyle, (v) => app.update({ termStyle: v })),
            h("div", { class: "seg-note" }, "Only single words stay as words. Sentences, verses and supplications are always translated into English.")),
          h("div", { class: "field" }, h("label", {}, "Honorifics"),
            segmented([["short", "ﷺ  (RA)  (RH)"], ["full", "Written out"]], s.honorifics, (v) => app.update({ honorifics: v })))),

        h("section", { class: "card" },
          h("h3", {}, icon("type"), "Display"),
          h("div", { class: "field" }, h("label", {}, "Theme"), segmented([["dark", "Dark"], ["light", "Light"]], s.theme, (v) => app.update({ theme: v }))),
          toggleRow("Show Arabic text", "Display the Arabic above each English paragraph", s.showArabic, (v) => app.update({ showArabic: v })),
          h("div", { class: "field", style: "margin-top:10px" }, h("label", {}, "Text size"), textSize)),

        h("section", { class: "card" },
          h("h3", {}, icon("mic"), "Microphone"),
          toggleRow("Keep listening with the screen off", "Shows a “Lisan is listening” notification so Android doesn't stop the microphone when you lock the phone or switch apps. Takes effect next time you start.", s.backgroundListening, (v) => app.update({ backgroundListening: v })),
          toggleRow("Noise suppression", "Reduces room noise and echo", s.noiseSuppression, (v) => app.update({ noiseSuppression: v })),
          toggleRow("Automatic volume", "Boosts a distant or quiet speaker", s.autoGain, (v) => app.update({ autoGain: v })),
          h("div", { class: "field", style: "margin-top:10px" }, h("label", {}, "Sensitivity"), sens, sensLabel),
          micTest(app)),

        h("section", { class: "card" },
          h("h3", {}, icon("download"), "Saving"),
          toggleRow("Save a .txt file when I stop", "Goes to Downloads/Lisan. The lecture is always kept in the Library too.", s.autoSave, (v) => app.update({ autoSave: v })),
          toggleRow("Include Arabic in the file", "", s.saveArabic, (v) => app.update({ saveArabic: v })),
          toggleRow("Include timestamps", "", s.saveTimestamps, (v) => app.update({ saveTimestamps: v }))),

        h("section", { class: "card" },
          h("details", { class: "adv" },
            h("summary", {}, "Advanced"),
            adv("Speech model override (Groq)", "modelStt", "whisper-large-v3"),
            adv("Translation model override (Groq)", "modelLlm", "openai/gpt-oss-120b"),
            adv("Gemini model override", "modelGemini", "gemini-2.5-flash"),
            adv("OpenAI translation model override", "modelOpenai", "gpt-4.1  (try gpt-4.1-mini to spend less)"))),

        h("div", { class: "about" },
          h("img", { src: "assets/logo-mark.png", alt: "" }),
          h("div", {}, `Lisan ${APP_VERSION}`),
          h("div", {}, "Lisan (لسان) is Arabic for “tongue” and “language”."),
          h("div", {}, "Open source · speech by Whisper · translation by large language models."),
          h("div", {}, "Machine translation can make mistakes — check verses and hadith against reliable sources."))
      ))
  );
}
