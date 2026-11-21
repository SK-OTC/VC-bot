// Encrypts secrets (Google refresh tokens) before they are stored, with AES-256-GCM from Web Crypto.
//
//  - The key is TOKEN_ENC_KEY: 32 random bytes, base64. It lives only in the Worker's secrets.
//  - Every encryption uses a fresh random 12-byte IV, stored next to the ciphertext.
//  - `context` (the Discord user id) is bound in as GCM "additional data": a ciphertext copied from one user's row to another's
//    fails to decrypt, so rows cannot be swapped between people.
//  - Nothing here logs, and no error message ever contains the plain text, the key or the ciphertext.

const enc = new TextEncoder();
const dec = new TextDecoder();
const IV_BYTES = 12;
const KEY_BYTES = 32;

export class TokenCryptoError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TokenCryptoError';
  }
}

function toBase64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromBase64(text) {
  const s = atob(String(text));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** The raw key bytes, or a fixed message (never the value) saying what is wrong with TOKEN_ENC_KEY. */
function parseKey(keyBase64) {
  if (!keyBase64) return { problem: 'TOKEN_ENC_KEY is not set.' };
  let raw;
  try {
    raw = fromBase64(String(keyBase64).trim());
  } catch {
    return { problem: 'TOKEN_ENC_KEY is not valid base64.' };
  }
  if (raw.length !== KEY_BYTES) return { problem: `TOKEN_ENC_KEY must decode to exactly ${KEY_BYTES} bytes.` };
  return { raw };
}

/** Checks the key without using it. Returns null when fine, otherwise a fixed message saying what is wrong. */
export function describeKeyProblem(keyBase64) {
  return parseKey(keyBase64).problem ?? null;
}

/** Same check as describeKeyProblem (kept async for callers that already await it). */
export async function checkKey(keyBase64) {
  return describeKeyProblem(keyBase64);
}

async function importKey(keyBase64, usage) {
  const { raw, problem } = parseKey(keyBase64);
  if (problem) throw new TokenCryptoError(problem);
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, [usage]);
}

/** Returns { ciphertext, iv }, both base64 strings. */
export async function encryptSecret(keyBase64, plaintext, context) {
  const key = await importKey(keyBase64, 'encrypt');
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: enc.encode(String(context)) },
    key,
    enc.encode(String(plaintext)),
  );
  return { ciphertext: toBase64(new Uint8Array(sealed)), iv: toBase64(iv) };
}

/** Returns the plain text. Throws TokenCryptoError (fixed message) if the key, the user, or the stored data is wrong or was changed. */
export async function decryptSecret(keyBase64, { ciphertext, iv }, context) {
  const key = await importKey(keyBase64, 'decrypt');
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(iv), additionalData: enc.encode(String(context)) },
      key,
      fromBase64(ciphertext),
    );
    return dec.decode(plain);
  } catch {
    throw new TokenCryptoError('Could not decrypt the stored token (wrong key, wrong owner, or the data was changed).');
  }
}
