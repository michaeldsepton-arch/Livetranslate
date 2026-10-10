import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { QuranIndex } from "../www/js/engine/quran.js";
import { englishScore, looksLikeEnglish } from "../www/js/engine/english.js";
import { normalizeArabic } from "../www/js/engine/arabic.js";

const data = JSON.parse(readFileSync(new URL("../www/data/quran-ar.json", import.meta.url)));
const quran = new QuranIndex(data);
const norm = (s) => normalizeArabic(s);

test("data set is complete: 114 surahs, 6236 verses", () => {
  assert.equal(data.s.length, 114);
  assert.equal(data.s.reduce((n, s) => n + s.v.length, 0), 6236);
  assert.equal(quran.verses.length, 6236);
});

test("the exact text from the phone screenshot (Al-Masad, mis-heard) is repaired and tagged", () => {
  // what Whisper produced: "ماله" heard as "معنه", "نارا" as "نار", the rest partly diacritised
  const heard = "ما أغنى عنه معنه وما كسب، سيصلى نار ذات لهب، وَامْرَأَتُهُ حَمَّالَةَ الْحَطَابِ فِي جِيدِهَا";
  const r = quran.annotate(heard);
  assert.ok(r, "should recognise it");
  assert.equal(r.refs[0].label, "Al-Masad 111:2–5");
  assert.equal(norm(r.text), norm("ما أغنى عنه ماله وما كسب سيصلى نارا ذات لهب وامرأته حمالة الحطب في جيدها"));
  assert.ok(r.text.includes("مَالُهُۥ"), "canonical diacritised word restored");
  assert.ok(!norm(r.text).includes("معنه"));
});

test("a short, exact recitation is recognised", () => {
  const r = quran.annotate("تبت يدا أبي لهب وتب");
  assert.equal(r.refs[0].label, "Al-Masad 111:1");
  assert.equal(norm(r.text), norm("تبت يدا أبي لهب وتب"));
});

test("a verse quoted inside a lecture sentence: only the quote is replaced", () => {
  const r = quran.annotate("قال الله تعالى في كتابه العزيز قل هو الله احد الله الصمد ثم قال الشيخ وهذا يدل على التوحيد");
  assert.ok(r);
  assert.equal(r.refs[0].name, "Al-Ikhlas");
  assert.equal(r.refs[0].label, "Al-Ikhlas 112:1–2");
  assert.ok(norm(r.text).startsWith(norm("قال الله تعالى في كتابه العزيز")), "lead-in kept");
  assert.ok(norm(r.text).endsWith("التوحيد"), "tail kept");
  assert.ok(r.text.includes(data.s[111].v[0]) && r.text.includes(data.s[111].v[1]), "verse words restored exactly, with diacritics");
});

test("not Qur'an: lecture speech, hadith and the Basmala are left alone", () => {
  assert.equal(quran.annotate("أيها الإخوة والأخوات موضوع محاضرتنا اليوم هو الإخلاص وهو أساس قبول الأعمال"), null);
  assert.equal(quran.annotate("إنما الأعمال بالنيات وإنما لكل امرئ ما نوى"), null);
  assert.equal(quran.annotate("بسم الله الرحمن الرحيم"), null);
  assert.equal(quran.annotate("نعم"), null);
});

test("recitation that continues across chunks: the next word position is returned", () => {
  const a = quran.annotate("تبت يدا أبي لهب وتب ما أغنى عنه ماله وما كسب");
  assert.equal(a.refs[0].label, "Al-Masad 111:1–2");
  assert.ok(a.next != null);
  const b = quran.annotate("سيصلى نارا ذات لهب وامرأته حمالة الحطب", a.next);
  assert.equal(b.refs[0].label, "Al-Masad 111:3–4");
});

test("heavily repeated verse (Ar-Rahman): where the recitation had reached picks the right one", () => {
  const first = quran.annotate("الشمس والقمر بحسبان والنجم والشجر يسجدان والسماء رفعها ووضع الميزان ألا تطغوا في الميزان وأقيموا الوزن بالقسط ولا تخسروا الميزان والأرض وضعها للأنام فيها فاكهة والنخل ذات الأكمام والحب ذو العصف والريحان");
  assert.equal(first.refs[0].label, "Ar-Rahman 55:5–12");
  const r = quran.annotate("فبأي آلاء ربكما تكذبان", first.next);
  assert.ok(r);
  assert.equal(r.refs[0].label, "Ar-Rahman 55:13");
});

test("English plausibility: real English vs Arabic written in Latin letters", () => {
  assert.ok(looksLikeEnglish("Hello, how are you?"));
  assert.ok(looksLikeEnglish("Good evening everyone. The Sheikh praised Allah and sent blessings on the Prophet."));
  assert.ok(!looksLikeEnglish("Tabbat yada abin habin wa tabba"));
  assert.ok(!looksLikeEnglish("abenumassada. Al Fatiha."));
  assert.ok(!looksLikeEnglish("Alhamdulillahi rabbil alamin"));
  assert.ok(looksLikeEnglish("Thank you."));
  assert.ok(englishScore("the cat is on the mat") > 0.6);
});

test("phrases that occur all over the Qur'an are not pinned to a made-up verse", () => {
  assert.equal(quran.annotate("لا إله إلا الله وحده"), null);
  assert.equal(quran.annotate("الحمد لله رب العالمين"), null);
  assert.equal(quran.annotate("فبأي آلاء ربكما تكذبان"), null);
  // but a longer, unambiguous stretch of the same surah is recognised
  const r = quran.annotate("الحمد لله رب العالمين الرحمن الرحيم مالك يوم الدين");
  assert.equal(r.refs[0].label, "Al-Fatihah 1:2–4");
});
