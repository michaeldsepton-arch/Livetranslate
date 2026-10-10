// Saved lectures: list + reader (open, rename, export, delete).
import { h, fmtDate, fmtDuration, wordCount } from "../util.js";
import { icon } from "./icons.js";
import { TranscriptView } from "./transcript-view.js";
import { viewToolbar, backButton } from "./common.js";
import { openSheet, toast } from "./overlay.js";
import { deleteLectures } from "./lecture-actions.js";
import { suggestFilename } from "../engine/transcript.js";

export function buildLibrary(app, screen) {
  const list = h("div", { class: "list" });
  const title = h("h2", {}, "Library");
  const back = h("button", { class: "icon-btn" });
  const actions = h("div", { class: "bar-actions" });
  let sessions = [];
  let selecting = false;
  const selected = new Set();

  screen.append(h("header", { class: "bar title-bar" }, back, title, actions), h("div", { class: "scroll" }, list));

  const exitSelect = () => {
    selecting = false;
    selected.clear();
    draw();
  };
  const toggle = (id) => {
    selected.has(id) ? selected.delete(id) : selected.add(id);
    draw();
  };
  const removeSelected = () => deleteLectures(app, sessions.filter((x) => selected.has(x.id)), { onChange: refresh }).then((done) => done && exitSelect());

  function drawHeader() {
    title.textContent = selecting ? `${selected.size} selected` : "Library";
    back.replaceChildren(icon(selecting ? "x" : "back"));
    back.setAttribute("aria-label", selecting ? "Cancel selection" : "Back to live");
    back.onclick = selecting ? exitSelect : () => app.go("live");
    if (selecting) {
      actions.replaceChildren(
        h("button", { class: "btn small", onclick: () => { sessions.forEach((x) => selected.add(x.id)); draw(); } }, "All"),
        h("button", { class: "btn small danger", disabled: selected.size ? null : true, onclick: removeSelected }, icon("trash"), "Delete")
      );
    } else {
      actions.replaceChildren(sessions.length ? h("button", { class: "btn small", onclick: () => { selecting = true; draw(); } }, "Select") : null);
    }
  }

  function draw() {
    drawHeader();
    list.replaceChildren();
    if (!sessions.length) {
      list.append(
        h("div", { class: "empty" },
          h("img", { class: "logo", src: "assets/logo-mark.png", alt: "", style: "opacity:.85;width:110px;height:86px" }),
          h("h2", {}, "No lectures yet"),
          h("p", {}, "Every lecture you record is saved here automatically, ready to read, share or export as a text file."))
      );
      return;
    }
    for (const s of sessions) {
      const first = (s.entries || []).find((e) => e.en);
      const words = (s.entries || []).reduce((n, e) => n + wordCount(e.en), 0);
      const isSel = selected.has(s.id);

      // long-press a lecture to start selecting several
      let timer = null, pressed = false;
      const arm = () => { pressed = false; timer = setTimeout(() => { pressed = true; selecting = true; selected.add(s.id); draw(); navigator.vibrate && navigator.vibrate(12); }, 520); };
      const disarm = () => clearTimeout(timer);

      const main = h("button", {
        class: "lib-main",
        onclick: () => (pressed ? (pressed = false) : selecting ? toggle(s.id) : app.go("reader", { id: s.id })),
        ontouchstart: arm, ontouchend: disarm, ontouchmove: disarm, ontouchcancel: disarm,
        oncontextmenu: (e) => e.preventDefault(),
      },
        h("h4", {}, s.title),
        h("p", { class: "snippet" }, first ? first.en : "—"),
        h("div", { class: "chips" },
          h("span", { class: "mini gold" }, fmtDate(s.startedAt, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })),
          h("span", { class: "mini" }, fmtDuration(s.durationSec)),
          h("span", { class: "mini" }, `${words.toLocaleString()} words`)));

      list.append(
        h("div", { class: "lib-item" + (isSel ? " sel" : "") },
          selecting ? h("span", { class: "lib-check" + (isSel ? " on" : ""), onclick: () => toggle(s.id) }, isSel ? icon("check") : null) : null,
          main,
          selecting ? null : h("button", { class: "icon-btn lib-del", "aria-label": `Delete ${s.title}`, onclick: () => deleteLectures(app, [s], { onChange: refresh }) }, icon("trash")))
      );
    }
  }

  async function refresh() {
    sessions = (await app.store.list().catch(() => [])).filter((x) => !x.active || x.entries.length);
    for (const id of [...selected]) if (!sessions.some((x) => x.id === id)) selected.delete(id);
    if (!sessions.length) selecting = false;
    draw();
  }
  app.on("nav", (n) => {
    if (n.screen === "library") refresh();
    else if (selecting) exitSelect();
  });
  refresh();
}

export function buildReader(app, screen) {
  const title = h("h2", {}, "");
  const meta = h("div", { class: "reader-meta" });
  const transcriptEl = h("div", { class: "transcript" });
  const actions = h("div", { class: "reader-actions" });
  const view = new TranscriptView(transcriptEl);
  let session = null;

  screen.append(
    h("header", { class: "bar title-bar" },
      backButton(() => app.go("library"), "Back to library"),
      title,
      h("button", { class: "icon-btn", "aria-label": "Rename", onclick: () => rename() }, icon("edit"))),
    viewToolbar(app),
    h("div", { class: "scroll" }, meta, transcriptEl, actions)
  );

  async function open(id) {
    session = await app.store.get(id).catch(() => null);
    if (!session) return app.go("library");
    title.textContent = session.title;
    meta.textContent = `${fmtDate(session.startedAt)} · ${fmtDuration(session.durationSec)}` + (session.context ? ` · ${session.context.slice(0, 60)}` : "");
    view.clear();
    view.render(session.entries, { animate: false });
    actions.replaceChildren(
      h("div", { class: "row-actions" },
        h("button", { class: "btn primary", onclick: async () => {
            const r = await app.exportFile(session).catch(() => null);
            toast(r && r.where === "downloads" ? `Saved to ${r.path}` : r ? "Ready to share" : "Couldn't save the file", { kind: r ? "ok" : "err", ms: 5000 });
          } }, icon("download"), "Save .txt"),
        h("button", { class: "btn", onclick: () => app.exportShare(session) }, icon("share"), "Share"),
        h("button", { class: "btn", onclick: () => app.exportCopy(session) }, icon("copy"), "Copy"),
        h("button", { class: "btn danger", onclick: async () => {
            const done = await deleteLectures(app, [session], { onChange: () => app.nav === "library" && app.go("library") });
            if (done) app.go("library");
          } }, icon("trash"), "Delete"))
    );
  }

  function rename() {
    if (!session) return;
    const input = h("input", { class: "input", value: session.title, maxlength: "80", "aria-label": "Lecture title" });
    openSheet((close) => [
      h("h3", {}, "Rename lecture"),
      h("div", { class: "field" }, input),
      h("button", { class: "btn primary block", onclick: async () => {
          const t = input.value.trim();
          if (t) {
            session.title = t;
            await app.store.save(session);
            title.textContent = t;
          }
          close();
        } }, "Save"),
    ]);
    setTimeout(() => input.select(), 250);
  }

  app.on("nav", (n) => n.screen === "reader" && open(n.id));
  app.on("settings", () => session && app.nav === "reader" && null);
}
