import Database from "better-sqlite3";
import type { Sha1Hex } from "@ws-git/protocol";

/**
 * SQLite-backed ref store with compare-and-swap support.
 */
export class RefStore {
  private db: Database.Database;
  private stmtGet: Database.Statement;
  private stmtList: Database.Statement;
  private stmtUpsert: Database.Statement;
  private stmtCas: Database.Statement;
  private stmtInsert: Database.Statement;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS refs (
        repo TEXT NOT NULL,
        ref  TEXT NOT NULL,
        hash TEXT NOT NULL,
        PRIMARY KEY (repo, ref)
      )
    `);

    this.stmtGet = this.db.prepare("SELECT hash FROM refs WHERE repo = ? AND ref = ?");
    this.stmtList = this.db.prepare("SELECT ref, hash FROM refs WHERE repo = ? AND ref LIKE ? || '%'");
    this.stmtUpsert = this.db.prepare(
      "INSERT INTO refs (repo, ref, hash) VALUES (?, ?, ?) ON CONFLICT (repo, ref) DO UPDATE SET hash = excluded.hash"
    );
    this.stmtCas = this.db.prepare(
      "UPDATE refs SET hash = ? WHERE repo = ? AND ref = ? AND hash = ?"
    );
    this.stmtInsert = this.db.prepare(
      "INSERT OR IGNORE INTO refs (repo, ref, hash) VALUES (?, ?, ?)"
    );
  }

  get(repo: string, ref: string): Sha1Hex | null {
    const row = this.stmtGet.get(repo, ref) as { hash: string } | undefined;
    return row?.hash ?? null;
  }

  list(repo: string, prefix: string): Record<string, Sha1Hex> {
    const rows = this.stmtList.all(repo, prefix) as { ref: string; hash: string }[];
    const result: Record<string, Sha1Hex> = {};
    for (const row of rows) {
      result[row.ref] = row.hash;
    }
    return result;
  }

  /** Unconditional set (for force push). */
  set(repo: string, ref: string, hash: Sha1Hex): void {
    this.stmtUpsert.run(repo, ref, hash);
  }

  /**
   * Compare-and-swap. Returns true if the update succeeded.
   * If old is null, only succeeds if the ref doesn't exist yet.
   */
  cas(repo: string, ref: string, oldHash: Sha1Hex | null, newHash: Sha1Hex): boolean {
    if (oldHash === null) {
      const result = this.stmtInsert.run(repo, ref, newHash);
      return result.changes > 0;
    }
    const result = this.stmtCas.run(newHash, repo, ref, oldHash);
    return result.changes > 0;
  }

  close(): void {
    this.db.close();
  }
}
