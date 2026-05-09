import * as vscode from 'vscode';
import type { AIService } from '../services/aiService';
import type { EventStore } from '../storage/eventStore';

export class SummaryPanel {
  private static panel: vscode.WebviewPanel | undefined;

  static show(context: vscode.ExtensionContext, store: EventStore, aiService: AIService): void {
    if (SummaryPanel.panel) {
      SummaryPanel.panel.reveal();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'ghTrackerSummary',
      'GH Tracker — Today Summary',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    SummaryPanel.panel = panel;

    try {
      const cachedPrompt = context.workspaceState.get<string>('summaryPrompt', '');
      panel.webview.html = SummaryPanel.getHtml(cachedPrompt);
      panel.reveal(vscode.ViewColumn.Active);
    } catch (err: any) {
      vscode.window.showErrorMessage(`GH Tracker: Failed to open Summary panel — ${err.message}`);
      panel.dispose();
      SummaryPanel.panel = undefined;
      return;
    }

    // Handle messages from the webview
    panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg.command === 'generate') {
        const userPrompt = msg.prompt ?? '';
        await context.workspaceState.update('summaryPrompt', userPrompt);

        panel.webview.postMessage({ command: 'status', text: 'Generating summary with AI...' });

        try {
          const today = new Date();
          today.setHours(0, 0, 0, 0);
          const todayStr = today.toISOString();
          const allEvents = store.getAllEvents();
          const todayEvents = allEvents.filter(e => e.createdAt >= todayStr);

          if (todayEvents.length === 0) {
            panel.webview.postMessage({ command: 'result', text: 'No events recorded today yet.' });
            return;
          }

          const summary = await aiService.generateDailySummary(todayEvents, userPrompt);
          panel.webview.postMessage({ command: 'result', text: summary });
        } catch (err: any) {
          panel.webview.postMessage({ command: 'status', text: `Error: ${err.message}` });
        }
      }
    });

    panel.onDidDispose(() => { SummaryPanel.panel = undefined; });
  }

  private static getHtml(cachedPrompt: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>Today Summary</title>
  <style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground);
           background: var(--vscode-editor-background); padding: 1rem; }
    h1 { font-size: 16px; font-weight: 500; margin: 0 0 0.5rem 0; }
    p.sub { font-size: 12px; color: var(--vscode-descriptionForeground); margin: 0 0 1rem 0; }
    textarea { width: 100%; padding: 6px 8px; background: var(--vscode-input-background);
               color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border);
               border-radius: 4px; font-size: 13px; box-sizing: border-box; resize: vertical; }
    button { padding: 6px 16px; cursor: pointer; background: var(--vscode-button-background);
             color: var(--vscode-button-foreground); border: none; border-radius: 4px;
             font-size: 13px; margin-top: 8px; }
    button:disabled { opacity: 0.5; cursor: default; }
    .status { font-size: 12px; color: var(--vscode-descriptionForeground); margin-top: 8px; min-height: 18px; }
    .result { margin-top: 12px; padding: 12px; background: var(--vscode-textBlockQuote-background);
              border-left: 3px solid var(--vscode-textLink-foreground); white-space: pre-wrap;
              font-size: 13px; line-height: 1.5; display: none; }
    .result.visible { display: block; }
    label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px;
            color: var(--vscode-descriptionForeground); display: block; margin-top: 1rem; margin-bottom: 4px; }
  </style>
</head>
<body>
  <h1>Today Summary</h1>
  <p class="sub">AI-generated overview of today's GitHub activity across all tracked repositories.</p>

  <label for="prompt">Optional custom prompt (cached between sessions)</label>
  <textarea id="prompt" rows="3" placeholder="E.g. Focus on pipeline failures and PRs that need my review">${cachedPrompt}</textarea>

  <button id="generateBtn">Generate Summary</button>
  <div class="status" id="status"></div>
  <div class="result" id="result"></div>

  <script>
    (function() {
      var vscode = acquireVsCodeApi();

      document.addEventListener('DOMContentLoaded', function() {
        document.getElementById('generateBtn').addEventListener('click', generate);
      });

      function generate() {
        var btn = document.getElementById('generateBtn');
        btn.disabled = true;
        btn.textContent = 'Generating...';

        var prompt = document.getElementById('prompt').value.trim();
        var resultEl = document.getElementById('result');
        resultEl.classList.remove('visible');
        vscode.postMessage({ command: 'generate', prompt: prompt });
      }

      window.addEventListener('message', function(e) {
        var msg = e.data;
        var statusEl = document.getElementById('status');
        var btn = document.getElementById('generateBtn');

        if (msg.command === 'status') {
          statusEl.textContent = msg.text;
          if (msg.text.indexOf('Error') === 0 || msg.text === 'Generated') {
            btn.disabled = false;
            btn.textContent = 'Generate Summary';
          }
        }

        if (msg.command === 'result') {
          var el = document.getElementById('result');
          el.textContent = msg.text;
          el.classList.add('visible');
          statusEl.textContent = 'Generated';
          btn.disabled = false;
          btn.textContent = 'Generate Summary';
        }
      });
    })();
  </script>
</body>
</html>`;
  }
}
