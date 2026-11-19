// Keeps us under Groq's limits by waiting, instead of getting errors.
// All limits are configurable, because Groq's limits page does not say clearly which numbers apply to the
// free plan. Set them from your own account's limits page.

/** How long (ms) until `need` more units fit inside `cap` units per `windowMs`. 0 = fits now. */
export function windowWait(events, now, windowMs, cap, need) {
  const live = events.filter((e) => e.t > now - windowMs);
  const want = Math.min(need, cap);
  let total = live.reduce((n, e) => n + e.units, 0);
  if (total + want <= cap) return 0;
  for (const e of live) {
    total -= e.units;
    if (total + want <= cap) return e.t + windowMs - now;
  }
  return windowMs;
}

export class RateLimiter {
  /**
   * limits: [{ name, windowMs, cap, units: (request) => number }]. Every request is checked against all of them.
   * Example: requests per minute, audio seconds per hour.
   */
  constructor({ limits, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
    this.limits = limits.map((l) => ({ ...l, events: [] }));
    this.now = now;
    this.sleep = sleep;
    this.blockedUntil = 0;
  }

  waitMs(request) {
    const t = this.now();
    let wait = Math.max(0, this.blockedUntil - t);
    for (const l of this.limits) {
      l.events = l.events.filter((e) => e.t > t - l.windowMs);
      wait = Math.max(wait, windowWait(l.events, t, l.windowMs, l.cap, l.units(request)));
    }
    return wait;
  }

  async acquire(request) {
    for (;;) {
      const w = this.waitMs(request);
      if (w <= 0) break;
      await this.sleep(w + 50);
    }
    const t = this.now();
    for (const l of this.limits) l.events.push({ t, units: l.units(request) });
  }

  /** Called after a 429: nothing is sent until this many seconds have passed. */
  block(seconds) {
    this.blockedUntil = Math.max(this.blockedUntil, this.now() + seconds * 1000);
  }
}

/** Whisper (speech to text): requests per minute and audio seconds per hour. */
export function whisperLimiter({ requestsPerMinute = 18, audioPerHour = 6500, audioPerDay = 27000, ...rest } = {}) {
  return new RateLimiter({
    limits: [
      { name: 'requests/min', windowMs: 60_000, cap: requestsPerMinute, units: () => 1 },
      { name: 'audio sec/hour', windowMs: 3_600_000, cap: audioPerHour, units: (r) => r.billableSec },
      { name: 'audio sec/day', windowMs: 86_400_000, cap: audioPerDay, units: (r) => r.billableSec },
    ],
    ...rest,
  });
}

/** Chat models: requests per minute, tokens per minute, tokens per day. */
export function chatLimiter({ requestsPerMinute = 25, tokensPerMinute = 6500, tokensPerDay = 180_000, ...rest } = {}) {
  return new RateLimiter({
    limits: [
      { name: 'requests/min', windowMs: 60_000, cap: requestsPerMinute, units: () => 1 },
      { name: 'tokens/min', windowMs: 60_000, cap: tokensPerMinute, units: (r) => r.tokens },
      { name: 'tokens/day', windowMs: 86_400_000, cap: tokensPerDay, units: (r) => r.tokens },
    ],
    ...rest,
  });
}
