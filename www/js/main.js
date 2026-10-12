import { App } from "./app.js";
import { buildShell } from "./ui/shell.js";
import { toast } from "./ui/overlay.js";
import { autoCheck } from "./update.js";
import { watchBattery } from "./battery.js";

const app = new App();
window.__app = app; // handy for debugging in a desktop browser
buildShell(app);
app.go("live");

// While the on-screen keyboard is up, hide the dock so fields are never covered.
const isField = (el) => el && /^(INPUT|TEXTAREA)$/.test(el.tagName) && el.type !== "range";
document.addEventListener("focusin", (e) => {
  if (!isField(e.target)) return;
  document.body.classList.add("typing");
  setTimeout(() => e.target.scrollIntoView({ block: "center", behavior: "smooth" }), 250);
});
document.addEventListener("focusout", () => setTimeout(() => !isField(document.activeElement) && document.body.classList.remove("typing"), 80));

// If the phone died or the app was swiped away mid-lecture, the autosaved transcript is still there.
app.recoverInterrupted().then((s) => {
  if (s) toast("Recovered your unfinished lecture.", { kind: "ok", ms: 8000, action: "Open", onAction: () => app.go("reader", { id: s.id }) });
});

// While recording, a heads-up if the battery gets low (Android's Battery Saver can slow Lisan down or stop it listening).
let stopBatteryWatch = null;
app.on("phase", () => {
  if (app.phase === "recording" && !stopBatteryWatch && !app.isDemo) {
    stopBatteryWatch = watchBattery({
      onLow: (pct, severity) =>
        toast(`Battery ${pct}% — ${severity === "critical" ? "plug in now: " : ""}Android's Battery Saver can slow Lisan down or stop it listening. Plug in if you can.`, { kind: "warn", ms: 12000 }),
    });
  } else if (!app.active && stopBatteryWatch) {
    stopBatteryWatch();
    stopBatteryWatch = null;
  }
});

// A quiet look for a newer version a few seconds after the app opens (never during a lecture).
setTimeout(async () => {
  const r = await autoCheck({ isBusy: () => app.active });
  if (r && r.status === "available") toast(`Update available — build ${r.latest}`, { kind: "ok", ms: 12000, action: "Open", onAction: () => app.go("settings") });
}, 6000);

if ("serviceWorker" in navigator && location.protocol.startsWith("http") && location.hostname !== "localhost") {
  // (offline shell for the web version; the Android app already bundles everything)
}
