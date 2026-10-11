import test from "node:test";
import assert from "node:assert/strict";
import { groupEntries, buildTxt, suggestFilename, mergeRefs } from "../www/js/engine/transcript.js";
import { SessionStore, MemoryBackend } from "../www/js/store.js";

const E = (id, t0, t1, kind, ar, en) => ({ id, t0, t1, kind, ar, en, state: "done" });

test("entries flow into paragraphs: speaker changes and long pauses start new ones", () => {
  const g = groupEntries([
    E("1", 0, 4, "lecture", "أ", "One."),
    E("2", 4.5, 8, "lecture", "ب", "Two."),
    E("3", 9, 12, "interpreter", "", "Interpreter."),
    E("4", 13, 16, "lecture", "ج", "Three."),
    E("5", 25, 28, "lecture", "د", "Four after a long pause."),
  ]);
  assert.deepEqual(g.map((x) => x.entries.map((e) => e.id).join("")), ["12", "3", "4", "5"]);
});

test("paragraphs are capped so they stay readable", () => {
  const many = Array.from({ length: 14 }, (_, i) => E(String(i), i * 4, i * 4 + 3.5, "lecture", "ك", "word ".repeat(4) + "word."));
  assert.ok(groupEntries(many).length >= 3);
});

test("txt export: header, timestamps, English first then Arabic, sheikh and interpreter labelled", () => {
  const session = {
    title: "Seerah — Week 3",
    startedAt: Date.UTC(2026, 9, 10, 14, 32),
    durationSec: 3725,
    context: "Shaykh X, Seerah series",
    entries: [
      E("1", 3, 8, "lecture", "بسم الله", "In the name of Allah."),
      E("2", 8.5, 12, "lecture", "الحمد لله", "All praise is due to Allah."),
      E("3", 65, 70, "interpreter", "", "The Sheikh thanked everyone for coming."),
    ],
  };
  const txt = buildTxt(session);
  assert.ok(txt.includes("Title:    Seerah — Week 3"));
  assert.ok(txt.includes("Duration: 1 h 02 min"));
  assert.ok(txt.includes("[00:00:03] SHEIKH\nIn the name of Allah. All praise is due to Allah.\n‏بسم الله الحمد لله"));
  assert.ok(txt.includes("[00:01:05] INTERPRETER\nThe Sheikh thanked everyone for coming."));
  assert.ok(txt.trim().endsWith("— end of transcript —"));
  const plain = buildTxt(session, { includeArabic: false, timestamps: false });
  assert.ok(!plain.includes("بسم"));
  assert.ok(!plain.includes("[00:"));
  assert.ok(plain.includes("\nSHEIKH\nIn the name of Allah."), "the speaker label stays even without timestamps");
  assert.ok(plain.includes("\nINTERPRETER\nThe Sheikh thanked everyone for coming."));
  assert.match(suggestFilename(session), /^Seerah-Week-3_2026-10-10_\d\d-\d\d\.txt$/); // custom title is used
  assert.match(suggestFilename({ ...session, title: "Lecture — 10 Oct 2026, 14:32" }), /^lecture_2026-10-10_\d\d-\d\d\.txt$/); // default title -> "lecture"
});

test("session store: save, list newest first, recover an interrupted lecture", async () => {
  const store = new SessionStore(new MemoryBackend());
  const a = store.newSession({ title: "A", startedAt: 1000 });
  const b = store.newSession({ title: "B", startedAt: 2000 });
  a.entries.push(E("1", 0, 1, "lecture", "ا", "A."));
  b.entries.push(E("2", 0, 1, "lecture", "ب", "B."));
  await store.save(a);
  await store.save(b);
  assert.deepEqual((await store.list()).map((s) => s.title), ["B", "A"]);
  assert.equal((await store.findInterrupted()).title, "B");
  await store.markFinished(b);
  assert.equal((await store.findInterrupted()).title, "A");
  await store.remove(a.id);
  assert.equal((await store.list()).length, 1);
});

test("undo after delete: a removed lecture can be put back unchanged", async () => {
  const store = new SessionStore(new MemoryBackend());
  const s = store.newSession({ title: "Keep me", startedAt: 5000 });
  s.entries.push(E("1", 0, 1, "lecture", "ا", "Words."));
  await store.save(s);
  const copy = (await store.list())[0];
  await store.remove(s.id);
  assert.equal((await store.list()).length, 0);
  await store.save(copy);
  const back = (await store.list())[0];
  assert.equal(back.title, "Keep me");
  assert.equal(back.entries[0].en, "Words.");
});

test("txt export tags Qur'an passages", () => {
  const session = { title: "T", startedAt: 0, durationSec: 60, entries: [
    { id: "1", t0: 0, t1: 5, kind: "lecture", ar: "تبت يدا أبي لهب وتب", en: "Perish the hands of Abu Lahab, and perish he.", quran: [{ label: "Al-Masad 111:1" }], state: "done" } ] };
  assert.ok(buildTxt(session).includes("[00:00:00] SHEIKH\n(Qur'an: Al-Masad 111:1)\nPerish the hands"));
});

test("a block changes identity when its speaker kind changes (no stale styling)", () => {
  const before = groupEntries([E("a", 0, 4, "lecture", "", "")])[0].key;
  const after = groupEntries([E("a", 0, 4, "interpreter", "", "Hello.")])[0].key;
  assert.notEqual(before, after);
});

test("Qur'an references of a paragraph merge into one range", () => {
  const r = (surah, from, to) => ({ surah, name: "Al-Masad", from, to, label: `Al-Masad ${surah}:${from}` });
  assert.deepEqual(mergeRefs([r(111, 1, 1), r(111, 2, 5), r(111, 5, 5)]), ["Al-Masad 111:1–5"]);
  assert.deepEqual(mergeRefs([r(111, 1, 2), { surah: 112, name: "Al-Ikhlas", from: 1, to: 2, label: "x" }]), ["Al-Masad 111:1–2", "Al-Ikhlas 112:1–2"]);
  assert.deepEqual(mergeRefs([r(111, 1, 1), r(111, 4, 5)]), ["Al-Masad 111:1", "Al-Masad 111:4–5"], "gaps are not merged");
  assert.deepEqual(mergeRefs([{ label: "Al-Ikhlas 112:1–2" }, { label: "Al-Ikhlas 112:1–2" }]), ["Al-Ikhlas 112:1–2"], "refs without numbers (demo) stay as written");
  assert.deepEqual(mergeRefs(undefined), []);
});
