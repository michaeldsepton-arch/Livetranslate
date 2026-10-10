// Small shared helpers (no dependencies).

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function uid(prefix = "") {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

export function debounce(fn, ms) {
  let t;
  const wrapped = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  wrapped.flush = (...args) => {
    clearTimeout(t);
    fn(...args);
  };
  wrapped.cancel = () => clearTimeout(t);
  return wrapped;
}

export function wordCount(s) {
  const m = (s || "").trim().match(/\S+/g);
  return m ? m.length : 0;
}

const pad2 = (n) => String(n).padStart(2, "0");

/** 3725 -> "01:02:05" */
export function fmtClock(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  return `${pad2(Math.floor(sec / 3600))}:${pad2(Math.floor((sec % 3600) / 60))}:${pad2(sec % 60)}`;
}

/** 3725 -> "1 h 02 min" ; 125 -> "2 min" ; 40 -> "40 s" */
export function fmtDuration(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  if (sec < 60) return `${sec} s`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h ? `${h} h ${pad2(m)} min` : `${m} min`;
}

export function fmtDate(ms, opts) {
  return new Date(ms).toLocaleString(undefined, opts || { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** Safe, readable file stamp: 2026-10-10_14-32 */
export function fileStamp(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}_${pad2(d.getHours())}-${pad2(d.getMinutes())}`;
}

export function slugify(s) {
  return (s || "")
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

/** Tiny hyperscript: h('div', {class:'x', onclick}, child, ...) */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k === "html") el.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}
