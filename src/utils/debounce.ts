/**
 * Trailing-edge debounce keyed by an arbitrary string (typically a document URI),
 * so edits to one document never reset the timer for another.
 */

export function createKeyedDebouncer(delayMs: number) {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const schedule = (key: string, fn: () => void): void => {
    const existing = timers.get(key);
    if (existing) clearTimeout(existing);
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        fn();
      }, delayMs),
    );
  };

  const dispose = (): void => {
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
  };

  return { schedule, dispose };
}
