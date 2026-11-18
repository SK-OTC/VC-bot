# Voice recording feasibility test

Answers one question for free: **can a bot join a Discord voice channel under Discord's
end-to-end encryption (DAVE) and record one clear track per speaker, and can it do that from a
GitHub Actions runner?**

It does not transcribe anything. It joins, records for a fixed time, prints a PASS / WARN / FAIL
summary (counts only), and posts the clips to a private channel so you can listen.

## One-time setup (about 20 minutes)

1. **Test server.** Create a Discord server only for this. Add one voice channel and one private text channel.
2. **Test bot.** Developer Portal > New Application > Bot > Reset Token (copy it somewhere safe).
   No privileged intents are needed. Invite it with the `bot` scope and these permissions:
   View Channel, Connect, Send Messages, Attach Files.
3. **Developer Mode.** Discord > Settings > Advanced > Developer Mode on. Then right-click each
   channel > Copy Channel ID.
4. **Your computer.** Install Node.js 22 or newer.

## Step 1: run it on your own computer first

```
npm ci
cp .env.example .env      # then fill in DISCORD_TOKEN, CHANNEL_ID, POST_CHANNEL_ID
npm run record
```

While it says "recording", speak in the voice channel (join from the Discord app).

Why your computer first: if it works here but not on GitHub, the network is the problem.
If it fails in both places, the encryption library is the problem.

## Step 2: run the scenarios

Run each one and note the result. Each is a separate run.

| # | Scenario | How |
|---|----------|-----|
| A | Bot joins first, then you speak | Start the script, wait for "connected", then join the channel and talk |
| B | You are already in the channel when the bot joins | Join the channel, then start the script |
| C | Two speakers | Same as A, with a second person or account talking (take turns, then overlap) |
| D | Long run | `DURATION_SEC=1200`, talk now and then, check nobody goes silent |

Scenario B matters: an open discord.js bug reports that joining a channel where someone is
already connected can leave the first packets undecryptable.

## Step 3: run it on GitHub

1. Push this folder to a **new public repo**.
2. Repo > Settings > Secrets and variables > Actions > New secret: `DISCORD_TOKEN`.
3. Actions tab > "Voice recording test" > Run workflow. Fill in the two channel IDs.
4. Join the voice channel and talk during the run.

Logs in a public repo are public. This test prints only counts and anonymous labels
(`speaker-1`). Do not add logging of names, audio or tokens.

## Reading the result

* **PASS**: connected, every speaker produced audio, no unrecovered errors.
* **WARN**: audio arrived but something was thin (very short speech, or errors that recovered).
* **FAIL**: read the reason printed under `RESULT`. The common ones:
  * "Never reached the connected state": the network blocked Discord voice, or the handshake failed.
  * "Detected speaking but no audio came through": the decryption problem, or the silent-speaker bug.

Then open the clips in the private channel and listen. A PASS with garbled audio is a fail.

## Settings

| Variable | Default | Meaning |
|----------|---------|---------|
| `DISCORD_TOKEN` | required | Bot token |
| `CHANNEL_ID` | required | Voice channel to join |
| `POST_CHANNEL_ID` | none | Private text channel for the report and clips |
| `DURATION_SEC` | 60 | Recording time after connecting (10 to 1800) |
| `READY_TIMEOUT_SEC` | 30 | How long to wait for the voice connection |
| `MIN_PACKETS` | 100 | Packets (20 ms each) a speaker needs to count as a clear result |
| `DEBUG_VOICE` | off | `1` prints connection debug lines. May include server addresses |

## Tests

`npm test` runs offline checks of the settings parser, the pass/fail rules and the Ogg file writer
(the writer is checked by decoding its output with ffmpeg). They cannot prove Discord voice works.
Only a real run can.
