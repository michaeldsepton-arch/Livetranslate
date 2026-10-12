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
| **A continuous script for the whole lecture** | Small punctuation fixes are applied automatically (spacing, a capital after a full stop, a space between sentences). Sentence breaks are asked for explicitly (the translator splits long chains of "and… then… so…" into separate sentences, and a missing full stop is added when the next piece starts a new sentence). Each speaker's turn is **one paragraph** with a timestamp (the sheikh's runs on until the interpreter speaks, and the other way round; only an extremely long turn is broken, at the end of a sentence); the screen follows the lecture, and you can scroll back without losing your place. |
| **An English interpreter speaks too** | Every audio chunk is language-detected, and a chunk that holds the end of one speaker and the start of the other is **split where the language changes**. English is shown as **Interpreter** text (italic, gold bar) and is never re-translated; Arabic is translated. Arabic honorifics an interpreter says in English (ﷺ, (SWT), Alhamdulillah…) are written in English, in your chosen style. With OpenAI's speech model (which does not report the language it heard), a quick extra Whisper pass labels each piece's language, so English speech that came back in Arabic letters is re-read as English and shown as the interpreter (*Settings → Double-check who is speaking*). The interpreter's words are also given to the translator as context for the next Arabic passage. |
| **Save the transcript as a text file** | When you stop, a `.txt` is written to **Downloads/Lisan** (and kept in the in-app **Library**). Each paragraph is labelled **SHEIKH** or **INTERPRETER**. Share, copy, rename, re-export or delete any lecture later (delete has an Undo; long-press to select several). |
| **Works with free or paid keys** | Uses Groq (Whisper + an open LLM), Google Gemini and/or OpenAI. Accounts are **treated as paid by default** (no rationing or slowing of requests); free plans run out within minutes of a lecture, so use a paid key for real lectures, and switch the *paid plan* toggle off in Settings only if a key is on a free plan. No subscription, no card. You choose the engine for hearing (Whisper large-v3, Whisper **turbo**, **Gemini** or **OpenAI**) and for translating (Groq, Gemini or OpenAI) separately in *Settings → Connection*, and the **Speech test** lets you compare them on the same clip. **OpenAI has no free tier** (so no daily limit): add a few dollars of credit and, with *Auto*, it is used first. |
| **Qur'an recitation** | Recited verses are recognised against the full text of the Qur'an: the exact Arabic (with diacritics) replaces any mis-heard words, the verse is fenced in ﴿ ﴾ and its reference (e.g. *Qur'an Al-Masad 111:2–5*) sits right after the quotation in the English, so only the verse is marked and the sheikh's own words around it never are, and the translator is told exactly which words are the verse (and not to complete it beyond them), so a verse quoted inside the sheikh's sentence is put in quotation marks and his own words stay his own. Works for verses quoted inside a lecture too. Can be switched off in Settings. |
| **Know your free limits** | *Settings → Free allowance* (and a chip while recording) shows, per model, how much of the free Groq / Gemini allowance this phone has used — speech minutes this hour and today, requests, tokens — with a warning at 80 % and 95 %, an estimate of how long it will last at your current pace, and links to the official usage pages. It also paces requests so short chunks don't hit the per-minute limit. |
| **Tells you when credit runs out** | If OpenAI (or Groq/Gemini) reports that the account has no credit or hit its spending limit, a banner shows at once with **Add credit** and **I'm back — retry**. If another service is set up, Lisan carries on with it and says which one; if not, the lecture waits (nothing is lost) until you add credit and tap Retry. It cannot show how much credit is *left*: these services do not let an ordinary API key read the balance, so there is no "running low" warning. |
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

**Updating from inside the app.** *Settings → App updates → Check for updates* asks GitHub for the newest build (the app also looks quietly, at most every 6 hours, when it opens, and never while recording). If a newer one exists, tap **Download**: your phone fetches `Lisan.apk`, and you open it to install over the current version. This needs the repository to be **public** (a private repository answers "not found" to the app); otherwise the app offers a link to the downloads page instead. Every build stamps its GitHub run number into the app, which is what is compared.

### Getting the free key (one minute, no card)

1. Go to <https://console.groq.com/keys> and sign in with Google or e-mail.
2. **Create API key**, copy it.
3. Paste it into the app. Done.

*Optional, paid:* an OpenAI key from <https://platform.openai.com/api-keys> (add credit under Billing; the minimum is $5, and leaving auto-recharge off means it can never spend more than you loaded). Create the key with **All** permissions: a *Read only* key can list models but cannot make requests, and the **Test** button in Settings makes one tiny real request to catch exactly that. OpenAI has no free tier, but it has no daily wall either, so it suits long days of lectures. Roughly $0.3–1.5 per lecture hour depending on the models (the *Free allowance* screen shows a rough running cost).

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
  each make of that clip (plus OpenAI's gpt-4o-transcribe and Whisper-1 if you added a key), with the English each would give, and then the same Arabic
  through each service's *translator* side by side. Quiet, clipped or echoey audio shows up in the level read-out; if every engine
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

* **Failover.** Every model has its own free allowance. By default the router tries Whisper large-v3 → large-v3-turbo → Gemini → OpenAI, and the best
  available LLMs in order; *Settings → Connection* lets you put turbo, Gemini or OpenAI first for speech and Groq, Gemini or OpenAI first for translation.
  With *Auto*, OpenAI goes first when you have added its key (it is paid, so it cannot run out of free allowance). If its credit runs out, Lisan carries on with the other services.
* **Strong models first.** Mixing a big model with a small one inside one lecture makes the English change in style and accuracy, so the weaker models (Groq's small Llama/Qwen models, Gemini Flash-Lite, OpenAI's mini models) are only a last resort: every strong model of every service is tried first, and a brief limit is *waited out* (up to 30 s) instead of switching to a weaker model.
  A daily limit on one just moves to the next; a per-minute limit waits and retries; a rejected key is reported.
* **Recogniser hints.** Whisper gets a short Arabic religious primer; OpenAI's gpt-4o-transcribe gets only a short English description (it reads prompts as instructions and echoes them on quiet audio). Any read-back of the primer is removed from the transcript.
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
