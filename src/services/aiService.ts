import * as vscode from 'vscode';
import type { TrackedEvent } from '../types';
import type { GitHubClient } from './githubClient';

export class AIService {
  /** Select the best available Copilot model. Falls back gracefully if unavailable. */
  private async getModel(): Promise<vscode.LanguageModelChat | undefined> {
    try {
      const models = await vscode.lm.selectChatModels({
        vendor: 'copilot',
        family: 'gpt-4o-mini',
      });
      return models[0];
    } catch {
      return undefined;
    }
  }

  /**
   * AI-1: Detailed PR review with full context (title, description, commits, file stats, diff).
   * Streams the review into a VSCode Output Channel.
   */
  async reviewPR(
    event: TrackedEvent,
    diffFiles: Array<{ filename: string; patch?: string; additions?: number; deletions?: number; status?: string }>,
    client?: GitHubClient
  ): Promise<void> {
    const model = await this.getModel();
    if (!model) {
      vscode.window.showWarningMessage('GH Tracker: Copilot is not available.');
      return;
    }

    const output = vscode.window.createOutputChannel('GH Tracker — AI Review');
    output.show(true);
    output.appendLine('=== AI Pull Request Review ===\n');
    output.appendLine('PR: ' + event.title);
    output.appendLine('Repo: ' + event.repo + ' | Actor: ' + event.actor + '\n');

    // Gather rich context
    let contextParts: string[] = [];

    // PR metadata from event
    const prMatch = event.url.match(/\/pull\/(\d+)/);
    const prNumber = prMatch ? parseInt(prMatch[1], 10) : null;

    // Try to get PR details from API
    if (prNumber && client) {
      try {
        const details = await client.getPRDetails(event.repo, prNumber);
        contextParts.push('## Pull Request Information');
        contextParts.push('Title: ' + details.title);
        contextParts.push('Description: ' + (details.body || '(none)'));
        contextParts.push('State: ' + details.state + ' | Merged: ' + details.merged);
        contextParts.push('Files changed: ' + details.changedFiles + ' (+' + details.additions + '/-' + details.deletions + ')');
        if (details.commits.length > 0) {
          contextParts.push('\n## Commits in this PR');
          for (const c of details.commits) {
            contextParts.push('  ' + c.sha + ' ' + c.message + ' (' + c.author + ')');
          }
        }
      } catch {}
    }

    // Diff content
    if (diffFiles.length > 0) {
      contextParts.push('\n## Files Changed');
      for (const f of diffFiles.slice(0, 15)) {
        const stats = (f.additions != null) ? ' (+' + f.additions + '/-' + f.deletions + ')' : '';
        contextParts.push('  ' + (f.status || 'modified') + ' ' + f.filename + stats);
      }

      contextParts.push('\n## Diff Content');
      let diffText = '';
      for (const f of diffFiles.slice(0, 10)) {
        const patch = f.patch || '';
        diffText += '\n--- ' + f.filename + ' ---\n' + patch.slice(0, 1000);
      }
      contextParts.push(diffText.slice(0, 8000));
    }

    const fullContext = contextParts.join('\n');

    const prompt = 'You are a senior software engineer conducting a thorough code review.\n\n' +
      fullContext + '\n\n' +
      'Analyze this pull request in detail. Cover:\n' +
      '1. OVERVIEW: What does this PR do? Summarize the changes.\n' +
      '2. CODE QUALITY: Potential bugs, error handling gaps, edge cases.\n' +
      '3. SECURITY: Any injection risks, auth issues, data exposure.\n' +
      '4. PERFORMANCE: Inefficient queries, unnecessary allocations, large payloads.\n' +
      '5. ARCHITECTURE: Design concerns, coupling, testability issues.\n' +
      '6. SPECIFIC FEEDBACK: For each file, call out notable lines.\n\n' +
      'Be specific. Reference exact filenames and line patterns. Skip style nitpicks. Focus on what matters.';

    try {
      const cts = new vscode.CancellationTokenSource();
      const req = await model.sendRequest(
        [vscode.LanguageModelChatMessage.User(prompt)],
        {},
        cts.token
      );
      output.appendLine('─'.repeat(60));
      for await (const chunk of req.text) {
        output.append(chunk);
      }
      output.appendLine('\n\n=== End of AI Review ===');
    } catch (err: any) {
      output.appendLine('\nError: ' + err.message);
    }
  }

  /**
   * AI-2: Smart notification scoring (existing — wired to poll loop).
   */
  async scoreEventUrgency(event: TrackedEvent, currentUser: string): Promise<number> {
    const model = await this.getModel();
    if (!model) { return 3; }

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

  // ── New AI Features ──────────────────────────────────────────────────────

  /**
   * AI-3: Summarize a GitHub event with full context gathered from the API.
   * Streams the summary into an Output Channel.
   */
  async summarizeEvent(event: TrackedEvent, client: GitHubClient): Promise<void> {
    const model = await this.getModel();
    if (!model) {
      vscode.window.showWarningMessage('GH Tracker: Copilot is not available.');
      return;
    }

    const output = vscode.window.createOutputChannel('GH Tracker — AI Summary');
    output.show(true);
    output.appendLine(`=== AI Summary: ${event.title} ===\n`);

    // Gather context based on event type
    let contextText = `Event: ${event.type}\nRepo: ${event.repo}\nActor: ${event.actor}\nTime: ${event.createdAt}\n`;

    if (event.type.startsWith('pr_')) {
      // PR event — fetch PR details
      const prMatch = event.url.match(/\/pull\/(\d+)/);
      if (prMatch && client) {
        try {
          const prNum = parseInt(prMatch[1], 10);
          const details = await client.getPRDetails(event.repo, prNum);
          contextText += `\nPR #${prNum}: ${details.title}\nState: ${details.state}\nMerged: ${details.merged}\nDescription: ${details.body.slice(0, 1000)}\n`;
          contextText += `Files changed: ${details.changedFiles} (+${details.additions}/-${details.deletions})\n`;
          contextText += `Commits:\n${details.commits.map(c => `  ${c.sha} ${c.message} (${c.author})`).join('\n')}\n`;
        } catch { }
      }
    } else if (event.type === 'push') {
      const payload = event.payload as any;
      const branch = (payload?.ref as string)?.replace('refs/heads/', '') ?? 'unknown';
      contextText += `\nBranch: ${branch}\n`;
      if (payload?.commits) {
        contextText += `Commits:\n${(payload.commits as any[]).map((c: any) => `  ${c.sha?.slice(0, 7)} ${c.message?.split('\n')[0]} (${c.author?.name ?? ''})`).join('\n')}\n`;
      }
      // Also try fetching more via API
      if (client && payload?.ref) {
        try {
          const commits = await client.getPushCommitDetails(event.repo, payload.ref);
          if (commits.length > 0) {
            contextText += `\nAdditional commits from API:\n${commits.map(c => `  ${c.sha} ${c.message} (${c.author})`).join('\n')}\n`;
          }
        } catch { }
      }
    } else if (event.type === 'workflow_failed' || event.type === 'workflow_passed') {
      const payload = event.payload as any;
      const run = payload?.workflow_run;
      if (run) {
        contextText += `\nWorkflow: ${run.name ?? 'unknown'}\nBranch: ${run.head_branch ?? ''}\nStatus: ${run.status}\nConclusion: ${run.conclusion}\n`;
        contextText += `Trigger event: ${run.event ?? ''}\n`;
      }
    } else if (event.type === 'release_published') {
      const payload = event.payload as any;
      const release = payload?.release;
      if (release) {
        contextText += `\nRelease: ${release.tag_name ?? ''}\nName: ${release.name ?? ''}\n`;
        contextText += `Body: ${(release.body ?? '').slice(0, 1000)}\n`;
      }
    }

    const prompt = `You are a developer notification assistant. Provide a DETAILED summary of this GitHub event.

Cover:
1. WHAT: What exactly happened (PR merged, branch created, pipeline failed, etc.)
2. DETAILS: Key specifics — PR number, branch name, files changed, commit messages
3. CONTEXT: Why this matters — is it a feature? Bug fix? Release? CI failure?
4. IMPACT: Who or what is affected

Be thorough but well-organized. Use plain text with clear sections. Avoid fluff.

Event data:\n\n${contextText}`;

    try {
      const cts = new vscode.CancellationTokenSource();
      const req = await model.sendRequest(
        [vscode.LanguageModelChatMessage.User(prompt)],
        {},
        cts.token
      );
      for await (const chunk of req.text) {
        output.append(chunk);
      }
      output.appendLine('\n\n=== End of AI Summary ===');
    } catch (err: any) {
      output.appendLine(`\nError: ${err.message}`);
    }
  }

  /**
   * AI-4: Investigate a pipeline failure — fetches logs and returns root cause + fix.
   * Streams the analysis into an Output Channel.
   */
  async investigateFailure(event: TrackedEvent, client: GitHubClient): Promise<void> {
    const model = await this.getModel();
    if (!model) {
      vscode.window.showWarningMessage('GH Tracker: Copilot is not available.');
      return;
    }

    const output = vscode.window.createOutputChannel('GH Tracker — Failure Investigation');
    output.show(true);
    output.appendLine(`=== Failure Investigation: ${event.title} ===\n`);

    // Get workflow run ID from event payload
    const payload = event.payload as any;
    const run = payload?.workflow_run;
    const runId = run?.id;

    // Fetch log text
    let logTail = '';
    if (runId && client) {
      output.appendLine('Fetching workflow logs...\n');
      logTail = await client.getWorkflowRunLogText(event.repo, runId);
    }

    // If no logs from API, try from event payload
    if (!logTail) {
      output.appendLine('(No log data available from API)\n');
      const promptFallback = `A CI/CD pipeline failed. Based on the event information, suggest what might have gone wrong.

Event: ${event.type}
Repo: ${event.repo}
Title: ${event.title}
Workflow: ${run?.name ?? 'unknown'}
Branch: ${run?.head_branch ?? 'unknown'}

Provide:
- Likely root cause
- How to investigate further
- Possible fixes`;
      try {
        const cts = new vscode.CancellationTokenSource();
        const req = await model.sendRequest(
          [vscode.LanguageModelChatMessage.User(promptFallback)],
          {},
          cts.token
        );
        for await (const chunk of req.text) {
          output.append(chunk);
        }
      } catch { }
      output.appendLine('\n\n=== End of Investigation ===');
      return;
    }

    output.appendLine(`Log tail (last lines):\n${logTail.slice(-500)}\n`);

    const prompt = `A CI/CD pipeline failed. Analyze these log lines and provide:

1. ROOT CAUSE: What specifically caused the failure (one sentence)
2. IMPACT: What services/functionality is affected
3. FIX: Step-by-step to resolve the issue
4. PREVENTION: How to avoid this in the future

Format with clear headers. Be specific — reference actual error messages from the logs.

Log tail:
${logTail.slice(-2000)}`;

    try {
      const cts = new vscode.CancellationTokenSource();
      const req = await model.sendRequest(
        [vscode.LanguageModelChatMessage.User(prompt)],
        {},
        cts.token
      );
      for await (const chunk of req.text) {
        output.append(chunk);
      }
      output.appendLine('\n\n=== End of Investigation ===');
    } catch (err: any) {
      output.appendLine(`\nError: ${err.message}`);
    }
  }

  /**
   * AI-5: Semantic event search — keyword filter then AI reranking.
   * Returns scored results sorted by relevance.
   */
  async searchEvents(query: string, allEvents: TrackedEvent[]): Promise<Array<{ event: TrackedEvent; relevance: string }>> {
    if (!query.trim()) {
      return allEvents.slice(0, 20).map(e => ({ event: e, relevance: 'Recent event' }));
    }

    const q = query.toLowerCase();

    // Step 1: Quick keyword filter
    const candidates = allEvents.filter(e =>
      e.title.toLowerCase().includes(q) ||
      e.repo.toLowerCase().includes(q) ||
      e.actor.toLowerCase().includes(q) ||
      e.type.toLowerCase().includes(q) ||
      e.id === q
    );

    // If no keyword match, take most recent 20 for AI processing
    const toScore = candidates.length > 0 ? candidates : allEvents.slice(0, 20);

    if (toScore.length === 0) return [];

    // Step 2: AI scoring for relevance
    const model = await this.getModel();
    if (!model) {
      // Without AI, return keyword-matched results sorted by recency
      return toScore.slice(0, 20).map(e => ({ event: e, relevance: 'Keyword match' }));
    }

    // Score in batches to avoid token limits
    const BATCH_SIZE = 5;
    const results: Array<{ event: TrackedEvent; relevance: string }> = [];

    for (let i = 0; i < Math.min(toScore.length, 20); i += BATCH_SIZE) {
      const batch = toScore.slice(i, i + BATCH_SIZE);
      const eventsJson = batch.map((e, idx) =>
        `[${idx}] Type: ${e.type} | Repo: ${e.repo} | Actor: ${e.actor} | Title: ${e.title}`
      ).join('\n');

      const prompt = `Given the search query: "${query}"

Rate each event's relevance from 0 (completely irrelevant) to 10 (exactly what the user is looking for).
Respond with ONLY a JSON array of objects: [{"index": 0, "score": 5, "reason": "concise reason"}, ...]

Events:
${eventsJson}`;

      try {
        const cts = new vscode.CancellationTokenSource();
        const req = await model.sendRequest(
          [vscode.LanguageModelChatMessage.User(prompt)],
          {},
          cts.token
        );
        let result = '';
        for await (const chunk of req.text) { result += chunk; }

        // Parse AI response
        const jsonMatch = result.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          const scores = JSON.parse(jsonMatch[0]);
          for (const s of scores) {
            if (s.score >= 3 && batch[s.index]) {
              results.push({ event: batch[s.index], relevance: s.reason });
            }
          }
        }
      } catch {
        // Fallback: include all batch events
        for (const e of batch) {
          results.push({ event: e, relevance: 'Potential match' });
        }
      }
    }

    return results.slice(0, 20);
  }

  /**
   * AI-6: Generate a daily summary of all today's events.
   * Returns the summary text.
   */
  async generateDailySummary(events: TrackedEvent[], userPrompt: string): Promise<string> {
    const model = await this.getModel();
    if (!model) {
      return 'AI features require GitHub Copilot to be installed and signed in.';
    }

    // Group events by repo
    const byRepo = new Map<string, TrackedEvent[]>();
    for (const e of events) {
      const list = byRepo.get(e.repo) ?? [];
      list.push(e);
      byRepo.set(e.repo, list);
    }

    let eventsText = '';
    for (const [repo, repoEvents] of byRepo) {
      eventsText += `\n## ${repo}\n`;
      for (const e of repoEvents) {
        eventsText += `- [${e.type}] ${e.actor}: ${e.title} (${new Date(e.createdAt).toLocaleTimeString()})\n`;
      }
    }

    const systemPrompt = `You are a developer productivity assistant. Summarize today's GitHub activity.
Provide a concise overview organized by repository. Highlight:
- PRs opened/merged and their significance
- Pipeline failures that need attention
- New releases
- Who was most active
- Any notable patterns or concerns

Keep it under 400 words. Use plain text with clear sections.`;

    const finalPrompt = userPrompt
      ? `${systemPrompt}\n\nUser's additional request: ${userPrompt}\n\nToday's events:\n${eventsText}`
      : `${systemPrompt}\n\nToday's events:\n${eventsText}`;

    try {
      const cts = new vscode.CancellationTokenSource();
      const req = await model.sendRequest(
        [vscode.LanguageModelChatMessage.User(finalPrompt)],
        {},
        cts.token
      );
      let result = '';
      for await (const chunk of req.text) { result += chunk; }
      return result.trim() || 'No summary generated.';
    } catch {
      return 'Failed to generate summary. Copilot may be unavailable.';
    }
  }
}
