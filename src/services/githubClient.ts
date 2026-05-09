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
