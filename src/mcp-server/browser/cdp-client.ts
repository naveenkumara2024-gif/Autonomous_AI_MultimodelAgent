import { sleep, withTimeout } from "../core/async";

// --- Browser automation via Chrome DevTools Protocol (CDP) ---
//
// The desktop tools drive apps blindly through screen coordinates — necessary for arbitrary GUI
// apps, but wasteful for a browser, which already exposes a JSON-RPC-over-WebSocket API for
// querying the DOM by CSS selector and reading/typing into elements directly.
//
// We'd prefer to attach to the user's already-running, default-profile Chrome — but since
// Chrome 136, remote debugging is refused outright on the default user-data-dir (anti-malware
// hardening: a local process used to be able to silently steal session cookies via CDP). So we
// drive a SEPARATE, persistent profile dedicated to automation (PROFILE_DIR, kept across runs):
// logins made through it stick around, and the user's normal Chrome windows are never touched.
// Bun's native fetch/WebSocket cover CDP's transport entirely; no dependency.
//
// Hand-off to the desktop tools is intentionally narrow: most things people reach for a
// "native fallback" for have a direct CDP answer (DOM.setFileInputFiles for uploads,
// Page.handleJavaScriptDialog for alert/confirm/prompt). What's left is native OS/browser-chrome
// UI CDP can't see (a Windows Hello prompt, a hand-off to another native app).

const CDP_HOST = "127.0.0.1";
const CDP_PORT = 9222;
const CDP_BASE_URL = `http://${CDP_HOST}:${CDP_PORT}`;
const PROFILE_DIR = `${process.env.TEMP ?? process.env.LOCALAPPDATA ?? "C:\\Temp"}\\mcpgui-chrome-cdp`;

export interface CdpSession {
  targetId: string;
  sessionId: string;
  url: string;
  title: string;
}

interface CdpEventWaiter {
  sessionId?: string;
  resolve: (params: any) => void;
}

export interface CdpState {
  ws: WebSocket;
  nextId: number;
  pending: Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>;
  eventWaiters: Map<string, CdpEventWaiter[]>;
  sessions: Map<string, CdpSession>;
  currentSessionId: string | null;
  inFlightRequests: Map<string, Set<string>>;
  pendingDialogs: Map<string, { message: string; type: string }>;
}

let cdp: CdpState | null = null;

export function cdpSend(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
  if (!cdp) return Promise.reject(new Error("Not connected to Chrome."));
  const state = cdp;
  const id = state.nextId++;
  const message: Record<string, unknown> = { id, method, params };
  if (sessionId) message.sessionId = sessionId;
  return new Promise((resolve, reject) => {
    state.pending.set(id, { resolve, reject });
    state.ws.send(JSON.stringify(message));
  });
}

// One-shot listener for a CDP event, optionally scoped to a session (tab) — e.g. awaiting
// Page.loadEventFired for the tab we navigated, not any tab that happens to load. Register it
// BEFORE sending the triggering command, or a fast event can fire before we listen.
export function waitForCdpEvent(method: string, sessionId: string | undefined, timeoutMs: number): Promise<any> {
  if (!cdp) return Promise.reject(new Error("Not connected to Chrome."));
  const state = cdp;
  return new Promise((resolve, reject) => {
    const waiter: CdpEventWaiter = {
      sessionId,
      resolve: (params) => {
        clearTimeout(timer);
        resolve(params);
      },
    };
    const timer = setTimeout(() => {
      const waiters = state.eventWaiters.get(method);
      const idx = waiters?.indexOf(waiter) ?? -1;
      if (waiters && idx !== -1) waiters.splice(idx, 1);
      reject(new Error(`Timed out waiting for ${method} after ${timeoutMs}ms.`));
    }, timeoutMs);
    const waiters = state.eventWaiters.get(method) ?? [];
    waiters.push(waiter);
    state.eventWaiters.set(method, waiters);
  });
}

function dispatchCdpEvent(state: CdpState, method: string, params: any, sessionId?: string): void {
  if (sessionId && method === "Network.requestWillBeSent") {
    const set = state.inFlightRequests.get(sessionId) ?? new Set<string>();
    set.add(params.requestId);
    state.inFlightRequests.set(sessionId, set);
  } else if (sessionId && (method === "Network.loadingFinished" || method === "Network.loadingFailed")) {
    state.inFlightRequests.get(sessionId)?.delete(params.requestId);
  } else if (sessionId && method === "Page.javascriptDialogOpening") {
    state.pendingDialogs.set(sessionId, { message: params.message, type: params.type });
  } else if (sessionId && method === "Page.javascriptDialogClosed") {
    state.pendingDialogs.delete(sessionId);
  } else if (method === "Target.targetDestroyed") {
    for (const [sid, session] of state.sessions) {
      if (session.targetId === params.targetId) {
        state.sessions.delete(sid);
        if (state.currentSessionId === sid) state.currentSessionId = null;
      }
    }
  }

  const waiters = state.eventWaiters.get(method);
  if (waiters && waiters.length > 0) {
    const remaining: CdpEventWaiter[] = [];
    for (const waiter of waiters) {
      if (waiter.sessionId === undefined || waiter.sessionId === sessionId) waiter.resolve(params);
      else remaining.push(waiter);
    }
    state.eventWaiters.set(method, remaining);
  }
}

async function launchChromeWithDebugPort(): Promise<void> {
  // Plain "chrome" via `start` resolves through the App Paths registry entry — no hunting for
  // chrome.exe. --user-data-dir is our own persistent profile (Chrome 136+ refuses the debug
  // port on the default one), so this never collides with the user's running Chrome.
  Bun.spawn(
    ["cmd", "/c", "start", "", "chrome", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${PROFILE_DIR}`, "--no-first-run", "--no-default-browser-check"],
    { stdout: "ignore", stderr: "ignore" },
  );
  const attempts = 10;
  for (let i = 0; i < attempts; i++) {
    await sleep(500);
    try {
      const res = await fetch(`${CDP_BASE_URL}/json/version`);
      if (res.ok) return;
    } catch {
      // Not up yet; keep polling.
    }
  }
  throw new Error(`Launched Chrome but it never responded on the debug port (${CDP_PORT}) after ${(attempts * 500) / 1000}s.`);
}

async function connectCdp(): Promise<void> {
  let versionRes: Response;
  try {
    versionRes = await fetch(`${CDP_BASE_URL}/json/version`);
    if (!versionRes.ok) throw new Error(`status ${versionRes.status}`);
  } catch {
    await launchChromeWithDebugPort();
    versionRes = await fetch(`${CDP_BASE_URL}/json/version`);
  }

  const version = (await versionRes.json()) as { webSocketDebuggerUrl: string };
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  const state: CdpState = {
    ws,
    nextId: 1,
    pending: new Map(),
    eventWaiters: new Map(),
    sessions: new Map(),
    currentSessionId: null,
    inFlightRequests: new Map(),
    pendingDialogs: new Map(),
  };

  ws.onmessage = (event) => {
    let msg: any;
    try {
      msg = JSON.parse(event.data as string);
    } catch {
      return;
    }
    if (msg.id !== undefined) {
      const pendingReq = state.pending.get(msg.id);
      if (!pendingReq) return;
      state.pending.delete(msg.id);
      if (msg.error) pendingReq.reject(new Error(msg.error.message ?? "CDP error"));
      else pendingReq.resolve(msg.result);
    } else if (msg.method) {
      dispatchCdpEvent(state, msg.method, msg.params, msg.sessionId);
    }
  };

  ws.onclose = () => {
    if (cdp === state) cdp = null;
    for (const pendingReq of state.pending.values()) pendingReq.reject(new Error("CDP connection closed."));
  };

  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("Failed to open CDP WebSocket connection."));
  });

  cdp = state;

  const targets = (await cdpSend("Target.getTargets")) as { targetInfos: Array<{ targetId: string; type: string }> };
  const firstPage = targets.targetInfos.find((t) => t.type === "page");
  if (firstPage) await attachAndPrepare(firstPage.targetId);
}

export async function ensureBrowserConnected(): Promise<CdpState> {
  if (cdp && cdp.ws.readyState === WebSocket.OPEN) return cdp;
  await connectCdp();
  if (!cdp) throw new Error("Failed to establish a CDP connection.");
  return cdp;
}

export async function attachAndPrepare(targetId: string): Promise<CdpSession> {
  const state = await ensureBrowserConnected();
  const attached = (await cdpSend("Target.attachToTarget", { targetId, flatten: true })) as { sessionId: string };
  const sessionId = attached.sessionId;
  await Promise.all([
    cdpSend("Page.enable", {}, sessionId),
    cdpSend("DOM.enable", {}, sessionId),
    cdpSend("Runtime.enable", {}, sessionId),
    cdpSend("Network.enable", {}, sessionId),
  ]);
  await cdpSend("Page.setLifecycleEventsEnabled", { enabled: true }, sessionId);

  const info = (await cdpSend("Target.getTargetInfo", { targetId })) as { targetInfo: { url: string; title: string } };
  const session: CdpSession = { targetId, sessionId, url: info.targetInfo.url, title: info.targetInfo.title };
  state.sessions.set(sessionId, session);
  state.currentSessionId = sessionId;
  return session;
}

export function getCurrentSession(state: CdpState): CdpSession {
  if (!state.currentSessionId) throw new Error("No active browser tab. Call browser_connect or browser_new_tab first.");
  const session = state.sessions.get(state.currentSessionId);
  if (!session) throw new Error("Active tab session is stale. Call browser_list_tabs / browser_activate_tab to pick a tab.");
  return session;
}

/** Re-reads a tab's real URL/title (after redirects), instead of trusting what was requested. */
export async function refreshSessionInfo(session: CdpSession): Promise<CdpSession> {
  const info = (await cdpSend("Target.getTargetInfo", { targetId: session.targetId })) as { targetInfo: { url: string; title: string } };
  session.url = info.targetInfo.url;
  session.title = info.targetInfo.title;
  return session;
}

export async function listOpenTabs(state: CdpState): Promise<Array<{ id: string; url: string; title: string; current: boolean }>> {
  const targets = (await cdpSend("Target.getTargets")) as {
    targetInfos: Array<{ targetId: string; type: string; url: string; title: string }>;
  };
  return targets.targetInfos
    .filter((t) => t.type === "page")
    .map((t) => {
      const session = [...state.sessions.values()].find((s) => s.targetId === t.targetId);
      return { id: t.targetId, url: t.url, title: t.title, current: session?.sessionId === state.currentSessionId };
    });
}

const EVAL_TIMEOUT_MS = 5000;
const EVAL_TIMEOUT_HINT =
  "the page may be blocked on a native/JS dialog (alert/confirm/prompt) — check with browser_list_tabs, take a browser_screenshot, and use browser_handle_dialog if one is open.";

export async function cdpEvaluate(sessionId: string, expression: string, awaitPromise = false): Promise<any> {
  const evalPromise = cdpSend("Runtime.evaluate", { expression, returnByValue: true, awaitPromise, silent: true }, sessionId) as Promise<{
    result?: { value?: unknown };
    exceptionDetails?: { text?: string; exception?: { description?: string } };
  }>;
  const result = await withTimeout(evalPromise, EVAL_TIMEOUT_MS, `Evaluation timed out after ${EVAL_TIMEOUT_MS}ms — ${EVAL_TIMEOUT_HINT}`);
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "Evaluation threw.");
  }
  return result.result?.value;
}

export function checkNoPendingDialog(state: CdpState, session: CdpSession): void {
  const dialog = state.pendingDialogs.get(session.sessionId);
  if (dialog) {
    throw new Error(`A ${dialog.type} dialog is open on this tab ("${dialog.message}"). Call browser_handle_dialog before doing anything else on it.`);
  }
}

/** Connected state + current tab, the preamble nearly every browser_* tool starts with. */
export async function activeTab(options: { requireNoDialog?: boolean } = {}): Promise<{ state: CdpState; session: CdpSession }> {
  const state = await ensureBrowserConnected();
  const session = getCurrentSession(state);
  if (options.requireNoDialog) checkNoPendingDialog(state, session);
  return { state, session };
}
