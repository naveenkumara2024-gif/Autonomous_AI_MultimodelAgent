import { describe, expect, test } from "bun:test";
import { compiledEdges } from "./agent-runner";
import { listSubagents } from "./subagent-registry";

// AGENTS.md sections 10/12: a direct subagent → subagent edge would "work" in a demo while
// silently skipping the supervisor's checklist and retry cap. This reads the topology back
// from LangGraph's compiled graph (not from any table we maintain ourselves) and checks it.

describe("supervisor graph topology", () => {
  const edges = compiledEdges();
  const subagents = listSubagents().map((s) => s.name);

  test("registers the built-in desktop, browser and shell subagents", () => {
    expect(subagents.sort()).toEqual(["browser", "desktop", "shell"]);
  });

  test("every subagent's only outgoing edge goes to the supervisor", () => {
    for (const name of subagents) {
      const outgoing = edges.filter((e) => e.source === name).map((e) => e.target);
      expect(outgoing).toEqual(["supervisor"]);
    }
  });

  test("no edge connects two subagents", () => {
    const direct = edges.filter((e) => subagents.includes(e.source) && subagents.includes(e.target));
    expect(direct).toEqual([]);
  });

  test("the run starts at the supervisor", () => {
    expect(edges.filter((e) => e.source === "__start__").map((e) => e.target)).toEqual(["supervisor"]);
  });
});
