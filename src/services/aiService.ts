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

  /** Read aiLanguage setting and return an inline instruction for the model. */
  private lang(): string {
    const cfg = vscode.workspace.getConfiguration('ghTracker');
    const lang = cfg.get<'vi' | 'en'>('aiLanguage', 'vi');
    return lang === 'en'
      ? 'Write your response in English.'
      : 'Vi\u1EBFt ph\u1EA3n h\u1ED3i b\u1EB1ng ti\u1EBFng Vi\u1EC7t.';
  }

  // ── AI-1: PR review ────────────────────────────────────────────────────

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

    let contextParts: string[] = [];

    const prMatch = event.url.match(/\/pull\/(\d+)/);
    const prNumber = prMatch ? parseInt(prMatch[1], 10) : null;

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
      'Be specific. Reference exact filenames and line patterns. Skip style nitpicks. Focus on what matters.\n\n' +
      this.lang();

    try {
      const cts = new vscode.CancellationTokenSource();
      const req = await model.sendRequest(
        [vscode.LanguageModelChatMessage.User(prompt)],
        {},
        cts.token
      );
      output.appendLine('\u2500'.repeat(60));
      for await (const chunk of req.text) {
        output.append(chunk);
      }
      output.appendLine('\n\n=== End of AI Review ===');
    } catch (err: any) {
      output.appendLine('\nError: ' + err.message);
    }
  }

  // ── AI-2: Notification scoring ─────────────────────────────────────────

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

  // ── AI-3: Summarize an event (output channel) ──────────────────────────

  async summarizeEvent(event: TrackedEvent, client: GitHubClient): Promise<void> {
    const model = await this.getModel();
    if (!model) {
      vscode.window.showWarningMessage('GH Tracker: Copilot is not available.');
      return;
    }

    const output = vscode.window.createOutputChannel('GH Tracker — AI Summary');
    output.show(true);
    output.appendLine('=== AI Summary: ' + event.title + ' ===\n');

    let contextText = 'Event: ' + event.type + '\nRepo: ' + event.repo + '\nActor: ' + event.actor + '\nTime: ' + event.createdAt + '\n';

    if (event.type.startsWith('pr_')) {
      const prMatch = event.url.match(/\/pull\/(\d+)/);
      if (prMatch && client) {
        try {
          const prNum = parseInt(prMatch[1], 10);
          const details = await client.getPRDetails(event.repo, prNum);
          contextText += '\nPR #' + prNum + ': ' + details.title + '\nState: ' + details.state + '\nMerged: ' + details.merged + '\nDescription: ' + details.body.slice(0, 1000) + '\n';
          contextText += 'Files changed: ' + details.changedFiles + ' (+' + details.additions + '/-' + details.deletions + ')\n';
          contextText += 'Commits:\n' + details.commits.map(c => '  ' + c.sha + ' ' + c.message + ' (' + c.author + ')').join('\n') + '\n';
        } catch { }
      }
    } else if (event.type === 'push') {
      const payload = event.payload as any;
      const branch = (payload?.ref as string)?.replace('refs/heads/', '') ?? 'unknown';
      contextText += '\nBranch: ' + branch + '\n';
      if (payload?.commits) {
        contextText += 'Commits:\n' + (payload.commits as any[]).map((c: any) => '  ' + (c.sha?.slice(0, 7) ?? '') + ' ' + (c.message?.split('\n')[0] ?? '') + ' (' + (c.author?.name ?? '') + ')').join('\n') + '\n';
      }
      if (client && payload?.ref) {
        try {
          const commits = await client.getPushCommitDetails(event.repo, payload.ref);
          if (commits.length > 0) {
            contextText += '\nAdditional commits from API:\n' + commits.map(c => '  ' + c.sha + ' ' + c.message + ' (' + c.author + ')').join('\n') + '\n';
          }
        } catch { }
      }
    } else if (event.type === 'workflow_failed' || event.type === 'workflow_passed') {
      const payload = event.payload as any;
      const run = payload?.workflow_run;
      if (run) {
        contextText += '\nWorkflow: ' + (run.name ?? 'unknown') + '\nBranch: ' + (run.head_branch ?? '') + '\nStatus: ' + run.status + '\nConclusion: ' + run.conclusion + '\n';
        contextText += 'Trigger event: ' + (run.event ?? '') + '\n';
      }
    } else if (event.type === 'release_published') {
      const payload = event.payload as any;
      const release = payload?.release;
      if (release) {
        contextText += '\nRelease: ' + (release.tag_name ?? '') + '\nName: ' + (release.name ?? '') + '\n';
        contextText += 'Body: ' + (release.body ?? '').slice(0, 1000) + '\n';
      }
    }

    const prompt = 'You are a developer notification assistant. Provide a DETAILED summary of this GitHub event.\n\n' +
      'Cover:\n' +
      '1. WHAT: What exactly happened (PR merged, branch created, pipeline failed, etc.)\n' +
      '2. DETAILS: Key specifics \u2014 PR number, branch name, files changed, commit messages\n' +
      '3. CONTEXT: Why this matters \u2014 is it a feature? Bug fix? Release? CI failure?\n' +
      '4. IMPACT: Who or what is affected\n\n' +
      'Be thorough but well-organized. Use plain text with clear sections. Avoid fluff.\n\n' +
      this.lang() + '\n\nEvent data:\n\n' + contextText;

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
      output.appendLine('\nError: ' + err.message);
    }
  }

  // ── AI-4: Investigate pipeline failure ─────────────────────────────────

  async investigateFailure(event: TrackedEvent, client: GitHubClient): Promise<void> {
    const model = await this.getModel();
    if (!model) {
      vscode.window.showWarningMessage('GH Tracker: Copilot is not available.');
      return;
    }

    const output = vscode.window.createOutputChannel('GH Tracker \u2014 Failure Investigation');
    output.show(true);
    output.appendLine('=== Failure Investigation: ' + event.title + ' ===\n');

    const payload = event.payload as any;
    const run = payload?.workflow_run;
    const runId = run?.id;

    let logTail = '';
    if (runId && client) {
      output.appendLine('Fetching workflow logs...\n');
      logTail = await client.getWorkflowRunLogText(event.repo, runId);
    }

    if (!logTail) {
      output.appendLine('(No log data available from API)\n');
      const promptFallback = 'A CI/CD pipeline failed. Based on the event information, suggest what might have gone wrong.\n\n' +
        'Event: ' + event.type + '\nRepo: ' + event.repo + '\nTitle: ' + event.title + '\nWorkflow: ' + (run?.name ?? 'unknown') + '\nBranch: ' + (run?.head_branch ?? 'unknown') + '\n\n' +
        'Provide:\n- Likely root cause\n- How to investigate further\n- Possible fixes\n\n' + this.lang();
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

    output.appendLine('Log tail (last lines):\n' + logTail.slice(-500) + '\n');

    const prompt = 'A CI/CD pipeline failed. Analyze these log lines and provide:\n\n' +
      '1. ROOT CAUSE: What specifically caused the failure (one sentence)\n' +
      '2. IMPACT: What services/functionality is affected\n' +
      '3. FIX: Step-by-step to resolve the issue\n' +
      '4. PREVENTION: How to avoid this in the future\n\n' +
      'Format with clear headers. Be specific \u2014 reference actual error messages from the logs.\n\n' +
      this.lang() + '\n\nLog tail:\n' + logTail.slice(-2000);

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
      output.appendLine('\nError: ' + err.message);
    }
  }

  // ── AI-5: Semantic event search ────────────────────────────────────────

  async searchEvents(query: string, allEvents: TrackedEvent[]): Promise<Array<{ event: TrackedEvent; relevance: string }>> {
    if (!query.trim()) {
      return allEvents.slice(0, 20).map(e => ({ event: e, relevance: 'Recent event' }));
    }

    const q = query.toLowerCase();

    const candidates = allEvents.filter(e =>
      e.title.toLowerCase().includes(q) ||
      e.repo.toLowerCase().includes(q) ||
      e.actor.toLowerCase().includes(q) ||
      e.type.toLowerCase().includes(q) ||
      e.id === q
    );

    const toScore = candidates.length > 0 ? candidates : allEvents.slice(0, 20);

    if (toScore.length === 0) return [];

    const model = await this.getModel();
    if (!model) {
      return toScore.slice(0, 20).map(e => ({ event: e, relevance: 'Keyword match' }));
    }

    const BATCH_SIZE = 5;
    const results: Array<{ event: TrackedEvent; relevance: string }> = [];

    for (let i = 0; i < Math.min(toScore.length, 20); i += BATCH_SIZE) {
      const batch = toScore.slice(i, i + BATCH_SIZE);
      const eventsJson = batch.map((e, idx) =>
        '[' + idx + '] Type: ' + e.type + ' | Repo: ' + e.repo + ' | Actor: ' + e.actor + ' | Title: ' + e.title
      ).join('\n');

      const prompt = 'Given the search query: "' + query + '"\n\n' +
        'Rate each event\'s relevance from 0 (completely irrelevant) to 10 (exactly what the user is looking for).\n' +
        'Respond with ONLY a JSON array of objects: [{"index": 0, "score": 5, "reason": "concise reason"}, ...]\n' +
        'Write the "reason" text in the configured language.\n' + this.lang() + '\n\nEvents:\n' + eventsJson;

      try {
        const cts = new vscode.CancellationTokenSource();
        const req = await model.sendRequest(
          [vscode.LanguageModelChatMessage.User(prompt)],
          {},
          cts.token
        );
        let result = '';
        for await (const chunk of req.text) { result += chunk; }

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
        for (const e of batch) {
          results.push({ event: e, relevance: 'Potential match' });
        }
      }
    }

    return results.slice(0, 20);
  }

  // ── AI-6: Daily summary (legacy — returns single text) ─────────────────

  async generateDailySummary(events: TrackedEvent[], userPrompt: string): Promise<string> {
    const model = await this.getModel();
    if (!model) {
      return 'AI features require GitHub Copilot to be installed and signed in.';
    }

    const byRepo = new Map<string, TrackedEvent[]>();
    for (const e of events) {
      const list = byRepo.get(e.repo) ?? [];
      list.push(e);
      byRepo.set(e.repo, list);
    }

    let eventsText = '';
    for (const [repo, repoEvents] of byRepo) {
      eventsText += '\n## ' + repo + '\n';
      for (const e of repoEvents) {
        eventsText += '- [' + e.type + '] ' + e.actor + ': ' + e.title + ' (' + new Date(e.createdAt).toLocaleTimeString() + ')\n';
      }
    }

    const systemPrompt = 'You are a developer productivity assistant. Summarize today\'s GitHub activity.\n' +
      'Provide a concise overview organized by repository. Highlight:\n' +
      '- PRs opened/merged and their significance\n' +
      '- Pipeline failures that need attention\n' +
      '- New releases\n' +
      '- Who was most active\n' +
      '- Any notable patterns or concerns\n\n' +
      this.lang() + '\n\n' +
      'Keep it under 400 words. Use plain text with clear sections.';

    const finalPrompt = userPrompt
      ? systemPrompt + '\n\nUser\'s additional request: ' + userPrompt + '\n\nToday\'s events:\n' + eventsText
      : systemPrompt + '\n\nToday\'s events:\n' + eventsText;

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

  // ── AI-7: Per-PR full-context summary (returns text for a single PR) ───

  /**
   * Fetch full PR context (title, description, commits, diff, files)
   * from the GitHub API and generate an AI summary for this one PR.
   * Used by the Today Summary tree view for per-PR breakdown.
   */
  async generatePRSummary(
    event: TrackedEvent,
    client: GitHubClient,
    userPrompt: string
  ): Promise<{ summary: string; headBranch: string; baseBranch: string }> {
    const model = await this.getModel();
    if (!model) {
      return {
        summary: 'AI không kh\u1EA3 d\u1EE5ng (Copilot ch\u01B0a \u0111\u01B0\u1EE3c cài \u0111\u1EB7t ho\u1EB7c \u0111\u0103ng nh\u1EADp).',
        headBranch: '',
        baseBranch: '',
      };
    }

    // Extract PR number from the event URL
    const prMatch = event.url.match(/\/pull\/(\d+)/);
    const prNumber = prMatch ? parseInt(prMatch[1], 10) : null;
    if (!prNumber) {
      return {
        summary: 'Không th\u1EC3 xác \u0111\u1ECBnh s\u1ED1 PR t\u1EEB s\u1EF1 ki\u1EC7n.',
        headBranch: '',
        baseBranch: '',
      };
    }

    // Gather full context
    let contextParts: string[] = [];
    let headBranch = '';
    let baseBranch = '';

    try {
      const details = await client.getPRDetails(event.repo, prNumber);
      headBranch = details.headline;
      baseBranch = details.baseBranch;
      contextParts.push('## Pull Request Information');
      contextParts.push('Title: ' + details.title);
      contextParts.push('Description: ' + (details.body || '(none)'));
      contextParts.push('State: ' + details.state + ' | Merged: ' + details.merged);
      contextParts.push('Head branch: ' + headBranch + ' | Base branch: ' + baseBranch);
      contextParts.push('Files changed: ' + details.changedFiles + ' (+' + details.additions + '/-' + details.deletions + ')');

      if (details.commits.length > 0) {
        contextParts.push('\n## Commits');
        for (const c of details.commits) {
          contextParts.push('  ' + c.sha + ' ' + c.message + ' (' + c.author + ')');
        }
      }
    } catch {}
    
    // Fetch diff
    try {
      const files = await client.getPRFiles(event.repo, prNumber);
      if (files.length > 0) {
        contextParts.push('\n## Files Changed & Diff');
        for (const f of files.slice(0, 10)) {
          const stats = (f.additions != null) ? ' (+' + f.additions + '/-' + f.deletions + ')' : '';
          contextParts.push('  ' + (f.status || 'modified') + ' ' + f.filename + stats);
        }
        let diffText = '';
        for (const f of files.slice(0, 5)) {
          const patch = f.patch || '';
          diffText += '\n--- ' + f.filename + ' ---\n' + patch.slice(0, 800);
        }
        if (diffText) {
          contextParts.push('\n### Diff Content\n' + diffText.slice(0, 6000));
        }
      }
    } catch {}

    const fullContext = contextParts.join('\n');

    const prompt = 'B\u1EA1n l\u00E0 tr\u1EE3 l\u00FD ph\u00E1t tri\u1EC3n ph\u1EA7n m\u1EC1m. H\u00E3y ph\u00E2n t\u00EDch Pull Request n\u00E0y m\u1ED9t c\u00E1ch chi ti\u1EBFt.\n\n' +
      fullContext + '\n\n' +
      'H\u00E3y cung c\u1EA5p:\n' +
      '1. T\u1ED4NG QUAN: PR n\u00E0y l\u00E0m g\u00EC? T\u00F3m t\u1EAFt ng\u1EAFn g\u1ECDn.\n' +
      '2. THAY \u0110\u1ED4I CH\u00CDNH: Nh\u1EEFng file n\u00E0o \u0111\u01B0\u1EE3c thay \u0111\u1ED5i v\u00E0 m\u1EE5c \u0111\u00EDch.\n' +
      '3. \u0110\u00C1NH GI\u00C1: Ch\u1EA5t l\u01B0\u1EE3ng code, v\u1EA5n \u0111\u1EC1 b\u1EA3o m\u1EADt, hi\u1EC7u n\u0103ng n\u1EBFu c\u00F3.\n' +
      '4. T\u00C1C \u0110\u1ED8NG: PR n\u00E0y \u1EA3nh h\u01B0\u1EDFng \u0111\u1EBFn ai\/h\u1EC7 th\u1ED1ng n\u00E0o.\n\n' +
      this.lang() + '\n\n' +
      (userPrompt ? 'Y\u00EAu c\u1EA7u b\u1ED5 sung: ' + userPrompt + '\n\n' : '');

    try {
      const cts = new vscode.CancellationTokenSource();
      const req = await model.sendRequest(
        [vscode.LanguageModelChatMessage.User(prompt)],
        {},
        cts.token
      );
      let result = '';
      for await (const chunk of req.text) { result += chunk; }
      return { summary: result.trim() || '(không có nội dung tóm tắt)', headBranch, baseBranch };
    } catch (err: any) {
      return { summary: 'Lỗi khi tạo tóm tắt: ' + err.message, headBranch, baseBranch };
    }
  }
}
