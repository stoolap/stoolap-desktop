import { describe, expect, it } from "vitest";
import { middleCut } from "./utils";

// One unit per character, so `width` is how many fit
const within = (width: number) => (s: string) => s.length <= width;

describe("middleCut", () => {
  it("leaves a name that fits", () => {
    expect(middleCut("orders", within(10))).toBe("orders");
  });

  it("keeps the end and as much of the start as fits", () => {
    expect(middleCut("candlesticks_t1h", within(13))).toBe("candl…cks_t1h");
    expect(middleCut("candlesticks_t15m", within(13))).toBe("candl…ks_t15m");
  });

  it("keeps half of a long name at its end", () => {
    expect(middleCut("a_very_long_table_name_for_reports", within(21))).toBe("a_very_lon…or_reports");
  });

  it("gives up the start first when little fits", () => {
    expect(middleCut("candlesticks_t1h", within(8))).toBe("…cks_t1h");
  });
});
