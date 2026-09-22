import { ArrowUp, Mic, Plus } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { SessionList } from "./SessionList";
import { AeroShards } from "./components/backgrounds/AeroShards";
import { SideRays } from "./components/backgrounds/SideRays";
import { TopBar } from "./components/TopBar";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { useBackgroundEffect } from "./hooks/useBackgroundEffect";
import { useSidebarWidth } from "./hooks/useSidebarWidth";
import { useTheme } from "./hooks/useTheme";
import { HERO_BACKGROUND_IMAGE } from "./lib/hero-background";
import type { Message, Session } from "./types";
import { useSessionStatusEvent, useSessionUpdateEvent } from "./hooks/useIPC";

export default function App() {
  const { theme, toggleTheme } = useTheme();
  const { backgroundEffect, toggleBackgroundEffect } = useBackgroundEffect();
  const {
    width: sidebarWidth,
    setWidth: setSidebarWidth,
    isCollapsed: sidebarCollapsed,
    toggleCollapsed: toggleSidebarCollapsed,
  } = useSidebarWidth();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [landingDraft, setLandingDraft] = useState("");

  const hasBridge = typeof window.agentBridge !== "undefined";

  useEffect(() => {
    if (!hasBridge) return;
    window.agentBridge.listSessions().then(setSessions).catch(console.error);
  }, [hasBridge]);

  useEffect(() => {
    if (!hasBridge || !selectedId) {
      setMessages([]);
      return;
    }
    window.agentBridge.listMessages(selectedId).then(setMessages).catch(console.error);
  }, [hasBridge, selectedId]);

  const handleSessionUpdate = useCallback((payload: Partial<Session> & { id: string; deleted?: boolean }) => {
    setSessions((prev) => {
      if (payload.deleted) {
        return prev.filter((s) => s.id !== payload.id);
      }
      const next = prev.filter((s) => s.id !== payload.id);
      return [payload as Session, ...next].sort((a, b) => b.updatedAt - a.updatedAt);
    });
  }, []);
  useSessionUpdateEvent(handleSessionUpdate);

  const handleSessionStatus = useCallback((payload: { id: string; status: Session["status"] }) => {
    setSessions((prev) =>
      prev.map((s) => (s.id === payload.id ? { ...s, status: payload.status } : s)),
    );
  }, []);
  useSessionStatusEvent(handleSessionStatus);

  const selectedSession = useMemo(
    () => sessions.find((s) => s.id === selectedId) ?? null,
    [sessions, selectedId],
  );

  const handleCreate = useCallback(async () => {
    // Don't add to `sessions` here — main already emits a "session.update"
    // event for this (see session-manager.ts's createSession), which
    // useSessionUpdateEvent/handleSessionUpdate applies above. That event
    // typically arrives before this invoke's own promise resolves (it's
    // sent from inside the IPC handler, before the handler returns), so
    // adding the session again here raced with it and produced a duplicate
    // row with the same id. See fix/new-chat-duplicate-session.md.
    const session = await window.agentBridge.createSession();
    setSelectedId(session.id);
  }, []);

  const handleSend = useCallback(async () => {
    if (!selectedId || !draft.trim()) return;
    const content = draft.trim();
    setDraft("");
    const { message, session } = await window.agentBridge.continueSession(selectedId, content);
    setMessages((prev) => [...prev, message]);
    setSessions((prev) =>
      prev.map((s) => (s.id === session.id ? session : s)).sort((a, b) => b.updatedAt - a.updatedAt),
    );
  }, [selectedId, draft]);

  const handleRename = useCallback(async (id: string, title: string) => {
    // Same reasoning as handleCreate — the "session.update" event this
    // fires is what updates `sessions`, not a manual setSessions call here.
    await window.agentBridge.renameSession(id, title);
  }, []);

  const handleDeleteSession = useCallback(
    async (id: string) => {
      // "session.update" (deleted: true) drives removal from `sessions`.
      await window.agentBridge.deleteSession(id);
      if (selectedId === id) setSelectedId(null);
    },
    [selectedId],
  );

  const handleLandingSubmit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      const content = landingDraft.trim();
      if (!content) return;
      setLandingDraft("");
      // Same reasoning as handleCreate: don't touch `sessions`/`messages`
      // state directly here — creating the session fires "session.update"
      // (picked up above), and selecting it triggers the existing
      // listMessages effect, which will include the message we just sent.
      const session = await window.agentBridge.createSession();
      await window.agentBridge.continueSession(session.id, content);
      setSelectedId(session.id);
    },
    [landingDraft],
  );

  if (!hasBridge) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-background text-foreground">
        <div className="max-w-md rounded-lg border border-border bg-card px-8 py-6 shadow-sm">
          <h1 className="text-xl font-semibold">Browser preview mode</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            No <code className="font-mono text-foreground">window.agentBridge</code> — this page is
            running in a plain browser tab (<code className="font-mono text-foreground">bun run dev:web</code>),
            not inside Electron, so there's no IPC bridge and no session data.
          </p>
          <p className="mt-3 text-sm text-muted-foreground">
            Use this mode for UI/styling iteration only. Run{" "}
            <code className="font-mono text-foreground">bun run dev</code> for full functionality.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-app-bg text-foreground">
      <SessionList
        sessions={sessions}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onCreate={handleCreate}
        onHome={() => setSelectedId(null)}
        onRename={handleRename}
        onDelete={handleDeleteSession}
        collapsed={sidebarCollapsed}
        onToggleCollapsed={toggleSidebarCollapsed}
        width={sidebarWidth}
        onWidthChange={setSidebarWidth}
      />

      {/* Floating main panel, inset from the window edges — no divider
          against the sidebar, which sits flush on the same app-bg. */}
      <div className="relative my-3 mr-3 flex flex-1 flex-col overflow-hidden rounded-r-[20px] border-y border-r border-panel-border bg-background transition-surface">
        {/* Dark-theme-only decorative background — reactbits.dev's "Side
            Rays" (WebGL/ogl) or "Aero Shards" (WebGPU/vgpu), user-toggleable
            via TopBar. Spans the whole panel, not just the area below the
            top bar, so there's no hard rectangular seam where it starts;
            the top bar itself is transparent, so it reads as continuous
            behind it. Only shown on the idle/landing page, and unmounted
            entirely (not just hidden) outside dark mode/that page, since
            both are live GPU contexts. */}
        {theme === "dark" && !selectedSession && (
          <div className="pointer-events-none absolute inset-0 z-0">
            {backgroundEffect === "rays" ? (
              <SideRays rayColor1="#D7FF3A" rayColor2="#4A9EFF" intensity={1.6} spread={2.2} opacity={0.55} />
            ) : (
              <AeroShards backgroundColor="#1A1A1A" shardColor="#4A9EFF" accentColor="#D7FF3A" />
            )}
          </div>
        )}

        <TopBar
          // Blank until a real, content-derived title exists (see
          // session-manager.ts's updateTitle) — "New session" is the
          // pre-title placeholder, not something to surface here.
          title={selectedSession && selectedSession.title !== "New session" ? selectedSession.title : null}
          theme={theme}
          onToggleTheme={toggleTheme}
          backgroundEffect={backgroundEffect}
          onToggleBackgroundEffect={toggleBackgroundEffect}
        />

        {selectedSession ? (
          <>
            {/* Session title intentionally not shown as a header here — once
                AI title generation lands (see prompts/stage-1-session-core.md
                decision 8), it belongs in TopBar and only appears once a
                real title exists, not as a permanent fixture. */}
            <div className="flex-1 space-y-2 overflow-y-auto px-4 py-3">
              {messages.map((m) => (
                <div key={m.id} className="rounded-lg border border-border bg-card px-3 py-2 text-sm">
                  <span className="mr-2 font-mono text-xs text-muted-foreground">{m.role}</span>
                  {m.content}
                </div>
              ))}
            </div>

            <div className="flex gap-2 border-t border-border p-3">
              <Input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleSend();
                }}
                placeholder="Type a message…"
                className="flex-1"
              />
              <Button type="button" onClick={() => void handleSend()}>
                Send
              </Button>
            </div>
          </>
        ) : (
          <div
            className="relative z-10 flex flex-1 flex-col items-center justify-center gap-8 bg-cover bg-center px-4"
            style={HERO_BACKGROUND_IMAGE ? { backgroundImage: `url(${HERO_BACKGROUND_IMAGE})` } : undefined}
          >
            <div
              // Text sits directly over a busy animated background in dark
              // mode — a plain flat color reads as washed-out against it, so
              // give it a soft dark halo for contrast (invisible in light
              // mode, which has no animated backdrop to fight).
              className="flex flex-col items-center gap-0 text-center font-hero dark:[text-shadow:0_2px_24px_rgba(0,0,0,0.85),0_1px_2px_rgba(0,0,0,0.9)]"
            >
              <h1 className="text-[40px] font-medium tracking-[-0.02em] text-foreground">Hey There</h1>
              <p className="text-[38px] font-medium tracking-[-0.02em] text-text-secondary dark:text-white/40">
                What can I help you get done?
              </p>
              <p className="mt-2.5 text-sm font-normal text-muted-foreground dark:text-white/60">
                C
              </p>
            </div>

            <form onSubmit={(e) => void handleLandingSubmit(e)} className="relative z-10 w-full max-w-[640px]">
              <div
                // Glass/glossy treatment in dark mode: a busy animated
                // background needs a translucent, blurred surface to read as
                // a deliberate floating panel rather than a flat dead box —
                // light mode keeps the plain opaque card (nothing behind it
                // to blur).
                className="flex min-h-[100px] flex-col justify-between gap-3 rounded-[14px] border border-elevated-border bg-elevated p-4 shadow-[0_1px_3px_rgba(0,0,0,0.05)] transition-surface dark:border-white/10 dark:bg-white/[0.06] dark:shadow-[0_8px_32px_rgba(0,0,0,0.45)] dark:backdrop-blur-xl dark:focus-within:border-brand/40 dark:focus-within:shadow-[0_0_0_1px_rgba(215,255,58,0.25),0_8px_32px_rgba(0,0,0,0.45)]"
              >
                <Input
                  value={landingDraft}
                  onChange={(e) => setLandingDraft(e.target.value)}
                  placeholder="Ask anything…"
                  className="h-auto border-0 bg-transparent px-0 py-0 shadow-none focus-visible:ring-0 dark:placeholder:text-white/40"
                />
                <div className="flex items-center justify-between">
                  {/* Attach/voice — visual placeholders, not wired up yet. */}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 rounded-lg border border-elevated-border bg-square hover:bg-square dark:border-white/10 dark:bg-white/5 dark:text-white/70 dark:hover:bg-white/10"
                    disabled
                    aria-label="Attach a file (coming soon)"
                  >
                    <Plus />
                  </Button>
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 rounded-lg border border-elevated-border bg-square hover:bg-square dark:border-white/10 dark:bg-white/5 dark:text-white/70 dark:hover:bg-white/10"
                      disabled
                      aria-label="Voice input (coming soon)"
                    >
                      <Mic />
                    </Button>
                    <Button
                      type="submit"
                      size="icon"
                      className="h-8 w-8 rounded-lg dark:hover:bg-[#C8F02A]"
                      disabled={!landingDraft.trim()}
                      aria-label="Send"
                    >
                      <ArrowUp />
                    </Button>
                  </div>
                </div>
              </div>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}
