/** Every tracked GitHub event is normalized into this shape before storage or display */
export interface TrackedEvent {
  id: string;             // GitHub event ID (stable, unique)
  repo: string;           // "owner/repo" string
  type: EventType;        // discriminated union
  actor: string;          // GitHub username who caused the event
  title: string;          // human-readable one-liner
  url: string;            // the link to open in browser on click
  createdAt: string;      // ISO 8601 timestamp
  seen: boolean;          // has the user dismissed this notification?
  payload: unknown;       // raw GitHub event payload, stored as JSON
}

/** All event types the extension handles. */
export type EventType =
  | 'pr_opened'
  | 'pr_closed'
  | 'pr_merged'
  | 'pr_review'
  | 'pr_comment'
  | 'issue_comment'
  | 'pr_ready'
  | 'push'
  | 'workflow_failed'
  | 'workflow_passed'
  | 'review_requested'
  | 'label_changed'
  | 'branch_created'
  | 'branch_deleted'
  | 'release_published'
  | 'unknown';

export interface RepoConfig {
  nameWithOwner: string;  // "owner/repo"
  unreadCount: number;    // live-computed from EventStore
  hasFailure: boolean;    // true if latest workflow_failed event is unread
}

export interface ExtensionConfig {
  hostUrl: string;
  repositories: string[];
  pollIntervalSeconds: number;
  aiEnabled: boolean;
  notificationLevel: 'all' | 'important' | 'failures-only';
  maxEventsShown: number;
}
