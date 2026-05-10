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

  // ── AI-1: Notification scoring ─────────────────────────────────────────

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

  // ── AI-2: Summarize an event (output channel) ──────────────────────────

  async summarizeEvent(event: TrackedEvent, client: GitHubClient): Promise<void> {
    const model = await this.getModel();
    if (!model) {
      vscode.window.showWarningMessage('GH Tracker: Copilot is not available.');
      return;
    }

    const output = vscode.window.createOutputChannel('GH Tracker — AI Summary');
    output.show(true);
    output.appendLine('=== AI Summary: ' + event.title + ' ===\n');

    // Build context: prefer pre-enriched rawData, fall back to live API calls
    let contextText = 'Event: ' + event.type + '\nRepo: ' + event.repo + '\nActor: ' + event.actor + '\nTime: ' + event.createdAt + '\n';

    let rawData: any = null;
    try {
      rawData = event.rawData ? JSON.parse(event.rawData) : null;
    } catch {
      // Malformed rawData — ignore and fall through to live API
    }

    if (rawData) {
      // ── Use pre-fetched raw data ──────────────────────────────────────
      if (rawData.prTitle) {
        contextText += '\nPR #' + (event.url.match(/\/pull\/(\d+)/)?.[1] ?? '') + ': ' + rawData.prTitle + '\n';
        if (rawData.prBody) contextText += 'Description: ' + rawData.prBody.slice(0, 1000) + '\n';
        contextText += 'State: ' + (rawData.prState ?? 'unknown') + ' | Merged: ' + rawData.prMerged + '\n';
        contextText += 'Branch: ' + (rawData.prHeadBranch ?? '?') + ' → ' + (rawData.prBaseBranch ?? '?') + '\n';
        contextText += 'Files changed: ' + (rawData.prChangedFiles ?? 0) + ' (+' + (rawData.prAdditions ?? 0) + '/-' + (rawData.prDeletions ?? 0) + ')\n';
        if (rawData.prCommits?.length) {
          contextText += 'Commits:\n' + rawData.prCommits.map((c: any) => '  ' + c.sha + ' ' + c.message + ' (' + c.author + ')').join('\n') + '\n';
        }
        if (rawData.prFiles?.length) {
          contextText += '\nFiles changed:\n';
          for (const f of rawData.prFiles) {
            contextText += '  ' + f.status + ' ' + f.filename + (f.additions != null ? ' (+' + f.additions + '/-' + f.deletions + ')' : '') + '\n';
            if (f.patch) contextText += f.patch.slice(0, 800) + '\n';
          }
        }
        if (rawData.commentBody) {
          contextText += '\nComment: ' + rawData.commentBody + '\n';
          if (rawData.commentPath) contextText += 'Comment on file: ' + rawData.commentPath + '\n';
        }
      }

      if (rawData.pushDiff) {
        const payload = event.payload as any;
        const branch = (payload?.ref as string)?.replace('refs/heads/', '') ?? 'unknown';
        contextText += '\nBranch: ' + branch + '\n';
        if (rawData.pushCommits?.length) {
          contextText += 'Commits:\n' + rawData.pushCommits.map((c: any) => '  ' + c.sha + ' ' + c.message + ' (' + c.author + ')').join('\n') + '\n';
        }
        contextText += '\nFull diff:\n' + rawData.pushDiff.slice(0, 8000) + '\n';
      }

      if (rawData.workflowName) {
        contextText += '\nWorkflow: ' + rawData.workflowName + '\nBranch: ' + (rawData.workflowBranch ?? '') + '\nConclusion: ' + (rawData.workflowConclusion ?? '') + '\nTrigger: ' + (rawData.workflowTriggerEvent ?? '') + '\n';
      }
      if (rawData.workflowLogs) {
        contextText += 'Logs:\n' + rawData.workflowLogs.slice(-3000) + '\n';
      }

      if (rawData.issueTitle) {
        contextText += '\nIssue #' + (rawData.issueNumber ?? '') + ': ' + rawData.issueTitle + ' (' + (rawData.issueState ?? '') + ')\n';
      }
      if (rawData.issueBody) {
        contextText += 'Issue body:\n' + rawData.issueBody.slice(0, 2000) + '\n';
      }
      if (rawData.commentBody && !rawData.prTitle) {
        contextText += 'Comment: ' + rawData.commentBody + '\n';
      }
      if (rawData.releaseBody) {
        contextText += '\nRelease notes:\n' + rawData.releaseBody.slice(0, 2000) + '\n';
      }
    } else {
      // ── Fall back: fetch data live ────────────────────────────────────
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
        if (event.diff) {
          contextText += '\nFull diff:\n' + event.diff.slice(0, 8000) + '\n';
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
    }

    const prompt = 'You are a developer notification assistant. Provide a DETAILED summary of this GitHub event.\n\n' +
      'Cover:\n' +
      '1. WHAT: What exactly happened (PR merged, branch created, pipeline failed, etc.)\n' +
      '2. DETAILS: Key specifics, display as bullet points\n' +
      '3. CONTEXT: Why this matters — is it a feature? Bug fix? Release? CI failure?\n' +
      '4. IMPACT: Who or what is affected\n\n' +
      'Be thorough but well-organized. Use plain text with clear sections. Avoid fluff.\n\n' +
      'Write your response in English.\n\nEvent data:\n\n' + contextText;

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

  // ── AI-3: Investigate pipeline failure ─────────────────────────────────

  async investigateFailure(event: TrackedEvent, client: GitHubClient): Promise<void> {
    const model = await this.getModel();
    if (!model) {
      vscode.window.showWarningMessage('GH Tracker: Copilot is not available.');
      return;
    }

    const output = vscode.window.createOutputChannel('GH Tracker — Failure Investigation');
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
        'Provide:\n- Likely root cause\n- How to investigate further\n- Possible fixes\n\nWrite your response in English.';
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

    const logLines = logTail.split('\n');

    output.appendLine('Log tail:\n' + logLines + '\n');

    const prompt = 'A CI/CD pipeline failed. Analyze these log lines and provide:\n\n' +
      '1. ROOT CAUSE: What specifically caused the failure (one sentence)\n' +
      '2. IMPACT: What services/functionality is affected\n' +
      '3. FIX: Step-by-step to resolve the issue\n' +
      '4. PREVENTION: How to avoid this in the future\n\n' +
      'Focus on the FIRST error or non-zero exit code in the logs — ignore informational footnotes (deprecation warnings, runner cleanup).\n\n' +
      'Format with clear headers. Be specific — reference actual error messages from the logs.\n\n' +
      'Write your response in English.\n\nLog tail:\n' + logLines;

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

  // ── AI-4: Semantic event search ────────────────────────────────────────

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
        'Write the "reason" text in English.\n\nEvents:\n' + eventsJson;

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

  // ── AI-5: PR review (for review_requested events) ─────────────────────

  async reviewPR(event: TrackedEvent, client: GitHubClient): Promise<void> {
    const model = await this.getModel();
    if (!model) {
      vscode.window.showWarningMessage('GH Tracker: Copilot is not available.');
      return;
    }

    const prMatch = event.url.match(/\/pull\/(\d+)/);
    const prNumber = prMatch ? parseInt(prMatch[1], 10) : null;
    if (!prNumber) {
      vscode.window.showWarningMessage('GH Tracker: Cannot determine PR number from this event.');
      return;
    }

    const output = vscode.window.createOutputChannel('GH Tracker — AI Review');
    output.show(true);
    output.appendLine('=== AI Pull Request Review ===\n');
    output.appendLine('PR #' + prNumber + ' | ' + event.repo + ' | Requested by ' + event.actor + '\n');

    // Gather full PR context
    let contextParts: string[] = [];

    try {
      const details = await client.getPRDetails(event.repo, prNumber);
      contextParts.push('## Pull Request Information');
      contextParts.push('Title: ' + details.title);
      contextParts.push('Description: ' + (details.body || '(none)'));
      contextParts.push('State: ' + details.state + ' | Merged: ' + details.merged);
      contextParts.push('Branch: ' + details.headline + ' → ' + details.baseBranch);
      contextParts.push('Files changed: ' + details.changedFiles + ' (+' + details.additions + '/-' + details.deletions + ')');
      if (details.commits.length > 0) {
        contextParts.push('\n## Commits');
        for (const c of details.commits) {
          contextParts.push('  ' + c.sha + ' ' + c.message + ' (' + c.author + ')');
        }
      }
    } catch (err: any) {
      contextParts.push('(Failed to fetch PR details: ' + err.message + ')');
    }

    // Fetch diff files
    try {
      const files = await client.getPRFiles(event.repo, prNumber);
      if (files.length > 0) {
        contextParts.push('\n## Files Changed & Diff');
        for (const f of files.slice(0, 15)) {
          const stats = (f.additions != null) ? ' (+' + f.additions + '/-' + f.deletions + ')' : '';
          contextParts.push('  ' + (f.status || 'modified') + ' ' + f.filename + stats);
        }
        let diffText = '';
        for (const f of files.slice(0, 8)) {
          const patch = f.patch || '';
          diffText += '\n--- ' + f.filename + ' ---\n' + patch.slice(0, 1200);
        }
        if (diffText) {
          contextParts.push('\n### Diff Content\n' + diffText.slice(0, 12000));
        }
      }
    } catch { /* diff optional */ }

    // Fetch issue/PR comments
    try {
      const comments = await client.getPRIssueComments(event.repo, prNumber);
      if (comments.length > 0) {
        contextParts.push('\n## PR Comments');
        for (const c of comments.slice(0, 10)) {
          contextParts.push('  ' + c.author + ' (' + new Date(c.createdAt).toLocaleDateString() + '): ' + c.body.slice(0, 300));
        }
      }
    } catch { /* comments optional */ }

    // Fetch review comments
    try {
      const reviewComments = await client.getPRReviewComments(event.repo, prNumber);
      if (reviewComments.length > 0) {
        contextParts.push('\n## Review Comments (inline)');
        for (const c of reviewComments.slice(0, 10)) {
          contextParts.push('  ' + c.author + ' on ' + c.path + ': ' + c.body.slice(0, 300));
        }
      }
    } catch { /* review comments optional */ }

    // Fetch PR reviews
    try {
      const reviews = await client.getPRReviews(event.repo, prNumber);
      if (reviews.length > 0) {
        contextParts.push('\n## PR Reviews');
        for (const r of reviews.slice(0, 10)) {
          contextParts.push('  ' + r.author + ' [' + r.state + '] ' + (r.body ? ': ' + r.body.slice(0, 300) : ''));
        }
      }
    } catch { /* reviews optional */ }

    const fullContext = contextParts.join('\n');

    const prompt = 'You are a senior software engineer conducting a thorough code review.\n\n' +
      fullContext + '\n\n' +
      'Based on the PR information above, provide a comprehensive code review:\n\n' +
      '## OVERVIEW\nWhat does this PR do? Summarize the changes in 2-3 sentences.\n\n' +
      '## CODE QUALITY\n- Any logic errors, bugs, or edge cases missed?\n- Error handling gaps?\n- Code clarity and maintainability issues?\n\n' +
      '## SECURITY\n- Any injection risks, auth issues, or data exposure?\n- Unsafe operations?\n\n' +
      '## PERFORMANCE\n- Inefficient queries, large payloads, unnecessary allocations?\n\n' +
      '## SPECIFIC FEEDBACK\n- For each key file changed, call out specific lines or patterns.\n- Reference comments/reviews from other reviewers and whether you agree.\n\n' +
      '## RECOMMENDATION\n- APPROVE / REQUEST CHANGES / COMMENT with brief justification.\n\n' +
      'Be specific and actionable. Reference exact filenames and patterns. Skip style nitpicks.\n\n' +
      'Write your response in English.\n\n---\nContext:\n' + fullContext;

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
}
