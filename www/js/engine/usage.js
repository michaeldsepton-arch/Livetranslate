// Tracks how much of the free allowance this phone has used, per model, and paces requests.
// Counts are kept in one-minute buckets (so a 3-hour lecture is a few hundred numbers) and survive restarts.
import { limitsFor, providerOf } from "./limits.js";

const MIN = 60000;
const HOUR = 3600000;
const DAY = 24 * HOUR;
const KEEP_MS = 48 * HOUR;

/** Start of the current calendar day in a time zone, as epoch ms (Gemini's daily quota resets at midnight Pacific). */
export function startOfDayInTz(ms, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(ms);
  const get = (t) => +parts.find((p) => p.type === t).value;
  const wallNow = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  const offset = wallNow - Math.floor(ms / 1000) * 1000;
  return Date.UTC(get("year"), get("month") - 1, get("day")) - offset;
}

export class UsageTracker {
  constructor({ storage = globalThis.localStorage, now = Date.now, key = "lt.usage.v1" } = {}) {
    this.storage = storage;
    this.now = now;
    this.key = key;
    this.byId = {}; // id -> { minuteEpoch: [requests, audioSeconds, tokens] }
    this.reported = {}; // id -> numbers the service itself reported (response headers)
    this.recent = {}; // id -> timestamps of requests in the last minute (for pacing)
    this.paid = {}; // provider -> true when the account is on a paid plan (free-tier limits do not apply)
    this.listeners = new Set();
    this._timer = null;
    this._load();
  }

  _load() {
    try {
      const raw = this.storage && this.storage.getItem(this.key);
      if (raw) {
        const d = JSON.parse(raw);
        this.byId = d.b || {};
        this.reported = d.r || {};
      }
    } catch {}
    this._prune();
  }

  _save() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      try {
        this.storage && this.storage.setItem(this.key, JSON.stringify({ v: 1, b: this.byId, r: this.reported }));
      } catch {}
    }, 1500);
  }

  _prune() {
    const cutoff = Math.floor((this.now() - KEEP_MS) / MIN);
    for (const id of Object.keys(this.byId)) {
      for (const m of Object.keys(this.byId[id])) if (+m < cutoff) delete this.byId[id][m];
      if (!Object.keys(this.byId[id]).length) delete this.byId[id];
    }
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Called when a request is about to be sent (so parallel requests are paced correctly). */
  touch(id) {
    const t = this.now();
    const list = (this.recent[id] ||= []);
    list.push(t);
    while (list.length && list[0] < t - MIN) list.shift();
  }

  /** Called after a request succeeded. */
  record(id, { audio = 0, tokens = 0 } = {}) {
    const minute = Math.floor(this.now() / MIN);
    const b = ((this.byId[id] ||= {})[minute] ||= [0, 0, 0]);
    b[0] += 1;
    b[1] += audio;
    b[2] += tokens;
    this._save();
    this.listeners.forEach((fn) => fn(id));
  }

  setReported(id, rep) {
    if (!rep) return;
    this.reported[id] = { ...rep, at: this.now() };
    this._save();
  }

  /** Sum of a field (0 requests, 1 audio seconds, 2 tokens) since a timestamp. */
  sumSince(id, field, since) {
    const b = this.byId[id];
    if (!b) return 0;
    const first = Math.floor(since / MIN);
    let n = 0;
    for (const m of Object.keys(b)) if (+m >= first) n += b[m][field];
    return n;
  }

  /** Free-tier limits for a model, or none when that account is on a paid plan. */
  limits(id) {
    return this.paid[providerOf(id)] ? {} : limitsFor(id);
  }

  /** Start of this model's "today" window: rolling 24 h for Groq, calendar day (Pacific) for Gemini. */
  dayStart(id) {
    return providerOf(id) === "gemini" ? startOfDayInTz(this.now(), "America/Los_Angeles") : this.now() - DAY;
  }

  /** ms until another request to `id` stays politely under its per-minute limit (0 = go now). */
  pace(id) {
    const rpm = this.limits(id).rpm;
    if (!rpm) return 0;
    const cap = Math.max(1, Math.floor(rpm * 0.9));
    const t = this.now();
    const list = (this.recent[id] || []).filter((x) => x > t - MIN);
    this.recent[id] = list;
    if (list.length < cap) return 0;
    return Math.max(0, list[list.length - cap] + MIN - t) + 50;
  }

  /** Models that have been used in the last day. */
  usedIds() {
    const t = this.now();
    return Object.keys(this.byId).filter((id) => this.sumSince(id, 0, Math.min(this.dayStart(id), t - HOUR)) > 0);
  }

  /** Rows for the usage screen: each {key,label,used,limit,unit,frac|null,reported}. */
  rows(id) {
    const t = this.now();
    const L = this.limits(id);
    const day = this.dayStart(id);
    const rep = this.reported[id];
    const out = [];
    const row = (key, label, used, limit, unit, extra = {}) => out.push({ key, label, used, limit: limit || null, unit, frac: limit ? Math.min(1, used / limit) : null, ...extra });
    const isSpeech = !!L.ash;
    if (isSpeech) {
      row("ash", "This hour", this.sumSince(id, 1, t - HOUR), L.ash, "sec");
      row("asd", "Today", this.sumSince(id, 1, day), L.asd, "sec");
    } else {
      const usedTokens = this.sumSince(id, 2, day);
      if (L.tpd || usedTokens) row("tpd", "Tokens today", usedTokens, L.tpd, "tokens");
    }
    const reqUsed = this.sumSince(id, 0, day);
    if (rep && rep.limitRequests && rep.remainingRequests != null && t - rep.at < 2 * HOUR) {
      row("rpd", "Requests today", Math.max(reqUsed, rep.limitRequests - rep.remainingRequests), rep.limitRequests, "count", { reported: true });
    } else row("rpd", "Requests today", reqUsed, L.rpd, "count");
    return out;
  }

  /** The most-used known limit across the given models: { frac, label, id } or null. */
  headline(ids) {
    let best = null;
    for (const id of ids)
      for (const r of this.rows(id))
        if (r.frac != null && (!best || r.frac > best.frac)) best = { frac: r.frac, label: r.label, id, key: r.key };
    return best;
  }

  /**
   * Minutes of lecture until this model's free limit, at the pace of the last 10 minutes *while recording*:
   * speech models -> the hourly or daily audio limit (whichever comes first); translation models -> the daily token limit.
   * null when there is no recent activity or no known limit.
   */
  minutesLeft(id) {
    const L = this.limits(id);
    const t = this.now();
    const b = this.byId[id] || {};
    const first = Math.floor((t - 10 * MIN) / MIN);
    const activeMinutes = (field) => Object.keys(b).filter((m) => +m >= first && b[m][field] > 0).length;
    const paceOf = (field) => {
      const active = activeMinutes(field);
      return active ? this.sumSince(id, field, t - 10 * MIN) / active : 0;
    };
    if (L.asd && L.ash) {
      const perMin = paceOf(1);
      if (perMin <= 0) return null;
      const leftHour = L.ash - this.sumSince(id, 1, t - HOUR);
      const leftDay = L.asd - this.sumSince(id, 1, this.dayStart(id));
      return Math.max(0, Math.floor(Math.min(leftHour, leftDay) / perMin));
    }
    if (L.tpd) {
      const perMin = paceOf(2);
      if (perMin <= 0) return null;
      return Math.max(0, Math.floor((L.tpd - this.sumSince(id, 2, this.dayStart(id))) / perMin));
    }
    return null;
  }

  clear() {
    this.byId = {};
    this.reported = {};
    this.recent = {};
    this._save();
    this.listeners.forEach((fn) => fn(null));
  }
}
