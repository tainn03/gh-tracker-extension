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
