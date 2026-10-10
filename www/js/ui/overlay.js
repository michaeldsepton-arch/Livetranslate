// Toasts and bottom sheets (with a stack so the Android back button can close them).
import { h } from "../util.js";
import { icon } from "./icons.js";

const toastRoot = () => document.getElementById("toasts");

export function toast(text, { kind = "", action = "", onAction, ms = 4500 } = {}) {
  const el = h("div", { class: `toast ${kind}`, role: "status" }, h("span", { style: "flex:1" }, text));
  const remove = () => el.remove();
  if (action) el.append(h("button", { onclick: () => { remove(); onAction && onAction(); } }, action));
  toastRoot().append(el);
  if (ms) setTimeout(remove, ms);
  return remove;
}

const stack = [];
export const hasSheet = () => stack.length > 0;
export function closeTopSheet() {
  const top = stack[stack.length - 1];
  if (top) top.close();
  return !!top;
}

/**
 * @param {(close:()=>void)=>HTMLElement|HTMLElement[]} build
 * @returns {{close:()=>void, el:HTMLElement}}
 */
export function openSheet(build, { dismissible = true, onClose } = {}) {
  const sheet = h("div", { class: "sheet", role: "dialog", "aria-modal": "true" }, h("div", { class: "grab" }));
  const backdrop = h("div", { class: "backdrop" }, sheet);
  const handle = {
    el: sheet,
    close() {
      const i = stack.indexOf(handle);
      if (i >= 0) stack.splice(i, 1);
      backdrop.remove();
      onClose && onClose();
    },
  };
  const content = build(handle.close);
  sheet.append(...[].concat(content));
  if (dismissible) backdrop.addEventListener("click", (e) => e.target === backdrop && handle.close());
  document.body.append(backdrop);
  stack.push(handle);
  return handle;
}

export function confirmSheet({ title, text, confirm = "Confirm", cancel = "Cancel", danger = false }) {
  return new Promise((resolve) => {
    let answered = false;
    const done = (v, close) => {
      answered = true;
      close();
      resolve(v);
    };
    openSheet(
      (close) => [
        h("h3", {}, title),
        h("p", {}, text),
        h(
          "div",
          { class: "stack" },
          h("button", { class: `btn ${danger ? "danger" : "primary"} block`, onclick: () => done(true, close) }, confirm),
          h("button", { class: "btn block", onclick: () => done(false, close) }, cancel)
        ),
      ],
      { onClose: () => !answered && resolve(false) }
    );
  });
}

export function busyIcon() {
  return h("span", { class: "spinner" });
}
export { icon };
