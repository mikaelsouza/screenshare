import { describe, expect, it, vi } from "vitest";
import { type ControlMessage, ControlRateLimiter, parseControlMessage } from "@src/mesh-control";

describe("mesh-control", () => {
  it("enforces exact 256-byte length boundary on parseControlMessage", () => {
    const base = JSON.stringify({ c: "view", want: true });
    const exact256 = base + " ".repeat(256 - base.length);
    const over256 = base + " ".repeat(257 - base.length);

    expect(exact256.length).toBe(256);
    expect(over256.length).toBe(257);
    expect(parseControlMessage(exact256)).toEqual({ c: "view", want: true });
    expect(parseControlMessage(over256)).toBeNull();
  });

  it("computes msUntilReset accurately including backward clock jumps", () => {
    const limiter = new ControlRateLimiter();
    expect(limiter.allow(5_000)).toBe(true);
    expect(limiter.msUntilReset(5_000)).toBe(1_000);
    expect(limiter.msUntilReset(5_350)).toBe(650);
    expect(limiter.msUntilReset(6_000)).toBe(0);
    expect(limiter.msUntilReset(6_500)).toBe(0);
    // Backward wall-clock jump returns 0 immediately
    expect(limiter.msUntilReset(4_999)).toBe(0);
  });

  it("cancels pending deferred flush on close() and when superseded by an allowed valid message", async () => {
    vi.useFakeTimers();
    try {
      const limiter = new ControlRateLimiter();
      const applied: ControlMessage[] = [];
      const apply = (m: ControlMessage): void => { applied.push(m); };

      // 1. close() cancels pending deferred timer (and does not call clearTimeout when idle)
      const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
      limiter.close();
      expect(clearTimeoutSpy).not.toHaveBeenCalled();

      for (let i = 0; i < 20; i++) {
        limiter.handle(JSON.stringify({ c: "view", want: false }), apply);
      }
      limiter.handle(JSON.stringify({ c: "view", want: true }), apply);
      expect(applied).toHaveLength(20);
      limiter.close();
      expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
      clearTimeoutSpy.mockRestore();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(applied).toHaveLength(20);

      // 2. An allowed valid message after window reset supersedes and clears any pending deferred message
      const limiter2 = new ControlRateLimiter();
      const applied2: ControlMessage[] = [];
      const apply2 = (m: ControlMessage): void => { applied2.push(m); };
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

      for (let i = 0; i < 20; i++) {
        limiter2.handle(JSON.stringify({ c: "view", want: false }), apply2);
      }
      // Multiple overflow messages only schedule a single timer
      limiter2.handle(JSON.stringify({ c: "view", want: true }), apply2);
      limiter2.handle(JSON.stringify({ c: "view", want: false }), apply2);
      limiter2.handle(JSON.stringify({ c: "view", want: true }), apply2);
      expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
      setTimeoutSpy.mockRestore();

      // Advance system clock past window without firing timer yet, send allowed want:false
      vi.setSystemTime(Date.now() + 1_000);
      limiter2.handle(JSON.stringify({ c: "view", want: false }), apply2);
      expect(applied2).toHaveLength(21);
      expect(applied2.at(-1)).toEqual({ c: "view", want: false });

      // Advancing timers must not replay the superseded deferred want:true
      await vi.advanceTimersByTimeAsync(2_000);
      expect(applied2).toHaveLength(21);
    } finally {
      vi.useRealTimers();
    }
  });

  it("caps deferred parses per window at 20 and reschedules if timer fires early", async () => {
    vi.useFakeTimers();
    try {
      const limiter = new ControlRateLimiter();
      const applied: ControlMessage[] = [];
      const apply = (m: ControlMessage): void => { applied.push(m); };

      // 1. Exhaust 20 immediate + 20 deferred parses (20th overflow is want:true), 21st overflow is dropped
      for (let i = 0; i < 20; i++) {
        limiter.handle(JSON.stringify({ c: "view", want: false }), apply);
      }
      for (let i = 0; i < 19; i++) {
        limiter.handle(JSON.stringify({ c: "view", want: false }), apply);
      }
      limiter.handle(JSON.stringify({ c: "view", want: true }), apply); // 20th deferred parse (accepted)
      limiter.handle(JSON.stringify({ c: "view", want: false }), apply); // 21st deferred parse (dropped)

      await vi.advanceTimersByTimeAsync(1_050);
      expect(applied.at(-1)).toEqual({ c: "view", want: true });

      // 2. Simulate early timer wakeup (Date.now() still inside the window) -> reschedules and delivers once window resets
      const limiter2 = new ControlRateLimiter();
      const applied2: ControlMessage[] = [];
      const apply2 = (m: ControlMessage): void => { applied2.push(m); };
      let fakeNow = 10_000;
      const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => fakeNow);
      try {
        for (let i = 0; i < 20; i++) {
          limiter2.handle(JSON.stringify({ c: "view", want: false }), apply2);
        }
        limiter2.handle(JSON.stringify({ c: "view", want: true }), apply2);
        // Fire the 1000ms timer while Date.now() is still 10_999 (1ms early)
        fakeNow = 10_999;
        await vi.advanceTimersByTimeAsync(1_000);
        expect(applied2).toHaveLength(20);
        // Now cross the 1000ms window and advance the rescheduled 1ms timer
        fakeNow = 11_000;
        await vi.advanceTimersByTimeAsync(5);
        expect(applied2).toHaveLength(21);
        expect(applied2.at(-1)).toEqual({ c: "view", want: true });
      } finally {
        nowSpy.mockRestore();
      }
    } finally {
      vi.useRealTimers();
    }
  });
});
