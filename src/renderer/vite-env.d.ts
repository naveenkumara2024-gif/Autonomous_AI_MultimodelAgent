/// <reference types="vite/client" />

import type { Message, Session } from "./types";

// Mirrors the shape exposed by src/preload/index.ts. Not imported directly
// from there — preload belongs to tsconfig.node.json's project, and this
// file belongs to tsconfig.app.json's, so the shape is duplicated here.
declare global {
  interface Window {
    agentBridge: {
      getAppVersion: () => Promise<string>;
      listSessions: () => Promise<Session[]>;
      listMessages: (sessionId: string) => Promise<Message[]>;
      createSession: (title?: string) => Promise<Session>;
      startSession: (sessionId: string) => Promise<Session>;
      continueSession: (
        sessionId: string,
        content: string,
      ) => Promise<{ session: Session; message: Message }>;
      renameSession: (sessionId: string, title: string) => Promise<Session>;
      stopSession: (sessionId: string) => Promise<Session>;
      deleteSession: (sessionId: string) => Promise<void>;
      onSessionEvent: (
        channel: "session.update" | "session.status",
        listener: (payload: unknown) => void,
      ) => () => void;
    };
  }
}
