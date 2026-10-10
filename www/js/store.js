// Saved lectures.  IndexedDB in the app (plenty of room, survives restarts); an in-memory
// backend is used by the tests.  The active lecture is auto-saved while recording, so a crash,
// a dead battery or an accidental swipe never loses the transcript.
import { uid } from "./util.js";

export class MemoryBackend {
  constructor() {
    this.m = new Map();
  }
  async get(k) {
    return this.m.get(k);
  }
  async set(k, v) {
    this.m.set(k, JSON.parse(JSON.stringify(v)));
  }
  async del(k) {
    this.m.delete(k);
  }
  async all() {
    return [...this.m.values()].map((v) => JSON.parse(JSON.stringify(v)));
  }
}

export class IdbBackend {
  constructor(name = "livetranslate") {
    this.dbp = new Promise((res, rej) => {
      const r = indexedDB.open(name, 1);
      r.onupgradeneeded = () => r.result.createObjectStore("sessions");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  async _tx(mode, fn) {
    const db = await this.dbp;
    return new Promise((res, rej) => {
      const tx = db.transaction("sessions", mode);
      const out = fn(tx.objectStore("sessions"));
      tx.oncomplete = () => res(out && out.result);
      tx.onerror = () => rej(tx.error);
    });
  }
  get(k) {
    return this._tx("readonly", (s) => s.get(k));
  }
  set(k, v) {
    return this._tx("readwrite", (s) => s.put(v, k));
  }
  del(k) {
    return this._tx("readwrite", (s) => s.delete(k));
  }
  all() {
    return this._tx("readonly", (s) => s.getAll());
  }
}

export class SessionStore {
  constructor(backend) {
    this.b = backend;
  }

  newSession({ title, context = "", startedAt = Date.now() }) {
    return { id: uid("s"), title, context, startedAt, durationSec: 0, entries: [], active: true, version: 1 };
  }

  save(session) {
    return this.b.set(session.id, session);
  }

  get(id) {
    return this.b.get(id);
  }

  remove(id) {
    return this.b.del(id);
  }

  /** Newest first. */
  async list() {
    const all = await this.b.all();
    return all.filter(Boolean).sort((a, b) => b.startedAt - a.startedAt);
  }

  /** A lecture that was still "active" when the app last closed (crash / swipe-away). */
  async findInterrupted() {
    return (await this.list()).find((s) => s.active && s.entries.length > 0) || null;
  }

  async markFinished(session) {
    session.active = false;
    await this.save(session);
  }
}
