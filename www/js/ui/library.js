// Saved lectures: list + reader (open, rename, export, delete).
import { h, fmtDate, fmtDuration, wordCount } from "../util.js";
import { icon } from "./icons.js";
import { TranscriptView } from "./transcript-view.js";
import { viewToolbar, backButton } from "./common.js";
import { openSheet, confirmSheet, toast } from "./overlay.js";
import { suggestFilename } from "../engine/transcript.js";

export function buildLibrary(app, screen) {
  const list = h("div", { class: "list" });
  screen.append(
    h("header", { class: "bar title-bar" }, backButton(() => app.go("live"), "Back to live"), h("h2", {}, "Library")),
    h("div", { class: "scroll" }, list)
  );

  async function refresh() {
    const sessions = (await app.store.list().catch(() => [])).filter((s) => !s.active || s.entries.length);
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
      list.append(
        h("button", { class: "lib-item", onclick: () => app.go("reader", { id: s.id }) },
          h("h4", {}, h("span", {}, s.title), icon("chevron")),
          h("p", { class: "snippet" }, first ? first.en : "—"),
          h("div", { class: "chips" },
            h("span", { class: "mini gold" }, fmtDate(s.startedAt, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })),
            h("span", { class: "mini" }, fmtDuration(s.durationSec)),
            h("span", { class: "mini" }, `${words.toLocaleString()} words`)))
      );
    }
  }
  app.on("nav", (n) => n.screen === "library" && refresh());
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
            const ok = await confirmSheet({ title: "Delete this lecture?", text: "The transcript will be removed from this phone. Files you already saved or shared are not affected.", confirm: "Delete", danger: true });
            if (!ok) return;
            await app.store.remove(session.id);
            toast("Deleted");
            app.go("library");
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
