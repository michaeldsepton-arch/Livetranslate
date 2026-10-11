// Renders entries as flowing paragraphs.  Updates are incremental (per sentence) and each newly
// committed sentence fades in once — text that is already on screen is never touched again.
import { h, fmtClock } from "../util.js";
import { groupEntries, mergeRefs, refPlacement } from "../engine/transcript.js";
import { icon } from "./icons.js";

const place = (parent, child, index) => {
  if (parent.children[index] !== child) parent.insertBefore(child, parent.children[index] || null);
};

export class TranscriptView {
  constructor(root, { onRetry } = {}) {
    this.root = root;
    this.onRetry = onRetry;
    this.blocks = new Map();
    this.spans = new Map();
    this.animate = true;
  }

  clear() {
    this.root.replaceChildren();
    this.blocks.clear();
    this.spans.clear();
  }

  render(entries, { animate = true } = {}) {
    this.animate = animate;
    const groups = groupEntries(entries);
    const keep = new Set();
    groups.forEach((g, i) => {
      let b = this.blocks.get(g.key);
      if (!b) {
        b = this._make(g);
        this.blocks.set(g.key, b);
      }
      keep.add(g.key);
      place(this.root, b.el, i);
      this._update(b, g);
    });
    for (const [k, b] of this.blocks) if (!keep.has(k)) (b.el.remove(), this.blocks.delete(k));
    const ids = new Set(entries.map((e) => e.id));
    for (const [id, rec] of this.spans) if (!ids.has(id)) (rec.ar.remove(), rec.en.remove(), this.spans.delete(id));
  }

  _make(g) {
    const interp = g.kind === "interpreter";
    const time = h("span", { class: "time" });
    const meta = h("div", { class: "meta" }, time);
    if (interp) meta.append(h("span", { class: "tag" }, icon("user"), "Interpreter"));
    const ar = h("p", { class: "ar", dir: "rtl", lang: "ar" });
    const en = h("p", { class: "en", lang: "en" });
    const el = h("article", { class: `block ${interp ? "interpreter" : "lecture"}` }, meta, ar, en);
    return { el, time, ar, en };
  }

  _update(b, g) {
    b.time.textContent = fmtClock(g.t0);
    g.entries.forEach((e, i) => {
      let rec = this.spans.get(e.id);
      if (!rec) {
        rec = { ar: h("span", { class: "seg-span" }), en: h("span", { class: "seg-span" }), sig: "" };
        this.spans.set(e.id, rec);
      }
      place(b.ar, rec.ar, i);
      place(b.en, rec.en, i);
      this._fill(rec, e);
    });
  }

  _fill(rec, e) {
    const sig = [e.state, e.ar, e.en, e.error].join("\u0001");
    if (rec.sig === sig) return;
    const firstArabic = !rec.ar.textContent && e.ar;
    rec.sig = sig;
    const arText = e.ar ? e.ar + " " : ""; // trailing space keeps neighbouring sentences apart (and in copy/paste)
    if (rec.ar.textContent !== arText) {
      // only the verse itself (fenced in ﴿ ﴾) is styled as Qur'an; the speaker's own words around it stay ordinary
      rec.ar.replaceChildren(...arText.split(/(﴿[^﴾]*﴾)/).filter(Boolean).map((part) => (part.startsWith("﴿") ? h("span", { class: "qv" }, part) : part)));
      if (firstArabic && this.animate) this._pop(rec.ar);
    }
    const en = rec.en;
    if (e.state === "error") {
      en.replaceChildren(
        h("button", { class: "retry", onclick: () => this.onRetry && this.onRetry(e.id) }, icon("refresh"), `${e.error || "Failed"} · Retry`)
      );
    } else if (e.kind === "lecture" && !e.en) {
      en.replaceChildren(h("span", { class: "ph" + (e.ar && e.ar.length > 70 ? " long" : "") }));
    } else if (en.textContent !== this._enText(e) || en.querySelector(".ph,.retry")) {
      const refs = mergeRefs(e.quran || []);
      if (refs.length) {
        // the reference sits right after the quotation, not over the whole paragraph
        const at = refPlacement(e.en);
        en.replaceChildren(e.en.slice(0, at), h("span", { class: "qref" }, ` (Qur'an ${refs.join("; ")})`), e.en.slice(at) + " ");
      } else en.textContent = e.en + " ";
      if (this.animate) this._pop(en);
    }
  }

  _enText(e) {
    const refs = mergeRefs(e.quran || []);
    if (!refs.length) return e.en + " ";
    const at = refPlacement(e.en);
    return e.en.slice(0, at) + ` (Qur'an ${refs.join("; ")})` + e.en.slice(at) + " ";
  }

  _pop(el) {
    el.classList.remove("enter");
    void el.offsetWidth;
    el.classList.add("enter");
  }
}
