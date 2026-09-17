import { describe, expect, it, vi } from "vitest";

import {
  CONVERSATION_TITLE_SYSTEM_PROMPT,
  conversationTitlePrompt,
  generateConversationTitle,
  parseConversationTitle,
} from "./conversation-title.ts";

describe("conversation titles", () => {
  it("passes only bounded first-turn conversation data to the title model", () => {
    const prompt = conversationTitlePrompt("Review this pull request", "I found two race conditions");
    expect(prompt).toContain('"firstUserMessage":"Review this pull request"');
    expect(prompt).toContain('"firstAssistantAnswer":"I found two race conditions"');
    expect(prompt).not.toContain("system prompt");
  });

  it("accepts strict JSON and rejects prose, multiline, generic, and long titles", () => {
    expect(parseConversationTitle('{"title":"Pull Request Race Conditions"}')).toBe("Pull Request Race Conditions");
    expect(parseConversationTitle('```json\n{"title":"部署流程优化"}\n```')).toBe("部署流程优化");
    expect(parseConversationTitle("Pull Request Review")).toBeNull();
    expect(parseConversationTitle('{"title":"line one\\nline two"}')).toBeNull();
    expect(parseConversationTitle('{"title":"New task"}')).toBeNull();
    expect(parseConversationTitle(JSON.stringify({ title: "x".repeat(49) }))).toBeNull();
  });

  it("uses the isolated title prompt and returns a validated title", async () => {
    const invoke = vi.fn(async () => '{"title":"Coordinator Title Generation"}');
    await expect(generateConversationTitle("Implement chat titles", "Done", invoke)).resolves.toBe("Coordinator Title Generation");
    expect(invoke).toHaveBeenCalledWith(expect.stringContaining("Implement chat titles"), CONVERSATION_TITLE_SYSTEM_PROMPT);
  });
});
