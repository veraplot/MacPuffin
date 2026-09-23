/**
 * Pause / resume / stop for a running scan.
 *
 * A scan is a loop, and a loop cannot be interrupted from outside — it has to
 * ask. `checkpoint()` is that question, and it is *awaited* rather than polled:
 * while the control is paused the returned promise simply does not settle, so
 * the loop parks where it stands. Nothing spins, nothing unwinds, and every
 * counter and collector the scan has built stays exactly as it was. That is the
 * whole difference between a pause and a stop.
 *
 * A stop issued while paused wakes the parked loops and tells them to abandon,
 * so Stop always works — including from a paused scan, and including when the
 * browser disconnects mid-pause, which would otherwise leave the walk parked
 * forever holding a file descriptor.
 */
export function createControl() {
  let state = 'running';
  let waiters = [];
  let build = null;

  // Everyone parked in a pause is released together: they each re-test `state`,
  // so a release into `stopped` aborts them and a release into `running`
  // continues them, with no branch needed here.
  const release = () => {
    const pending = waiters;
    waiters = [];
    for (const resolve of pending) resolve();
  };

  return {
    get state() {
      return state;
    },
    get paused() {
      return state === 'paused';
    },
    get stopped() {
      return state === 'stopped';
    },
    /**
     * How many loops are parked inside a pause right now. Exposed so tests can
     * assert that a pause actually held the scan, instead of sleeping and
     * hoping.
     */
    get parked() {
      return waiters.length;
    },

    /** @returns {boolean} true if this call changed the state. */
    pause() {
      if (state !== 'running') return false;
      state = 'paused';
      return true;
    },

    resume() {
      if (state !== 'paused') return false;
      state = 'running';
      release();
      return true;
    },

    stop() {
      if (state === 'stopped') return false;
      state = 'stopped';
      release();
      return true;
    },

    /**
     * Awaited by the scan wherever it is safe to be interrupted.
     * @returns {Promise<boolean>} true to abandon the walk, false to carry on.
     */
    async checkpoint() {
      while (state === 'paused') {
        await new Promise((resolve) => waiters.push(resolve));
      }
      return state === 'stopped';
    },

    /**
     * The scan hands over a way to read its results mid-flight, so a pause can
     * show what has been found so far rather than an empty screen.
     */
    provide(fn) {
      build = fn;
    },

    /** @returns {object|null} the results as they stand, or null if the scan offers none. */
    snapshot() {
      if (!build) return null;
      try {
        return build();
      } catch {
        // A snapshot is a convenience; failing to take one must never take the
        // scan down with it.
        return null;
      }
    },
  };
}
