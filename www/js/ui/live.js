// The main screen: transcript, listening indicator, empty/welcome state, finish banner.
import { h } from "../util.js";
import { icon } from "./icons.js";
import { TranscriptView } from "./transcript-view.js";
import { viewToolbar, statusPill, fmtElapsed } from "./common.js";

export function buildLive(app, screen) {
  const pill = statusPill();
  const header = h(
    "header",
    { class: "bar" },
    h("div", { class: "brand" }, h("img", { src: "assets/logo-mark.png", alt: "" }), h("div", {}, h("h1", {}, "Lisan", h("span", { class: "wm-ar", lang: "ar" }, "لسان")), h("small", {}, "Arabic lectures → English"))),
    pill
  );

  const toolbar = viewToolbar(app);

  const empty = h("div", { class: "empty" });
  const transcriptEl = h("div", { class: "transcript", id: "transcript", "aria-live": "polite" });
  const ghost = h("div", { class: "ghost" });
  const scroll = h("div", { class: "scroll", id: "live-scroll" }, empty, transcriptEl, ghost);
  const jump = h("button", { class: "jump", onclick: () => toBottom(true) }, icon("down"), "Latest");

  const timerText = h("span", { class: "timer" }, "0:00");
  const pauseLabel = h("span", {}, "Pause");
  const pauseIcon = h("span", {}, icon("pause"));
  const strip = h(
    "div",
    { class: "strip" },
    h("div", { class: "chip rec" }, h("span", { class: "rd" }), timerText),
    h("button", { class: "chip", onclick: () => (app.phase === "paused" ? app.resume() : app.pause()) }, pauseIcon, pauseLabel)
  );

  screen.append(header, toolbar, scroll, jump, strip);

  const view = new TranscriptView(transcriptEl, { onRetry: (id) => app.retryEntry(id) });

  // ---- scrolling: follow new text unless the reader scrolled up --------------------------------
  let stick = true;
  const gap = () => scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight;
  scroll.addEventListener("scroll", () => {
    stick = gap() < 140;
    jump.classList.toggle("show", !stick && app.entries.length > 0);
  }, { passive: true });
  function toBottom(smooth) {
    stick = true;
    jump.classList.remove("show");
    requestAnimationFrame(() => scroll.scrollTo({ top: scroll.scrollHeight, behavior: smooth ? "smooth" : "auto" }));
  }

  // ---- empty / welcome ------------------------------------------------------------------------
  function renderEmpty() {
    empty.replaceChildren(
      h("img", { class: "logo", src: "assets/logo-mark.png", alt: "Lisan" }),
      h("div", { class: "wordmark" }, h("span", {}, "Lisan"), h("span", { class: "wm-ar", lang: "ar" }, "لسان")),
      h("h2", {}, "Follow the lecture as it happens"),
      h("p", {}, "Press the microphone and set your phone near the speaker. Arabic is translated into smooth, steady English — a few seconds behind, so it never flip-flops."),
      !app.hasKey()
        ? h("div", { class: "card", style: "text-align:left" },
            h("h3", {}, icon("key"), "One quick step"),
            h("p", { class: "hint" }, "Add a free speech key (takes a minute, no card needed). Your audio goes straight from this phone to the service."),
            h("button", { class: "btn primary block", onclick: () => app.emit("need-key") }, "Set up free key"))
        : null,
      h("div", { class: "tips" },
        h("div", { class: "tip" }, icon("headphones"), h("div", {}, h("b", {}, "Hears both languages. "), "When the interpreter speaks English it is shown as their words, never re-translated.")),
        h("div", { class: "tip" }, icon("library"), h("div", {}, h("b", {}, "Knows Islamic terms. "), "Names of the Prophets, Companions and scholars, plus hadith and fiqh vocabulary — add your own in Settings.")),
        h("div", { class: "tip" }, icon("file"), h("div", {}, h("b", {}, "Everything is saved. "), "A full .txt transcript lands in Downloads when you stop."))
      ),
      h("div", { class: "row-actions", style: "justify-content:center;margin-top:14px" },
        h("button", { class: "btn", onclick: () => app.start({ demo: true }) }, icon("play"), "Try a demo lecture"))
    );
  }

  // ---- ghost row (listening / finished) ---------------------------------------------------------
  function renderGhost() {
    ghost.replaceChildren();
    if (app.phase === "recording") {
      const busy = app.entries.some((e) => ["transcribing", "awaiting", "translating"].includes(e.state));
      ghost.append(
        h("span", { class: "bars" + (app.speaking ? "" : " quiet") }, h("i"), h("i"), h("i"), h("i"), h("i")),
        h("span", {}, app.speaking ? "Hearing speech…" : busy ? "Listening… translating" : "Listening…")
      );
    } else if (app.phase === "paused") {
      ghost.append(h("span", {}, "Paused — tap Resume to continue the same lecture."));
    } else if (app.phase === "finishing") {
      ghost.append(h("span", { class: "spinner" }), h("span", {}, "Finishing the last sentences…"));
    } else if (app.phase === "finished" && app.entries.length) {
      ghost.append(
        h("div", { style: "width:100%" },
          h("div", { class: "card", style: "margin:0" },
            h("h3", {}, icon("check"), app.isDemo ? "Demo finished" : "Lecture saved"),
            h("p", { class: "hint" }, app.isDemo ? "This is how a real lecture looks. Press the mic to try it for real." : "It's in your Library, and a .txt copy was saved to Downloads/Lisan."),
            h("div", { class: "row-actions" },
              !app.isDemo && app.session ? h("button", { class: "btn small", onclick: () => app.exportShare(app.session) }, icon("share"), "Share") : null,
              !app.isDemo && app.session ? h("button", { class: "btn small", onclick: () => app.exportCopy(app.session) }, icon("copy"), "Copy") : null,
              h("button", { class: "btn small primary", onclick: () => (app.newLecture(), app.start()) }, icon("mic"), "New lecture"))))
      );
    }
  }

  function renderStatus() {
    const { phase, health } = app;
    if (health.level === "err") return pill.set("err", "Needs attention");
    if (health.level === "warn" && app.active) return pill.set("warn", health.text.startsWith("No internet") ? "Offline" : "Limit reached");
    const map = {
      idle: app.hasKey() ? ["ok", "Ready"] : ["warn", "Setup needed"],
      starting: ["warn", "Starting…"],
      recording: ["rec", "Listening"],
      paused: ["warn", "Paused"],
      finishing: ["warn", "Finishing…"],
      finished: ["ok", app.isDemo ? "Demo finished" : "Saved"],
    };
    pill.set(...map[phase]);
  }

  function renderStrip() {
    const show = app.phase === "recording" || app.phase === "paused";
    strip.classList.toggle("show", show);
    scroll.classList.toggle("with-strip", show);
    pauseLabel.textContent = app.phase === "paused" ? "Resume" : "Pause";
    pauseIcon.replaceChildren(icon(app.phase === "paused" ? "play" : "pause"));
    timerText.textContent = fmtElapsed(app.elapsed);
  }

  function renderBody() {
    const has = app.entries.length > 0;
    const showEmpty = !has && (app.phase === "idle" || app.phase === "finished");
    empty.style.display = showEmpty ? "" : "none";
    screen.classList.toggle("no-transcript", showEmpty);
    if (showEmpty) renderEmpty();
    view.render(app.entries, { animate: true });
    if (!has) view.clear();
    renderGhost();
    renderStatus();
    renderStrip();
    if (has && stick) toBottom(true);
    else if (!has) scroll.scrollTop = 0;
  }

  app.on("entries", renderBody);
  app.on("phase", () => {
    if (app.phase === "starting") stick = true;
    renderBody();
  });
  app.on("health", renderStatus);
  app.on("settings", () => { renderStatus(); if (!app.entries.length && app.phase === "idle") renderEmpty(); });
  app.on("speech", renderGhost);
  app.on("clock", (n) => (timerText.textContent = fmtElapsed(n)));
  renderBody();
  return { pill, toBottom };
}
