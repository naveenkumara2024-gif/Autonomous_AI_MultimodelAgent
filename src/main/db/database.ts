import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { app } from "electron";

export interface SessionRow {
  id: string;
  title: string;
  status: string;
  model: string;
  permission_hooks: string;
  retry_policy: string;
  context_compaction: string;
  created_at: number;
  updated_at: number;
}

export interface MessageRow {
  id: string;
  session_id: string;
  role: string;
  content: string;
  created_at: number;
}

export interface ToolExecutionRow {
  id: string;
  session_id: string;
  tool: string;
  action: string;
  args: string;
  resources: string;
  outcome: string | null;
  created_at: number;
}

const SESSIONS_COLUMNS: Record<string, string> = {
  id: "TEXT PRIMARY KEY",
  title: "TEXT NOT NULL",
  status: "TEXT NOT NULL DEFAULT 'created'",
  model: "TEXT NOT NULL",
  permission_hooks: "TEXT NOT NULL DEFAULT '{}'",
  retry_policy: "TEXT NOT NULL DEFAULT '{}'",
  context_compaction: "TEXT NOT NULL DEFAULT '{}'",
  created_at: "INTEGER NOT NULL",
  updated_at: "INTEGER NOT NULL",
};

function prepareDatabaseDirectory(userDataPath: string): string {
  const dir = path.join(userDataPath, "data");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/** Adds a missing column to an existing table. `definition` must come from a fixed allowlist. */
function ensureColumn(
  db: DatabaseSync,
  table: string,
  column: string,
  definition: string,
): void {
  const existing = db
    .prepare(`PRAGMA table_info(${table})`)
    .all() as unknown as Array<{ name: string }>;
  if (existing.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function initializeSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  for (const [column, definition] of Object.entries(SESSIONS_COLUMNS)) {
    if (column === "id" || column === "title" || column === "created_at" || column === "updated_at") {
      continue;
    }
    ensureColumn(db, "sessions", column, definition);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS tool_executions (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      tool TEXT NOT NULL,
      action TEXT NOT NULL,
      args TEXT NOT NULL,
      resources TEXT NOT NULL,
      outcome TEXT,
      created_at INTEGER NOT NULL
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tool_executions_session_id ON tool_executions(session_id)`);
}

let dbInstance: DatabaseSync | null = null;

export function openDatabase(): DatabaseSync {
  if (dbInstance) return dbInstance;

  const dir = prepareDatabaseDirectory(app.getPath("userData"));
  const dbPath = path.join(dir, "agent.db");
  console.log(`[db] opening ${dbPath}`);

  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  initializeSchema(db);

  dbInstance = db;
  return db;
}
