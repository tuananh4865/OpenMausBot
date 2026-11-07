// When an external APFS/USB volume unmounts and remounts at the same mount point,
// macOS revokes open file descriptors on the volume (`SQLITE_IOERR` / `disk I/O error`)
// even though `existsSync(path)` returns true again. Probing `PRAGMA schema_version`
// reads only the 100-byte database header (avoiding a full-table `PRAGMA quick_check` scan)
// and reopening on recoverable I/O errors restores the connection transparently.
import { statSync } from "node:fs";
import type { DatabaseSync, StatementSync } from "node:sqlite";

const RECOVERABLE_SQLITE_ERRCODES = new Set([10, 14, 266, 522, 778, 1034]);

export function isRevokedSqliteError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const err = error as { errcode?: number; code?: string; message?: string };
  if (typeof err.errcode === "number" && RECOVERABLE_SQLITE_ERRCODES.has(err.errcode)) return true;
  if (err.code === "ERR_INVALID_STATE") return true;
  if (typeof err.message === "string" && /disk I\/O error|unable to open database file|database is not open/i.test(err.message)) {
    return true;
  }
  return false;
}

export function sqliteFileIdentity(file: string): string | null {
  try {
    const st = statSync(file);
    return `${st.dev}:${st.ino}`;
  } catch {
    return null;
  }
}

/** Verifies that `file` still resolves to the same inode on the mounted volume and `handle` still has a live FD. */
export function isSqliteHandleHealthy(handle: DatabaseSync, file: string, expectedIdentity?: string | null): boolean {
  try {
    const current = sqliteFileIdentity(file);
    if (!current) return false;
    if (expectedIdentity && current !== expectedIdentity) return false;
    handle.exec("PRAGMA schema_version");
    return true;
  } catch {
    return false;
  }
}

export function withSqliteRetry<T>(reopen: () => void, fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (!isRevokedSqliteError(error)) throw error;
    reopen();
    return fn();
  }
}

/** Wraps a `StatementSync` so `get`/`all`/`run` reopen the store and re-run once if the FD was revoked. */
export function resilientStatement(
  getStatement: () => StatementSync,
  reopen: () => void,
): StatementSync {
  return new Proxy({} as StatementSync, {
    get(_target, prop) {
      if (prop === "get" || prop === "all" || prop === "run") {
        return (...args: unknown[]) =>
          withSqliteRetry(reopen, () => (getStatement()[prop] as (...a: unknown[]) => unknown)(...args));
      }
      const stmt = getStatement();
      const value = Reflect.get(stmt, prop, stmt);
      return typeof value === "function" ? value.bind(stmt) : value;
    },
  });
}

/** Wraps a `DatabaseSync` provider so `exec` and `prepare` automatically reopen on a revoked FD. */
export function resilientDatabase(
  getDb: () => DatabaseSync,
  reopen: () => DatabaseSync,
): DatabaseSync {
  return new Proxy({} as DatabaseSync, {
    get(_target, prop) {
      if (prop === "exec") {
        return (sql: string) => withSqliteRetry(reopen, () => getDb().exec(sql));
      }
      if (prop === "prepare") {
        return (sql: string) => {
          let currentDb: DatabaseSync | null = null;
          let currentStmt: StatementSync | null = null;
          return resilientStatement(
            () => {
              const active = getDb();
              if (!currentStmt || currentDb !== active) {
                currentDb = active;
                currentStmt = active.prepare(sql);
              }
              return currentStmt;
            },
            () => {
              currentDb = null;
              currentStmt = null;
              reopen();
            },
          );
        };
      }
      const active = getDb();
      const value = Reflect.get(active, prop, active);
      return typeof value === "function" ? value.bind(active) : value;
    },
  });
}
