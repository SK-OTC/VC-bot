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
| `recorder/config.mjs` | Reads settings; takes the channel settings from `/setup-recording` (via `recorder/remote-config.mjs`) or the optional `TEAM_CONFIG` secret; refuses to run without them |
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

1. Repo secrets: `DISCORD_TOKEN`, `GROQ_API_KEY`, `WORKER_URL` and `WORKER_SHARED_SECRET`. The last two are how the
   job fetches the channel settings made with `/setup-recording`, polls the stop flag and stores the transcript.
   (`TEAM_CONFIG` is no longer needed: see below.)
2. **Tell the bot where each voice channel's transcript goes, in Discord, with `/setup-recording`** (see the next
   section). The optional `TEAM_CONFIG` secret still works as a fallback for runs you start by hand without a session
   (the settings from `/setup-recording` win when both exist). It is JSON, keyed by voice channel ID:

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
| GitHub Actions recorder | `record.mjs`, `recorder/`, `pipeline/`, `track.mjs`, `.github/workflows/record.yml` | `DISCORD_TOKEN` (the same bot's token), `GROQ_API_KEY`, `WORKER_URL`, `WORKER_SHARED_SECRET` (`TEAM_CONFIG` is optional) |

`WORKER_SHARED_SECRET` is one long random string you make up. It goes in both places, and the recorder uses it to call
the Worker's `GET /api/sessions/<id>/stop` and `POST /api/transcripts`. Set Worker secrets with
`npx wrangler secret put NAME`, and GitHub secrets in the repo's Settings > Secrets and variables > Actions.
Never commit `.dev.vars` (it is in `.gitignore`).

### Starting and stopping a recording from Discord

| Command | What it does |
|---------|--------------|
| `/start-recording [channel]` | Records the voice channel you are in (or the one you pick). The Worker starts the GitHub job; the bot joins within about a minute |
| `/stop-recording [channel] [force]` | The bot leaves within about 15 seconds, then transcribes and posts as usual. Only the person who started it, or someone with Manage Server, can stop it. `force:True` clears a stuck recording |

Anyone in the server can start a recording, but only in a voice channel an admin has set up (below). Otherwise
`/start-recording` says so right away.

### Setting up a server: `/setup-recording` (no GitHub secret to edit)

| Command (needs Manage Server) | What it does |
|---------|--------------|
| `/setup-recording voice_channel transcript_channel [name] [backup_channel] [language] [glossary]` | Saves where that voice channel's transcript and summary go. Run it again to change it |
| `/recording-settings [voice_channel]` | Shows the saved setups for this server |
| `/remove-recording-setup voice_channel` | Stops allowing recordings of that voice channel |

To add the bot to another server: invite the same bot, give it the permissions below, then run `/setup-recording` there.
Nothing in GitHub changes. (Register the commands globally, with no `DISCORD_GUILD_ID`, so they show up in every server.)

* **Checked when you save it.** The bot looks up each channel, makes sure they are all in this server and of the right
  kind, and posts a confirmation message in the transcript channel (and backup channel). If it cannot see or post
  there, nothing is saved and you are told which permissions are missing, so a mistake shows up now instead of in the
  middle of a meeting.
* **Admin only, twice.** The commands are hidden from people without Manage Server by default, and the handlers check
  the permission again. A server's settings are never visible to, or editable from, another server.
* **Private.** The recorder fetches its settings from the Worker with the shared secret, so channel IDs, team names and
  glossaries never appear in the public GitHub run page or log.
* Up to 25 setups per server. Languages are 2 or 3 letter codes (`en`, `es`, `fr`). The glossary (up to 500
  characters) helps the transcriber spell names and product terms.
* You can delete the `TEAM_CONFIG` secret from GitHub once every channel you record has a `/setup-recording`.

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
Groq to answer from them only. Short meetings (under about 24,000 characters) are sent whole. Long ones use **hybrid
retrieval**: keyword search (SQLite full-text, BM25) and meaning-based search (embeddings in Cloudflare Vectorize) each
rank the transcript's chunks, the two rankings are merged with Reciprocal Rank Fusion, and the top matches are sent with
their neighbouring chunks and the opening (speaker list). Meaning search finds "how much did we spend?" in a chunk that
only says "the budget is forty thousand dollars"; keyword search keeps names, numbers and exact terms reliable.

Setup:

1. `npx wrangler secret put GROQ_API_KEY` (kept on the Worker only). Without it the page has no question box.
2. For meaning-based search, create the vector index **before deploying** (the bindings in `wrangler.toml` need it):
   `npx wrangler vectorize create vc-bot-chunks --dimensions=768 --metric=cosine`
3. `npm run db:migrate:remote` (applies `0007` and `0008`), then `npm run deploy`.

How the vector index is used:

* Long transcripts are indexed in the background right after they are saved (Workers AI model
  `@cf/baai/bge-base-en-v1.5`, 768 dimensions, English). Transcripts saved before this feature, or whose indexing failed,
  are indexed by the first question asked about them, and that question is answered with keyword search alone. Failed
  indexing is retried at most every 10 minutes.
* **One Vectorize namespace per transcript**, and every query names it, so a question can only match its own meeting.
  Ids returned by the index are checked again before use.
* **Only vectors are stored in Vectorize**: no text, no names, no metadata (ids look like `abc234:17`).
* **It is a pure upgrade.** If the AI or Vectorize binding is missing, slow or failing, questions are answered with
  keyword search alone and nothing breaks. Failures are logged by type only.
* A non-English team needs a multilingual embedding model: set `EMBEDDING_MODEL` and recreate the index with that
  model's dimensions (the model and the index size must match, and existing vectors must be rebuilt).
* The question and the transcript chunks are sent to Cloudflare Workers AI to be embedded (in addition to Groq
  receiving the parts used for the answer). To remove a transcript's vectors, call `deleteEmbeddings` in
  `src/semantic.js`; deleting a transcript row does not remove them by itself.
* Local `wrangler dev` cannot reach these services without a Cloudflare login (they always run remotely); the
  offline tests use fakes.

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
