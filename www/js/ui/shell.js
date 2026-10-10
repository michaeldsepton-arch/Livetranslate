// App frame: the five screens, the bottom dock with the big microphone button, navigation and back-button logic.
import { h } from "../util.js";
import { icon } from "./icons.js";
import { buildLive } from "./live.js";
import { buildLibrary, buildReader } from "./library.js";
import { buildSettings } from "./settings.js";
import { openKeySetup } from "./setup.js";
import { openSheet, confirmSheet, closeTopSheet, toast } from "./overlay.js";
import * as platform from "../platform.js";

export function buildShell(app) {
  const root = document.getElementById("app");
  const screens = {
    live: h("section", { class: "screen pattern active", id: "screen-live" }),
    library: h("section", { class: "screen pattern", id: "screen-library" }),
    reader: h("section", { class: "screen pattern", id: "screen-reader" }),
    settings: h("section", { class: "screen pattern", id: "screen-settings" }),
  };

  // ---- dock ------------------------------------------------------------------------------------
  const micIcon = h("span");
  const mic = h("button", { class: "mic", "aria-label": "Start listening" }, micIcon);
  const navLib = h("button", { class: "nav", onclick: () => app.go(app.nav === "library" ? "live" : "library") }, icon("library"), h("span", {}, "Library"));
  const navSet = h("button", { class: "nav", onclick: () => app.go(app.nav === "settings" ? "live" : "settings") }, icon("settings"), h("span", {}, "Settings"));
  const dock = h("nav", { class: "dock", "aria-label": "Main" }, navLib, h("div", { class: "mic-wrap" }, mic), navSet);

  root.append(...Object.values(screens), dock);
  buildLive(app, screens.live);
  buildLibrary(app, screens.library);
  buildReader(app, screens.reader);
  buildSettings(app, screens.settings);

  // ---- mic button -------------------------------------------------------------------------------
  mic.addEventListener("click", async () => {
    if (app.phase === "starting" || app.phase === "finishing") return;
    if (app.phase === "recording" || app.phase === "paused") {
      if (app.nav !== "live") return app.go("live");
      openStopSheet();
      return;
    }
    if (app.nav !== "live") app.go("live");
    if (app.phase === "finished") app.newLecture();
    app.start();
  });

  function openStopSheet() {
    openSheet((close) => {
      let armed = false, timer = null;
      const discard = h("button", { class: "btn danger block" }, icon("trash"), "Delete, don't save");
      discard.onclick = () => {
        if (!armed) {
          armed = true;
          discard.replaceChildren(icon("trash"), "Tap again to delete for good");
          timer = setTimeout(() => { armed = false; discard.replaceChildren(icon("trash"), "Delete, don't save"); }, 4000);
          return;
        }
        clearTimeout(timer);
        close();
        app.discard();
      };
      return [
        h("h3", {}, "End this lecture?"),
        h("p", {}, "Save keeps the transcript in your Library" + (app.settings.autoSave ? " and as a .txt file in Downloads." : ".")),
        h("div", { class: "stack" },
          h("button", { class: "btn primary block", onclick: () => { close(); app.stop(); } }, "Stop and save"),
          h("button", { class: "btn block", onclick: close }, "Keep recording"),
          discard),
      ];
    });
  }

  function renderMic() {
    const rec = app.phase === "recording" || app.phase === "paused";
    mic.classList.toggle("rec", rec);
    mic.classList.toggle("busy", app.phase === "starting" || app.phase === "finishing");
    mic.setAttribute("aria-label", rec ? "Stop and save" : "Start listening");
    micIcon.replaceChildren(icon(rec ? "stop" : "mic", rec ? "fill" : ""));
  }
  let raf = 0;
  app.on("level", (l) => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => mic.style.setProperty("--lvl", String(l)));
  });
  app.on("phase", renderMic);
  renderMic();

  // ---- navigation ---------------------------------------------------------------------------------
  app.on("nav", ({ screen }) => {
    for (const [k, el] of Object.entries(screens)) el.classList.toggle("active", k === screen);
    navLib.classList.toggle("on", screen === "library" || screen === "reader");
    navSet.classList.toggle("on", screen === "settings");
  });

  app.on("need-key", () => openKeySetup(app));
  app.on("halt", (msg) => {
    openSheet((close) => [
      h("h3", {}, "Your key needs attention"),
      h("p", {}, msg + " Nothing is lost — your recording is paused in the queue and will continue as soon as the key works."),
      h("div", { class: "stack" },
        h("button", { class: "btn primary block", onclick: () => { close(); app.go("settings"); } }, "Open Settings"),
        h("button", { class: "btn block", onclick: close }, "Not now")),
    ]);
  });

  // ---- Android back button ----------------------------------------------------------------------------
  platform.onBackButton(() => {
    if (closeTopSheet()) return;
    if (app.nav === "reader") return app.go("library");
    if (app.nav !== "live") return app.go("live");
    if (app.active) return toast("Recording — press the red button to stop.", { ms: 2500 });
    platform.exitApp();
  });
  platform.onAppResume((active) => active && app.onForeground());
}
