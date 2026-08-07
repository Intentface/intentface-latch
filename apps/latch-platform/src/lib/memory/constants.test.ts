import { describe, expect, it } from "vitest";
import {
  MEMORY_FAILURE_BACKOFF_MS,
  MEMORY_PARK_MS,
  memoryFailureBackoffMs,
} from "./constants";

describe("memoryFailureBackoffMs", () => {
  it("doubles per consecutive failure and caps at the park interval", () => {
    const h = 3_600_000;
    expect(memoryFailureBackoffMs(1)).toBe(2 * h);
    expect(memoryFailureBackoffMs(2)).toBe(4 * h);
    expect(memoryFailureBackoffMs(3)).toBe(8 * h);
    expect(memoryFailureBackoffMs(4)).toBe(16 * h);
    // Capped, not unbounded — and a large count must not overflow into
    // Infinity, which would park the scope forever instead of daily.
    expect(memoryFailureBackoffMs(5)).toBe(MEMORY_PARK_MS);
    expect(memoryFailureBackoffMs(500)).toBe(MEMORY_PARK_MS);
  });

  it("never returns less than the base interval", () => {
    // The sweep passes `failures + 1`, so 1 is the floor in practice; 0 and a
    // negative can only come from a corrupt row, and must not retry instantly.
    expect(memoryFailureBackoffMs(0)).toBe(MEMORY_FAILURE_BACKOFF_MS);
    expect(memoryFailureBackoffMs(-3)).toBe(MEMORY_FAILURE_BACKOFF_MS);
  });
});
