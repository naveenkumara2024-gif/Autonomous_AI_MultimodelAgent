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
