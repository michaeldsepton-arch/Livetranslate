import { App } from "./app.js";
import { buildShell } from "./ui/shell.js";
import { toast } from "./ui/overlay.js";

const app = new App();
window.__app = app; // handy for debugging in a desktop browser
buildShell(app);
app.go("live");

// If the phone died or the app was swiped away mid-lecture, the autosaved transcript is still there.
app.recoverInterrupted().then((s) => {
  if (s) toast("Recovered your unfinished lecture.", { kind: "ok", ms: 8000, action: "Open", onAction: () => app.go("reader", { id: s.id }) });
});

if ("serviceWorker" in navigator && location.protocol.startsWith("http") && location.hostname !== "localhost") {
  // (offline shell for the web version; the Android app already bundles everything)
}
