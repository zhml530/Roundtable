import { describe, expect, it } from "vitest";

import type { CoordinationTask } from "@/state/store";
import { layoutCoordinationDag } from "./coordination-dag";

function task(id: string, dependsOn: string[] = []): CoordinationTask {
  return { id, title: id, description: id, role: "developer", botId: "bot", botName: "Bot", dependsOn, status: "pending", attempt: 1 };
}

describe("layoutCoordinationDag", () => {
  it("places dependencies in earlier columns and parallel work in the same column", () => {
    const layout = layoutCoordinationDag([task("root"), task("left", ["root"]), task("right", ["root"]), task("gate", ["left", "right"])]);
    const nodes = Object.fromEntries(layout.nodes.map((node) => [node.task.id, node]));
    expect(nodes.root?.depth).toBe(0);
    expect(nodes.left?.depth).toBe(1);
    expect(nodes.right?.depth).toBe(1);
    expect(nodes.gate?.depth).toBe(2);
    expect(nodes.left?.y).not.toBe(nodes.right?.y);
  });

  it("does not recurse forever on malformed cyclic input", () => {
    const layout = layoutCoordinationDag([task("a", ["b"]), task("b", ["a"])]);
    expect(layout.nodes).toHaveLength(2);
    expect(layout.width).toBeGreaterThan(0);
  });
});
