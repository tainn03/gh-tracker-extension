# GitHub Enterprise Tracker — VSCode Extension: Implementation Guide

> **How to read this guide.** Each step builds on the previous one. Every code block starts with
> a `// path/to/file.ts` comment so you always know where the code lives. Commands marked
> with `▶` are meant to be run in your terminal. Commands marked with `✓ verify` let you
> check that the previous step worked correctly before moving on.

---

## Prerequisites

Before writing a single line of code, make sure you have:

- Node.js ≥ 18 (check: `node -v`)
- VSCode ≥ 1.90 (required for the Language Model API)
- `vsce` and Yeoman scaffolder: `npm install -g @vscode/vsce yo generator-code`
- A GitHub / GitHub Enterprise account with a token that has `repo`, `read:org`, and `workflow` scopes

---

## Step 1 — Scaffold the project

The `yo code` wizard generates a correctly structured extension skeleton so you don't have to wrestle with the tsconfig or webpack config from scratch.

```bash
# ▶ Run in a directory where you keep your projects
yo code

# Answer the wizard:
#   What type of extension?  → TypeScript
#   Name:                    → gh-tracker
#   Identifier:              → gh-tracker
#   Description:             → Track GitHub Enterprise events inside VSCode
#   Initialize git repo?     → Yes
#   Bundle with webpack?     → Yes   ← important for smaller .vsix size
#   Package manager?         → npm
```

After the wizard finishes, open the folder in VSCode:

```bash
# ▶
cd gh-tracker
code .
```

Now install the specific dependencies this extension needs:

```bash
# ▶  Runtime dependencies
npm install @octokit/rest @octokit/plugin-throttling better-sqlite3

# ▶  Type definitions (dev only)
npm install -D @types/better-sqlite3
```

> **Why `@octokit/plugin-throttling`?**  GitHub's API enforces rate limits.
> This plugin automatically retries requests with exponential backoff when you hit
> the secondary rate limit — essential for a poller that runs forever in the background.

```bash
# ✓ verify the install worked
ls node_modules/@octokit && ls node_modules/better-sqlite3
# You should see both directories without errors
```

---

## Step 2 — Design the `package.json` manifest

The manifest is the contract between your extension and VSCode. It declares everything
VSCode needs to know at *load time* — before any TypeScript runs. Think of it as the
schema for your entire extension's surface area.

```jsonc
// package.json  (replace the generated content entirely)
{
  "name": "gh-tracker",
  "displayName": "GitHub Enterprise Tracker",
  "description": "Real-time event tracking for GitHub / GHE repositories",
  "version": "0.1.0",
  "publisher": "your-publisher-id",
  "engines": { "vscode": "^1.90.0" },
  "categories": ["Other"],
  "activationEvents": ["onStartupFinished"],
  // onStartupFinished = activate AFTER the editor is ready, not on cold start.
  // This keeps the editor launch fast.

  "main": "./dist/extension.js",

  "contributes": {

    // ── Activity bar icon (the sidebar button) ──────────────────────────
    "viewsContainers": {
      "activitybar": [
        {
          "id": "ghTracker",
          "title": "GH Tracker",
          "icon": "resources/icon.svg"
        }
      ]
    },

    // ── Two tree views inside the sidebar ──────────────────────────────
    "views": {
      "ghTracker": [
        {
          "id": "ghTracker.repos",
          "name": "Repositories",
          "icon": "$(repo)"
        },
        {
          "id": "ghTracker.events",
          "name": "Events",
          "icon": "$(bell)"
        }
      ]
    },

    // ── Commands exposed in the command palette ─────────────────────────
    "commands": [
      { "command": "ghTracker.setup",       "title": "GH Tracker: Open Setup" },
      { "command": "ghTracker.refresh",     "title": "GH Tracker: Refresh Now", "icon": "$(refresh)" },
      { "command": "ghTracker.addRepo",     "title": "GH Tracker: Add Repository" },
      { "command": "ghTracker.removeRepo",  "title": "GH Tracker: Remove Repository" },
      { "command": "ghTracker.markRead",    "title": "GH Tracker: Mark All Read" },
      { "command": "ghTracker.aiReview",    "title": "GH Tracker: AI Review PR" }
    ],

    // ── Toolbar buttons on each view ────────────────────────────────────
    "menus": {
      "view/title": [
        {
          "command": "ghTracker.refresh",
          "when": "view == ghTracker.repos",
          "group": "navigation"
        },
        {
          "command": "ghTracker.addRepo",
          "when": "view == ghTracker.repos",
          "group": "navigation"
        }
      ],
      "view/item/context": [
        {
          "command": "ghTracker.removeRepo",
          "when": "view == ghTracker.repos && viewItem == repo"
        },
        {
          "command": "ghTracker.aiReview",
          "when": "view == ghTracker.events && viewItem == event_pr"
        }
      ]
    },

    // ── User-configurable settings (appears in File → Preferences) ──────
    "configuration": {
      "title": "GitHub Enterprise Tracker",
      "properties": {
        "ghTracker.hostUrl": {
          "type": "string",
          "default": "https://github.com",
          "description": "GitHub or GitHub Enterprise host URL (e.g. https://ghe.corp.co.jp)"
        },
        "ghTracker.repositories": {
          "type": "array",
          "items": { "type": "string" },
          "default": [],
          "description": "List of repositories to track in org/repo format"
        },
        "ghTracker.pollIntervalSeconds": {
          "type": "number",
          "default": 60,
          "minimum": 30,
          "description": "How often to poll for new events (seconds)"
        },
        "ghTracker.aiEnabled": {
          "type": "boolean",
          "default": false,
          "description": "Enable Copilot AI features (requires GitHub Copilot)"
        },
        "ghTracker.notificationLevel": {
          "type": "string",
          "enum": ["all", "important", "failures-only"],
          "default": "important",
          "description": "Which events trigger a toast notification"
        },
        "ghTracker.maxEventsShown": {
          "type": "number",
          "default": 10,
          "description": "Maximum events shown per repository"
        }
      }
    }
  },

  "scripts": {
    "vscode:prepublish": "npm run package",
    "compile":           "webpack",
    "watch":             "webpack --watch",
    "package":           "webpack --mode production --devtool hidden-source-map",
    "lint":              "eslint src --ext ts"
  }
}
```

```bash
# ✓ verify VSCode can parse the manifest
npx vsce ls 2>&1 | head -20
# Should list files without a JSON parse error
```

---

## Step 3 — TypeScript config and project structure

Before writing any logic, establish the full folder structure so imports resolve correctly:

```bash
# ▶  Create all the directories at once
mkdir -p src/{providers,services,storage,webviews,utils} resources
touch resources/icon.svg
```

Your `tsconfig.json` should look like this (the generator creates a decent one, but verify):

```jsonc
// tsconfig.json
{
  "compilerOptions": {
    "module": "Node16",       // ← must match what VSCode's extension host uses
    "target": "ES2022",
    "lib": ["ES2022"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "sourceMap": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

```bash
# ✓ verify TypeScript compiles with zero errors on the empty scaffold
npx tsc --noEmit
```

---

## Step 4 — Types and constants (shared across the whole extension)

Define your core data shapes first. This is the single source of truth for what an "event"
looks like throughout the codebase. Every other file imports from here.

```typescript
// src/types.ts

/** Every tracked GitHub event is normalized into this shape before storage or display */
export interface TrackedEvent {
  id: string;             // GitHub event ID (stable, unique)
  repo: string;           // "owner/repo" string
  type: EventType;        // discriminated union — see below
  actor: string;          // GitHub username who caused the event
  title: string;          // human-readable one-liner
  url: string;            // the link to open in browser on click
  createdAt: string;      // ISO 8601 timestamp
  seen: boolean;          // has the user dismissed this notification?
  payload: unknown;       // raw GitHub event payload, stored as JSON
}

/** All event types the extension handles. Keeping this as a union (not freeform string)
 *  means TypeScript will warn you if a switch statement misses a case. */
export type EventType =
  | 'pr_opened'
  | 'pr_closed'
  | 'pr_merged'
  | 'pr_review'
  | 'pr_comment'
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
```

---

## Step 5 — Configuration service

Rather than reading `vscode.workspace.getConfiguration()` scattered everywhere, wrap it in
a single service. This also makes it trivial to listen for changes.

```typescript
// src/services/configService.ts
import * as vscode from 'vscode';
import type { ExtensionConfig } from '../types';

export class ConfigService {
  private static readonly SECTION = 'ghTracker';

  /** Read the current config snapshot from VSCode settings */
  static get(): ExtensionConfig {
    const cfg = vscode.workspace.getConfiguration(ConfigService.SECTION);
    return {
      hostUrl:             cfg.get<string>('hostUrl', 'https://github.com').replace(/\/$/, ''),
      repositories:        cfg.get<string[]>('repositories', []),
      pollIntervalSeconds: cfg.get<number>('pollIntervalSeconds', 60),
      aiEnabled:           cfg.get<boolean>('aiEnabled', false),
      notificationLevel:   cfg.get<'all'|'important'|'failures-only'>('notificationLevel', 'important'),
      maxEventsShown:      cfg.get<number>('maxEventsShown', 10),
    };
  }

  /** Add a new repo to the persistent settings list */
  static async addRepository(nameWithOwner: string): Promise<void> {
    const cfg = vscode.workspace.getConfiguration(ConfigService.SECTION);
    const current = cfg.get<string[]>('repositories', []);
    if (!current.includes(nameWithOwner)) {
      await cfg.update('repositories', [...current, nameWithOwner], vscode.ConfigurationTarget.Global);
    }
  }

  static async removeRepository(nameWithOwner: string): Promise<void> {
    const cfg = vscode.workspace.getConfiguration(ConfigService.SECTION);
    const current = cfg.get<string[]>('repositories', []);
    await cfg.update(
      'repositories',
      current.filter(r => r !== nameWithOwner),
      vscode.ConfigurationTarget.Global
    );
  }

  /** Returns a disposable you can push to context.subscriptions */
  static onChange(handler: () => void): vscode.Disposable {
    return vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration(ConfigService.SECTION)) {
        handler();
      }
    });
  }
}
```

---

## Step 6 — Authentication service

VSCode has a built-in GitHub auth provider since version 1.63. For github.com, you can
request a session directly. For GHE, the approach differs slightly: VSCode 1.90+ supports
custom auth providers, but the simplest cross-version approach is to accept a PAT from the
user and store it in `SecretStorage` (which is OS-keychain-backed, never written to disk in
plaintext).

```typescript
// src/services/authService.ts
import * as vscode from 'vscode';

export class AuthService {
  private static readonly SECRET_KEY = 'ghTracker.token';

  /**
   * Main entry point. For github.com, tries the built-in OAuth provider first.
   * For GHE (any other host), falls back to a PAT prompt stored in SecretStorage.
   */
  static async getToken(
    context: vscode.ExtensionContext,
    hostUrl: string
  ): Promise<string | undefined> {
    const isGithubDotCom = hostUrl.replace(/\/$/, '') === 'https://github.com';

    if (isGithubDotCom) {
      return AuthService.getOAuthToken();
    } else {
      return AuthService.getPATToken(context, hostUrl);
    }
  }

  /**
   * VSCode's built-in GitHub authentication. This opens the browser-based OAuth
   * flow automatically and returns a token with the requested scopes.
   * 'createIfNone: true' means VSCode will prompt the user if no session exists.
   */
  private static async getOAuthToken(): Promise<string | undefined> {
    try {
      const session = await vscode.authentication.getSession(
        'github',
        ['repo', 'read:org', 'workflow'],
        { createIfNone: true }
      );
      return session.accessToken;
    } catch {
      vscode.window.showErrorMessage('GH Tracker: GitHub authentication failed.');
      return undefined;
    }
  }

  /**
   * For GHE: check SecretStorage first (so the user doesn't re-enter every session),
   * then prompt if not found.
   */
  private static async getPATToken(
    context: vscode.ExtensionContext,
    hostUrl: string
  ): Promise<string | undefined> {
    // Try cached token first
    const cached = await context.secrets.get(AuthService.SECRET_KEY);
    if (cached) { return cached; }

    // Prompt user for PAT
    const pat = await vscode.window.showInputBox({
      title: `GH Tracker — Personal Access Token for ${hostUrl}`,
      prompt: 'Enter a token with repo, read:org, and workflow scopes',
      password: true,          // ← renders as •••• in the input box
      ignoreFocusOut: true,    // ← don't dismiss when user clicks away
    });

    if (pat) {
      await context.secrets.store(AuthService.SECRET_KEY, pat);
    }

    return pat;
  }

  /** Call this when the user logs out or the token becomes invalid */
  static async clearToken(context: vscode.ExtensionContext): Promise<void> {
    await context.secrets.delete(AuthService.SECRET_KEY);
  }
}
```

---

## Step 7 — GitHub API client

Wrap Octokit so every other service has a clean, typed API to call. The throttling plugin
is registered here once and applies automatically to all requests.

```typescript
// src/services/githubClient.ts
import { Octokit } from '@octokit/rest';
import { throttling } from '@octokit/plugin-throttling';
import type { TrackedEvent } from '../types';
import { normalizeEvent } from '../utils/eventNormalizer';

// Register the throttling plugin globally
const ThrottledOctokit = Octokit.plugin(throttling);

export class GitHubClient {
  private octokit: Octokit;
  private baseUrl: string;

  // etag cache: repo → last ETag header value
  // When GitHub returns 304 Not Modified, we skip processing entirely.
  private etagCache = new Map<string, string>();

  constructor(token: string, hostUrl: string) {
    const isGHE = !hostUrl.includes('github.com');

    this.baseUrl = isGHE ? `${hostUrl}/api/v3` : 'https://api.github.com';

    this.octokit = new ThrottledOctokit({
      auth: token,
      baseUrl: this.baseUrl,
      throttle: {
        onRateLimit: (retryAfter: number, options: { method: string; url: string }) => {
          console.warn(`GH Tracker: Rate limited on ${options.method} ${options.url}. Retrying after ${retryAfter}s`);
          return true; // return true = retry automatically
        },
        onSecondaryRateLimit: (_retryAfter: number, options: { method: string; url: string }) => {
          console.warn(`GH Tracker: Secondary rate limit on ${options.method} ${options.url}`);
          return true;
        },
      },
    });
  }

  /**
   * Fetch new events for a repository. Uses ETag to avoid redundant processing.
   * Returns only events newer than `sinceEventId` if provided.
   */
  async getNewEvents(
    nameWithOwner: string,
    sinceEventId?: string
  ): Promise<TrackedEvent[]> {
    const [owner, repo] = nameWithOwner.split('/');
    const cachedEtag = this.etagCache.get(nameWithOwner);

    let response: Awaited<ReturnType<typeof this.octokit.request>>;

    try {
      response = await this.octokit.request('GET /repos/{owner}/{repo}/events', {
        owner,
        repo,
        per_page: 30,
        headers: cachedEtag ? { 'If-None-Match': cachedEtag } : {},
      });
    } catch (err: any) {
      // 304 = nothing changed since last poll — this is normal, not an error
      if (err.status === 304) { return []; }
      throw err;
    }

    // Store the new ETag for next poll
    const newEtag = response.headers['etag'];
    if (newEtag) { this.etagCache.set(nameWithOwner, newEtag); }

    // Normalize each raw GitHub event into our TrackedEvent shape
    const allEvents: TrackedEvent[] = (response.data as any[]).map(raw =>
      normalizeEvent(raw, nameWithOwner)
    );

    // Filter to only events we haven't seen yet
    if (sinceEventId) {
      const sinceIdx = allEvents.findIndex(e => e.id === sinceEventId);
      return sinceIdx === -1 ? allEvents : allEvents.slice(0, sinceIdx);
    }

    return allEvents;
  }

  /** Fetch the diff files for a pull request — used by the AI review feature */
  async getPRFiles(nameWithOwner: string, prNumber: number) {
    const [owner, repo] = nameWithOwner.split('/');
    const { data } = await this.octokit.pulls.listFiles({ owner, repo, pull_number: prNumber });
    return data;
  }

  /** Fetch the last N lines of a failed workflow run log */
  async getWorkflowRunLog(nameWithOwner: string, runId: number): Promise<string> {
    const [owner, repo] = nameWithOwner.split('/');
    // GitHub returns a redirect to a zip download — we request the URL only
    const { url } = await this.octokit.actions.downloadWorkflowRunLogs({
      owner, repo, run_id: runId
    });
    // We return the URL here; the AI service will fetch and trim the log
    return url;
  }

  /** Quick connectivity check — useful in the setup UI to validate the host URL + token */
  async validateConnection(): Promise<{ login: string; name: string }> {
    const { data } = await this.octokit.users.getAuthenticated();
    return { login: data.login, name: data.name ?? data.login };
  }
}
```

---

## Step 8 — Event normalizer utility

The GitHub Events API returns a different shape for each event type. This function
translates the raw API response into our clean `TrackedEvent` type. The key insight is
the `type` field on the raw event tells you what's in the `payload` object.

```typescript
// src/utils/eventNormalizer.ts
import type { TrackedEvent, EventType } from '../types';

export function normalizeEvent(raw: any, repo: string): TrackedEvent {
  const base = {
    id:        String(raw.id),
    repo,
    actor:     raw.actor?.login ?? 'unknown',
    createdAt: raw.created_at ?? new Date().toISOString(),
    seen:      false,
    payload:   raw.payload,
  };

  switch (raw.type) {
    case 'PullRequestEvent': {
      const pr = raw.payload.pull_request;
      const action = raw.payload.action; // 'opened', 'closed', 'reopened', 'ready_for_review'
      const merged = pr?.merged;

      let type: EventType = 'pr_opened';
      let verb = 'opened';

      if (action === 'closed' && merged) { type = 'pr_merged'; verb = 'merged'; }
      else if (action === 'closed')      { type = 'pr_closed'; verb = 'closed'; }
      else if (action === 'ready_for_review') { type = 'pr_ready'; verb = 'marked ready'; }

      return {
        ...base, type,
        title: `${base.actor} ${verb} PR #${pr?.number}: ${pr?.title ?? ''}`,
        url:   pr?.html_url ?? '',
      };
    }

    case 'PullRequestReviewEvent': {
      const pr = raw.payload.pull_request;
      const review = raw.payload.review;
      return {
        ...base, type: 'pr_review',
        title: `${base.actor} reviewed PR #${pr?.number}: ${review?.state ?? ''}`,
        url:   review?.html_url ?? pr?.html_url ?? '',
      };
    }

    case 'PullRequestReviewCommentEvent': {
      const pr = raw.payload.pull_request;
      const comment = raw.payload.comment;
      return {
        ...base, type: 'pr_comment',
        title: `${base.actor} commented on PR #${pr?.number}`,
        url:   comment?.html_url ?? pr?.html_url ?? '',
      };
    }

    case 'IssueCommentEvent': {
      // IssueCommentEvent fires for comments on both issues AND pull requests
      const issue = raw.payload.issue;
      const comment = raw.payload.comment;
      return {
        ...base, type: 'pr_comment',
        title: `${base.actor} commented on #${issue?.number}: ${issue?.title ?? ''}`,
        url:   comment?.html_url ?? issue?.html_url ?? '',
      };
    }

    case 'PushEvent': {
      const commits = raw.payload.commits ?? [];
      const branch  = (raw.payload.ref as string)?.replace('refs/heads/', '') ?? '';
      return {
        ...base, type: 'push',
        title: `${base.actor} pushed ${commits.length} commit(s) to ${branch}`,
        // Link to the compare view for the full push
        url: `https://github.com/${repo}/compare/${raw.payload.before}...${raw.payload.head}`,
      };
    }

    case 'WorkflowRunEvent': {
      const run = raw.payload.workflow_run;
      const failed = run?.conclusion === 'failure';
      return {
        ...base,
        type:  failed ? 'workflow_failed' : 'workflow_passed',
        title: `${failed ? '❌' : '✅'} ${run?.name ?? 'Pipeline'} ${run?.conclusion} on ${run?.head_branch}`,
        url:   run?.html_url ?? '',
      };
    }

    case 'CreateEvent': {
      const refType = raw.payload.ref_type; // 'branch' or 'tag'
      return {
        ...base, type: 'branch_created',
        title: `${base.actor} created ${refType} "${raw.payload.ref}"`,
        url:   `https://github.com/${repo}/tree/${raw.payload.ref}`,
      };
    }

    case 'DeleteEvent': {
      return {
        ...base, type: 'branch_deleted',
        title: `${base.actor} deleted ${raw.payload.ref_type} "${raw.payload.ref}"`,
        url:   `https://github.com/${repo}`,
      };
    }

    case 'ReleaseEvent': {
      const release = raw.payload.release;
      return {
        ...base, type: 'release_published',
        title: `${base.actor} released ${release?.tag_name}: ${release?.name ?? ''}`,
        url:   release?.html_url ?? '',
      };
    }

    default:
      return {
        ...base, type: 'unknown',
        title: `${raw.type} by ${base.actor}`,
        url:   `https://github.com/${repo}`,
      };
  }
}
```

---

## Step 9 — Event store (SQLite persistence)

`better-sqlite3` is a synchronous SQLite driver. That might sound alarming, but it's
actually fine inside a VSCode extension host because the extension host runs in its own
Node.js process (separate from the renderer), so blocking it briefly doesn't freeze the UI.
All your TypeScript runs here, never in the browser renderer.

```typescript
// src/storage/eventStore.ts
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
```

```bash
# ✓ verify better-sqlite3 compiles for your Node version
node -e "require('better-sqlite3')" && echo "SQLite OK"
```

---

## Step 10 — Poll service

This is the heartbeat of the extension. It schedules a regular check for each tracked
repository, diffs against the last-seen event, and fires events that the rest of the system
reacts to.

```typescript
// src/services/pollService.ts
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
          this.store.insertMany(events);
          allNew.push(...events);
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
```

---

## Step 11 — Notification service

Listens to `PollService.onNewEvents` and decides which events are important enough to
show as a VSCode toast notification.

```typescript
// src/services/notifyService.ts
import * as vscode from 'vscode';
import type { TrackedEvent } from '../types';
import type { ExtensionConfig } from '../types';

/** Events that are always considered "important" (bypass the 'failures-only' filter) */
const IMPORTANT_TYPES = new Set([
  'pr_opened', 'pr_merged', 'workflow_failed', 'review_requested', 'pr_ready'
]);

export class NotifyService {
  notify(events: TrackedEvent[], config: ExtensionConfig): void {
    for (const event of events) {
      if (!this.shouldNotify(event, config)) { continue; }

      const isFailure = event.type === 'workflow_failed';
      const showMsg   = isFailure
        ? vscode.window.showWarningMessage.bind(vscode.window)
        : vscode.window.showInformationMessage.bind(vscode.window);

      // showWarningMessage / showInformationMessage accept action button labels as extra args.
      // The returned promise resolves with the label the user clicked, or undefined if dismissed.
      showMsg(`GH Tracker: ${event.title}`, 'Open', 'Dismiss').then(choice => {
        if (choice === 'Open') {
          vscode.env.openExternal(vscode.Uri.parse(event.url));
        }
      });
    }
  }

  private shouldNotify(event: TrackedEvent, config: ExtensionConfig): boolean {
    if (config.notificationLevel === 'all') { return true; }
    if (config.notificationLevel === 'failures-only') {
      return event.type === 'workflow_failed';
    }
    // 'important': only fire for high-signal event types
    return IMPORTANT_TYPES.has(event.type);
  }
}
```

---

## Step 12 — Tree data providers (sidebar UI)

VSCode's sidebar trees use the `TreeDataProvider` interface. You implement two methods:
`getChildren` (what nodes are inside a node?) and `getTreeItem` (how does a node look?).
The `_onDidChangeTreeData` emitter tells VSCode to re-render when data changes.

```typescript
// src/providers/repoTreeProvider.ts
import * as vscode from 'vscode';
import type { EventStore } from '../storage/eventStore';
import type { RepoConfig } from '../types';

export class RepoTreeProvider implements vscode.TreeDataProvider<RepoItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(
    private store: EventStore,
    private repos: string[]
  ) {}

  /** Called by PollService or on config change — triggers a re-render */
  refresh(repos?: string[]): void {
    if (repos) { this.repos = repos; }
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(item: RepoItem): vscode.TreeItem {
    return item;
  }

  getChildren(): RepoItem[] {
    return this.repos.map(repo => {
      const unread    = this.store.getUnreadCount(repo);
      const hasFailure = this.store.hasUnreadFailure(repo);
      return new RepoItem(repo, unread, hasFailure);
    });
  }
}

class RepoItem extends vscode.TreeItem {
  constructor(
    public readonly nameWithOwner: string,
    unreadCount: number,
    hasFailure: boolean
  ) {
    // TreeItemCollapsibleState.None = leaf node (clicking fires a command, not expanding)
    super(nameWithOwner, vscode.TreeItemCollapsibleState.None);

    // The badge number shown on the item (VSCode renders this as a pill)
    this.description = unreadCount > 0 ? `${unreadCount} new` : '';

    // contextValue is matched against `viewItem` in package.json menu conditions
    this.contextValue = 'repo';

    // Icon changes based on state
    this.iconPath = hasFailure
      ? new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'))
      : unreadCount > 0
        ? new vscode.ThemeIcon('bell-dot', new vscode.ThemeColor('notificationsInfoIcon.foreground'))
        : new vscode.ThemeIcon('repo');

    // When the user clicks this item, run the showEvents command and pass this repo as argument
    this.command = {
      command:   'ghTracker.showEvents',
      title:     'Show Events',
      arguments: [nameWithOwner],
    };
  }
}
```

```typescript
// src/providers/eventTreeProvider.ts
import * as vscode from 'vscode';
import type { EventStore } from '../storage/eventStore';
import type { TrackedEvent, EventType } from '../types';

export class EventTreeProvider implements vscode.TreeDataProvider<EventItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private currentRepo: string | undefined;

  constructor(private store: EventStore, private maxEvents: number) {}

  showRepo(repo: string): void {
    this.currentRepo = repo;
    this._onDidChangeTreeData.fire();
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(item: EventItem): vscode.TreeItem { return item; }

  getChildren(): EventItem[] {
    if (!this.currentRepo) { return []; }
    const events = this.store.getEventsForRepo(this.currentRepo, this.maxEvents);
    return events.map(e => new EventItem(e));
  }
}

const EVENT_ICONS: Record<EventType, string> = {
  pr_opened:        'git-pull-request',
  pr_closed:        'git-pull-request-closed',
  pr_merged:        'git-merge',
  pr_review:        'eye',
  pr_comment:       'comment',
  pr_ready:         'pass',
  push:             'arrow-up',
  workflow_failed:  'error',
  workflow_passed:  'pass-filled',
  review_requested: 'person',
  label_changed:    'tag',
  branch_created:   'git-branch',
  branch_deleted:   'trash',
  release_published:'package',
  unknown:          'circle-outline',
};

class EventItem extends vscode.TreeItem {
  constructor(public readonly event: TrackedEvent) {
    super(event.title, vscode.TreeItemCollapsibleState.None);

    this.description = new Date(event.createdAt).toLocaleTimeString();
    this.tooltip     = `${event.type} · ${event.actor} · ${new Date(event.createdAt).toLocaleString()}`;

    // dimmed icon for events already seen
    const iconName = EVENT_ICONS[event.type] ?? 'circle-outline';
    this.iconPath   = new vscode.ThemeIcon(
      iconName,
      event.seen ? undefined : new vscode.ThemeColor('notificationsInfoIcon.foreground')
    );

    // 'event_pr' context value enables the "AI Review" right-click option in menus
    this.contextValue = event.type.startsWith('pr_') ? 'event_pr' : 'event';

    this.command = {
      command:   'ghTracker.openEvent',
      title:     'Open Event',
      arguments: [event],
    };
  }
}
```

---

## Step 13 — Setup webview panel (first-run UI)

Webviews in VSCode are essentially iframes with message-passing. You send data from the
extension host to the webview with `panel.webview.postMessage()`, and receive user input
back via `panel.webview.onDidReceiveMessage`. Never trust data from the webview — treat
it like data from a web form.

```typescript
// src/webviews/setupPanel.ts
import * as vscode from 'vscode';
import { ConfigService } from '../services/configService';
import { AuthService } from '../services/authService';
import type { GitHubClient } from '../services/githubClient';

export class SetupPanel {
  private static panel: vscode.WebviewPanel | undefined;

  static show(
    context: vscode.ExtensionContext,
    clientFactory: (token: string, host: string) => GitHubClient,
    onSave: () => void
  ): void {
    if (SetupPanel.panel) {
      SetupPanel.panel.reveal();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'ghTrackerSetup',
      'GH Tracker — Setup',
      vscode.ViewColumn.One,
      {
        enableScripts: true,        // allow JS in the webview HTML
        retainContextWhenHidden: true  // don't destroy state when switching tabs
      }
    );

    SetupPanel.panel = panel;

    const cfg = ConfigService.get();
    panel.webview.html = SetupPanel.getHtml(cfg);

    // Listen for messages sent from the webview JavaScript
    panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg.command === 'save') {
        const { hostUrl, repositories, aiEnabled, pollIntervalSeconds, notificationLevel } = msg.data;

        // Persist each setting
        const globalTarget = vscode.ConfigurationTarget.Global;
        const c = vscode.workspace.getConfiguration('ghTracker');
        await Promise.all([
          c.update('hostUrl',             hostUrl,             globalTarget),
          c.update('repositories',        repositories,        globalTarget),
          c.update('aiEnabled',           aiEnabled,           globalTarget),
          c.update('pollIntervalSeconds', pollIntervalSeconds, globalTarget),
          c.update('notificationLevel',   notificationLevel,   globalTarget),
        ]);

        vscode.window.showInformationMessage('GH Tracker: Settings saved!');
        onSave();
        panel.dispose();
      }

      if (msg.command === 'testConnection') {
        try {
          const token = await AuthService.getToken(context, msg.hostUrl);
          if (!token) { throw new Error('No token'); }
          const client = clientFactory(token, msg.hostUrl);
          const user = await client.validateConnection();
          panel.webview.postMessage({ command: 'connectionResult', success: true, user });
        } catch (err: any) {
          panel.webview.postMessage({ command: 'connectionResult', success: false, error: err.message });
        }
      }
    });

    panel.onDidDispose(() => { SetupPanel.panel = undefined; });
  }

  private static getHtml(cfg: ReturnType<typeof ConfigService.get>): string {
    // Inline HTML/CSS/JS for the setup form.
    // In a production extension you would load this from a separate .html file
    // using panel.webview.asWebviewUri() for assets.
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>GH Tracker Setup</title>
  <style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground);
           background: var(--vscode-editor-background); padding: 2rem; max-width: 600px; }
    label { display: block; margin-top: 1.2rem; font-size: 12px; text-transform: uppercase;
            letter-spacing: 0.5px; color: var(--vscode-descriptionForeground); }
    input, select { width: 100%; margin-top: 4px; padding: 6px 8px;
                    background: var(--vscode-input-background);
                    color: var(--vscode-input-foreground);
                    border: 1px solid var(--vscode-input-border);
                    border-radius: 4px; font-size: 13px; box-sizing: border-box; }
    textarea { width: 100%; height: 80px; resize: vertical;
               background: var(--vscode-input-background); color: var(--vscode-input-foreground);
               border: 1px solid var(--vscode-input-border); border-radius: 4px;
               padding: 6px 8px; font-family: var(--vscode-editor-font-family); font-size: 12px;
               box-sizing: border-box; }
    button { margin-top: 1.5rem; padding: 8px 20px; cursor: pointer;
             background: var(--vscode-button-background); color: var(--vscode-button-foreground);
             border: none; border-radius: 4px; font-size: 13px; }
    button.secondary { background: var(--vscode-button-secondaryBackground);
                       color: var(--vscode-button-secondaryForeground); }
    .status { margin-top: 8px; font-size: 12px; min-height: 18px; }
    .ok { color: var(--vscode-testing-iconPassed); }
    .err { color: var(--vscode-errorForeground); }
    .toggle-row { display: flex; align-items: center; gap: 10px; margin-top: 1.2rem; }
    h1 { font-size: 18px; font-weight: 500; margin-bottom: 0.5rem; }
    p.sub { font-size: 12px; color: var(--vscode-descriptionForeground); margin: 0; }
  </style>
</head>
<body>
  <h1>GitHub Enterprise Tracker</h1>
  <p class="sub">Configure which repositories to monitor and how notifications should behave.</p>

  <label for="hostUrl">Host URL</label>
  <input id="hostUrl" value="${cfg.hostUrl}" placeholder="https://github.com" />
  <button class="secondary" onclick="testConn()" style="margin-top:8px;padding:5px 12px">Test connection</button>
  <div class="status" id="connStatus"></div>

  <label for="repos">Repositories (one per line, org/repo format)</label>
  <textarea id="repos">${cfg.repositories.join('\n')}</textarea>

  <label for="pollInterval">Poll interval (seconds)</label>
  <input id="pollInterval" type="number" min="30" value="${cfg.pollIntervalSeconds}" />

  <label for="notifLevel">Notification level</label>
  <select id="notifLevel">
    <option value="all"           ${cfg.notificationLevel === 'all'           ? 'selected' : ''}>All events</option>
    <option value="important"     ${cfg.notificationLevel === 'important'     ? 'selected' : ''}>Important only (PRs, failures)</option>
    <option value="failures-only" ${cfg.notificationLevel === 'failures-only' ? 'selected' : ''}>Failures only</option>
  </select>

  <div class="toggle-row">
    <input type="checkbox" id="aiEnabled" ${cfg.aiEnabled ? 'checked' : ''} style="width:auto">
    <label for="aiEnabled" style="margin:0">Enable AI features (requires GitHub Copilot)</label>
  </div>

  <button onclick="save()">Save &amp; Start Tracking</button>

  <script>
    const vscode = acquireVsCodeApi();

    function save() {
      vscode.postMessage({
        command: 'save',
        data: {
          hostUrl:             document.getElementById('hostUrl').value.trim(),
          repositories:        document.getElementById('repos').value.split('\n').map(s => s.trim()).filter(Boolean),
          pollIntervalSeconds: parseInt(document.getElementById('pollInterval').value, 10),
          notificationLevel:   document.getElementById('notifLevel').value,
          aiEnabled:           document.getElementById('aiEnabled').checked,
        }
      });
    }

    function testConn() {
      const hostUrl = document.getElementById('hostUrl').value.trim();
      document.getElementById('connStatus').textContent = 'Testing…';
      vscode.postMessage({ command: 'testConnection', hostUrl });
    }

    window.addEventListener('message', e => {
      const msg = e.data;
      if (msg.command === 'connectionResult') {
        const el = document.getElementById('connStatus');
        if (msg.success) {
          el.className = 'status ok';
          el.textContent = '✓ Connected as @' + msg.user.login;
        } else {
          el.className = 'status err';
          el.textContent = '✗ ' + msg.error;
        }
      }
    });
  </script>
</body>
</html>`;
  }
}
```

---

## Step 14 — AI service (VSCode Language Model API)

The Language Model API (`vscode.lm`) was introduced in VSCode 1.90 and lets extensions
call Copilot's underlying models without any API key. The user just needs Copilot installed.
The `token` parameter is a `CancellationToken` — always pass it so long requests can be
cancelled when the extension deactivates.

```typescript
// src/services/aiService.ts
import * as vscode from 'vscode';
import type { TrackedEvent } from '../types';

export class AIService {
  /** Select the best available Copilot model. Falls back gracefully if unavailable. */
  private async getModel(): Promise<vscode.LanguageModelChat | undefined> {
    try {
      // 'family' is a hint — VSCode picks the best available matching model.
      // 'gpt-4o-mini' is the free-tier Copilot model as of mid-2025.
      const models = await vscode.lm.selectChatModels({
        vendor: 'copilot',
        family: 'gpt-4o-mini',
      });
      return models[0];
    } catch {
      return undefined;  // Copilot not installed or not signed in
    }
  }

  /**
   * AI-1: Generate a one-sentence human summary of an event.
   * Called automatically after each new event is stored.
   */
  async summarizeEvent(event: TrackedEvent): Promise<string | undefined> {
    const model = await this.getModel();
    if (!model) { return undefined; }

    const prompt = `You are a developer notification assistant.
Summarize this GitHub event in one sentence (max 20 words). Be specific. No fluff.
Event type: ${event.type}
Title: ${event.title}
Actor: ${event.actor}
Repository: ${event.repo}
Only output the summary sentence. No preamble.`;

    try {
      const cts = new vscode.CancellationTokenSource();
      const req  = await model.sendRequest(
        [vscode.LanguageModelChatMessage.User(prompt)],
        {},
        cts.token
      );

      let result = '';
      for await (const chunk of req.text) { result += chunk; }
      return result.trim();
    } catch {
      return undefined;
    }
  }

  /**
   * AI-2: Quick PR diff review.
   * Streams the review into a VSCode Output Channel so the user sees it as it arrives.
   */
  async reviewPR(
    event: TrackedEvent,
    diffFiles: Array<{ filename: string; patch?: string }>
  ): Promise<void> {
    const model = await this.getModel();
    if (!model) {
      vscode.window.showWarningMessage('GH Tracker: Copilot is not available. Enable AI features and ensure Copilot is installed.');
      return;
    }

    const output = vscode.window.createOutputChannel('GH Tracker — AI Review');
    output.show(true);  // true = don't take focus from the editor
    output.appendLine(`=== AI Review: ${event.title} ===\n`);

    // Build a focused diff string (cap at ~4000 chars to stay within token budget)
    const diffText = diffFiles
      .slice(0, 10)
      .map(f => `--- ${f.filename} ---\n${(f.patch ?? '').slice(0, 400)}`)
      .join('\n\n')
      .slice(0, 4000);

    const prompt = `You are a senior software engineer doing a concise code review.
Review the following PR diff. Flag only real issues: bugs, security problems, missing error handling.
Skip style comments. Be direct and actionable. Format as bullet points.

${diffText}`;

    try {
      const cts = new vscode.CancellationTokenSource();
      const req  = await model.sendRequest(
        [vscode.LanguageModelChatMessage.User(prompt)],
        {},
        cts.token
      );

      for await (const chunk of req.text) {
        output.append(chunk);  // stream chunks as they arrive
      }
      output.appendLine('\n\n=== End of AI Review ===');
    } catch (err: any) {
      output.appendLine(`\nError: ${err.message}`);
    }
  }

  /**
   * AI-3: Pipeline failure root-cause triage.
   * Given log lines from a failed run, explain why it failed.
   */
  async triagePipelineFailure(
    event: TrackedEvent,
    logTail: string
  ): Promise<string | undefined> {
    const model = await this.getModel();
    if (!model) { return undefined; }

    const prompt = `A CI/CD pipeline failed. Given these log lines, state the root cause in one sentence and suggest one fix.
Log (last 50 lines):
${logTail.slice(-2000)}

Output format:
Root cause: <sentence>
Fix: <sentence>`;

    try {
      const cts = new vscode.CancellationTokenSource();
      const req = await model.sendRequest(
        [vscode.LanguageModelChatMessage.User(prompt)],
        {},
        cts.token
      );

      let result = '';
      for await (const chunk of req.text) { result += chunk; }
      return result.trim();
    } catch {
      return undefined;
    }
  }

  /**
   * AI-4: Smart notification scoring.
   * Returns a score 1-5. Only fire notifications for score >= threshold (configurable, default 3).
   */
  async scoreEventUrgency(event: TrackedEvent, currentUser: string): Promise<number> {
    const model = await this.getModel();
    if (!model) { return 3; }  // default to medium if AI unavailable

    const prompt = `Score the urgency of this GitHub event for user "${currentUser}" from 1 (noise) to 5 (critical).
Event: ${JSON.stringify({ type: event.type, title: event.title, actor: event.actor, repo: event.repo })}
Rules: 5=pipeline failure or direct review request, 4=PR opened/merged, 3=new comment, 2=label change, 1=unknown
Reply with ONLY a single digit 1-5.`;

    try {
      const cts = new vscode.CancellationTokenSource();
      const req = await model.sendRequest(
        [vscode.LanguageModelChatMessage.User(prompt)],
        {},
        cts.token
      );

      let result = '';
      for await (const chunk of req.text) { result += chunk; }
      const score = parseInt(result.trim(), 10);
      return isNaN(score) ? 3 : Math.max(1, Math.min(5, score));
    } catch {
      return 3;
    }
  }
}
```

---

## Step 15 — Extension entry point (wiring it all together)

`extension.ts` is the orchestrator. It initializes all services, connects them, and
registers all commands. The `activate` function is called once when the extension starts.
Every disposable must be pushed to `context.subscriptions` so VSCode can clean up
automatically when the extension deactivates.

```typescript
// src/extension.ts
import * as vscode from 'vscode';
import { ConfigService }    from './services/configService';
import { AuthService }      from './services/authService';
import { GitHubClient }     from './services/githubClient';
import { PollService }      from './services/pollService';
import { NotifyService }    from './services/notifyService';
import { AIService }        from './services/aiService';
import { EventStore }       from './storage/eventStore';
import { RepoTreeProvider } from './providers/repoTreeProvider';
import { EventTreeProvider } from './providers/eventTreeProvider';
import { SetupPanel }       from './webviews/setupPanel';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  console.log('GH Tracker: activating');

  // ── 1. Initialize storage ───────────────────────────────────────────────
  const store = new EventStore(context.globalStorageUri.fsPath);
  context.subscriptions.push({ dispose: () => store.dispose() });

  // ── 2. Initialize services ──────────────────────────────────────────────
  const aiService     = new AIService();
  const notifyService = new NotifyService();

  // ── 3. Initialize tree providers ────────────────────────────────────────
  const cfg           = ConfigService.get();
  const repoProvider  = new RepoTreeProvider(store, cfg.repositories);
  const eventProvider = new EventTreeProvider(store, cfg.maxEventsShown);

  vscode.window.registerTreeDataProvider('ghTracker.repos',  repoProvider);
  vscode.window.registerTreeDataProvider('ghTracker.events', eventProvider);

  // ── 4. Factory for GitHubClient (re-created when settings change) ───────
  let client: GitHubClient | undefined;

  async function initClient(): Promise<GitHubClient | undefined> {
    const c     = ConfigService.get();
    const token = await AuthService.getToken(context, c.hostUrl);
    if (!token) {
      vscode.window.showErrorMessage('GH Tracker: Authentication failed. Run "GH Tracker: Open Setup".');
      return undefined;
    }
    return new GitHubClient(token, c.hostUrl);
  }

  // ── 5. Initialize and start the poll service ─────────────────────────────
  let pollService: PollService | undefined;

  async function startPolling(): Promise<void> {
    const c = ConfigService.get();
    if (c.repositories.length === 0) {
      // No repos configured — show setup on first run
      SetupPanel.show(context, (token, host) => new GitHubClient(token, host), restart);
      return;
    }

    client = await initClient();
    if (!client) { return; }

    pollService?.dispose();
    pollService = new PollService(client, store, c.repositories, c.pollIntervalSeconds * 1000);

    // React to new events: notify + refresh tree
    const sub = pollService.onNewEvents(async (events) => {
      const currentConfig = ConfigService.get();

      // AI scoring: filter notifications by urgency score
      const toNotify = currentConfig.aiEnabled
        ? (await Promise.all(events.map(async e => ({
            event: e,
            score: await aiService.scoreEventUrgency(e, 'current-user')
          })))).filter(x => x.score >= 3).map(x => x.event)
        : events;

      notifyService.notify(toNotify, currentConfig);
      repoProvider.refresh();
      eventProvider.refresh();
    });

    context.subscriptions.push(sub);
    pollService.start();
    console.log(`GH Tracker: polling ${c.repositories.length} repos every ${c.pollIntervalSeconds}s`);
  }

  async function restart(): Promise<void> {
    pollService?.dispose();
    const c = ConfigService.get();
    repoProvider.refresh(c.repositories);
    await startPolling();
  }

  // ── 6. Register all commands ─────────────────────────────────────────────
  context.subscriptions.push(

    vscode.commands.registerCommand('ghTracker.setup', () => {
      SetupPanel.show(context, (token, host) => new GitHubClient(token, host), restart);
    }),

    vscode.commands.registerCommand('ghTracker.refresh', async () => {
      await restart();
      vscode.window.showInformationMessage('GH Tracker: Refreshed');
    }),

    vscode.commands.registerCommand('ghTracker.addRepo', async () => {
      const input = await vscode.window.showInputBox({
        prompt: 'Enter repository in org/repo format (e.g. myorg/my-service)',
        validateInput: v => v?.includes('/') ? undefined : 'Format must be org/repo',
      });
      if (input) {
        await ConfigService.addRepository(input.trim());
        await restart();
      }
    }),

    vscode.commands.registerCommand('ghTracker.removeRepo', async (item) => {
      if (item?.nameWithOwner) {
        await ConfigService.removeRepository(item.nameWithOwner);
        await restart();
      }
    }),

    vscode.commands.registerCommand('ghTracker.showEvents', (repo: string) => {
      eventProvider.showRepo(repo);
      store.markAllRead(repo);
      repoProvider.refresh();
    }),

    vscode.commands.registerCommand('ghTracker.openEvent', (event) => {
      store.markEventRead(event.id);
      vscode.env.openExternal(vscode.Uri.parse(event.url));
      repoProvider.refresh();
    }),

    vscode.commands.registerCommand('ghTracker.aiReview', async (item) => {
      if (!item?.event || !client) { return; }
      const prMatch = item.event.url.match(/\/pull\/(\d+)/);
      if (!prMatch) { return; }
      const files = await client.getPRFiles(item.event.repo, parseInt(prMatch[1], 10));
      await aiService.reviewPR(item.event, files);
    }),

    vscode.commands.registerCommand('ghTracker.markRead', (item) => {
      if (item?.nameWithOwner) {
        store.markAllRead(item.nameWithOwner);
        repoProvider.refresh();
        eventProvider.refresh();
      }
    }),

    // Restart polling when settings change (e.g. user edits settings.json)
    ConfigService.onChange(restart)
  );

  // ── 7. Kick off polling ──────────────────────────────────────────────────
  await startPolling();
}

export function deactivate(): void {
  // VSCode automatically disposes everything in context.subscriptions.
  // SQLite close is handled via the store's dispose registered above.
  console.log('GH Tracker: deactivated');
}
```

---

## Step 16 — Webpack config

Because `better-sqlite3` is a native Node addon (`.node` file), you must tell webpack
to treat it as an external. It can't be bundled — it must be shipped alongside the extension.

```javascript
// webpack.config.js
const path = require('path');

module.exports = {
  target: 'node',   // VSCode extension host is Node, not browser
  mode:   'none',

  entry:  './src/extension.ts',
  output: {
    path:           path.resolve(__dirname, 'dist'),
    filename:       'extension.js',
    libraryTarget:  'commonjs2',
    devtoolModuleFilenameTemplate: '../[resource-path]',
  },

  externals: {
    vscode:           'commonjs vscode',  // provided by VSCode at runtime
    'better-sqlite3': 'commonjs better-sqlite3',  // native addon — can't bundle
  },

  resolve: { extensions: ['.ts', '.js'] },

  module: {
    rules: [{ test: /\.ts$/, use: 'ts-loader', exclude: /node_modules/ }],
  },
};
```

Because `better-sqlite3` is external, you need to copy it to `dist` before packaging:

```bash
# ▶  Add this postinstall / prebuild script or run manually
cp -r node_modules/better-sqlite3 dist/node_modules/better-sqlite3
```

---

## Step 17 — Build, run, and debug

```bash
# ▶  Compile in watch mode (recompiles on every file save)
npm run watch

# ▶  In VSCode, press F5 to launch the Extension Development Host
#    This opens a second VSCode window with your extension loaded.
#    Any console.log() calls appear in the Debug Console of the first window.
```

**Useful debug commands in the Extension Development Host:**

- `Ctrl+Shift+P` → "GH Tracker: Open Setup" — verify the webview renders
- `Ctrl+Shift+P` → "GH Tracker: Add Repository" — add a repo (e.g. `torvalds/linux`)
- `Ctrl+Shift+P` → "GH Tracker: Refresh Now" — force a poll immediately
- Check the sidebar for the GH Tracker icon in the activity bar

```bash
# ✓ verify the compiled output exists and is not empty
ls -lh dist/extension.js
# Expected: > 10KB

# ✓ verify the SQLite DB is being created (run after first launch)
ls ~/.config/Code/User/globalStorage/your-publisher-id.gh-tracker/
# Expected: events.db
```

---

## Step 18 — Package and publish

```bash
# ▶  Run the linter first
npm run lint

# ▶  Package into a .vsix file for local install or marketplace upload
npx vsce package
# Creates: gh-tracker-0.1.0.vsix

# ▶  Install locally to test the packaged extension (not dev mode)
code --install-extension gh-tracker-0.1.0.vsix

# ▶  Publish to VSCode Marketplace (requires a publisher account at marketplace.visualstudio.com)
npx vsce publish
```

---

## Quick reference: all commands

| Command | What it does |
|---|---|
| `npm run watch` | Compile TypeScript incrementally on save |
| `F5` in VSCode | Launch Extension Development Host |
| `npx vsce package` | Create installable `.vsix` |
| `npx vsce publish` | Publish to Marketplace |
| `npx tsc --noEmit` | Type-check without emitting files |
| `npm run lint` | ESLint check |

## Quick reference: file map

```
gh-tracker/
├── src/
│   ├── extension.ts               ← entry point, command registration
│   ├── types.ts                   ← shared interfaces
│   ├── providers/
│   │   ├── repoTreeProvider.ts    ← sidebar repo list
│   │   └── eventTreeProvider.ts  ← sidebar event list
│   ├── services/
│   │   ├── authService.ts         ← OAuth + PAT auth
│   │   ├── configService.ts       ← settings read/write
│   │   ├── githubClient.ts        ← Octokit wrapper
│   │   ├── pollService.ts         ← background polling loop
│   │   ├── notifyService.ts       ← toast notifications
│   │   └── aiService.ts           ← Copilot LM API
│   ├── storage/
│   │   └── eventStore.ts          ← SQLite persistence
│   ├── utils/
│   │   └── eventNormalizer.ts     ← GitHub API → TrackedEvent
│   └── webviews/
│       └── setupPanel.ts          ← first-run setup UI
├── resources/
│   └── icon.svg                   ← activity bar icon
├── package.json                   ← manifest + contributions
├── tsconfig.json
└── webpack.config.js
```
