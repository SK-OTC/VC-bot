// Instructions given to the language model that writes the meeting notes.
// Every prompt lists the team's correct spellings. The example uses invented names and facts on purpose: real colleagues'
// names in a prompt sent with every meeting could leak into other meetings' notes.
import { dateTable, meetingDay } from './dates.mjs';

/** The glossary as a prompt line: names and terms the model must spell exactly like this. */
export function glossaryLine(glossary) {
  const terms = String(glossary ?? '')
    .split(/[,\n;]/)
    .map((t) => t.split('=')[0].trim()) // a "Correct=Mishearing" entry contributes only the correct spelling
    .filter(Boolean)
    .slice(0, 60);
  return terms.length ? `\nCorrect spellings of names and terms used by this team (always spell them exactly like this): ${terms.join(', ')}.` : '';
}

/** Appended to the prompts when Groq is the fallback model. */
export const FALLBACK_SUFFIX = '\nDo not add information that is not in the transcript.';

const hhmmss = (sec) => [3600, 60, 1].map((u, i) => String(Math.floor(sec / u) % (i ? 60 : 1e6)).padStart(2, '0')).join(':');

/**
 * What the recording knows about the meeting, as prompt lines. Every field is optional.
 * meeting: { name, startedAt, lengthSec, speakers: ['Name', ...] }
 */
export function contextBlock(meeting = {}) {
  const { name = '', startedAt = null, lengthSec = null, speakers = [] } = meeting ?? {};
  const days = dateTable(startedAt);
  const lines = [
    name ? `- Meeting name: ${name}` : null,
    days ? `- Date: ${days.split('; ')[0].replace('today = ', '')} ${meetingDay(startedAt).getUTCFullYear()} (UTC).` : null,
    days ? `- Calendar for turning "tomorrow", "Wednesday", "Friday" and similar into dates. Copy the date from this list; never work one out yourself: ${days}.` : null,
    Number.isFinite(lengthSec) && lengthSec > 0 ? `- Length: ${hhmmss(Math.round(lengthSec))}` : null,
    speakers.length ? `- Speakers (their Discord names): ${speakers.join(', ')}` : null,
  ].filter(Boolean);
  return lines.length ? `Meeting context (from the recording, not the conversation):\n${lines.join('\n')}` : '';
}

const LINE_FORMAT = 'Each transcript line looks like "[hh:mm:ss] Name: what they said". The transcript is automatic, so words can be misheard; leave out anything you cannot make sense of.';

export const PURPOSE = `First work out the meeting's purpose (a demo, a planning session, a status check). Write notes about the work: what was shown or reported, what was concluded, what is still outstanding, problems found, who must talk to whom, and dates. Leave out completely, even when they take many minutes: joining and audio trouble, waiting, greetings, small talk, hobbies and TV, job applications, resumes and career advice, personal favours between attendees, and anything someone asked to keep private. These notes are shared with the team.`;

export const SPECIFIC = `Be specific. A bullet that only names a topic ("Output format discussed") is not allowed: say WHAT was said about it, with the numbers, limits, tools, file or branch names, dates and reasons that were mentioned. Combine several lines about the same point into one bullet. Use only the transcript: never invent owners, deadlines, numbers or names.`;

export const NAMES = `Names: use the people named in the transcript, including people who are only mentioned (someone to ask, someone who will join). A speaker may be called by another name in conversation, for example a short name; when the transcript makes that clear (someone is greeted by that name and that speaker answers), write it once as "Short name (Discord name)" and then the short name. Never invent a name.`;

const TONE = 'Tone: formal, neutral, short factual statements; no jokes, emoji or exclamation marks.';

/**
 * The word limit for the whole set of notes (title, topics and next steps together), from the meeting's length: 450 words up
 * to 45 minutes (Granola's notes for a 36-minute meeting were about 430), then 150 more for each further half hour started,
 * up to 900. Worked out here so the model does no arithmetic. Unknown length: 450.
 */
export function wordLimit(lengthSec) {
  const min = Number(lengthSec) / 60;
  if (!Number.isFinite(min) || min <= 45) return 450;
  return Math.min(900, 450 + 150 * Math.ceil((min - 45) / 30));
}

export const finalFormat = (words = 450) => `Write plain text in exactly this format:

First line: a short plain title (no bold) naming the meeting's main subject.

Then 2 to 5 topic sections; never repeat a point in two sections. Topic bullets have NO timestamps. Each section starts with a short bold heading named after the topic, such as **Export settings**, or after a person for a status update, such as **Maya's demo (cart page)**. Under it, 1 to 6 short bullets. Use sub-bullets indented by two spaces for details. Write "Pending: ..." for a decision that waits on someone, and say who it waits on.

Then this section, with exactly this bold heading:

**Next steps**
- Owner: task, with the detail and due date needed to act on it [hh:mm:ss]
Each next step ends with ONE timestamp in the form [hh:mm:ss] (for example [00:34:18]; never a range, never [mm:ss]): the line where it was agreed. Include every task someone said they would do or was asked to do, including sending something and talking to someone outside the meeting; never turn a topic into a task nobody took on. At most 10 next steps. The owner is a person's name; use "Unassigned" if nobody took it. Add a due date only if one was said (turn "tomorrow" into a date). Write "None recorded" if there are none.

No other sections. Keep the whole answer under ${words} words.`;
export const FINAL_FORMAT = finalFormat(450);

export const SUMMARY_EXAMPLE = `An example of good notes. It shows the level of detail and what to leave out. It is an illustration only: never copy its names, facts or dates.

Meeting context: Date: Tuesday 8 March. Speakers: Lena, Omar Haddad, Maya.
Transcript:
[00:03:10] Lena: Next, export settings. I'd like 1080p for now.
[00:03:18] Omar Haddad: Agreed. 2K and 4K can come later once encoding is stable.
[00:03:30] Lena: And all encoding stays on the server with FFmpeg, not in the browser, so fonts look the same everywhere.
[00:03:44] Omar Haddad: The preview is still open. Raj wants a browser preview.
[00:03:52] Lena: I'll talk to Raj before Thursday.
[00:04:05] Lena: Oz, the speed change, where are you?
[00:04:08] Omar Haddad: Video goes from 0.25x to 3x, but audio breaks below 0.5x.
[00:04:20] Lena: Then cap audio at 0.5x to 2x, and the audio length must still match the clip.
[00:04:31] Omar Haddad: I can have that by tomorrow.
[00:04:40] Maya: Did anyone watch the match last night?
[00:04:44] Omar Haddad: Don't remind me, we lost three nil.
Notes:
Export settings and speed changes

**Export settings**
- Output is 1080p for now; 2K and 4K follow once encoding is stable
- All encoding stays on the server with FFmpeg, not in the browser, so fonts render the same everywhere
- Pending: a browser preview, which Raj wants; waits on Lena's talk with Raj

**Oz (Omar Haddad): speed per segment**
- Video speed range 0.25x to 3x; audio breaks below 0.5x, so audio is capped at 0.5x to 2x
- Audio length must still match the clip after a speed change

**Next steps**
- Lena: discuss the browser preview with Raj before Thursday 10 March [00:03:52]
- Oz: finish speed per segment with the audio cap and the length check by Wednesday 9 March [00:04:31]
(Left out: the football chat [00:04:40].)

The "(Left out: ...)" line explains the example. Do not write one in your notes.`;

const withContext = (context) => (context ? `\n${context}` : '');

/** One request for the whole meeting (the usual case on Cloudflare). */
export const singleSystem = ({ glossary = '', context = '', words = 450 } = {}) =>
  `You write meeting notes from an automatic transcript, like a careful assistant who was in the room.${withContext(context)}\n${LINE_FORMAT}${glossaryLine(glossary)}\n\n${PURPOSE}\n${SPECIFIC}\n${NAMES}\n${TONE}\n\n${finalFormat(words)}\n\n${SUMMARY_EXAMPLE}`;

/** One part of a meeting that is too long for one request (detailed notes: the final step sees only these). */
export const mapSystem = ({ glossary = '', context = '' } = {}) =>
  `You are reading ONE PART of a longer meeting transcript. Another step will write the final notes from your notes alone, so anything you leave out is lost.${withContext(context)}\n${LINE_FORMAT}${glossaryLine(glossary)}\n\n${PURPOSE}\n${NAMES}
Write DETAILED notes, grouped under short topic headings, plain bullets only (no tables). Keep every number, limit, tool name, file or branch name, date, reason, problem found, and the name of every person who must be asked, told, or given the remaining work. Each note ends with ONE [hh:mm:ss] (never a range).
After the topic notes, a list headed exactly NEXT STEPS: "Owner: task (due date if said) [hh:mm:ss]", or "none". Only tasks someone said they would do or was asked to do.
Use only this part. Never invent owners, deadlines, numbers or names.`;

/** Notes from consecutive parts that are still too long together: shortened, keeping every next step. */
export const mergeNotesSystem = ({ glossary = '', context = '' } = {}) =>
  `You are given notes from consecutive parts of one meeting. Merge them into one shorter set of notes in the same form (topic headings, then NEXT STEPS) and merge duplicates. Do not drop any next step: keep its owner, due date and [hh:mm:ss] timestamp. Keep every number, name and date.${withContext(context)}${glossaryLine(glossary)}\n${PURPOSE}\nNever invent owners, deadlines, numbers or names.`;

/** The final notes from the parts' notes. */
export const reduceSystem = ({ glossary = '', context = '', words = 450 } = {}) =>
  `You are given detailed notes from consecutive parts of one meeting. Write the final meeting notes from them. Merge duplicates, but keep every specific detail and every next step with its [hh:mm:ss].${withContext(context)}${glossaryLine(glossary)}\n\n${PURPOSE}\n${SPECIFIC}\n${NAMES}\n${TONE}\n\n${finalFormat(words)}\n\n${SUMMARY_EXAMPLE}`;

/** Two drafts written independently from the same transcript, combined into one: evens out what a single run misses. */
export const draftMergeSystem = ({ glossary = '', context = '', words = 450 } = {}) =>
  `You are given two drafts of notes for the SAME meeting, written independently from the same transcript. Each draft may have missed points the other caught.${withContext(context)}${glossaryLine(glossary)}

Combine them into one set of notes: keep every specific point about the work that appears in EITHER draft (numbers, names, dates, who must ask whom), merge points that say the same thing into one bullet, and never add anything that is in neither draft. If the drafts disagree on a fact (a date, an owner), keep the version that is more specific; if you cannot tell, leave that detail out.
Drop anything either draft included that belongs to this leave-out list: joining and audio trouble, greetings, small talk, hobbies and TV, job applications, resumes and career advice, personal favours between attendees, and anything someone asked to keep private.
${SPECIFIC}\n${TONE}\n\n${finalFormat(words)}`;
