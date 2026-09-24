import { describe, expect, test } from "bun:test";
import { resolveResources } from "../tools/resource-resolvers";
import { ResourceLockManager } from "./resource-lock-manager";

// AGENTS.md section 13 concurrency test: non-overlapping resources run truly simultaneously;
// overlapping resources are serialized and never execute at the same time. Covers a
// same-kind pair and a cross-kind pair, with resources resolved from real tool args.

interface Span {
  name: string;
  start: number;
  end: number;
}

async function runPair(
  locks: ResourceLockManager,
  a: { name: string; tool: string; args: Record<string, unknown> },
  b: { name: string; tool: string; args: Record<string, unknown> },
): Promise<Span[]> {
  const spans: Span[] = [];
  const t0 = performance.now();
  const job = async (j: typeof a) => {
    const lease = await locks.acquire(resolveResources(j.tool, j.args));
    const start = performance.now() - t0;
    await Bun.sleep(60);
    spans.push({ name: j.name, start, end: performance.now() - t0 });
    lease.release();
  };
  await Promise.all([job(a), job(b)]);
  return spans;
}

const overlapped = ([x, y]: Span[]) => x!.start < y!.end && y!.start < x!.end;

describe("resource-lock-manager", () => {
  test("same kind, different files: two screenshot writes run concurrently", async () => {
    const spans = await runPair(
      new ResourceLockManager(),
      { name: "a", tool: "screenshot", args: { output_path: "C:/tmp/a.png" } },
      { name: "b", tool: "screenshot", args: { output_path: "C:/tmp/b.png" } },
    );
    expect(overlapped(spans)).toBe(true);
  });

  test("same kind, same file: two screenshot writes serialize", async () => {
    const spans = await runPair(
      new ResourceLockManager(),
      { name: "a", tool: "screenshot", args: { output_path: "C:/tmp/a.png" } },
      { name: "b", tool: "screenshot", args: { output_path: "c:\\TMP\\a.png" } },
    );
    expect(overlapped(spans)).toBe(false);
  });

  test("same kind, different tabs: two browser actions run concurrently; same tab serializes", async () => {
    const locks = new ResourceLockManager();
    const parallel = await runPair(
      locks,
      { name: "a", tool: "browser_close_tab", args: { tab_id: "T1" } },
      { name: "b", tool: "browser_close_tab", args: { tab_id: "T2" } },
    );
    expect(overlapped(parallel)).toBe(true);
    const serial = await runPair(
      locks,
      { name: "a", tool: "browser_click", args: { selector: "#x" } },
      { name: "b", tool: "browser_type", args: { selector: "#y", text: "z" } },
    );
    expect(overlapped(serial)).toBe(false);
  });

  test("cross kind: browser action + native input run concurrently", async () => {
    const spans = await runPair(
      new ResourceLockManager(),
      { name: "browser", tool: "browser_click", args: { selector: "#go" } },
      { name: "native", tool: "click", args: { x: 10, y: 10 } },
    );
    expect(overlapped(spans)).toBe(true);
  });

  test("cross kind: two native-input actions from different tools serialize", async () => {
    const spans = await runPair(
      new ResourceLockManager(),
      { name: "click", tool: "click", args: { x: 10, y: 10 } },
      { name: "type", tool: "type_text", args: { text: "hi" } },
    );
    expect(overlapped(spans)).toBe(false);
  });

  test("cross kind: shell + native input run concurrently", async () => {
    const spans = await runPair(
      new ResourceLockManager(),
      { name: "shell", tool: "run_powershell", args: { command: "Get-Date" } },
      { name: "key", tool: "key_press", args: { key: "a" } },
    );
    expect(overlapped(spans)).toBe(true);
  });

  test("multi-key acquisition is atomic and waiting reports waitedMs", async () => {
    const locks = new ResourceLockManager();
    const first = await locks.acquire(["a"]);
    const pending = locks.acquire(["a", "b"]);
    // "b" must NOT be taken while "a" is still held elsewhere (no partial acquisition).
    await Bun.sleep(20);
    expect(locks.heldKeys()).toEqual(["a"]);
    first.release();
    const second = await pending;
    expect(second.waitedMs).toBeGreaterThanOrEqual(15);
    expect(locks.heldKeys().sort()).toEqual(["a", "b"]);
    second.release();
    expect(locks.heldKeys()).toEqual([]);
  });

  test("an aborted waiter leaves the queue without taking the lock", async () => {
    const locks = new ResourceLockManager();
    const held = await locks.acquire(["x"]);
    const controller = new AbortController();
    const waiting = locks.acquire(["x"], controller.signal);
    controller.abort();
    await expect(waiting).rejects.toThrow(/Aborted/);
    held.release();
    expect(locks.heldKeys()).toEqual([]);
  });
});
