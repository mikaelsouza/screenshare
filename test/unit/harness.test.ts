import { describe, expect, it, vi } from "vitest";
import { MAX_ROOM_SIZE } from "@shared/protocol";
import { DEFAULT_CODEC, preferCodec } from "@src/quality";
import { isDirect } from "@src/stats";
import type { LinkHealth } from "@src/quality";

interface HarnessCli {
  DEFAULT_PEERS: number;
  parseArgs: (argv: string[]) => {
    command: string;
    role: string | null;
    both: boolean;
    json: boolean;
    mode: string | null;
    seconds: number;
  };
}

interface HarnessLib {
  SELECTORS: Record<string, string>;
  DIRECT_TYPES: readonly string[];
  redact: (text: string, options?: { room?: string; names?: string[] }) => string;
}

/** Computed specifier: strict tsc has no allowJs, so a literal .mjs import is rejected. */
async function load<T>(relativePath: string): Promise<T> {
  const specifier = new URL(relativePath, import.meta.url).href;
  return (await import(/* @vite-ignore */ specifier)) as T;
}

const cli = await load<HarnessCli>("../manual/cli.mjs");
const lib = await load<HarnessLib>("../manual/lib.mjs");

const directLink: LinkHealth = {
  candidateType: "srflx",
  remoteCandidateType: "srflx",
  rttMs: 20,
  availableOutgoingBitrate: null,
  packetLossRatio: null,
  outboundBitrate: null,
  framesPerSecond: null,
  frameWidth: null,
  frameHeight: null,
  encoderImplementation: null,
  jitterBufferDelayMs: null,
};

describe("manual harness contract", () => {
  it("pins DEFAULT_PEERS to the room cap", () => {
    expect(cli.DEFAULT_PEERS).toBe(MAX_ROOM_SIZE);
    expect(cli.DEFAULT_PEERS).toBe(20);
  });

  it("rejects ambiguous or incomplete arguments", () => {
    expect(() => cli.parseArgs([])).toThrow();
    expect(() => cli.parseArgs(["pair"])).toThrow();
    expect(() => cli.parseArgs(["pair", "--create", "--room", "ABCD2345"])).toThrow();
    expect(() => cli.parseArgs(["pair", "--both", "--role", "viewer"])).toThrow();
    expect(() => cli.parseArgs(["load", "--expect-peers", "21"])).toThrow();
    expect(() => cli.parseArgs(["audio", "--mode", "bogus"])).toThrow();
    expect(() => cli.parseArgs(["timer", "--create"])).toThrow();
  });

  it("parses the documented pair/audio shapes", () => {
    const both = cli.parseArgs(["pair", "--both", "--media", "fake", "--seconds", "10"]);
    expect(both.command).toBe("pair");
    expect(both.role).toBe("both");
    expect(both.both).toBe(true);
    expect(both.seconds).toBe(10);

    const created = cli.parseArgs(["pair", "--create", "--role", "sharer", "--json"]);
    expect(created.role).toBe("sharer");
    expect(created.json).toBe(true);

    const audio = cli.parseArgs(["audio", "--mode", "second-pick", "--both"]);
    expect(audio.mode).toBe("second-pick");
    expect(audio.role).toBe("both");

    expect(cli.parseArgs(["timer", "--seconds", "1"]).command).toBe("timer");
  });

  it("pins the selector map so a page rename fails loudly", () => {
    expect(Object.values(lib.SELECTORS)).toEqual(
      expect.arrayContaining([
        "#display-name",
        "#room-code",
        "#create",
        "#join",
        "#relay-only",
        "#preset",
        "#codec",
        "#status",
        "#roster",
        "#roster-list",
        "#share",
        "#audio-mode",
        "#audio-chip-text",
        "#audio-pick-app",
        ".tile-health",
      ]),
    );
  });

  it("redacts every identifier the issue forbids in a comment", () => {
    const raw =
      "peer 3f2c1a9e-8b4d-4c1e-9a7f-0e5d6c4b3a21 " +
      "at 203.0.113.5 and 2001:db8::1, room ABCD2345, name Alice, hostToken=supersecret123";
    const clean = lib.redact(raw, { room: "ABCD2345", names: ["Alice"] });

    for (const secret of [
      "3f2c1a9e-8b4d-4c1e-9a7f-0e5d6c4b3a21",
      "203.0.113.5",
      "2001:db8::1",
      "ABCD2345",
      "Alice",
      "supersecret123",
    ]) {
      expect(clean).not.toContain(secret);
    }
    expect(clean).toContain("<peer>");
    expect(clean).toContain("<ipv4>");
    expect(clean).toContain("<ipv6>");
    expect(clean).toContain("<room>");
    expect(clean).toContain("<name>");
    expect(clean).toContain("<redacted>");
    expect(lib.redact("plain room code ABCD2345")).toContain("<room>");
  });

  it("keeps the direct candidate set behind isDirect", () => {
    expect(lib.DIRECT_TYPES).toEqual(["host", "srflx", "prflx"]);
    for (const type of lib.DIRECT_TYPES) {
      expect(isDirect({ ...directLink, candidateType: type, remoteCandidateType: type })).toBe(true);
    }
    expect(isDirect({ ...directLink, candidateType: "relay" })).toBe(false);
    expect(isDirect({ ...directLink, candidateType: "unknown" })).toBe(false);
  });

  it("puts H.264 first in codec preferences", () => {
    expect(DEFAULT_CODEC).toBe("h264");
    const codecs = [
      { mimeType: "video/VP8", clockRate: 90000 },
      { mimeType: "video/H264", clockRate: 90000 },
      { mimeType: "video/VP9", clockRate: 90000 },
      { mimeType: "video/AV1", clockRate: 90000 },
    ];
    const getCapabilities = vi.fn(() => ({ codecs }));
    vi.stubGlobal("RTCRtpSender", { getCapabilities });
    const setCodecPreferences = vi.fn();
    try {
      preferCodec({ setCodecPreferences } as unknown as RTCRtpTransceiver, "h264");
      expect(setCodecPreferences).toHaveBeenCalledTimes(1);
      const ordered = setCodecPreferences.mock.calls[0]?.[0] as Array<{ mimeType: string }>;
      expect(ordered).toHaveLength(codecs.length);
      expect(ordered[0]?.mimeType).toBe("video/H264");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps the latency page a file-URL clock, not an app route", async () => {
    // @ts-expect-error -- this project intentionally has no @types/node.
    const fs = (await import("node:fs")) as {
      readFileSync: (path: URL, encoding: "utf8") => string;
    };
    const html = fs.readFileSync(new URL("../manual/latency.html", import.meta.url), "utf8");
    expect(html).toContain('id="clock"');
    expect(html).toContain('id="frames"');
    expect(html).toContain("requestAnimationFrame");
    expect(html).toContain("performance.now()");
    expect(html).toContain("getMilliseconds()");
    expect(html).toMatch(/100vw|100vh/);
    expect(html).not.toContain("src/main.ts");
  });
});
