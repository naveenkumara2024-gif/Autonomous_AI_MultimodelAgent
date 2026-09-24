import { Bot, MoreHorizontal, PanelLeft, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "./components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu";
import { Input } from "./components/ui/input";
import { ScrollArea } from "./components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./components/ui/tooltip";
import { SIDEBAR_MAX_WIDTH, SIDEBAR_ICON_WIDTH } from "./hooks/useSidebarWidth";
import type { Session } from "./types";

const STATUS_DOT_CLASS: Record<Session["status"], string> = {
  created: "bg-status-created",
  idle: "bg-status-idle",
  running: "bg-status-running animate-pulse",
  stopped: "bg-status-stopped",
  deleted: "bg-destructive",
};

interface SessionRowProps {
  session: Session;
  selected: boolean;
  editing: boolean;
  onSelect: () => void;
  onStartEdit: () => void;
  onCommitEdit: (title: string) => void;
  onCancelEdit: () => void;
  onDelete: () => void;
}

function SessionRow({
  session,
  selected,
  editing,
  onSelect,
  onStartEdit,
  onCommitEdit,
  onCancelEdit,
  onDelete,
}: SessionRowProps) {
  const [draft, setDraft] = useState(session.title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) return;
    setDraft(session.title);
    const id = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(id);
  }, [editing, session.title]);

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== session.title) {
      onCommitEdit(trimmed);
    } else {
      onCancelEdit();
    }
  };

  return (
    <div
      className={`group flex items-center gap-2 rounded-lg py-2 pr-1 text-sm transition-colors hover:bg-accent hover:text-accent-foreground ${
        selected
          ? "border-l-2 border-brand bg-accent pl-[6px] text-accent-foreground"
          : "border-l-2 border-transparent pl-[6px] text-foreground"
      }`}
    >
      <span className={`h-2 w-2 shrink-0 rounded-full ${STATUS_DOT_CLASS[session.status]}`} />

      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") onCancelEdit();
          }}
          onBlur={commit}
          className="min-w-0 flex-1 rounded-sm bg-transparent px-1 text-sm outline-none ring-1 ring-ring"
        />
      ) : (
        <button type="button" onClick={onSelect} className="min-w-0 flex-1 truncate text-left">
          {/* key={session.title}: replays the fade-in whenever the title
              text changes (truncated fallback -> AI-refined title, or a
              manual rename), same treatment as TopBar's title. */}
          <span key={session.title} className="block truncate animate-in fade-in-0 duration-300">
            {session.title}
          </span>
        </button>
      )}

      {!editing && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-6 w-6 shrink-0 opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100"
              onClick={(e) => e.stopPropagation()}
              aria-label="Session options"
            >
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onCloseAutoFocus={(e) => e.preventDefault()}>
            <DropdownMenuItem onSelect={onStartEdit}>
              <Pencil />
              Edit
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={onDelete}
              className="text-destructive focus:bg-destructive focus:text-destructive-foreground"
            >
              <Trash2 />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

interface SessionListProps {
  sessions: Session[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onHome: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  width: number;
  onWidthChange: (width: number) => void;
}

export function SessionList({
  sessions,
  selectedId,
  onSelect,
  onCreate,
  onHome,
  onRename,
  onDelete,
  collapsed,
  onToggleCollapsed,
  width,
  onWidthChange,
}: SessionListProps) {
  const [query, setQuery] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [isResizing, setIsResizing] = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter((s) => s.title.toLowerCase().includes(q));
  }, [sessions, query]);

  const handleResizeStart = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      setIsResizing(true);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      const handleMove = (ev: PointerEvent) => {
        onWidthChange(Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_ICON_WIDTH, ev.clientX)));
      };
      const handleUp = () => {
        setIsResizing(false);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", handleUp);
      };

      window.addEventListener("pointermove", handleMove);
      window.addEventListener("pointerup", handleUp);
    },
    [onWidthChange],
  );

  return (
    <div
      // sidebar-scope: fixed dark shell in both themes (see index.css) — no
      // vertical divider against the main panel, per the reference layout.
      // `text-foreground` here (not just `bg-background`) matters: `color`
      // is a plain inherited CSS property, so without re-declaring it at
      // this scope boundary, ghost-variant buttons below (which never set
      // their own text color) would keep inheriting the stale color
      // already resolved on <body>, ignoring the --foreground override.
      className={`sidebar-scope relative h-full shrink-0 overflow-hidden bg-background text-foreground ${
        isResizing ? "" : "transition-[width] duration-200 ease-in-out"
      }`}
      style={{ width }}
    >
      {collapsed ? (
        <div className="flex h-full w-full flex-col items-center gap-2 py-3">
          <TooltipProvider delayDuration={300}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={onToggleCollapsed}
                  aria-label="Expand sidebar"
                >
                  <PanelLeft />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">Expand sidebar</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button type="button" variant="ghost" size="icon" onClick={onHome} aria-label="Home">
                  <Bot />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">Home</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button type="button" variant="ghost" size="icon" onClick={onCreate} aria-label="New chat">
                  <Plus />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">New chat</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      ) : (
        <div className="flex h-full w-full flex-col">
          <div className="flex flex-col gap-2 p-4">
            <div className="flex items-center justify-between">
              <TooltipProvider delayDuration={300}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    {/* Placeholder icon — swap for a real app icon/logo later. */}
                    <Button type="button" variant="ghost" size="icon" onClick={onHome} aria-label="Home">
                      <Bot />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="right">Home</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={onToggleCollapsed}
                      aria-label="Collapse sidebar"
                    >
                      <PanelLeft />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="right">Collapse sidebar</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>

            <Button
              type="button"
              variant="secondary"
              className="h-10 justify-start rounded-[10px] border border-sidebar-border font-medium transition-surface"
              onClick={onCreate}
            >
              <Plus />
              New chat
            </Button>

            <div className="group relative rounded-lg transition-surface hover:bg-sidebar-elevated">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search chat"
                className="border-0 bg-transparent pl-8 shadow-none"
              />
            </div>
          </div>

          <div className="px-3 pb-1 pt-6 text-xs font-medium text-sidebar-faint">Recent</div>

          <ScrollArea className="flex-1">
            <div className="flex flex-col gap-0.5 px-2 pb-2">
              {filtered.length === 0 && (
                <p className="px-2 py-3 text-xs text-muted-foreground">
                  {sessions.length === 0 ? "No sessions yet." : "No matches."}
                </p>
              )}
              {filtered.map((session) => (
                <SessionRow
                  key={session.id}
                  session={session}
                  selected={session.id === selectedId}
                  editing={editingId === session.id}
                  onSelect={() => onSelect(session.id)}
                  onStartEdit={() => setEditingId(session.id)}
                  onCommitEdit={(title) => {
                    onRename(session.id, title);
                    setEditingId(null);
                  }}
                  onCancelEdit={() => setEditingId(null)}
                  onDelete={() => onDelete(session.id)}
                />
              ))}
            </div>
          </ScrollArea>
        </div>
      )}

      <div
        onPointerDown={handleResizeStart}
        className="group absolute -right-1 top-0 z-10 h-full w-2 cursor-col-resize touch-none"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
      >
        <div
          className={`mx-auto h-full w-px transition-colors ${
            isResizing ? "bg-ring" : "bg-transparent group-hover:bg-ring"
          }`}
        />
      </div>
    </div>
  );
}
