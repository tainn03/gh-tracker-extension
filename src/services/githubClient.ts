import { Octokit } from '@octokit/rest';
import { throttling } from '@octokit/plugin-throttling';
import type { TrackedEvent, EnrichedEventData } from '../types';
import { normalizeEvent, normalizeWorkflowRun } from '../utils/eventNormalizer';

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
    let newEvents: TrackedEvent[];
    if (sinceEventId) {
      const sinceIdx = allEvents.findIndex(e => e.id === sinceEventId);
      newEvents = sinceIdx === -1 ? allEvents : allEvents.slice(0, sinceIdx);
    } else {
      newEvents = allEvents;
    }

    // ── Also fetch completed workflow runs from the Actions API ──────
    //     The Events API does NOT return WorkflowRunEvent, so we must
    //     call the Actions API separately.
    try {
      const workflowRuns = await this.getWorkflowRuns(nameWithOwner);
      const workflowEvents = workflowRuns.map(run => normalizeWorkflowRun(run, nameWithOwner));
      // Merge and re-sort newest-first
      newEvents.push(...workflowEvents);
      newEvents.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    } catch {
      // Workflow runs are best-effort
    }

    // Enrich only new events with full detail from GitHub API (PR diff, commit diff, etc.)
    // NOTE: workflow events from Actions API use a different payload structure;
    //       enrichEvent handles them via the 'workflow_failed'/'workflow_passed' branch
    //       which reads payload.workflow_run.
    for (const evt of newEvents) {
      await this.enrichEvent(evt, nameWithOwner);
    }

    return newEvents;
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

  /** Fetch pull request details (title, body, commits, changed files summary, branch info) */
  async getPRDetails(nameWithOwner: string, prNumber: number) {
    const [owner, repo] = nameWithOwner.split('/');
    const { data: pr } = await this.octokit.pulls.get({ owner, repo, pull_number: prNumber });
    const { data: commits } = await this.octokit.pulls.listCommits({ owner, repo, pull_number: prNumber, per_page: 20 });
    return {
      title: pr.title,
      body: pr.body ?? '',
      state: pr.state,
      merged: pr.merged,
      headline: pr.head?.ref ?? '',
      baseBranch: pr.base?.ref ?? '',
      commits: commits.map(c => ({ sha: c.sha.slice(0, 7), message: c.commit.message.split('\n')[0], author: c.commit.author?.name ?? '' })),
      changedFiles: pr.changed_files ?? 0,
      additions: pr.additions ?? 0,
      deletions: pr.deletions ?? 0,
    };
  }

  /** Fetch text log for a workflow run (fetches full job logs) */
  async getWorkflowRunLogText(nameWithOwner: string, runId: number, onlyFailed: boolean = true): Promise<string> {
    const [owner, repo] = nameWithOwner.split('/');
    try {
      // List jobs for this run
      const { data: jobsData } = await this.octokit.actions.listJobsForWorkflowRun({
        owner, repo, run_id: runId, filter: 'latest',
      });
      // Filter jobs: failed only or all jobs
      const jobs = onlyFailed
        ? jobsData.jobs.filter(j => j.conclusion === 'failure')
        : jobsData.jobs;

      if (jobs.length === 0) return onlyFailed ? 'No failed jobs found.' : 'No jobs found.';

      let logText = '';
      for (const job of jobs.slice(0, 5)) { // max 5 jobs
        const status = job.conclusion || job.status;
        logText += `\n--- Job: ${job.name} (${status}) ---\n`;
        try {
          const logResponse = await this.octokit.request('GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs', {
            owner, repo, job_id: job.id,
            headers: { Accept: 'application/vnd.github+json' },
          });
          const raw = typeof logResponse.data === 'string' ? logResponse.data : JSON.stringify(logResponse.data);
          // Take full log for failed jobs, tail for passed
          const lines = raw.split('\n');
          const maxLines = onlyFailed ? 500 : 100;
          logText += lines.slice(-maxLines).join('\n');
        } catch {
          logText += '(logs unavailable)\n';
        }
      }
      return logText.trim().slice(0, 100000); // cap at 100KB
    } catch (err: any) {
      return `Failed to fetch logs: ${err.message}`;
    }
  }

  /** Fetch commit details for a push (get commit messages and authors) */
  async getPushCommitDetails(nameWithOwner: string, ref: string): Promise<Array<{ sha: string; message: string; author: string }>> {
    const [owner, repo] = nameWithOwner.split('/');
    const branch = ref.replace('refs/heads/', '');
    try {
      const { data } = await this.octokit.repos.listCommits({ owner, repo, sha: branch, per_page: 10 });
      return data.map(c => ({
        sha: c.sha.slice(0, 7),
        message: c.commit.message.split('\n')[0],
        author: c.commit.author?.name ?? '',
      }));
    } catch {
      return [];
    }
  }

  /**
   * Enrich a TrackedEvent with full detail from the GitHub API.
   * Fetches PR details, commit diffs, workflow logs, etc. depending on event type.
   * Stores the result as JSON in evt.rawData.
   */
  private async enrichEvent(evt: TrackedEvent, nameWithOwner: string): Promise<void> {
    const [owner, repo] = nameWithOwner.split('/');
    const payload = evt.payload as any;

    try {
      // ── PR events: fetch full details + file diffs ────────────────────
      if (evt.type.startsWith('pr_')) {
        const prNumber = payload?.pull_request?.number
          ?? payload?.issue?.number
          ?? parseInt(evt.url.match(/\/pull\/(\d+)/)?.[1] ?? '0', 10);
        if (!prNumber) return;

        const { data: pr } = await this.octokit.pulls.get({ owner, repo, pull_number: prNumber });
        const { data: commits } = await this.octokit.pulls.listCommits({ owner, repo, pull_number: prNumber, per_page: 20 });
        const { data: files } = await this.octokit.pulls.listFiles({ owner, repo, pull_number: prNumber });

        const data: EnrichedEventData = {
          prTitle: pr.title,
          prBody: pr.body ?? '',
          prState: pr.state,
          prMerged: pr.merged ?? false,
          prHeadBranch: pr.head?.ref ?? '',
          prBaseBranch: pr.base?.ref ?? '',
          prChangedFiles: pr.changed_files ?? 0,
          prAdditions: pr.additions ?? 0,
          prDeletions: pr.deletions ?? 0,
          prCommits: commits.slice(0, 20).map(c => ({
            sha: c.sha.slice(0, 7),
            message: c.commit.message.split('\n')[0],
            author: c.commit.author?.name ?? '',
          })),
          prFiles: files.slice(0, 30).map(f => ({
            filename: f.filename,
            status: f.status ?? 'modified',
            patch: f.patch?.slice(0, 2000),
            additions: f.additions,
            deletions: f.deletions,
          })),
        };

        // For comment/review events, include the comment body
        if (evt.type === 'pr_review' && payload?.review?.body) {
          data.commentBody = payload.review.body;
        }
        if (evt.type === 'pr_comment' && payload?.comment?.body) {
          data.commentBody = payload.comment.body;
          data.commentPath = payload.comment.path;
        }

        evt.rawData = JSON.stringify(data);
        return;
      }

      // ── Push events: fetch diff + commit details ──────────────────────
      if (evt.type === 'push') {
        const before = payload?.before as string;
        const head = payload?.head as string;
        const ref = payload?.ref as string;

        const data: EnrichedEventData = {};

        // Diff via compare API
        if (before && head) {
          const diff = await this.getPushDiff(nameWithOwner, before, head);
          if (diff) {
            data.pushDiff = diff;
            evt.diff = diff; // keep backward compat
          }
        }

        // Commit details
        if (ref) {
          const branch = ref.replace('refs/heads/', '');
          try {
            const { data: commits } = await this.octokit.repos.listCommits({ owner, repo, sha: branch, per_page: 10 });
            data.pushCommits = commits.map(c => ({
              sha: c.sha.slice(0, 7),
              message: c.commit.message.split('\n')[0],
              author: c.commit.author?.name ?? '',
            }));
          } catch { /* commit list optional */ }
        }

        evt.rawData = JSON.stringify(data);
        return;
      }

      // ── Workflow events: fetch full log for failures, summary for passed ─
      if (evt.type === 'workflow_failed' || evt.type === 'workflow_passed') {
        const run = payload?.workflow_run;
        const runId = run?.id;
        const data: EnrichedEventData = {};
        data.workflowName = run?.name ?? 'unknown';
        data.workflowBranch = run?.head_branch ?? '';
        data.workflowConclusion = run?.conclusion ?? '';
        data.workflowTriggerEvent = run?.event ?? '';

        if (runId) {
          const isFailed = evt.type === 'workflow_failed';
          const logs = await this.getWorkflowRunLogText(nameWithOwner, runId, isFailed);
          data.workflowLogs = logs;
        }

        evt.rawData = JSON.stringify(data);
        return;
      }

      // ── Review requested events: fetch PR details for AI review ──────
      if (evt.type === 'review_requested') {
        const prNumber = payload?.pull_request?.number ?? parseInt(evt.url.match(/\/pull\/(\d+)/)?.[1] ?? '0', 10);
        if (!prNumber) return;

        const { data: pr } = await this.octokit.pulls.get({ owner, repo, pull_number: prNumber });
        evt.rawData = JSON.stringify({
          prTitle: pr.title,
          prBody: pr.body ?? '',
          prState: pr.state,
          prHeadBranch: pr.head?.ref ?? '',
          prBaseBranch: pr.base?.ref ?? '',
          prChangedFiles: pr.changed_files ?? 0,
          prAdditions: pr.additions ?? 0,
          prDeletions: pr.deletions ?? 0,
        } satisfies EnrichedEventData);
        return;
      }

      // ── Issue events: body is already in payload.issue.body ───────────
      if (evt.type === 'issue_opened' || evt.type === 'issue_closed') {
        const issue = payload?.issue;
        if (issue?.body) {
          evt.rawData = JSON.stringify({ issueBody: issue.body } satisfies EnrichedEventData);
        }
        return;
      }

      // ── Issue comment events: comment body + issue context ─────────────
      if (evt.type === 'issue_comment') {
        const comment = payload?.comment;
        const issue = payload?.issue;
        const data: EnrichedEventData = {};
        if (comment?.body) {
          data.commentBody = comment.body;
        }
        if (issue) {
          data.issueTitle = issue.title;
          data.issueNumber = issue.number;
          data.issueBody = issue.body ?? '';
          data.issueState = issue.state;
        }
        evt.rawData = JSON.stringify(data);
        return;
      }

      // ── Release events: body is already in payload.release.body ───────
      if (evt.type === 'release_published') {
        const release = payload?.release;
        if (release?.body) {
          evt.rawData = JSON.stringify({ releaseBody: release.body } satisfies EnrichedEventData);
        }
        return;
      }
    } catch {
      // Silently skip enrichment failures — the base event data still works
    }
  }

  /** Fetch issue/PR comments for a pull request (general comments, not review comments) */
  async getPRIssueComments(nameWithOwner: string, prNumber: number): Promise<Array<{ author: string; body: string; createdAt: string }>> {
    const [owner, repo] = nameWithOwner.split('/');
    try {
      const { data } = await this.octokit.issues.listComments({ owner, repo, issue_number: prNumber, per_page: 20 });
      return data.map(c => ({
        author: c.user?.login ?? 'unknown',
        body: c.body ?? '',
        createdAt: c.created_at ?? '',
      }));
    } catch {
      return [];
    }
  }

  /** Fetch PR review comments (inline code review comments on diffs) */
  async getPRReviewComments(nameWithOwner: string, prNumber: number): Promise<Array<{ author: string; body: string; path: string; createdAt: string }>> {
    const [owner, repo] = nameWithOwner.split('/');
    try {
      const { data } = await this.octokit.pulls.listReviewComments({ owner, repo, pull_number: prNumber, per_page: 30 });
      return data.map(c => ({
        author: c.user?.login ?? 'unknown',
        body: c.body ?? '',
        path: c.path ?? '',
        createdAt: c.created_at ?? '',
      }));
    } catch {
      return [];
    }
  }

  /** Fetch PR reviews (summary reviews with state: APPROVED, CHANGES_REQUESTED, COMMENTED) */
  async getPRReviews(nameWithOwner: string, prNumber: number): Promise<Array<{ author: string; body: string; state: string; createdAt: string }>> {
    const [owner, repo] = nameWithOwner.split('/');
    try {
      const { data } = await this.octokit.pulls.listReviews({ owner, repo, pull_number: prNumber, per_page: 20 });
      return data.map(r => ({
        author: r.user?.login ?? 'unknown',
        body: r.body ?? '',
        state: r.state ?? 'COMMENTED',
        createdAt: r.submitted_at ?? '',
      }));
    } catch {
      return [];
    }
  }

  /**
   * Fetch completed workflow runs from the Actions API.
   * The Events API does NOT return WorkflowRunEvent, so we must call this separately.
   * Returns raw API response items; caller normalises them into TrackedEvent.
   */
  async getWorkflowRuns(nameWithOwner: string): Promise<any[]> {
    const [owner, repo] = nameWithOwner.split('/');
    try {
      const { data } = await this.octokit.actions.listWorkflowRunsForRepo({
        owner,
        repo,
        status: 'completed',
        per_page: 10,
      });
      return data.workflow_runs ?? [];
    } catch {
      return [];
    }
  }

  /** Quick connectivity check — useful in the setup UI to validate the host URL + token */
  async validateConnection(): Promise<{ login: string; name: string }> {
    const { data } = await this.octokit.users.getAuthenticated();
    return { login: data.login, name: data.name ?? data.login };
  }

  /**
   * Fetch the full raw diff for a push/compare range.
   * Uses the compare API to get the combined diff between two commits.
   */
  async getPushDiff(nameWithOwner: string, before: string, head: string): Promise<string> {
    const [owner, repo] = nameWithOwner.split('/');
    try {
      const { data } = await this.octokit.repos.compareCommits({
        owner, repo,
        base: before,
        head,
      });
      // Return the diff patch content (only from files that changed)
      const files = data.files ?? [];
      const parts: string[] = [];
      for (const f of files.slice(0, 30)) {
        const patch = f.patch ?? '';
        if (patch) {
          parts.push(`--- ${f.filename} (${f.status})\n${patch}`);
        }
      }
      return parts.join('\n').slice(0, 50000); // cap at 50KB
    } catch {
      return '';
    }
  }
}
