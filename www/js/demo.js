// A scripted sample lecture so the app can be tried (and demonstrated) without any API key.
// Behaves like LectureEngine: same entry shapes, same events, same "commit once" life-cycle.
import { Emitter } from "./engine/session-engine.js";
import { uid, sleep } from "./util.js";

export const DEMO_SCRIPT = [
  { kind: "lecture", dur: 5.5, ar: "بسم الله الرحمن الرحيم، الحمد لله رب العالمين، والصلاة والسلام على نبينا محمد وعلى آله وصحبه أجمعين.", en: "In the name of Allah, the Most Gracious, the Most Merciful. All praise is due to Allah, Lord of the worlds, and may peace and blessings be upon our Prophet Muhammad ﷺ, and upon his family and all his companions." },
  { kind: "lecture", dur: 5, ar: "أيها الإخوة والأخوات، موضوع محاضرتنا اليوم هو الإخلاص، وهو أساس قبول الأعمال عند الله سبحانه وتعالى.", en: "Dear brothers and sisters, the topic of our lecture today is ikhlas (sincerity), which is the foundation for deeds being accepted by Allah, glorified and exalted is He." },
  { kind: "interpreter", dur: 6, en: "Good evening everyone. The Sheikh began by praising Allah and sending blessings on the Prophet, and said that tonight's topic is sincerity." },
  { kind: "lecture", dur: 8, ar: "روى الإمام البخاري في صحيحه عن أمير المؤمنين عمر بن الخطاب رضي الله عنه قال: سمعت رسول الله صلى الله عليه وسلم يقول: إنما الأعمال بالنيات، وإنما لكل امرئ ما نوى.", en: "Imam al-Bukhari narrated in his Sahih, on the authority of the Commander of the Believers, Umar ibn al-Khattab (RA), who said: I heard the Messenger of Allah ﷺ say: “Deeds are only by intentions, and every person will have only what they intended.”" },
  { kind: "lecture", dur: 5, ar: "فالنية هي روح العمل، وبها تتميز العادة من العبادة، والطاعة من المعصية.", en: "For intention (niyyah) is the soul of every deed. By it, habit is distinguished from worship, and obedience from disobedience." },
  { kind: "lecture", dur: 5, ar: "ولهذا كان السلف الصالح يهتمون بتصحيح النية أكثر من اهتمامهم بكثرة العمل.", en: "That is why the righteous predecessors (the salaf) cared more about correcting their intention than about the quantity of their deeds." },
  { kind: "interpreter", dur: 5, en: "He is explaining the famous hadith about intentions, narrated by Umar, may Allah be pleased with him." },
  { kind: "lecture", dur: 6, ar: "قال ابن المبارك رحمه الله: رب عمل صغير تكبره النية، ورب عمل كبير تصغره النية.", en: "Ibn al-Mubarak (RH) said: “How many a small deed is made great by the intention, and how many a great deed is made small by the intention.”" },
];

export class DemoEngine extends Emitter {
  constructor({ speed = 1 } = {}) {
    super();
    this.entries = [];
    this.speed = speed;
    this.timers = new Set();
    this.stopped = false;
    this.clock = 0;
    this.run = this._run();
  }

  _wait(ms) {
    return new Promise((res) => {
      const t = setTimeout(() => (this.timers.delete(t), res()), ms / this.speed);
      this.timers.add(t);
    });
  }

  async _run() {
    for (const [i, s] of DEMO_SCRIPT.entries()) {
      if (this.stopped) return;
      const e = { id: uid("d"), seq: i + 1, t0: this.clock, t1: this.clock + s.dur - 0.5, kind: s.kind, ar: "", en: "", state: "transcribing" };
      this.clock += s.dur;
      await this._wait(s.dur * 1000 * 0.7); // the sheikh speaks…
      if (this.stopped) return;
      this.entries.push(e);
      this.emit("entry", e);
      await this._wait(900); // …speech-to-text
      if (this.stopped) return;
      if (s.kind === "interpreter") {
        Object.assign(e, { en: s.en, state: "done" });
        this.emit("entry", e);
        continue;
      }
      Object.assign(e, { ar: s.ar, state: "awaiting" });
      this.emit("entry", e);
      await this._wait(1800); // …waits briefly for the next sentence (look-ahead)
      if (this.stopped) return;
      e.state = "translating";
      this.emit("entry", e);
      await this._wait(900);
      if (this.stopped) return;
      Object.assign(e, { en: s.en, state: "done" });
      this.emit("entry", e);
    }
  }

  retry() {}
  markBreak() {}
  resume() {}
  async finish() {
    this.speed = 40;
    await this.run;
    this.stop();
  }
  stop() {
    this.stopped = true;
    this.timers.forEach(clearTimeout);
  }
  snapshot() {
    return this.entries.filter((e) => e.state === "done").map(({ id, seq, t0, t1, kind, ar, en }) => ({ id, seq, t0, t1, kind, ar, en, state: "done" }));
  }
}
