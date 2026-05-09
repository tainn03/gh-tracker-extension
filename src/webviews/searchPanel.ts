import * as vscode from 'vscode';
import type { AIService } from '../services/aiService';
import type { EventStore } from '../storage/eventStore';

export class SearchPanel {
  private static panel: vscode.WebviewPanel | undefined;

  static show(store: EventStore, aiService: AIService): void {
    if (SearchPanel.panel) {
      SearchPanel.panel.reveal();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'ghTrackerSearch',
      'GH Tracker — Event Search',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    SearchPanel.panel = panel;

    try {
      panel.webview.html = SearchPanel.getHtml();
      panel.reveal(vscode.ViewColumn.Active);
    } catch (err: any) {
      vscode.window.showErrorMessage(`GH Tracker: Failed to open Search panel — ${err.message}`);
      panel.dispose();
      SearchPanel.panel = undefined;
      return;
    }

    // Handle messages from the webview
    panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg.command === 'search') {
        const query = msg.query ?? '';
        panel.webview.postMessage({ command: 'searchStatus', text: 'Searching...' });

        try {
          const allEvents = store.getAllEvents();
          const results = await aiService.searchEvents(query, allEvents);
          panel.webview.postMessage({
            command: 'searchResults',
            results: results.map(r => ({
              id: r.event.id,
              title: r.event.title,
              repo: r.event.repo,
              type: r.event.type,
              actor: r.event.actor,
              time: new Date(r.event.createdAt).toLocaleString(),
              url: r.event.url,
              relevance: r.relevance,
            })),
          });
        } catch (err: any) {
          panel.webview.postMessage({ command: 'searchStatus', text: `Error: ${err.message}` });
        }
      }

      if (msg.command === 'openEvent') {
        const cfg = vscode.workspace.getConfiguration('ghTracker');
        const openIn = cfg.get<string>('openIn', 'vscode');
        if (openIn === 'external') {
          vscode.env.openExternal(vscode.Uri.parse(msg.url));
        } else {
          vscode.commands.executeCommand('simpleBrowser.show', msg.url);
        }
      }
    });

    panel.onDidDispose(() => { SearchPanel.panel = undefined; });
  }

  private static getHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>Event Search</title>
  <style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground);
           background: var(--vscode-editor-background); padding: 1rem; }
    .search-row { display: flex; gap: 6px; margin-bottom: 1rem; }
    input { flex: 1; padding: 6px 8px; background: var(--vscode-input-background);
            color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border);
            border-radius: 4px; font-size: 13px; }
    button { padding: 6px 16px; cursor: pointer; background: var(--vscode-button-background);
             color: var(--vscode-button-foreground); border: none; border-radius: 4px; font-size: 13px; }
    .status { font-size: 12px; color: var(--vscode-descriptionForeground); min-height: 18px; margin-bottom: 8px; }
    .result { padding: 8px; border-bottom: 1px solid var(--vscode-panel-border); cursor: pointer; }
    .result:hover { background: var(--vscode-list-hoverBackground); }
    .result-title { font-size: 13px; font-weight: 500; }
    .result-meta { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 2px; }
    .result-relevance { font-size: 11px; color: var(--vscode-testing-iconPassed); margin-top: 2px; }
    .empty { text-align: center; color: var(--vscode-descriptionForeground); margin-top: 2rem; font-size: 13px; }
    h1 { font-size: 16px; font-weight: 500; margin: 0 0 1rem 0; }
  </style>
</head>
<body>
  <h1>Event Search</h1>
  <p style="font-size:12px;color:var(--vscode-descriptionForeground);margin:0 0 1rem 0">
    Natural language search across all tracked GitHub events.
  </p>
  <div class="search-row">
    <input id="query" type="text" placeholder="e.g. PR reviews I need to handle, pipeline failures, releases" autofocus />
    <button id="searchBtn">Search</button>
  </div>
  <div class="status" id="status">Enter a query and press Enter or click Search.</div>
  <div id="results"></div>

  <script>
    (function() {
      var vscode = acquireVsCodeApi();

      function doSearch() {
        var query = document.getElementById('query').value.trim();
        if (!query) return;
        vscode.postMessage({ command: 'search', query: query });
      }

      function openEvent(url) {
        vscode.postMessage({ command: 'openEvent', url: url });
      }

      // Use event delegation for result clicks (safe, no inline onclick with quotes)
      document.addEventListener('DOMContentLoaded', function() {
        document.getElementById('searchBtn').addEventListener('click', doSearch);
        document.getElementById('query').addEventListener('keydown', function(e) {
          if (e.key === 'Enter') doSearch();
        });

        document.getElementById('results').addEventListener('click', function(e) {
          var target = e.target;
          // Walk up to find the result element
          while (target && !target.dataset.url) {
            target = target.parentElement;
          }
          if (target && target.dataset.url) {
            openEvent(target.dataset.url);
          }
        });
      });

      window.addEventListener('message', function(e) {
        var msg = e.data;
        var statusEl = document.getElementById('status');
        var resultsEl = document.getElementById('results');

        if (msg.command === 'searchStatus') {
          statusEl.textContent = msg.text;
        }

        if (msg.command === 'searchResults') {
          if (!msg.results || msg.results.length === 0) {
            statusEl.textContent = 'No matching events found. Try a different query.';
            resultsEl.innerHTML = '<div class="empty">No results</div>';
            return;
          }
          statusEl.textContent = msg.results.length + ' result(s) found';
          resultsEl.innerHTML = '';
          for (var i = 0; i < msg.results.length; i++) {
            var r = msg.results[i];
            var div = document.createElement('div');
            div.className = 'result';
            div.dataset.url = r.url;
            div.innerHTML =
              '<div class="result-title">' + escapeHtml(r.title) + '</div>' +
              '<div class="result-meta">' + escapeHtml(r.repo) + ' &middot; ' + escapeHtml(r.type) + ' &middot; ' + escapeHtml(r.actor) + ' &middot; ' + escapeHtml(r.time) + '</div>' +
              '<div class="result-relevance">' + escapeHtml(r.relevance) + '</div>';
            resultsEl.appendChild(div);
          }
        }
      });

      function escapeHtml(str) {
        if (!str) return '';
        return String(str)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      }
    })();
  </script>
</body>
</html>`;
  }
}
