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
  diff?: string;          // raw full diff for commit/push events (stored for AI summary)
  rawData?: string;       // JSON-serialized enriched data fetched from GitHub API (PR details, comments, etc.)
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
  | 'issue_opened'
  | 'issue_closed'
  | 'fork'
  | 'watch'
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
  maxEventsShown: number;
  openIn: 'vscode' | 'external';
  notifyFilterTypes: string[];  // event types allowed to notify; empty = notify all
}

/** Structured enriched data stored in TrackedEvent.rawData (JSON-serialized). */
export interface EnrichedEventData {
  // PR detail
  prTitle?: string;
  prBody?: string;
  prState?: string;
  prMerged?: boolean;
  prHeadBranch?: string;
  prBaseBranch?: string;
  prCommits?: Array<{ sha: string; message: string; author: string }>;
  prChangedFiles?: number;
  prAdditions?: number;
  prDeletions?: number;
  prFiles?: Array<{ filename: string; status: string; patch?: string; additions?: number; deletions?: number }>;
  // Push / commit
  pushDiff?: string;
  pushCommits?: Array<{ sha: string; message: string; author: string }>;
  // Workflow
  workflowName?: string;
  workflowBranch?: string;
  workflowConclusion?: string;
  workflowTriggerEvent?: string;
  workflowLogs?: string;
  // Comment
  commentBody?: string;
  commentPath?: string;
  // Issue
  issueTitle?: string;
  issueNumber?: number;
  issueBody?: string;
  issueState?: string;
  // Release
  releaseBody?: string;
}
