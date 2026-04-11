import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { Sha1Hex } from "@ws-git/protocol";

/**
 * Per-repo SQLite-backed ref store with compare-and-swap support.
 */
export class RefStore {
  private db: Database.Database;
  private stmtGet: Database.Statement;
  private stmtList: Database.Statement;
  private stmtUpsert: Database.Statement;
  private stmtCas: Database.Statement;
  private stmtInsert: Database.Statement;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS refs (
        ref  TEXT NOT NULL PRIMARY KEY,
        hash TEXT NOT NULL
      )
    `);

    this.stmtGet = this.db.prepare("SELECT hash FROM refs WHERE ref = ?");
    this.stmtList = this.db.prepare("SELECT ref, hash FROM refs WHERE ref LIKE ? || '%'");
    this.stmtUpsert = this.db.prepare(
      "INSERT INTO refs (ref, hash) VALUES (?, ?) ON CONFLICT (ref) DO UPDATE SET hash = excluded.hash"
    );
    this.stmtCas = this.db.prepare(
      "UPDATE refs SET hash = ? WHERE ref = ? AND hash = ?"
    );
    this.stmtInsert = this.db.prepare(
      "INSERT OR IGNORE INTO refs (ref, hash) VALUES (?, ?)"
    );
  }

  get(ref: string): Sha1Hex | null {
    const row = this.stmtGet.get(ref) as { hash: string } | undefined;
    return row?.hash ?? null;
  }

  list(prefix: string): Record<string, Sha1Hex> {
    const rows = this.stmtList.all(prefix) as { ref: string; hash: string }[];
    const result: Record<string, Sha1Hex> = {};
    for (const row of rows) {
      result[row.ref] = row.hash;
    }
    return result;
  }

  /** Unconditional set (for force push). */
  set(ref: string, hash: Sha1Hex): void {
    this.stmtUpsert.run(ref, hash);
  }

  /**
   * Compare-and-swap. Returns true if the update succeeded.
   * If old is null, only succeeds if the ref doesn't exist yet.
   */
  cas(ref: string, oldHash: Sha1Hex | null, newHash: Sha1Hex): boolean {
    if (oldHash === null) {
      const result = this.stmtInsert.run(ref, newHash);
      return result.changes > 0;
    }
    const result = this.stmtCas.run(newHash, ref, oldHash);
    return result.changes > 0;
  }

  close(): void {
    this.db.close();
  }
}
