/**
 * When the app may offer an update on its own. Each "Later" waits longer
 * before the next offer (1, 3, 7, 14, then 30 days): an update is the
 * user's choice, and one turned down is not pressed. Installing one (the
 * app's version changing) starts over. Help → Check for Updates is never
 * held back.
 */

const DAY = 24 * 60 * 60 * 1000;
const WAITS = [1, 3, 7, 14, 30].map((d) => d * DAY);
/** No sooner than this after the last check, while the app stays open */
export const CHECK_EVERY = 4 * 60 * 60 * 1000;

export interface Snooze {
  /** The app's version when it was turned down */
  version: string;
  /** How many times in a row */
  declined: number;
  /** No offer before this (ms since the epoch) */
  until: number;
}

export function waitAfter(declined: number): number {
  return WAITS[Math.min(declined, WAITS.length) - 1] ?? 0;
}

/** The snooze after one more "Later" */
export function decline(prev: Snooze | null, version: string, now: number): Snooze {
  const declined = prev && prev.version === version ? prev.declined + 1 : 1;
  return { version, declined, until: now + waitAfter(declined) };
}

/** Whether the app may offer an update now */
export function mayOffer(snooze: Snooze | null, version: string, now: number): boolean {
  return !snooze || snooze.version !== version || now >= snooze.until;
}

const KEY = "update-snooze";

export function loadSnooze(): Snooze | null {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "null");
  } catch {
    return null;
  }
}

export function saveSnooze(snooze: Snooze) {
  try {
    localStorage.setItem(KEY, JSON.stringify(snooze));
  } catch {
    // Without storage it offers again on the next launch
  }
}
