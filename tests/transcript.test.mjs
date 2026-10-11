import test from "node:test";
import assert from "node:assert/strict";
import { groupEntries, buildTxt, suggestFilename, mergeRefs } from "../www/js/engine/transcript.js";
import { SessionStore, MemoryBackend } from "../www/js/store.js";

const E = (id, t0, t1, kind, ar, en) => ({ id, t0, t1, kind, ar, en, state: "done" });

test("a paragraph is one speaker's whole turn: only a change of speaker starts a new one", () => {
  const g = groupEntries([
    E("1", 0, 4, "lecture", "أ", "One."),
    E("2", 4.5, 8, "lecture", "ب", "Two."),
    E("3", 9, 12, "interpreter", "", "Interpreter."),
    E("4", 13, 16, "interpreter", "", "Interpreter again after a pause."),
    E("5", 40, 44, "interpreter", "", "And again, much later, still the interpreter."),
    E("6", 45, 48, "lecture", "ج", "Three."),
    E("7", 60, 64, "lecture", "د", "Four after a pause."),
  ]);
  assert.deepEqual(g.map((x) => [x.kind, x.entries.map((e) => e.id).join("")]), [["lecture", "12"], ["interpreter", "345"], ["lecture", "67"]]);
});

test("a chunk that is still being transcribed does not cut the turn around it in two", () => {
  const pendingOne = { id: "p", t0: 12, t1: 16, kind: "lecture", ar: "", en: "", state: "transcribing" };
  const failed = { id: "f", t0: 20, t1: 24, kind: "lecture", ar: "", en: "", state: "error", error: "No connection" };
  const g = groupEntries([
    E("1", 0, 4, "interpreter", "", "The interpreter begins"),
    pendingOne,
    E("3", 17, 20, "interpreter", "", "and carries on."),
    failed,
    E("5", 25, 28, "interpreter", "", "Still the interpreter."),
  ]);
  assert.equal(g.length, 1, "one interpreter block, with placeholders inside it");
  assert.deepEqual(g[0].entries.map((e) => e.id), ["1", "p", "3", "f", "5"]);
  // once it turns out to be the sheikh, it moves to its own block and the interpreter's turn is still in one piece
  const resolved = groupEntries([E("1", 0, 4, "interpreter", "", "The interpreter begins"), { ...pendingOne, kind: "lecture", ar: "كلام", en: "Words.", state: "done" }, E("3", 17, 20, "interpreter", "", "and carries on.")]);
  assert.deepEqual(resolved.map((x) => x.kind), ["interpreter", "lecture", "interpreter"]);
  // a pending chunk with nothing before it still gets somewhere to live
  assert.equal(groupEntries([pendingOne]).length, 1);
  // a recording pause still starts a fresh paragraph
  const paused = groupEntries([E("1", 0, 4, "lecture", "أ", "One."), { ...E("2", 100, 104, "lecture", "ب", "Two."), breakBefore: true }]);
  assert.equal(paused.length, 2);
});

test("only a very long turn is paragraphed, and only where a sentence ends", () => {
  const sentence = (id, i) => E(String(id), i * 10, i * 10 + 9, "lecture", "ك", ("word ".repeat(49) + "end.").trim());
  const many = Array.from({ length: 30 }, (_, i) => sentence(i, i)); // 30 sentences of 50 words = 1500 words
  const g = groupEntries(many);
  assert.ok(g.length >= 2 && g.length <= 3, `got ${g.length}`);
  assert.ok(g.slice(0, -1).every((x) => x.words <= 650), "breaks come soon after the soft limit");
  // mid-sentence text is never cut at the soft limit
  const unfinished = Array.from({ length: 14 }, (_, i) => E(String(i), i * 10, i * 10 + 9, "lecture", "ك", "word ".repeat(50).trim()));
  assert.equal(groupEntries(unfinished).length, 1, "700 words but no sentence has ended");
  // a long silence after a finished sentence is a new paragraph
  const silence = groupEntries([E("1", 0, 4, "lecture", "أ", "Finished."), E("2", 200, 204, "lecture", "ب", "After a long silence.")]);
  assert.equal(silence.length, 2);
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
