import * as path from 'path';
import * as fs from 'fs';
import type { TrackedEvent } from '../types';

/**
 * JSON-file-backed event store.
 *
 * `better-sqlite3` is a native Node addon compiled against the system Node ABI.
 * VSCode runs inside Electron (different Node ABI), so native `.node` binaries
 * fail to load in the extension host.  A JSON file is simpler, needs zero native
 * dependencies, and is fast enough for hundreds-to-low-thousands of events.
 */
export class EventStore {
  private events: TrackedEvent[] = [];
  private readonly filePath: string;
  private dirty = false;
  private flushTimer: NodeJS.Timeout | undefined;

  constructor(storagePath: string) {
    // storagePath is context.globalStorageUri.fsPath
    fs.mkdirSync(storagePath, { recursive: true });
    this.filePath = path.join(storagePath, 'events.json');
    this.load();
  }

  // ── Persistence ────────────────────────────────────────────────────────

  private load(): void {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      this.events = JSON.parse(raw);
    } catch {
      this.events = [];
    }
  }

  /**
   * Debounced save — writes at most once per 2 s so rapid insertMany calls
   * don't thrash the disk.
   */
  private scheduleFlush(): void {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      if (this.dirty) {
        this.dirty = false;
        try {
          fs.writeFileSync(this.filePath, JSON.stringify(this.events));
        } catch (err) {
          console.error('GH Tracker: Failed to persist events', err);
        }
      }
    }, 2000);
  }

  // ── Public API ─────────────────────────────────────────────────────────

  /** Insert events that don't already exist (dedup by id). */
  insertMany(newEvents: TrackedEvent[]): void {
    if (newEvents.length === 0) return;

    const existing = new Set(this.events.map(e => e.id));
    let inserted = 0;

    for (const evt of newEvents) {
      if (!existing.has(evt.id)) {
        this.events.push(evt);
        existing.add(evt.id);
        inserted++;
      }
    }

    if (inserted === 0) return;

    // Keep newest-first for efficient LIMIT queries
    this.events.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    // Auto-cleanup: drop events older than 30 days
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    this.events = this.events.filter(e => new Date(e.createdAt).getTime() >= cutoff);

    this.scheduleFlush();
  }

  /** Get the most recent N events for a repo. */
  getEventsForRepo(repo: string, limit = 10): TrackedEvent[] {
    const results: TrackedEvent[] = [];
    for (const e of this.events) {
      if (e.repo === repo) {
        results.push(e);
        if (results.length >= limit) break;
      }
    }
    return results;
  }

  /** Get the ID of the most recent event for a repo. */
  getLatestEventId(repo: string): string | undefined {
    for (const e of this.events) {
      if (e.repo === repo) return e.id;
    }
    return undefined;
  }

  /** Count unread events for a repo. */
  getUnreadCount(repo: string): number {
    let count = 0;
    for (const e of this.events) {
      if (e.repo === repo && !e.seen) count++;
    }
    return count;
  }

  /** Does the repo have any unread workflow failures? */
  hasUnreadFailure(repo: string): boolean {
    for (const e of this.events) {
      if (e.repo === repo && e.type === 'workflow_failed' && !e.seen) return true;
    }
    return false;
  }

  /** Mark all events for a repo as seen. */
  markAllRead(repo: string): void {
    let changed = false;
    for (const e of this.events) {
      if (e.repo === repo && !e.seen) {
        e.seen = true;
        changed = true;
      }
    }
    if (changed) this.scheduleFlush();
  }

  /** Mark a single event as seen. */
  markEventRead(id: string): void {
    for (const e of this.events) {
      if (e.id === id && !e.seen) {
        e.seen = true;
        this.scheduleFlush();
        break;
      }
    }
  }

  dispose(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    // Flush any pending writes
    if (this.dirty) {
      try {
        fs.writeFileSync(this.filePath, JSON.stringify(this.events));
      } catch (err) {
        console.error('GH Tracker: Failed to flush events on dispose', err);
      }
      this.dirty = false;
    }
  }
}
