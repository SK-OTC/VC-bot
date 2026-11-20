// Instructions given to the language model that writes the summary and action items.
// Written for a cautious model (Llama 3.3 tends to leave things out rather than make things up), so they push for
// completeness while forbidding invention. Every prompt lists the team's correct spellings.

/** The glossary as a prompt line: names and terms the model must spell exactly like this. */
export function glossaryLine(glossary) {
  const terms = String(glossary ?? '')
    .split(/[,\n;]/)
    .map((t) => t.split('=')[0].trim()) // a future "Correct=Mishearing" entry contributes only the correct spelling
    .filter(Boolean)
    .slice(0, 60);
  return terms.length ? `\nCorrect spellings of names and terms used by this team (always spell them exactly like this): ${terms.join(', ')}.` : '';
}

/** Appended to the prompts when Groq is the fallback model. */
export const FALLBACK_SUFFIX = '\nDo not add information that is not in the transcript.';

const LINE_FORMAT = 'Each transcript line looks like "[hh:mm:ss] Name: what they said".';

const GROUNDING = `Use ONLY the transcript. Never invent owners, deadlines, numbers or names; spell speakers' names as in the transcript. The transcript is automatic and may be wrong: leave out anything unclear. Include every clearly stated decision and action item, even small ones.`;

const ACTION_RULE = `Action items: "Owner: task [hh:mm:ss]". The owner is a speaker's name exactly as it appears in the transcript, or "Unassigned" if no owner is clear. Add a due date only if one was actually said.`;

const FINAL_FORMAT = `Write plain text in exactly this format, with these four bold headings. EVERY bullet ends with the [hh:mm:ss] of the transcript line it came from.

**Summary**
- 4 to 8 short bullets: the topics discussed and what was concluded [hh:mm:ss]

**Decisions**
- each decision that was actually made [hh:mm:ss], or "None recorded"

**Action items**
- Owner: task [hh:mm:ss]
- "None recorded" if there are none

**Open questions**
- questions raised but not answered [hh:mm:ss], or "None"

${ACTION_RULE}
${GROUNDING}
Keep each bullet to one line and the whole answer under 450 words.`;

export const singleSystem = ({ glossary = '' } = {}) =>
  `You write meeting notes from an automatic transcript. ${LINE_FORMAT}${glossaryLine(glossary)}\n\n${FINAL_FORMAT}`;

export const mapSystem = ({ glossary = '' } = {}) =>
  `You are reading ONE PART of a longer meeting transcript. ${LINE_FORMAT}${glossaryLine(glossary)}
Write terse bullet notes in exactly these four lists, in this order: TOPICS, DECISIONS, ACTION ITEMS, OPEN QUESTIONS ("none" under an empty list).
Every item ends with the [hh:mm:ss] of the transcript line it came from.
${ACTION_RULE}
${GROUNDING} Use only this part.`;

export const reduceSystem = ({ glossary = '' } = {}) =>
  `You are given notes from consecutive parts of one meeting. Combine them into the final meeting notes and merge duplicates. Do not drop any action item from the chunk notes: each must appear in the result with its [hh:mm:ss] timestamp.${glossaryLine(glossary)}\n\n${FINAL_FORMAT}`;

export const mergeNotesSystem = ({ glossary = '' } = {}) =>
  `You are given notes from consecutive parts of one meeting. Merge them into one shorter set of notes using the same four lists (TOPICS, DECISIONS, ACTION ITEMS, OPEN QUESTIONS) and merge duplicates. Do not drop any action item: keep its owner, due date and timestamp. Every item keeps its [hh:mm:ss] timestamp.${glossaryLine(glossary)}\n${ACTION_RULE}\n${GROUNDING}`;
