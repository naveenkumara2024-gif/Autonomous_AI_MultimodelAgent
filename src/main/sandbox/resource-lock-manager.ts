/**
 * Global, resource-keyed locks (AGENTS.md section 11). Concurrency is decided by the
 * `resources` a call resolves to — never by which subagent or tool kind issued it — and the
 * table is shared across ALL sessions, because the things being protected (the real mouse and
 * keyboard, a Chrome tab, a file) are machine-wide.
 *
 * A call acquires all of its keys atomically or waits: holding some keys while waiting for
 * others is how two calls deadlock, so partial acquisition never happens. Waiters are served
 * FIFO, except a waiter whose keys are free may run ahead of an earlier one that is still
 * blocked — otherwise one busy key would stall unrelated work behind it.
 */

export interface LockLease {
  release: () => void;
  waitedMs: number;
}

interface Waiter {
  keys: string[];
  grant: () => void;
  signal?: AbortSignal;
}

export class ResourceLockManager {
  private readonly held = new Set<string>();
  private readonly waiters: Waiter[] = [];

  /** Keys currently held — exposed for tests and diagnostics. */
  heldKeys(): string[] {
    return [...this.held];
  }

  async acquire(resources: string[], signal?: AbortSignal): Promise<LockLease> {
    const keys = [...new Set(resources)];
    const start = Date.now();

    if (keys.length === 0) return { release: () => {}, waitedMs: 0 };
    if (signal?.aborted) throw abortError();

    if (this.isFree(keys) && this.waiters.length === 0) {
      this.take(keys);
      return { release: this.releaser(keys), waitedMs: 0 };
    }

    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        keys,
        signal,
        grant: () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        },
      };
      const onAbort = () => {
        const idx = this.waiters.indexOf(waiter);
        if (idx !== -1) this.waiters.splice(idx, 1);
        reject(abortError());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(waiter);
      this.drain();
    });

    return { release: this.releaser(keys), waitedMs: Date.now() - start };
  }

  private isFree(keys: string[]): boolean {
    return keys.every((k) => !this.held.has(k));
  }

  private take(keys: string[]): void {
    for (const k of keys) this.held.add(k);
  }

  private releaser(keys: string[]): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const k of keys) this.held.delete(k);
      this.drain();
    };
  }

  private drain(): void {
    for (let i = 0; i < this.waiters.length; ) {
      const waiter = this.waiters[i]!;
      if (this.isFree(waiter.keys)) {
        this.waiters.splice(i, 1);
        this.take(waiter.keys);
        waiter.grant();
      } else {
        i++;
      }
    }
  }
}

function abortError(): Error {
  const error = new Error("Aborted while waiting for a resource lock.");
  error.name = "AbortError";
  return error;
}

/** The one lock table for the whole app — shared by every session's tool executor. */
export const resourceLocks = new ResourceLockManager();
