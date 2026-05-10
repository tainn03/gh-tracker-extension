import * as vscode from 'vscode';
import type { GitHubClient } from './githubClient';
import type { EventStore } from '../storage/eventStore';
import type { TrackedEvent } from '../types';

/** PollService emits these events. Any module can subscribe. */
export type PollEventMap = {
  newEvents: TrackedEvent[];
};

export class PollService {
  private timer: NodeJS.Timeout | undefined;

  // EventEmitter from vscode gives us typed events with automatic disposal
  private readonly _onNewEvents = new vscode.EventEmitter<TrackedEvent[]>();
  readonly onNewEvents = this._onNewEvents.event;

  constructor(
    private client: GitHubClient,
    private store: EventStore,
    private repos: string[],
    private intervalMs: number
  ) {}

  /** Start polling immediately, then on each interval tick */
  start(): void {
    this.poll();  // fire once immediately on start
    this.timer = setInterval(() => this.poll(), this.intervalMs);
  }

  /** Update the repo list and interval without restarting (e.g. when settings change) */
  update(repos: string[], intervalMs: number): void {
    this.repos = repos;
    this.intervalMs = intervalMs;
    this.stop();
    this.start();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Core poll logic. For each repo, fetch events newer than the last one we stored.
   * All errors are caught per-repo so one failing repo doesn't stop the others.
   */
  private async poll(): Promise<void> {
    const allNew: TrackedEvent[] = [];

    for (const repo of this.repos) {
      try {
        const lastId  = this.store.getLatestEventId(repo);
        const events  = await this.client.getNewEvents(repo, lastId);

        if (events.length > 0) {
          // Filter to genuinely new events BEFORE inserting into the store.
          // Workflow runs fetched inside getNewEvents bypass the "since last
          // event" filter and can include already-seen events on every poll.
          const genuinelyNew = this.store.filterNew(events);
          if (genuinelyNew.length > 0) {
            this.store.insertMany(genuinelyNew);
            allNew.push(...genuinelyNew);
          }
        }
      } catch (err) {
        // Log but don't crash the whole poll cycle
        console.error(`GH Tracker: Failed to poll ${repo}:`, err);
      }
    }

    if (allNew.length > 0) {
      this._onNewEvents.fire(allNew);
    }
  }

  dispose(): void {
    this.stop();
    this._onNewEvents.dispose();
  }
}
