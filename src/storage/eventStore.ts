import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import type { TrackedEvent } from '../types';

export class EventStore {
  private db: Database.Database;

  constructor(storagePath: string) {
    // storagePath is context.globalStorageUri.fsPath
    // Create the directory if it doesn't exist yet
    fs.mkdirSync(storagePath, { recursive: true });

    const dbPath = path.join(storagePath, 'events.db');
    this.db = new Database(dbPath);

    // WAL mode = much faster writes, safe for concurrent reads
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    this.migrate();
  }

  /** Idempotent schema creation — safe to call on every startup */
  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id          TEXT PRIMARY KEY,
        repo        TEXT NOT NULL,
        type        TEXT NOT NULL,
        actor       TEXT NOT NULL,
        title       TEXT NOT NULL,
        url         TEXT NOT NULL,
        seen        INTEGER NOT NULL DEFAULT 0,
        payload     TEXT NOT NULL,
        created_at  TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_events_repo       ON events (repo);
      CREATE INDEX IF NOT EXISTS idx_events_created    ON events (created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_events_seen       ON events (seen);

      -- Auto-cleanup: delete events older than 30 days
      DELETE FROM events WHERE created_at < datetime('now', '-30 days');
    `);
  }

  /** Insert multiple new events in a single transaction (much faster than one-by-one) */
  insertMany(events: TrackedEvent[]): void {
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO events (id, repo, type, actor, title, url, seen, payload, created_at)
      VALUES (@id, @repo, @type, @actor, @title, @url, @seen, @payload, @created_at)
    `);

    // Wrapping multiple inserts in a transaction is the single biggest SQLite performance trick
    const insertAll = this.db.transaction((evts: TrackedEvent[]) => {
      for (const e of evts) {
        insert.run({
          id:         e.id,
          repo:       e.repo,
          type:       e.type,
          actor:      e.actor,
          title:      e.title,
          url:        e.url,
          seen:       e.seen ? 1 : 0,
          payload:    JSON.stringify(e.payload),
          created_at: e.createdAt,
        });
      }
    });

    insertAll(events);
  }

  /** Get the most recent N events for a repo, sorted newest-first */
  getEventsForRepo(repo: string, limit = 10): TrackedEvent[] {
    const rows = this.db.prepare(`
      SELECT * FROM events
      WHERE repo = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(repo, limit) as any[];

    return rows.map(row => ({
      id:        row.id,
      repo:      row.repo,
      type:      row.type,
      actor:     row.actor,
      title:     row.title,
      url:       row.url,
      seen:      row.seen === 1,
      payload:   JSON.parse(row.payload),
      createdAt: row.created_at,
    }));
  }

  /** Get the ID of the most recent event for a repo — used to find "new since last poll" */
  getLatestEventId(repo: string): string | undefined {
    const row = this.db.prepare(`
      SELECT id FROM events WHERE repo = ? ORDER BY created_at DESC LIMIT 1
    `).get(repo) as { id: string } | undefined;
    return row?.id;
  }

  /** Count unread events per repo */
  getUnreadCount(repo: string): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) as count FROM events WHERE repo = ? AND seen = 0
    `).get(repo) as { count: number };
    return row.count;
  }

  /** Does the repo have any unread workflow failures? */
  hasUnreadFailure(repo: string): boolean {
    const row = this.db.prepare(`
      SELECT 1 FROM events
      WHERE repo = ? AND type = 'workflow_failed' AND seen = 0
      LIMIT 1
    `).get(repo);
    return !!row;
  }

  markAllRead(repo: string): void {
    this.db.prepare(`UPDATE events SET seen = 1 WHERE repo = ?`).run(repo);
  }

  markEventRead(id: string): void {
    this.db.prepare(`UPDATE events SET seen = 1 WHERE id = ?`).run(id);
  }

  dispose(): void {
    this.db.close();
  }
}
