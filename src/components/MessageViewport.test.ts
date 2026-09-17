/* oxlint-disable anti-slop/no-module-mocking -- Render viewport frames without browser-only virtualizer measurement. */
import { createElement, Fragment, type ComponentType, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MessageViewport } from "./MessageViewport";

vi.mock("react-virtuoso", () => ({
  Virtuoso: ({ components, context, data }: {
    components: {
      List: ComponentType<{ children?: ReactNode }>;
      Footer: ComponentType<{ context: { empty: boolean; footer?: ReactNode } }>;
      EmptyPlaceholder: ComponentType<{ context: { empty: boolean; footer?: ReactNode } }>;
    };
    context: { empty: boolean; footer?: ReactNode };
    data: unknown[];
  }) => createElement(
    Fragment,
    null,
    data.length
      ? createElement(components.List, null, "Settled message")
      : createElement(components.EmptyPlaceholder, { context }),
    createElement(components.Footer, { context }),
  ),
}));

function renderViewport(empty: boolean, footer?: ReactNode) {
  return renderToStaticMarkup(createElement(MessageViewport, {
    ariaLabel: "Conversation",
    items: empty ? [] : [{ key: "message", messageIds: ["message"] }],
    canLoadEarlier: false,
    loading: false,
    onLoadEarlier: () => {},
    renderItem: () => null,
    footer,
  }));
}

function frameClasses(markup: string, text: string) {
  const classes = markup.match(new RegExp(`<div class="([^"]+)">${text}</div>`))?.[1];
  expect(classes).toBeDefined();
  return classes!.split(" ");
}

describe("MessageViewport live-output alignment", () => {
  it.each(["Thinking…", "Working for 12s", "Streaming reply"])(
    "keeps %s in the same centered column as settled messages",
    (text) => {
      const markup = renderViewport(false, text);
      const settledClasses = frameClasses(markup, "Settled message");
      const liveClasses = frameClasses(markup, text);

      for (const className of ["mx-auto", "w-[calc(100%-2.5rem)]", "max-w-[900px]"]) {
        expect(settledClasses).toContain(className);
        expect(liveClasses).toContain(className);
      }
      expect(liveClasses).toContain("pt-3");
      expect(liveClasses).toContain("pb-14");
    },
  );

  it("keeps empty-thread output centered without duplicating the footer", () => {
    const markup = renderViewport(true, "Thinking…");
    const classes = frameClasses(markup, "Thinking…");
    expect(classes).toEqual(expect.arrayContaining(["mx-auto", "w-[calc(100%-2.5rem)]", "max-w-[900px]"]));
    expect(markup.match(/Thinking…/g)).toHaveLength(1);
  });

  it("preserves the bottom spacer when there is no live output", () => {
    expect(renderViewport(false)).toContain('<div class="h-14" aria-hidden="true"></div>');
  });
});
