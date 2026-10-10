// Small UI pieces shared by several screens.
import { h } from "../util.js";
import { icon } from "./icons.js";

/** English | + Arabic toggle and text-size buttons.  Stays in sync with app.settings. */
export function viewToolbar(app) {
  const mk = (label, val) => h("button", { onclick: () => app.update({ showArabic: val }) }, label);
  const en = mk("English", false);
  const both = mk("English + Arabic", true);
  const sync = () => {
    en.classList.toggle("on", !app.settings.showArabic);
    both.classList.toggle("on", !!app.settings.showArabic);
  };
  const step = (d) => app.update({ textSize: Math.min(1.6, Math.max(0.8, Math.round((app.settings.textSize + d) * 100) / 100)) });
  const el = h(
    "div",
    { class: "toolbar" },
    h("div", { class: "seg", role: "group", "aria-label": "Transcript view" }, en, both),
    h("div", { class: "grow" }),
    h(
      "div",
      { class: "size-btns", role: "group", "aria-label": "Text size" },
      h("button", { "aria-label": "Smaller text", onclick: () => step(-0.1), style: "font-size:13px" }, "A"),
      h("button", { "aria-label": "Larger text", onclick: () => step(0.1), style: "font-size:19px" }, "A")
    )
  );
  sync();
  app.on("settings", sync);
  return el;
}

export function statusPill() {
  const dot = h("span", { class: "dot" });
  const label = h("span");
  const el = h("span", { class: "pill", role: "status" }, dot, label);
  el.set = (kind, text) => {
    el.className = `pill ${kind}`;
    label.textContent = text;
  };
  return el;
}

export function backButton(onclick, label = "Back") {
  return h("button", { class: "icon-btn", "aria-label": label, onclick }, icon("back"));
}

export function toggleRow(title, desc, value, onChange) {
  const sw = h("span", { class: "switch" + (value ? " on" : ""), role: "switch", "aria-checked": String(!!value) });
  const row = h(
    "div",
    { class: "toggle", onclick: () => {
        const v = !sw.classList.contains("on");
        sw.classList.toggle("on", v);
        sw.setAttribute("aria-checked", String(v));
        onChange(v);
      } },
    h("div", {}, h("div", { class: "t" }, title), desc ? h("div", { class: "d" }, desc) : null),
    sw
  );
  return row;
}

export function segmented(options, value, onChange, { full = true } = {}) {
  const el = h("div", { class: "seg" + (full ? " full" : ""), role: "group" });
  const btns = options.map(([val, label]) => {
    const b = h("button", { onclick: () => {
        value = val;
        sync();
        onChange(val);
      } }, label);
    b._val = val;
    return b;
  });
  const sync = () => btns.forEach((b) => b.classList.toggle("on", b._val === value));
  el.append(...btns);
  sync();
  return el;
}

export function fmtElapsed(sec) {
  const m = Math.floor(sec / 60), s = sec % 60;
  const hr = Math.floor(m / 60);
  const mm = String(m % 60).padStart(2, "0"), ss = String(s).padStart(2, "0");
  return hr ? `${hr}:${mm}:${ss}` : `${m}:${ss}`;
}
