import { describe, expect, it } from "vitest";
import { decline, mayOffer, waitAfter } from "./update-schedule";

const DAY = 24 * 60 * 60 * 1000;

describe("update schedule", () => {
  it("waits longer after each Later, up to 30 days", () => {
    expect([1, 2, 3, 4, 5, 6, 9].map((n) => waitAfter(n) / DAY)).toEqual([1, 3, 7, 14, 30, 30, 30]);
  });

  it("holds offers back until the wait is over", () => {
    let s = decline(null, "0.5.17", 0);
    expect(mayOffer(s, "0.5.17", DAY - 1)).toBe(false);
    expect(mayOffer(s, "0.5.17", DAY)).toBe(true);
    s = decline(s, "0.5.17", DAY);
    expect(s.declined).toBe(2);
    expect(mayOffer(s, "0.5.17", DAY + 3 * DAY - 1)).toBe(false);
  });

  it("starts over once the app has been updated", () => {
    const s = decline(decline(null, "0.5.17", 0), "0.5.17", 0);
    expect(mayOffer(s, "0.5.18", 0)).toBe(true);
    expect(decline(s, "0.5.18", 0).declined).toBe(1);
  });
});
