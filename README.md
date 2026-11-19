# Voice recording, transcripts and summaries

Two parts live in this folder:

1. **Feasibility test** (`record-test.mjs`): can a bot join a Discord voice channel under Discord's
   end-to-end encryption (DAVE) and record one clear, time-aligned track per speaker, from your computer
   and from a GitHub Actions runner? It does not transcribe anything.
2. **Meeting recorder** (`record.mjs` and friends): the real thing. Records a meeting, transcribes it,
   posts a transcript and a summary with action items to the team's private channel.

The Cloudflare Worker side (`/record`, `/transcript`, share pages, storage) is **not in this folder**.
The plan for it is in the separate build instructions document (v2.1).

## Part 1: feasibility test

It joins, records for a fixed time, prints a PASS / WARN / FAIL summary (counts only), and posts the
clips to a private channel so you can listen.

Each speaker gets one file (`speaker-1-001.ogg`, `speaker-2-001.ogg`, ...). All files start at the
same moment and keep real time, with silence where the person was quiet. Play the same-numbered
files together and you hear the conversation in sync, overlaps included. Files roll over to a new
number about every 9 MB so they fit Discord's upload limit. The summary also reports how many
seconds two or more people were audible at the same time, so you can check that overlapping
speech was captured.

### One-time setup (about 20 minutes)

1. **Test server.** Create a Discord server only for this. Add one voice channel and one private text channel.
2. **Test bot.** Developer Portal > New Application > Bot > Reset Token (copy it somewhere safe).
   No privileged intents are needed. Invite it with the `bot` scope and these permissions:
   View Channel, Connect, Send Messages, Attach Files.
3. **Developer Mode.** Discord > Settings > Advanced > Developer Mode on. Then right-click each
   channel > Copy Channel ID.
4. **Your computer.** Install Node.js 22 or newer.

### Step 1: run it on your own computer first

```
npm ci
cp .env.example .env      # then fill in DISCORD_TOKEN, CHANNEL_ID, POST_CHANNEL_ID
npm run record
```

While it says "recording", speak in the voice channel (join from the Discord app).

Why your computer first: if it works here but not on GitHub, the network is the problem.
If it fails in both places, the encryption library is the problem.

### Step 2: run the scenarios

Run each one and note the result. Each is a separate run.

| # | Scenario | How |
|---|----------|-----|
| A | Bot joins first, then you speak | Start the script, wait for "connected", then join the channel and talk |
| B | You are already in the channel when the bot joins | Join the channel, then start the script. Repeat a few times |
| C | Two speakers | Same as A, with a second person or account talking (take turns, then overlap) |
| E | People joining and leaving | During a run, have someone join late, someone leave and rejoin, and a third person join. Every speaker's packet count should keep growing |
| D | Long run | `DURATION_SEC=1200`, talk now and then, check nobody goes silent |

Scenario B matters: an open discord.js bug reports that joining a channel where someone is
already connected can leave the first packets undecryptable.

### Step 3: run it on GitHub

1. The repo is `SK-OTC/VC-bot`. Keep it public (logs of a public repo are public, see below).
2. Repo > Settings > Secrets and variables > Actions > New secret: `DISCORD_TOKEN`.
3. Actions tab > "Voice recording test" > Run workflow. Fill in the two channel IDs.
4. Join the voice channel and talk during the run.

Logs in a public repo are public. This test prints only counts and anonymous labels
(`speaker-1`). Do not add logging of names, audio or tokens.

### Reading the result

* **PASS**: connected, every speaker produced audio, no unrecovered errors.
* **WARN**: audio arrived but something was thin (very short speech, or errors that recovered).
* **FAIL**: read the reason printed under `RESULT`. The common ones:
  * "Never reached the connected state": the network blocked Discord voice, or the handshake failed.
  * "Detected speaking but no audio came through": the decryption problem, or the silent-speaker bug.

Then open the clips in the private channel and listen. A PASS with garbled audio is a fail.
For an overlap check, talk over each other for a while, then compare the reported overlap seconds
with what you hear when you play both speakers' files together.

### Settings

| Variable | Default | Meaning |
|----------|---------|---------|
| `DISCORD_TOKEN` | required | Bot token |
| `CHANNEL_ID` | required | Voice channel to join |
| `POST_CHANNEL_ID` | none | Private text channel for the report and clips |
| `DURATION_SEC` | 60 | Recording time after connecting (10 to 1800) |
| `READY_TIMEOUT_SEC` | 30 | How long to wait for the voice connection |
| `MIN_PACKETS` | 100 | Packets (20 ms each) a speaker needs to count as a clear result |
| `DEBUG_VOICE` | off | `1` prints connection debug lines. May include server addresses |

## Part 2: recording, transcripts and summaries

| File | What it does |
| ---- | ------------ |
| `record.mjs` | The production recorder. Joins, renames itself `[REC] ...`, posts a notice, records, stops by rule, then hands over to the steps below |
| `track.mjs` | One time-aligned Ogg file per speaker (silence filled in), and the overlap measurement |
| `ogg.mjs` | Minimal Ogg Opus writer |
| `recorder/config.mjs` | Reads settings and the `TEAM_CONFIG` secret; refuses to run without a team entry for the channel |
| `recorder/stop.mjs` | Stop rules (limit, empty channel, silence, stop flag), nickname, attachment batching |
| `recorder/session.mjs` | After the meeting: transcribe, post transcript, summary, audio backup, upload to the Worker |
| `pipeline/*` | Silence cutting, batching, Groq Whisper client with limits and retries, clean-up, merge, summary, upload |
| `pipeline/local_whisper.py` | Backup transcriber (faster-whisper) |
| `transcribe.mjs` | Command line: a folder of `speaker-N-001.ogg` files in, `transcript.txt` (and `summary.txt`) out |
| `.github/workflows/record.yml` | The job the Worker starts (or you start by hand) |

### Try the transcription on a recording you already have

Put the `speaker-1-001.ogg`, `speaker-2-001.ogg` ... files in one folder. Optionally add `names.json`:
`{ "speaker-1": "Farah", "speaker-2": "Sam" }`.

```
npm ci
node transcribe.mjs path/to/folder --dry-run        # no key needed: shows how much speech and how many requests
GROQ_API_KEY=... GLOSSARY="VibeCut, CapCut" node transcribe.mjs path/to/folder --summary
```

This needs ffmpeg (and ffprobe) installed on your computer. It writes `transcript.txt` (and `summary.txt`)
into the folder. Do this first: it is the quality check, and the first real call confirms Groq's endpoint addresses.

### Run the recorder on GitHub

1. Repo secrets: `DISCORD_TOKEN`, `GROQ_API_KEY`, `TEAM_CONFIG`, and optionally `WORKER_URL` and `WORKER_SHARED_SECRET`.
   `WORKER_URL` and `WORKER_SHARED_SECRET` can stay empty while testing: the transcript is still posted, and the
   log says storage is not configured.
2. `TEAM_CONFIG` is JSON, keyed by voice channel ID:

   ```json
   {
     "<voice channel id>": {
       "name": "Team A",
       "transcriptChannelId": "<private text channel id>",
       "backupChannelId": "<private audio backup channel id, optional>",
       "glossary": "VibeCut, CapCut",
       "language": "en"
     }
   }
   ```

3. Actions tab > "Record meeting" > Run workflow. Enter the voice channel ID. Join and talk.
   End it with everyone leaving, silence, the time limit, or the stop flag from the Worker.

The bot needs View Channel, Connect and Send Messages in the voice channel, Change Nickname in the server, and
View Channel, Send Messages, Attach Files and Read Message History in the transcript and backup channels.
It refuses to record if it can neither rename itself nor post the notice.

### Other settings (environment variables)

| Variable | Default | Meaning |
|----------|---------|---------|
| `MAX_MINUTES` | 150 | Longest meeting (5 to 240), counted from the first person |
| `START_WAIT_MINUTES` | 15 | How long to wait for the first person |
| `EMPTY_GRACE_MINUTES` | 3 | Stop this long after the last person leaves |
| `SILENCE_STOP_MINUTES` | 20 | Stop after this long with nobody speaking |
| `GROQ_MODEL` / `LLM_MODEL` | `whisper-large-v3` / `openai/gpt-oss-120b` | Speech and summary models |
| `USE_LOCAL_FALLBACK` | on | `0` turns the backup transcriber off |
| `GROQ_BASE_URL` | Groq's address | For tests against a fake server |
| `LANGUAGE`, `GLOSSARY` | `en`, empty | Used by `transcribe.mjs` |

Rate limits are in `pipeline/limiter.mjs` (`whisperLimiter`, `chatLimiter`). They are cautious defaults.
Check them against your own Groq account's limits page.

## Tests

`npm test` runs the offline tests (over 200 now, including the Worker, commands and recording API). The recorder ones: the settings parsers, pass/fail rules, the Ogg writer, the aligned tracks
and overlap measurement, the speech-span and batch logic, transcript clean-up and merging, the rate limiter,
the Groq retry rules (against a fake `fetch`), summary chunking and message splitting, and the stop rules.
One test decodes the Ogg writer's output with ffmpeg and is skipped when ffmpeg is not installed.

## What is and is not tested

The tests prove logic only. They do **not** prove:

* Groq's real endpoints, limits or Whisper's accuracy on your voices (the endpoint addresses are assumed from Groq's
  OpenAI-compatible design).
* Joining Discord voice in `record.mjs`: the notice, rename and stop loop have not run against Discord, and the
  recorder's per-speaker streams have not been exercised in a real overlapping conversation.
* The whole audio-to-transcript pipeline with real ffmpeg on real audio (`runPipeline`, `extract.mjs`).
* `summarize` and `finishSession` against a real model, and `record.yml` itself (it has never run).
* The backup transcriber (`faster-whisper`) install and speed on a GitHub runner, or a 2-hour run.

Only a real run can show those.

## Part 3: the Cloudflare Worker (one bot, one repo)

This repo holds both halves of one Discord bot. **There is a single bot application**: the Worker uses its token to
post messages and answer slash commands over HTTP, and the GitHub recorder logs in as the same bot to join voice.

| Where | Files | Secrets |
|-------|-------|---------|
| Cloudflare Worker + D1 | `src/` (commands, scheduler, Google Calendar, recorder API), `migrations/`, `wrangler.toml`, `scripts/` | `DISCORD_PUBLIC_KEY`, `DISCORD_BOT_TOKEN`, `WORKER_SHARED_SECRET`, `GITHUB_DISPATCH_TOKEN` |
| GitHub Actions recorder | `record.mjs`, `recorder/`, `pipeline/`, `track.mjs`, `.github/workflows/record.yml` | `DISCORD_TOKEN` (the same bot's token), `GROQ_API_KEY`, `TEAM_CONFIG`, `WORKER_URL`, `WORKER_SHARED_SECRET` |

`WORKER_SHARED_SECRET` is one long random string you make up. It goes in both places, and the recorder uses it to call
the Worker's `GET /api/sessions/<id>/stop` and `POST /api/transcripts`. Set Worker secrets with
`npx wrangler secret put NAME`, and GitHub secrets in the repo's Settings > Secrets and variables > Actions.
Never commit `.dev.vars` (it is in `.gitignore`).

### Starting and stopping a recording from Discord

| Command | What it does |
|---------|--------------|
| `/start-recording [channel]` | Records the voice channel you are in (or the one you pick). The Worker starts the GitHub job; the bot joins within about a minute |
| `/stop-recording [channel] [force]` | The bot leaves within about 15 seconds, then transcribes and posts as usual. Only the person who started it, or someone with Manage Server, can stop it. `force:True` clears a stuck recording |

Anyone in the server can start a recording. The voice channel must have an entry in the `TEAM_CONFIG` GitHub secret,
otherwise the job stops straight away (the Worker cannot see that secret, so it cannot warn you up front).

One-time setup for `/start-recording`:

1. GitHub > Settings > Developer settings > Fine-grained tokens > new token, limited to this one repository, with
   **Actions: Read and write**. Then `npx wrangler secret put GITHUB_DISPATCH_TOKEN`.
2. Check `GITHUB_REPO` (and `GITHUB_REF`, default `main`) in `wrangler.toml`.
3. `npm run deploy`, then `npm run register` (the commands are new).

Without the token the commands still exist and say recording is not set up. The recorder tells the Worker when its job
ends (`POST /api/sessions/<id>/finish`), so an empty meeting or a crash frees the channel. Sessions that never report in
are cleared automatically after 20 minutes (never started) or 6 hours (running).

### Private web links for transcripts

Every saved transcript gets a private page at `https://<your worker>/t/<token>` showing the summary and action items,
plus a box to **ask questions about the meeting**. The full transcript is **not** shown on the page (it stays in the
database, and in Discord as the file the bot posted). The recorder posts the link in the team's private channel under
the transcript. It is made when the
transcript is stored, so it needs `WORKER_URL` and `WORKER_SHARED_SECRET` to be set on GitHub.

| Command (run it in the transcript's private channel) | What it does |
|---------|--------------|
| `/share-transcript [id] [days]` | Makes a new link (default: the latest transcript in this channel, 30 days, up to 365). Only you see the reply |
| `/unshare-transcript [id]` | Turns off every link for that transcript, including the automatic one |

Settings in `wrangler.toml`: `SHARE_LINK_DAYS` (default 30; `0` turns the automatic links off) and optionally
`PUBLIC_URL` (an https address, for example your own domain, to build links on instead of the Worker's address).

How it is protected:

* **Unguessable.** A link holds 256 random bits, so it cannot be guessed. Only a hash of it is stored: a database
  dump or `backup.sql` cannot open any page. Because of that, a lost link cannot be recovered; make a new one.
* **Same "not available" page** for a wrong, expired, revoked or malformed link, so nobody can probe for real ones.
* **Expires and can be revoked.** Links stop at their expiry time; `/unshare-transcript` stops them at once.
  At most 10 live links per transcript. Deleting a transcript deletes its links.
* **The page has no scripts, images or links, and its one form posts only back to itself.** Everything from speech,
  speaker names, the summary and the model's answers is HTML-escaped. A strict Content-Security-Policy,
  `X-Frame-Options: DENY` and `nosniff` are sent on every response.
* **Not indexed or cached.** `noindex` headers and meta tag, `robots.txt` disallowing everything, `Cache-Control: no-store`,
  and `Referrer-Policy: no-referrer` so the address is not passed on to other sites.
* **Not logged.** Neither the Worker nor the recorder ever prints a link, and the recorder posts it only to the private channel.
* **Only the right people can make links.** The commands work only in the channel the transcript was posted to, so only
  people who can use that channel can create or revoke its links.

### Asking questions about a meeting (Groq)

A reader types a question; the Worker finds the relevant parts of **that one meeting's** stored transcript and asks
Groq to answer from them only. Short meetings are sent whole; long ones use the database's full-text index to pick the
best-matching parts (plus their neighbours and the opening, with the speaker list). Setup: `npx wrangler secret put
GROQ_API_KEY` (the same kind of key the recorder uses, kept on the Worker only), then `npm run deploy` and apply the
new migration with `npm run db:migrate:remote`. Without the key the page simply has no question box.

* **Only this meeting.** Retrieval is limited to the transcript the link opens, so one link can never reveal another meeting.
* **Words from the meeting are data, not instructions.** They are passed to the model as quoted material, the model has
  no tools, and its answer is shown as escaped text, so something said aloud like "ignore your rules" cannot change
  the rules, run code or add a link or script to the page. The worst case is a wrong answer, which is why every answer
  says it can be wrong.
* **Your Groq quota is protected.** Defaults: 15 questions per link per hour, 60 per link per day and 300 per day in
  total (`QA_HOURLY_PER_LINK`, `QA_DAILY_PER_LINK`, `QA_DAILY_TOTAL` in `wrangler.toml`; total `0` switches questions
  off). Failed attempts count too. Questions are limited to 500 characters.
* **Questions and answers are not stored or logged.** The database keeps only a count and a time per question.
* **Forms from other websites are refused** (the `Origin` is checked), and expired or revoked links cannot ask anything.
* **Privacy:** the question, the summary and the parts of the transcript used for an answer are sent to Groq, the same
  provider that already transcribes the audio.

What a link does not protect against: anyone who is given the address can read the page until it expires or is
turned off (there is no login), and Cloudflare's own request logs for your account include the address. Treat links
like passwords. For extra protection add a Cloudflare rate-limiting rule for `/t/*` in the dashboard (optional,
since guessing is not feasible).

The original reminder-bot documentation is in [docs/meeting-time-bot.md](docs/meeting-time-bot.md).

```
npm test                        # all offline tests (Worker + recorder)
npm run db:migrate:local        # apply migrations to a local test database
npm run deploy                  # publish the Worker (after db:migrate:remote and setting the secrets)
npm run register                # (re)register the slash commands with Discord
```

One bot records one voice channel per server at a time, and while it records it renames itself `[REC] ...` in that
server. Two teams meeting at the same moment in the same server would need a second bot application.
