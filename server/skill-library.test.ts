import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadUserSkills, mergeSkills, parseSkillManifest, skillInstructionsFor, type BundledSkill } from "./skill-library.ts";

const calendar: BundledSkill = {
  directory: "/skills/calendar-helper",
  instructions: "---\nname: calendar-helper\ndescription: test\n---\nUse calendar tools.",
  manifest: {
    id: "calendar-helper",
    name: "Calendar Helper",
    version: "0.1.0",
    description: "Manage a calendar",
    defaultEnabled: true,
    triggerTerms: ["calendar", "schedule"],
    requiredCapabilities: ["calendarMcp"],
  },
};

describe("bundled skill library", () => {
  it("selects a skill only when both its trigger and capability are present", () => {
    const rendered = skillInstructionsFor("Schedule lunch", ["calendarMcp"], [calendar]);
    expect(rendered).toContain("Use calendar tools");
    expect(rendered).not.toContain('root="/skills/calendar-helper"');
    expect(skillInstructionsFor("Schedule lunch", ["calendarMcp"], [calendar], { includeRoot: true }))
      .toContain('root="/skills/calendar-helper"');
    expect(skillInstructionsFor("Schedule lunch", [], [calendar])).toBe("");
    expect(skillInstructionsFor("Write a poem", ["calendarMcp"], [calendar])).toBe("");
  });

  it("requires the manifest id to match its isolated folder", () => {
    expect(() => parseSkillManifest({
      ...calendar.manifest,
      id: "other-skill",
    }, "/skills/calendar-helper")).toThrow(/invalid id/);
  });

  it("loads a recorded skill without letting a broken sibling disable it", () => {
    const root = mkdtempSync(join(tmpdir(), "Roundtable-skills-"));
    const valid = join(root, "file-expense");
    mkdirSync(valid);
    writeFileSync(join(valid, "manifest.json"), JSON.stringify({
      id: "file-expense", name: "File expense", version: "1.0.0", description: "File expenses",
      defaultEnabled: true, triggerTerms: ["expense"], requiredCapabilities: [],
    }));
    writeFileSync(join(valid, "SKILL.md"), "---\nname: file-expense\ndescription: File expenses\n---\nDo it safely.\n");
    const broken = join(root, "broken");
    mkdirSync(broken);
    writeFileSync(join(broken, "manifest.json"), "not json");
    writeFileSync(join(broken, "SKILL.md"), "broken");

    expect(loadUserSkills(root).map((skill) => skill.manifest.id)).toEqual(["file-expense"]);
  });

  it("does not let a user skill shadow a bundled skill id", () => {
    expect(mergeSkills([calendar], [{ ...calendar, instructions: "user replacement" }])).toEqual([calendar]);
  });

  it("treats a non-directory user skill root as empty", () => {
    const root = mkdtempSync(join(tmpdir(), "Roundtable-skills-root-"));
    const file = join(root, "not-a-directory");
    writeFileSync(file, "nope");
    expect(loadUserSkills(file)).toEqual([]);
  });
});

