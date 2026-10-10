# Lisan · لسان

<img src="assets-src/icon-1024.png" width="96" align="right" alt="Lisan icon">

*Lisan* is Arabic for “tongue” and “language”.

**A free Android app that translates an Arabic lecture into smooth, steady English as it happens.**
Press the microphone, put the phone near the speaker, read along. Everything is saved as a transcript (`.txt`).

Built because the usual translators flip-flop between versions of a sentence, mangle Islamic terms and names,
and get confused when an English interpreter starts speaking.

## What it does

| You asked for | How it is done |
|---|---|
| **Press a mic button, nothing else** | One big button starts and stops. The lecture is auto-saved while recording, so nothing is lost if the phone dies. |
| **A few seconds behind, so it has context — no choppy, changing text** | Each sentence is held briefly so the translator can see the *next* sentence too, then shown **once and never rewritten**. Four presets: **Instant (~3–4 s behind)**, Quick (~6 s), Balanced (~10 s, default), Smooth (~15 s). Instant translates every couple of seconds — a little more fragmentary, and it uses the free allowance about three times faster. |
| **Understands Islamic terms and names** | Whisper large-v3 for the Arabic, primed with a religious-lecture vocabulary. A built-in glossary of **~500** terms, prophets, Companions, scholars, places, books and all 114 surahs is handed to the translator whenever it appears. You can add your own names in *Settings → My names & terms*, and describe the lecture ("Seerah class by Shaykh X") for extra context. |
| **A continuous script for the whole lecture** | Sentences flow into paragraphs with timestamps; the screen follows the lecture, and you can scroll back without losing your place. |
| **An English interpreter speaks too** | Every audio chunk is language-detected. English is shown as **Interpreter** text (italic, gold bar) and is never re-translated; Arabic is translated. The interpreter's words are also given to the translator as context for the next Arabic passage. |
| **Save the transcript as a text file** | When you stop, a `.txt` is written to **Downloads/Lisan** (and kept in the in-app **Library**). Share, copy, rename, re-export or delete any lecture later (delete has an Undo; long-press to select several). |
| **Free** | Uses the free tiers of Groq (Whisper + an open LLM) and, optionally, Google Gemini. No subscription, no card. You choose the engine for hearing (Whisper large-v3, Whisper **turbo**, or **Gemini**) and for translating (Groq or Gemini) separately in *Settings → Connection*, and the **Speech test** lets you compare them on the same clip. |
| **Qur'an recitation** | Recited verses are recognised against the full text of the Qur'an: the exact Arabic (with diacritics) replaces any mis-heard words, the surah and verse are tagged (e.g. *Al-Masad 111:2–5*), and the translator is told it is translating the Qur'an so it gives the true meaning. Works for verses quoted inside a lecture too. Can be switched off in Settings. |
| **Know your free limits** | *Settings → Free allowance* (and a chip while recording) shows, per model, how much of the free Groq / Gemini allowance this phone has used — speech minutes this hour and today, requests, tokens — with a warning at 80 % and 95 %, an estimate of how long it will last at your current pace, and links to the official usage pages. It also paces requests so short chunks don't hit the per-minute limit. |
| **Only words are transliterated** | Single Islamic terms and names stay as words (taqwa, salah, hadith…) plus a few short expressions (Alhamdulillah, InshaAllah…). Sentences, verses and supplications are always translated; if the translator ever transliterates a sentence it is asked again. |
| **Fusha, with the odd Saudi word** | The translator is told the speaker uses Modern Standard Arabic and may slip into Saudi (Najdi/Hijazi) colloquial words, and to read those in context. Change it in *Settings → This lecture → The speaker's Arabic*. |
| **Nice design from the logo** | Navy / gold / cream palette taken from the logo; Amiri for Arabic, Literata for reading, dark and light themes. |

## Install the app (about 2 minutes)

1. **Get the APK.** On your phone open the repo's **Releases** page and download `Lisan.apk` from
   **“Lisan — latest build”**. (Every push builds it automatically with GitHub Actions; you can also grab it from the
   *Actions* tab → latest run → *Artifacts*.)
2. Open the downloaded file. Android will ask to allow **Install unknown apps** for your browser/Files app — allow it once.
3. Open **Lisan**. Allow the microphone.
4. Tap **Set up free key** and follow the 3 steps (see below).
5. Press the microphone. 🎙️

Updates install straight over the old version and keep your keys and saved lectures.

### Getting the free key (one minute, no card)

1. Go to <https://console.groq.com/keys> and sign in with Google or e-mail.
2. **Create API key**, copy it.
3. Paste it into the app. Done.

*Optional backup:* a free Google Gemini key from <https://aistudio.google.com/apikey> in *Settings → Connection*. If Groq's free
daily allowance runs out mid-lecture, the app switches over by itself.

> **Why a key at all?** Good Arabic speech recognition and translation need a large model, far too big to run on a phone. The key
> is your own free account on a service that runs it for you. Audio goes **directly from your phone to Groq/Google** — there is no
> server of ours in between, and the key never leaves your phone.

## Using it well in a lecture

* Put the phone **near the speaker or the PA speaker**, screen up. The screen stays awake while recording; plug in if it's a long one.
* Leave **Noise suppression** and **Automatic volume** on. If quiet speech is missed raise *Sensitivity*; if it hears chatter lower it.
* Fill in **This lecture** in Settings (speaker, topic, names you expect). It makes a noticeable difference to spelling and meaning.
* Screen off is optional: press the power button and Lisan keeps listening (notification shown). Screen on is still best — you can read along.
* Use **Pause** for breaks (the lecture continues in the same transcript). The red **stop** button asks: *Stop and save*, *Keep recording*, or *Delete, don't save* (tap twice, nothing is kept).
* No interpreter? Set *Who is speaking?* to **Arabic only** — slightly more accurate.
* **If the result isn't good, run the Speech test** (*Settings → Speech test*). It records 8 seconds the same way a lecture does, plays it
  back (so you hear exactly what Lisan hears), and shows what Whisper large-v3, large-v3 *without* the vocabulary hint, Whisper turbo and Gemini
  each make of that clip, with the English each would give. Quiet, clipped or echoey audio shows up in the level read-out; if every engine
  is poor the audio is the problem (move closer, try turning Noise suppression off), and if only one is, switch the engine in *Connection*.
* Try **Try a demo lecture** on the home screen to see exactly how it looks, no key needed.

## How it works (for the curious)

```
 mic ─► resample 16 kHz ─► speech-aware chunker ─► Whisper large-v3 (Groq) ─► clean-up
        │ cuts at pauses, or at the quietest moment (never mid-word)         │ drops "subtitles by…" phantom text,
        │                                                                     │ repeated loops, echoes of the prompt
        ▼                                                                     ▼
   English?  ──► shown as Interpreter                          Arabic ─► wait ≤ N s for the next sentence
                                                                        ─► LLM translates with: glossary hits, the English already on
                                                                           screen, previous + next Arabic, your lecture context
                                                                        ─► committed once, fades in, never changes
```

* **Failover.** Every model has its own free allowance. By default the router tries Whisper large-v3 → large-v3-turbo → Gemini, and the best
  available LLMs in order; *Settings → Connection* lets you put turbo or Gemini first for speech and Groq or Gemini first for translation.
  A daily limit on one just moves to the next; a per-minute limit waits and retries; a rejected key is reported.
* **Models are discovered at start-up** (`/models`), so retired models never break the app. You can override them under *Advanced*.
* **Crash-proof.** The transcript is auto-saved a moment after every sentence; an interrupted lecture is recovered on next launch.
* Everything above the Android layer is plain HTML/CSS/JS (no bundler) wrapped with [Capacitor](https://capacitorjs.com).

### Free-tier reality check

Free allowances are set by Groq/Google and change from time to time. At the time of writing Groq's free tier gives roughly 2 hours of
speech-to-text per hour and ~8 hours per day, plus a daily token budget for the translator per model. A typical 1-hour lecture fits;
back-to-back all-day sessions may switch to the backup key, or wait for the daily reset. The app tells you when a limit is hit.

## How much can I record? Free vs pay-as-you-go

The free allowance is set by Groq/Google, and **translation (the language model) runs out first, not speech recognition**: each translated
sentence costs roughly 1,100 tokens (the instructions are most of it), and Groq's free tier allows about 200,000 tokens a day per model.
Typical numbers for **continuous speech** (estimates — your own figures appear in *Settings → Free allowance*):

| Setting | Free Groq lecture time per day* | Pay-as-you-go cost per lecture hour** |
|---|---|---|
| Instant (~3–4 s behind) | ~15 min | ~$0.55–0.90 |
| Quick (~6 s) | ~30 min | ~$0.25–0.40 |
| **Balanced (~10 s, default)** | **~40 min** | **~$0.20–0.30** |
| Smooth (~15 s) | ~45 min | ~$0.15–0.25 |

\* assumes two free translation models at 200k tokens/day each; if Groq lists more free models the app uses those too, and a free
**Gemini key** adds a backup pool (its free limits are not published precisely — the app just shows usage).
\** Groq's published pay-as-you-go prices (Whisper large-v3 $0.111 or large-v3-turbo $0.04 per audio hour, billed at least 10 s per clip;
gpt-oss-120b $0.15 / $0.60 per million input / output tokens) applied to those token counts. There is **no subscription**: you add a card
to your Groq account and pay for what you use — roughly 20–30 cents per lecture hour. Turn on *"My Groq account is on a paid plan"*
in Settings so the app stops treating you as free-tier.

## Honest limitations

* **Needs internet** during the lecture (mobile data is fine: ~2 MB per minute of speech).
* **Not simultaneous-interpreter perfect.** It is machine translation: heavy dialect, a very distant microphone, an echoing hall or
  several people talking at once reduce accuracy. Qur'anic verses and hadith are translated by meaning — check important quotes against
  reliable sources.
* **No speaker names.** It separates *Arabic* from *English* (sheikh vs interpreter) but doesn't tell two Arabic speakers apart.
* **Screen on is the reliable way.** The app keeps the screen awake while recording. You can also lock the phone or switch apps: a
  “Lisan is listening” notification asks Android to keep the microphone running (switch off in *Settings → Microphone*). If Android
  ever interrupts the microphone anyway, Lisan restarts it when you return and marks a paragraph break where audio was missed.
* Android 6+; Android 10+ writes the `.txt` straight to Downloads (older versions open the Share sheet instead).
* **Installing outside the Play Store.** Android is gradually adding a *developer verification* step for apps installed from outside the
  Play Store (it started in a few countries in September 2026 and widens in 2027). If your phone blocks the install, look for
  Android's “advanced flow”/“install anyway” option in its warning, or open an issue with the exact message you see.

## Build it yourself

Everything builds in the cloud with GitHub Actions (`.github/workflows/build-apk.yml`) — no Android Studio needed. Push → tests → signed APK → Release.

Locally:

```bash
npm install
npm test                 # unit tests: chunker, glossary, filters, router failover, engine behaviour…
npm run serve            # try the web version at http://localhost:8080 (Chrome; microphone works on localhost)
npm run icons            # regenerate icons/splash from assets-src/logo-options.png
npx cap sync android && cd android && ./gradlew assembleRelease   # needs JDK 21 + Android SDK
```

**Signing key.** The repo includes a throw-away key (`android/app/sideload.keystore`) purely so every CI build is signed identically and
updates install over each other. For anything you distribute, create your own and add the GitHub secrets `LT_KEYSTORE_B64`
(`base64 -w0 my.keystore`), `LT_KEYSTORE_PASSWORD`, `LT_KEY_ALIAS`, `LT_KEY_PASSWORD`.

### Project layout

```
www/                     the app (served as-is, no build step)
  js/engine/             chunk → transcript → translation pipeline, glossary, filters, router, export
  js/providers/          Groq + Gemini clients, model selection
  js/audio/              mic capture, resampler, speech chunker, WAV encoder
  js/ui/                 live screen, library/reader, settings, sheets
android/                 Capacitor Android project + small native plugin (save to Downloads, keep awake)
tests/                   node --test unit tests
scripts/                 icon generator, dev server
assets-src/              logo source sheet + master icon
```

## Credits & licences

App code: MIT. Qur'an text data (`www/data/quran-ar.json`): CC BY-SA 4.0, from [quran-json](https://github.com/risan/quran-json) / The Noble Qur'an Encyclopedia / Tanzil — see `www/data/LICENSE-quran-data.txt`. Fonts: Inter, Literata, Amiri (SIL OFL, licences in `www/fonts/`). Icons: Feather (MIT). Speech: OpenAI Whisper,
served by Groq. Translation: open large language models served by Groq / Google Gemini.
