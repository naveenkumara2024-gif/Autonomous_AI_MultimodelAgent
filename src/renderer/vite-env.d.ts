/// <reference types="vite/client" />

import type { ApprovalRequest, Message, Session, TraceEvent } from "./types";

type EventChannel = "session.update" | "session.status" | "session.message" | "trace.event" | "approval.request" | "approval.resolved";

// Mirrors the shape exposed by src/preload/index.ts. Not imported directly
// from there — preload belongs to tsconfig.node.json's project, and this
// file belongs to tsconfig.app.json's, so the shape is duplicated here.
declare global {
  interface Window {
    agentBridge: {
      getAppVersion: () => Promise<string>;
      listSessions: () => Promise<Session[]>;
      listMessages: (sessionId: string) => Promise<Message[]>;
      listTrace: (sessionId: string) => Promise<TraceEvent[]>;
      createSession: (title?: string) => Promise<Session>;
      startSession: (sessionId: string) => Promise<Session>;
      continueSession: (
        sessionId: string,
        content: string,
      ) => Promise<{ session: Session; message: Message }>;
      cancelTurn: (sessionId: string) => Promise<void>;
      renameSession: (sessionId: string, title: string) => Promise<Session>;
      stopSession: (sessionId: string) => Promise<Session>;
      deleteSession: (sessionId: string) => Promise<void>;
      getTraceImage: (imagePath: string) => Promise<string | null>;
      listApprovals: () => Promise<ApprovalRequest[]>;
      respondApproval: (id: string, approved: boolean) => Promise<void>;
      onSessionEvent: (channel: EventChannel, listener: (payload: unknown) => void) => () => void;
    };
  }
}
