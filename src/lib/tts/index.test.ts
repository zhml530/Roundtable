import { beforeEach, describe, expect, it, vi } from "vitest";

import { Speaker } from "./index";

class FakeAudio {
  static latest: FakeAudio | null = null;

  src: string;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  pause = vi.fn();
  play = vi.fn(async () => {});

  constructor(src: string) {
    this.src = src;
    FakeAudio.latest = this;
  }
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function stubBridge(handler: (request: { path: string; body?: string }) => Promise<Response>): void {
  vi.stubGlobal("ogb", {
    orchestration: {
      request: vi.fn(async (request: { path: string; body?: string }) => {
        const response = await handler(request);
        return {
          status: response.status,
          headers: Object.fromEntries(response.headers.entries()),
          body: new Uint8Array(await response.arrayBuffer()),
        };
      }),
      onEvent: vi.fn(() => () => {}),
    },
  });
}

describe("Speaker lifecycle", () => {
  beforeEach(() => {
    FakeAudio.latest = null;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.stubGlobal("Audio", FakeAudio);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:voice-test");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  });

  it("settles an in-progress speak when stop interrupts audio", async () => {
    stubBridge(async ({ path }) =>
      path.endsWith("/prepare")
        ? json({ ready: true, utterances: ["Hello there."] })
        : new Response(new Blob(["mp3"]), { status: 200 }),
    );
    const speaker = new Speaker();
    const speaking = speaker.speak("Hello there.");
    await vi.waitFor(() => expect(FakeAudio.latest).not.toBeNull());

    speaker.stop();

    await expect(speaking).resolves.toBeUndefined();
    expect(FakeAudio.latest!.pause).toHaveBeenCalled();
    expect(speaker.state).toEqual({ status: "idle" });
  });

  it("aborts preparation when stopped instead of leaving a request alive", async () => {
    let requestStarted = false;
    stubBridge(async () => {
      requestStarted = true;
      return new Promise<Response>(() => {});
    });
    const speaker = new Speaker();
    const speaking = speaker.speak("A long response");

    speaker.stop();

    await expect(speaking).resolves.toBeUndefined();
    expect(requestStarted).toBe(false);
    expect(speaker.state).toEqual({ status: "idle" });
  });

  it("passes a per-bot voice through preparation and synthesis", async () => {
    const bodies: unknown[] = [];
    stubBridge(async ({ path, body }) => {
      bodies.push(JSON.parse(body ?? "{}"));
      return path.endsWith("/prepare")
        ? json({ ready: true, utterances: ["Distinct voice."] })
        : new Response(new Blob(["mp3"]), { status: 200 });
    });
    const speaker = new Speaker();
    const speaking = speaker.speak("Distinct voice.", { voiceId: "voice-bot" });
    await vi.waitFor(() => expect(FakeAudio.latest).not.toBeNull());
    FakeAudio.latest!.onended?.();
    await speaking;

    expect(bodies).toEqual([
      { text: "Distinct voice.", voiceId: "voice-bot" },
      { text: "Distinct voice.", voiceId: "voice-bot" },
    ]);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:voice-test");
  });
});
