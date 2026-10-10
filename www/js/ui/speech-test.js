// Settings → "Speech test": record a few seconds through the app's own audio path, play it back, and
// show what each speech engine makes of the same clip.
import { h } from "../util.js";
import { icon } from "./icons.js";
import { MicCapture } from "../audio/capture.js";
import { Chunker } from "../audio/chunker.js";
import { encodeWav } from "../audio/wav.js";
import { compareEngines, compareTranslators } from "../engine/compare.js";

const SECONDS = 8;

/** Plain-language read-out of how loud the recording was: the first thing to check when results are poor. */
export function describeLevel(samples) {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
  const peakDb = 20 * Math.log10(peak + 1e-9);
  const rmsDb = Chunker.dbOf(samples);
  if (peak < 0.003) return { ok: false, text: "No sound was picked up. Check the microphone permission and that nothing else is using it." };
  if (peakDb < -30) return { ok: false, text: `Very quiet (peak ${peakDb.toFixed(0)} dB). Move the phone closer to the speaker or switch Automatic volume on.` };
  if (peak >= 0.99) return { ok: false, text: "The sound is clipping (too loud / distorted). Move the phone a little further away." };
  return { ok: true, text: `Recording level looks fine (peak ${peakDb.toFixed(0)} dB, average ${rmsDb.toFixed(0)} dB).` };
}

export function speechTest(app) {
  const btn = h("button", { class: "btn small" }, icon("mic"), `Record ${SECONDS} seconds & compare`);
  const meter = h("div", { class: "meter" }, h("i"));
  const status = h("div", { class: "status-line", style: "margin-top:8px" });
  const player = h("audio", { controls: true, class: "st-audio", hidden: true });
  const results = h("div", { class: "st-results" });
  const trHead = h("div", { class: "st-sub", hidden: true }, "Translation of the first transcript, by each translator");
  const trResults = h("div", { class: "st-results" });
  let busy = false;
  let url = null;

  const say = (kind, text) => { status.className = "status-line " + kind; status.textContent = text; };

  function drawRow(row) {
    let el = results.querySelector(`[data-key="${row.key}"]`);
    if (!el) { el = h("div", { class: "st-row", "data-key": row.key }); results.append(el); }
    const head = h("div", { class: "st-head" }, h("b", {}, row.label), h("span", { class: "st-ms" }, row.state === "waiting" ? "waiting…" : row.state === "speech" ? "listening…" : row.ms ? `${(row.ms / 1000).toFixed(1)} s` : ""));
    const body = [];
    if (row.error && !row.text) body.push(h("div", { class: "st-err" }, row.error));
    else {
      if (row.text) body.push(h("div", { class: "st-ar", lang: "ar", dir: "rtl" }, row.text));
      else if (row.state === "done") body.push(h("div", { class: "st-none" }, "(nothing recognised)"));
      if (row.language && row.text) body.push(h("div", { class: "st-lang" }, `heard as: ${row.language}`));
      if (row.state === "translating") body.push(h("div", { class: "st-none" }, "translating…"));
      if (row.en) body.push(h("div", { class: "st-en" }, row.en));
      if (row.error && row.text) body.push(h("div", { class: "st-err" }, row.error));
    }
    el.replaceChildren(head, ...body);
  }

  function drawTr(row) {
    let el = trResults.querySelector(`[data-key="${row.key}"]`);
    if (!el) { el = h("div", { class: "st-row", "data-key": row.key }); trResults.append(el); }
    const head = h("div", { class: "st-head" }, h("b", {}, row.label), h("span", { class: "st-ms" }, row.state === "waiting" ? "waiting…" : row.state === "translating" ? "translating…" : `${(row.ms / 1000).toFixed(1)} s`));
    el.replaceChildren(head, row.error ? h("div", { class: "st-err" }, row.error) : row.en ? h("div", { class: "st-en" }, row.en) : null);
  }

  btn.onclick = async () => {
    if (busy) return;
    if (app.active) { say("bad", "Stop the current recording first."); return; }
    if (!app.hasKey()) { say("bad", "Add a key above first."); return; }
    busy = true;
    btn.disabled = true;
    results.replaceChildren();
    trResults.replaceChildren();
    trHead.hidden = true;
    player.hidden = true;
    if (url) { URL.revokeObjectURL(url); url = null; }

    // 1. record through exactly the same capture path (and mic settings) a lecture uses
    const blocks = [];
    let lvl = 0;
    const cap = new MicCapture({
      noiseSuppression: app.settings.noiseSuppression,
      autoGain: app.settings.autoGain,
      onSamples: (s) => { blocks.push(s); lvl = lvl * 0.6 + Math.max(0, Math.min(1, (Chunker.dbOf(s) + 60) / 45)) * 0.4; meter.style.setProperty("--lvl", lvl); },
    });
    try {
      await cap.start();
    } catch (e) {
      say("bad", e.message); busy = false; btn.disabled = false; return;
    }
    const t0 = performance.now();
    const tick = setInterval(() => say("", `Recording… speak or play the lecture near the phone (${Math.max(0, Math.ceil(SECONDS - (performance.now() - t0) / 1000))} s)`), 250);
    await new Promise((r) => setTimeout(r, SECONDS * 1000));
    clearInterval(tick);
    cap.stop();
    meter.style.setProperty("--lvl", 0);

    const total = blocks.reduce((n, b) => n + b.length, 0);
    const samples = new Float32Array(total);
    let o = 0;
    for (const b of blocks) { samples.set(b, o); o += b.length; }
    const wav = encodeWav(samples, 16000);
    url = URL.createObjectURL(wav);
    player.src = url;
    player.hidden = false;
    const lv = describeLevel(samples);
    say(lv.ok ? "ok" : "bad", lv.text);
    if (total < 16000) { busy = false; btn.disabled = false; return; }

    // 2. same clip, every engine
    try {
      const router = app.buildRouter();
      await router.init();
      const rows = await compareEngines({ router, wav, seconds: total / 16000, settings: app.settings, usage: app.usage, onRow: drawRow });
      if (!rows.length) say("bad", "No speech engine available. Check your keys.");
      const first = rows.find((r) => r.text);
      if (first) {
        trHead.hidden = false;
        await compareTranslators({ router, text: first.text, settings: app.settings, usage: app.usage, onRow: drawTr });
      }
    } catch (e) {
      say("bad", e.message || "The test failed.");
    }
    busy = false;
    btn.disabled = false;
  };

  return h("div", { class: "field" },
    h("div", {}, btn),
    meter, status, player, results, trHead, trResults);
}
