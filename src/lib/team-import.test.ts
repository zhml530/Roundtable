import { describe, expect, it } from "vitest";

import { teamImportPreview } from "./team-import";

describe("team import preview", () => {
  it.each([1, 2])("previews version %s team files", (version) => {
    const preview = teamImportPreview({
      format: "openmaus.team",
      version,
      team: {
        name: " Engineering ",
        description: " Ships software ",
        members: [{ name: " Ada ", title: " Tech Lead " }],
        ...(version === 1
          ? { room: { name: "Engineering", bulletin: "", defaultResponder: { kind: "everyone" } } }
          : {}),
      },
    });

    expect(preview).toMatchObject({
      name: "Engineering",
      description: "Ships software",
      members: [{ name: "Ada", title: "Tech Lead" }],
    });
  });

  it("rejects unsupported and empty files", () => {
    expect(() => teamImportPreview({ format: "openmaus.team", version: 3, team: {} })).toThrow("not supported");
    expect(() =>
      teamImportPreview({ format: "openmaus.team", version: 2, team: { name: "Empty", members: [] } }),
    ).toThrow("no members");
    const retiredLeadershipField = ["chief", "Of", "Staff"].join("");
    expect(() => teamImportPreview({
      format: "openmaus.package",
      version: 1,
      package: {
        name: "Old leadership package",
        agents: [{ key: "lead", name: "Lead" }],
        [retiredLeadershipField]: "lead",
      },
    })).toThrow("leadership packages are no longer supported");
  });

  it("previews the complete package setup before installation", () => {
    const preview = teamImportPreview({
      format: "openmaus.package",
      version: 1,
      package: {
        name: "Lead Desk",
        summary: "Find qualified conversations.",
        agents: [
          { key: "scout", name: "Scout", title: "Researcher" },
          { key: "writer", name: "Writer", title: "Outreach" },
        ],
        rooms: [{}],
        playbooks: [{}, {}],
        routines: [{}],
        requirements: {
          apps: [
            { label: "Reddit" },
            { label: "Google Sheets", optional: true },
          ],
        },
      },
    });

    expect(preview).toMatchObject({
      kind: "package",
      name: "Lead Desk",
      rooms: 1,
      playbooks: 2,
      routines: 1,
      apps: [
        { label: "Reddit", optional: false },
        { label: "Google Sheets", optional: true },
      ],
    });
  });

  it("previews a portable Markdown playbook", () => {
    const preview = teamImportPreview(`---
botmrr: 1
name: Lead Desk
summary: Find qualified conversations.
agents:
  - key: scout
    name: Scout
    title: Researcher
rooms: []
playbooks: []
routines: []
requirements:
  apps:
    - label: Reddit
---

# Lead Desk

## Activation

Create the team.`);

    expect(preview).toMatchObject({
      kind: "package",
      name: "Lead Desk",
      apps: [{ label: "Reddit", optional: false }],
    });
  });
});
