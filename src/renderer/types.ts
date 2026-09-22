// Mirrors src/main/session/session-store.ts. Duplicated rather than imported
// across the tsconfig.app.json / tsconfig.node.json project boundary (same
// approach as vite-env.d.ts's Window.agentBridge typing).

export type SessionStatus = "created" | "idle" | "running" | "stopped" | "deleted";
export type MessageRole = "user" | "assistant" | "system";

export interface Session {
  id: string;
  title: string;
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
