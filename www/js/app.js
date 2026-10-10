// Application controller: owns settings, the saved-lecture store and the recording session,
// and tells the screens what changed through a tiny event bus.
import { Emitter, LectureEngine } from "./engine/session-engine.js";
import { Router } from "./engine/router.js";
import { GroqProvider } from "./providers/groq.js";
import { GeminiProvider } from "./providers/gemini.js";
import { Chunker } from "./audio/chunker.js";
import { MicCapture } from "./audio/capture.js";
import { DEFAULT_SETTINGS, DELAY_PRESETS, loadSettings, saveSettings } from "./settings.js";
import { SessionStore, IdbBackend, MemoryBackend } from "./store.js";
import { buildTxt, suggestFilename, suggestTitle } from "./engine/transcript.js";
import { DemoEngine } from "./demo.js";
import { loadQuran } from "./engine/quran.js";
import { UsageTracker } from "./engine/usage.js";
import { PROVIDER_LABEL, providerOf, roleOf } from "./engine/limits.js";
import { debounce, wordCount } from "./util.js";
import { toast } from "./ui/overlay.js";
import * as platform from "./platform.js";

export class App extends Emitter {
  constructor() {
    super();
    this.settings = loadSettings();
    let backend;
    try {
      backend = new IdbBackend();
    } catch {
      backend = new MemoryBackend();
    }
    this.store = new SessionStore(backend);
    this.nav = "live"; // live | library | settings | reader
    this.phase = "idle"; // idle | starting | recording | paused | finishing | finished
    this.entries = [];
    this.session = null;
    this.engine = null;
    this.elapsed = 0;
    this.level = 0;
    this.speaking = false;
    this.health = { level: "idle", text: "" };
    this.isDemo = false;
    this.autoPaused = false;
    this.usage = new UsageTracker();
    this._alerted = new Set();
    this.usage.on(() => this._checkAllowance());
    this.autosave = debounce(() => this._persist(), 1500);
    this.applySettings();
  }

  // ---- settings -----------------------------------------------------------------------------
  applySettings() {
    const s = this.settings;
    const root = document.documentElement;
    root.dataset.theme = s.theme === "light" ? "light" : "dark";
    root.style.setProperty("--text-scale", String(s.textSize));
    document.body.classList.toggle("show-ar", !!s.showArabic);
    platform.setStatusBar(s.theme === "light");
  }

  update(patch) {
    const keysChanged = "groqKey" in patch || "geminiKey" in patch || "preferGemini" in patch || "modelStt" in patch || "modelLlm" in patch || "modelGemini" in patch;
    Object.assign(this.settings, patch);
    saveSettings(this.settings);
    this.applySettings();
    this.emit("settings", patch);
    if (keysChanged && this.engine && this.engine.halted) this.resumeEngine();
  }

  hasKey() {
    return !!(this.settings.groqKey.trim() || this.settings.geminiKey.trim());
  }

  buildRouter() {
    const s = this.settings;
    const providers = {};
    if (s.groqKey.trim()) providers.groq = new GroqProvider(s.groqKey);
    if (s.geminiKey.trim()) providers.gemini = new GeminiProvider(s.geminiKey);
    return new Router(providers, {
      preferGemini: s.preferGemini && !!providers.gemini,
      overrides: { stt: s.modelStt.trim(), llm: s.modelLlm.trim(), gemini: s.modelGemini.trim() },
      onNotice: (n) => this._notice(n),
      usage: this.usage,
    });
  }

  async resumeEngine() {
    const router = this.buildRouter();
    await router.init();
    this.engine.resume(router);
    this._setHealth("ok", "");
    toast("Trying again with your updated key…", { kind: "ok" });
  }

  _notice(n) {
    if (n.code === "ok") return this._setHealth("ok", "");
    if (n.level === "error") this._setHealth("err", n.text);
    else this._setHealth("warn", n.text);
    if (n.text) toast(n.text, { kind: n.level === "error" ? "err" : "warn", ms: 6000 });
  }

  _setHealth(level, text) {
    this.health = { level, text };
    this.emit("health", this.health);
  }

  // ---- navigation ---------------------------------------------------------------------------
  go(screen, extra) {
    this.nav = screen;
    this.emit("nav", { screen, ...extra });
  }

  // ---- recording ----------------------------------------------------------------------------
  get active() {
    return this.phase === "recording" || this.phase === "paused" || this.phase === "finishing" || this.phase === "starting";
  }

  async start({ demo = false } = {}) {
    if (this.active) return;
    if (!demo && !this.hasKey()) {
      this.emit("need-key");
      return;
    }
    this.isDemo = demo;
    this.phase = "starting";
    this.entries = [];
    this.elapsed = 0;
    this._setHealth("idle", "");
    this.emit("phase", this.phase);
    this.emit("entries", this.entries);

    try {
      if (demo) {
        this.engine = new DemoEngine();
      } else {
        const router = this.buildRouter();
        await router.init();
        if (router.exhausted) throw new Error("Your API key was rejected. Check it in Settings → Connection.");
        const quran = this.settings.quranMatching ? await loadQuran() : null;
        const preset = DELAY_PRESETS[this.settings.delay] || DELAY_PRESETS.balanced;
        this.engine = new LectureEngine({ router, settings: this.settings, quran, usage: this.usage, maxParallelStt: preset.parallel || 2 });
        const p = DELAY_PRESETS[this.settings.delay] || DELAY_PRESETS.balanced;
        this.chunker = new Chunker({
          minChunkMs: p.minChunkMs,
          maxChunkMs: p.maxChunkMs,
          endSilenceMs: p.endSilenceMs,
          sensitivityDb: this.settings.sensitivity,
          onChunk: (c) => this.engine.ingestChunk(c),
          onLevel: (l) => this._level(l),
          onSpeech: (s) => {
            this.speaking = s;
            this.emit("speech", s);
          },
        });
        await this._openMic();
      }
    } catch (e) {
      this.phase = "idle";
      this.engine = null;
      this.emit("phase", this.phase);
      toast(e.message || String(e), { kind: "err", ms: 7000 });
      return;
    }

    this.entries = this.engine.entries;
    const on = () => {
      this.emit("entries", this.entries);
      if (!this.isDemo) this.autosave();
    };
    this.engine.on("entry", on);
    this.engine.on("remove", on);
    this.engine.on("notice", (n) => this._notice(n));
    this.engine.on("halt", (m) => this.emit("halt", m));

    this.session = this.store.newSession({ title: suggestTitle(Date.now()), context: this.settings.context });
    this.session.demo = demo;
    if (!demo) await this.store.save(this.session).catch(() => {});
    this.phase = "recording";
    this._startClock();
    platform.keepAwake(true);
    if (!demo) this._service(true);
    this.emit("phase", this.phase);
    this.emit("entries", this.entries);
  }

  /** The "Lisan is listening" foreground service (lets recording continue with the screen off). */
  _service(on) {
    if (on && this.settings.backgroundListening) platform.startListening();
    else if (!on) platform.stopListening();
  }

  async _openMic() {
    this.capture = new MicCapture({
      onSamples: (s) => this.chunker.push(s),
      onError: (msg) => {
        if (this.phase === "recording") {
          this.pause(true);
          this.autoPaused = true; // came back automatically when the app is on screen again
          toast(msg, { kind: "warn", ms: 6000 });
        }
      },
      noiseSuppression: this.settings.noiseSuppression,
      autoGain: this.settings.autoGain,
    });
    await this.capture.start();
  }

  _level(l) {
    this.level = l;
    this.emit("level", l);
  }

  _startClock() {
    clearInterval(this.clock);
    this.clock = setInterval(() => {
      if (this.phase === "recording") {
        this.elapsed += 1;
        this.emit("clock", this.elapsed);
        // the OS can silently stall the microphone; when we are on screen, notice and restart it
        if (this.capture && !this.isDemo && document.visibilityState === "visible" && !this.capture.healthy && !this._restarting) this._restartMic();
      }
    }, 1000);
  }

  async _restartMic() {
    this._restarting = true;
    try {
      if (this.capture && this.capture.ctx && this.capture.ctx.state === "suspended") await this.capture.ctx.resume();
      if (this.capture && this.capture.healthy) return;
      this.capture && this.capture.stop();
      await this._openMic();
    } catch (e) {
      this.pause(true);
      toast(e.message, { kind: "warn" });
    } finally {
      this._restarting = false;
    }
  }

  pause(auto = false) {
    if (this.phase !== "recording") return;
    this.autoPaused = false;
    this.phase = "paused";
    if (this.capture) {
      this.capture.stop();
      this.chunker.flush();
    }
    this.engine.markBreak && this.engine.markBreak();
    this._level(0);
    platform.keepAwake(false);
    this._service(false);
    this.emit("phase", this.phase);
    if (!auto) this.autosave.flush();
  }

  async resume() {
    if (this.phase !== "paused") return;
    try {
      if (!this.isDemo) await this._openMic();
    } catch (e) {
      toast(e.message, { kind: "err" });
      return;
    }
    this.autoPaused = false;
    this.phase = "recording";
    platform.keepAwake(true);
    if (!this.isDemo) this._service(true);
    this.emit("phase", this.phase);
  }

  /** App returned to the foreground: Android may have taken the microphone away meanwhile. */
  async onForeground() {
    if (this.phase === "paused" && this.autoPaused) {
      await this.resume();
      if (this.phase === "recording") toast("Welcome back — listening again.", { kind: "ok", ms: 2500 });
      return;
    }
    if (this.phase === "recording" && this.capture && !this.capture.healthy) await this._restartMic();
    if (this.phase === "recording") platform.keepAwake(true);
  }

  async stop() {
    if (!(this.phase === "recording" || this.phase === "paused")) return;
    this.phase = "finishing";
    this.emit("phase", this.phase);
    clearInterval(this.clock);
    if (this.capture) {
      this.capture.stop();
      this.chunker.flush();
    }
    this._level(0);
    this.speaking = false;
    this.emit("speech", false);
    await this.engine.finish();
    platform.keepAwake(false);
    this._service(false);

    this.session.entries = this.engine.snapshot();
    this.session.durationSec = this.elapsed;
    this.session.active = false;
    this.phase = "finished";
    this.emit("entries", this.entries);
    this.emit("phase", this.phase);

    if (this.isDemo || !this.session.entries.length) {
      if (!this.isDemo) await this.store.remove(this.session.id).catch(() => {});
      toast(this.isDemo ? "That was the demo — press the mic to translate a real lecture." : "Nothing was heard, so nothing was saved.", { ms: 5000 });
      return;
    }
    await this.store.save(this.session).catch(() => {});
    if (this.settings.autoSave) {
      try {
        const r = await this.exportFile(this.session, "txt");
        toast(r.where === "downloads" ? `Saved to ${r.path}` : "Transcript ready", {
          kind: "ok",
          ms: 7000,
          action: "Share",
          onAction: () => this.exportShare(this.session),
        });
      } catch (e) {
        toast("Lecture saved in your Library (couldn't write the .txt file).", { kind: "warn" });
      }
    } else {
      toast("Lecture saved in your Library.", { kind: "ok" });
    }
  }

  /** Stop right now and throw the lecture away: nothing is saved, no .txt is written. */
  async discard() {
    if (!(this.phase === "recording" || this.phase === "paused")) return;
    clearInterval(this.clock);
    this.autosave.cancel();
    if (this.capture) this.capture.stop();
    if (this.engine) this.engine.stop(); // cancels requests still in flight
    platform.keepAwake(false);
    this._service(false);
    const id = this.session && !this.isDemo ? this.session.id : null;
    this.session = null;
    this.engine = null;
    this.entries = [];
    this.elapsed = 0;
    this.speaking = false;
    this.phase = "idle";
    if (id) await this.store.remove(id).catch(() => {});
    this._level(0);
    this.emit("speech", false);
    this.emit("phase", this.phase);
    this.emit("entries", this.entries);
    toast("Lecture deleted. Nothing was saved.", { ms: 3500 });
  }

  /** Warn once when a free allowance is getting used up (80 % and 95 %). */
  _checkAllowance() {
    clearTimeout(this._allowanceTimer);
    this._allowanceTimer = setTimeout(() => {
      for (const id of this.usage.usedIds()) {
        for (const r of this.usage.rows(id)) {
          if (r.frac == null) continue;
          for (const level of [0.95, 0.8]) {
            const key = `${id}|${r.key}|${level}|${Math.floor(Date.now() / 3600000)}`;
            if (r.frac >= level) {
              if (!this._alerted.has(key)) {
                this._alerted.add(key);
                const what = roleOf(id) === "Speech" ? "speech" : "translation";
                const backup = this.settings.geminiKey.trim() && providerOf(id) === "groq" ? " Gemini will take over if you added its key." : "";
                toast(`${PROVIDER_LABEL[providerOf(id)] || providerOf(id)} ${what} allowance is ${Math.round(r.frac * 100)}% used (${r.label.toLowerCase()}).${backup}`, { kind: "warn", ms: 7000 });
              }
              break;
            }
          }
        }
      }
    }, 2000);
  }

  newLecture() {
    this.entries = [];
    this.session = null;
    this.engine = null;
    this.phase = "idle";
    this.elapsed = 0;
    this.emit("phase", this.phase);
    this.emit("entries", this.entries);
  }

  retryEntry(id) {
    this.engine && this.engine.retry(id);
  }

  async _persist() {
    if (!this.session || this.isDemo || !this.engine) return;
    this.session.entries = this.engine.snapshot();
    this.session.durationSec = this.elapsed;
    await this.store.save(this.session).catch(() => {});
  }

  /** A lecture that was still recording when the app died: finish it so nothing is lost. */
  async recoverInterrupted() {
    const s = await this.store.findInterrupted().catch(() => null);
    if (!s || this.active) return null;
    await this.store.markFinished(s);
    return s;
  }

  // ---- export -------------------------------------------------------------------------------
  txtFor(session) {
    return buildTxt(session, { includeArabic: this.settings.saveArabic, timestamps: this.settings.saveTimestamps });
  }

  exportFile(session, ext = "txt") {
    return platform.saveTextFile(suggestFilename(session, ext), this.txtFor(session));
  }

  exportShare(session) {
    return platform.shareTextFile(suggestFilename(session), this.txtFor(session), "text/plain", session.title);
  }

  async exportCopy(session) {
    const ok = await platform.copyText(this.txtFor(session));
    toast(ok ? "Transcript copied" : "Couldn't copy", { kind: ok ? "ok" : "err", ms: 2500 });
  }

  stats(session) {
    const words = (session.entries || []).reduce((n, e) => n + wordCount(e.en), 0);
    return { words };
  }
}
