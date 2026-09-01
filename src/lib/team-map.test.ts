import { describe, expect, it } from "vitest";

import { buildTeamMapEdges, buildTeamMapSections, teamMapStatus, type TeamMapSnapshot } from "./team-map";

const bots = [
  { id: "atlas", name: "Atlas", section: "Work", busy: true },
  { id: "maker", name: "Pixel", section: "Work" },
  { id: "home", name: "Mochi" },
  { id: "archived", name: "Old", hidden: true },
];

describe("team map projection", () => {
  it("groups visible bots by section", () => {
    expect(buildTeamMapSections(bots)).toEqual([
      { key: "Work", name: "Work", bots: [bots[0], bots[1]] },
      { key: "", name: "General", bots: [bots[2]] },
    ]);
  });

  it("keeps the unsectioned team distinct from a section literally named General", () => {
    const projected = buildTeamMapSections([
      { id: "none", name: "Unsectioned" },
      { id: "named", name: "Named", section: " General " },
    ]);
    expect(projected.map(({ key, name }) => ({ key, name }))).toEqual([
      { key: "", name: "General" },
      { key: "General", name: "General" },
    ]);
  });

  it("keeps one edge per pair and gives live work priority", () => {
    const snapshot: TeamMapSnapshot = {
      collaborations: [{ groupId: "channel", botIds: ["atlas", "maker"], lastAt: 10 }],
      queued: [{ sourceBotId: "atlas", targetBotId: "maker", reason: "design" }],
      running: [{ sourceBotId: "atlas", targetBotId: "maker", threadId: "task" }],
    };
    expect(buildTeamMapEdges(bots, snapshot)).toEqual([
      { sourceBotId: "atlas", targetBotId: "maker", state: "running", groupId: undefined },
    ]);
  });

  it("filters archived endpoints and explains live states", () => {
    const snapshot: TeamMapSnapshot = {
      collaborations: [{ groupId: "old", botIds: ["atlas", "archived"], lastAt: 10 }],
      queued: [],
      running: [],
    };
    expect(buildTeamMapEdges(bots, snapshot)).toEqual([]);
    expect(teamMapStatus(bots[0])).toEqual({ label: "Working", tone: "success" });
    expect(teamMapStatus({ id: "x", name: "X", activity: "waiting-on-you" })).toEqual({
      label: "Waiting for you",
      tone: "warning",
    });
  });
});
