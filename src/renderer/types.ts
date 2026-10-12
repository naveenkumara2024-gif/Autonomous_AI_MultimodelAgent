// Mirrors src/main/session/session-store.ts. Duplicated rather than imported
// across the tsconfig.app.json / tsconfig.node.json project boundary (same
// approach as vite-env.d.ts's Window.agentBridge typing).

export type SessionStatus = "created" | "idle" | "running" | "stopped" | "deleted";
export type MessageRole = "user" | "assistant" | "system";
export type TitleSource = "auto" | "manual";

export interface Session {
  id: string;
  title: string;
  titleSource: TitleSource;
  status: SessionStatus;
  model: string;
  permissionHooks: { requireApprovalFor: string[] };
  retryPolicy: { maxRetries: number; maxLoopIterations: number };
  contextCompaction: { strategy: "summarize" | "truncate"; threshold: number };
  createdAt: number;
  updatedAt: number;
}

export interface Message {
  id: string;
  sessionId: string;
  role: MessageRole;
  content: string;
  createdAt: number;
  /** Voice: the Tamil transcript, when `content` is its English translation. */
  originalText?: string;
}

// Mirrors src/main/agent/trace.ts.
export type TraceEventType =
  | "agent_start"
  | "agent_end"
  | "supervisor_decision"
  | "subagent_start"
  | "subagent_end"
  | "llm_request"
  | "llm_response"
  | "message_update"
  | "message_end"
  | "tool_execution_start"
  | "tool_risk"
  | "approval_requested"
  | "approval_resolved"
  | "lock_wait"
  | "tool_execution_end"
  | "mcp_log"
  | "shortcut"
  | "error";

export interface TraceEvent {
  id: string;
  sessionId: string;
  turnId: string;
  parentId: string | null;
  seq: number;
  ts: number;
  type: TraceEventType;
  actor: string;
  data: Record<string, any>;
}

// Mirrors src/main/sandbox/approval-gate.ts.
export interface ApprovalRequest {
  id: string;
  sessionId: string;
  turnId: string;
  subagent: string;
  tool: string;
  intent: string;
  args: Record<string, unknown>;
  risk: { verdict: string; category: string | null; categories: string[]; reasons: string[]; matchedRules: string[] };
  requestedAt: number;
  expiresAt: number;
}

// Mirrors src/main/settings/{provider-store,settings-service,provider-client}.ts. The renderer
// never receives an API key — only `hasKey` and the last four characters.
export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export interface ProviderPublic {
  id: string;
  kind: "preset" | "custom";
  name: string;
  baseUrl: string;
  model: string;
  /** The system-chosen session-title model for this provider (not user-editable). */
  titleModel: string;
  hasKey: boolean;
  keyHint: string | null;
  active: boolean;
  keyUrl: string | null;
  blurb: string | null;
}

export interface GeneralSettings {
  automationOverlayEnabled: boolean;
  automationMinimizeMainWindow: boolean;
  allowScreenshotsToModel: boolean;
  actionCacheEnabled: boolean;
  voiceLanguage: "auto" | "ta";
}

export interface SettingsSnapshot {
  providers: ProviderPublic[];
  activeId: string;
  active: { id: string; name: string; model: string } | null;
  general: GeneralSettings;
  secureStorage: boolean;
}

export interface ProviderSaveInput {
  id?: string;
  name?: string;
  baseUrl: string;
  model: string;
  /** undefined = keep the saved key, null = remove it, string = replace it. */
  apiKey?: string | null;
}

export interface ProviderProbeInput {
  id?: string;
  baseUrl: string;
  apiKey?: string;
  model?: string;
}

export interface ProviderTestResult {
  ok: boolean;
  message: string;
  ms: number;
  status?: number;
}

export interface ProviderModelsResult {
  ok: boolean;
  models: string[];
  message?: string;
}
