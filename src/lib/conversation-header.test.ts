import { describe, expect, it } from "vitest";
import { channelHeaderLabels } from "./conversation-header";

describe("channelHeaderLabels", () => {
  it("shows the topic above its owning channel", () => {
    expect(channelHeaderLabels({ name: "Engineering", topicName: "Release" })).toEqual({
      title: "Release",
      subtitle: "Engineering",
    });
  });

  it("does not repeat a channel name when no topic is available", () => {
    expect(channelHeaderLabels({ name: "Engineering" })).toEqual({
      title: "Engineering",
      subtitle: "Channel",
    });
  });

  it("labels direct-message rooms explicitly", () => {
    expect(channelHeaderLabels({ name: "Ari and Bea", dm: true })).toEqual({
      title: "Ari and Bea",
      subtitle: "Direct message",
    });
  });
});
