// The "prompt" given to Whisper: a list of names and terms to spell correctly.
// Groq limits the prompt to 224 tokens. We stay well under by capping words and characters.

export function buildPrompt(glossary, { maxWords = 100, maxChars = 600 } = {}) {
  const terms = String(glossary ?? '')
    .split(/[,\n;]/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (terms.length === 0) return '';
  const out = [];
  let words = 0;
  let chars = 'Names and terms: '.length;
  for (const term of terms) {
    const w = term.split(/\s+/).length;
    if (words + w > maxWords || chars + term.length + 2 > maxChars) break;
    out.push(term);
    words += w;
    chars += term.length + 2;
  }
  return out.length ? `Names and terms: ${out.join(', ')}.` : '';
}
