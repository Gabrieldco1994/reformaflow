import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';

// @testing-library/react's `waitFor` only special-cases fake timers when it
// detects a global `jest` (checking `typeof jest !== 'undefined'`). Vitest's
// `vi.useFakeTimers()` doesn't expose that global, so without this shim any
// test that combines `vi.useFakeTimers()` with `waitFor` hangs forever (the
// internal microtask-draining `setTimeout(..., 0)` never fires because time
// is frozen and nothing ever calls `advanceTimersByTime` again). Aliasing
// `jest` to the subset of the Vitest fake-timer API `@testing-library` needs
// makes it use the correct (working) codepath.
if (typeof (globalThis as unknown as { jest?: unknown }).jest === 'undefined') {
  (globalThis as unknown as { jest: { advanceTimersByTime: (ms: number) => void } }).jest = {
    advanceTimersByTime: (ms: number) => vi.advanceTimersByTime(ms),
  };
}
