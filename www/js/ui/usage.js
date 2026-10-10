// "How much of my free allowance is left?"  Bars per model, estimates, and links to the official pages.
import { h, fmtDuration } from "../util.js";
import { icon } from "./icons.js";
import { openSheet } from "./overlay.js";
import { PROVIDER_LABEL, providerOf, roleOf, prettyModel } from "../engine/limits.js";

export const OFFICIAL = [
  { label: "Groq usage", url: "https://console.groq.com/dashboard/usage" },
  { label: "Groq limits", url: "https://console.groq.com/settings/limits" },
  { label: "Google AI Studio usage", url: "https://aistudio.google.com/usage" },
];

const fmtNum = (n) => (n >= 10000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k` : Math.round(n).toLocaleString());
function fmtValue(n, unit) {
  if (unit === "sec") return n < 60 ? `${Math.round(n)} s` : fmtDuration(n);
  return fmtNum(n);
}
const tone = (f) => (f >= 0.9 ? "hot" : f >= 0.7 ? "warn" : "ok");

/** Models to show: everything used recently, plus the main model of each key that is set. */
export function idsToShow(app) {
  const s = app.settings;
  const ids = new Set(app.usage.usedIds());
  if (s.groqKey.trim()) {
    ids.add("groq:whisper-large-v3");
    ids.add("groq:openai/gpt-oss-120b");
  }
  if (s.geminiKey.trim()) ids.add("gemini:" + (s.modelGemini.trim() || "gemini-2.5-flash"));
  return [...ids].sort((a, b) => providerOf(a).localeCompare(providerOf(b)) || (roleOf(a) === "Speech" ? -1 : 1) - (roleOf(b) === "Speech" ? -1 : 1) || a.localeCompare(b));
}

function row(r) {
  const text = r.limit ? `${fmtValue(r.used, r.unit)} of ${fmtValue(r.limit, r.unit)}` : `${fmtValue(r.used, r.unit)} used`;
  return h("div", { class: "u-row" },
    h("div", { class: "u-top" }, h("span", {}, r.label, r.reported ? h("em", { title: "Reported by the service" }, " ✓") : null), h("span", { class: "u-val" }, text)),
    r.limit ? h("div", { class: "u-bar" }, h("i", { class: tone(r.frac), style: `width:${Math.max(r.frac > 0 ? 2 : 0, r.frac * 100)}%` })) : null
  );
}

export function usagePanel(app) {
  const root = h("div", { class: "usage" });
  function render() {
    root.replaceChildren();
    const ids = idsToShow(app);
    if (!ids.length) {
      root.append(h("p", { class: "hint" }, "Add a key above and your usage will appear here as you record."));
      return;
    }
    let lastProvider = "";
    for (const id of ids) {
      const prov = providerOf(id);
      if (prov !== lastProvider) {
        root.append(h("div", { class: "u-prov" }, PROVIDER_LABEL[prov] || prov, h("small", {}, prov === "gemini" ? "resets at midnight Pacific time" : "counted over the last 24 hours")));
        lastProvider = prov;
      }
      const role = roleOf(id);
      const card = h("div", { class: "u-model" }, h("div", { class: "u-name" }, prettyModel(id), role ? h("span", { class: "mini" }, role) : null));
      for (const r of app.usage.rows(id)) card.append(row(r));
      const left = app.usage.minutesLeft(id);
      if (left != null) {
        const what = role === "Speech" ? "free speech limit" : "free daily tokens of this model";
        card.append(h("div", { class: "u-est" }, left > 0 ? `At this pace the ${what} ${role === "Speech" ? "is" : "are"} used up in about ${fmtDuration(left * 60)} of lecture.` : `The ${what} for now ${role === "Speech" ? "has" : "have"} been used up.`));
      }
      root.append(card);
    }
    root.append(h("p", { class: "hint", style: "margin:10px 0 0" }, "These counts cover this phone only, and the limits are typical free-tier values — Groq and Google can change them and may count slightly differently. The official pages below are always right."));
  }
  render();
  let t = null;
  const off = app.usage.on(() => {
    if (!root.isConnected) return off();
    clearTimeout(t);
    t = setTimeout(render, 400);
  });
  root.refresh = render;
  return root;
}

export function officialLinks() {
  return h("div", { class: "row-actions", style: "margin-top:12px" }, ...OFFICIAL.map((o) => h("a", { class: "btn small", href: o.url, target: "_blank", rel: "noopener" }, o.label, " →")));
}

export function openUsageSheet(app) {
  openSheet((close) => [
    h("h3", {}, "Free allowance"),
    h("p", {}, "What you've used of the free Groq and Gemini limits."),
    usagePanel(app),
    officialLinks(),
    h("button", { class: "btn block", style: "margin-top:14px", onclick: close }, "Close"),
  ]);
}

/** Small chip for the recording screen: the most-used limit, e.g. "Groq 38%".  Hidden until there is something to show. */
export function allowanceChip(app) {
  const label = h("span");
  const chip = h("button", { class: "chip allowance", "aria-label": "Free allowance", onclick: () => openUsageSheet(app), style: "display:none" }, icon("battery"), label);
  function update() {
    const ids = app.usage.usedIds().filter((id) => providerOf(id) !== "gemini" || app.usage.rows(id).some((r) => r.frac != null));
    const hd = app.usage.headline(ids);
    if (!hd || hd.frac < 0.01) {
      chip.style.display = "none";
      return;
    }
    chip.style.display = "";
    chip.dataset.tone = tone(hd.frac);
    label.textContent = `${PROVIDER_LABEL[providerOf(hd.id)] || ""} ${Math.round(hd.frac * 100)}%`;
  }
  let t = null;
  app.usage.on(() => {
    clearTimeout(t);
    t = setTimeout(update, 500);
  });
  update();
  return chip;
}
