// The transcription time budget (PARAKEET_BUDGET_MIN, default 120 minutes).
//
// The job limit is 345 minutes and a meeting can run 150, so transcription gets a budget. The pipeline measures how fast the
// main engine really is (seconds of audio per second of wall clock) over the first batches, projects the total, and if the
// projection would go over the budget it sends ALL the remaining batches to the fallback engine. Once it has decided, it stays
// decided: the work is not shuffled back and forth.
//
//   projected = time already spent + remaining audio / measured speed
//
// Before there is enough to measure (minSamples batches AND minAudioSec seconds of audio) no projection is made, but a budget
// that is simply used up still stops the main engine.

export function createTimeBudget({ budgetSec, now = Date.now, minSamples = 2, minAudioSec = 60 }) {
  const start = now();
  let audioDone = 0;
  let wallDone = 0;
  let samples = 0;
  let decision = null; // { reason, speed, projectedSec } once the work has been moved

  const elapsedSec = () => (now() - start) / 1000;
  const speed = () => (wallDone > 0 ? audioDone / wallDone : null);

  return {
    /** Call after each batch the main engine finished: how many seconds of audio it was and how long it took. */
    record(audioSec, wallSec) {
      if (audioSec > 0 && wallSec > 0) {
        audioDone += audioSec;
        wallDone += wallSec;
        samples++;
      }
    },
    speed,
    elapsedSec,
    get decision() {
      return decision;
    },
    /** Before each batch: should the rest go to the fallback? remainingAudioSec = audio still to do, this batch included. */
    shouldFallBack(remainingAudioSec) {
      if (decision) return true;
      const spent = elapsedSec();
      if (spent >= budgetSec) {
        decision = { reason: 'the time budget is used up', speed: speed(), projectedSec: spent };
        return true;
      }
      const s = speed();
      if (s && samples >= minSamples && audioDone >= minAudioSec) {
        const projectedSec = spent + remainingAudioSec / s;
        if (projectedSec > budgetSec) {
          decision = { reason: 'the projected time is over the budget', speed: s, projectedSec };
          return true;
        }
      }
      return false;
    },
  };
}
