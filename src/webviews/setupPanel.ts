import * as vscode from 'vscode';
import { ConfigService } from '../services/configService';
import { AuthService } from '../services/authService';
import type { GitHubClient } from '../services/githubClient';

export class SetupPanel {
  private static panel: vscode.WebviewPanel | undefined;
  private static normalizeHostUrl(hostUrl: string): string {
    return hostUrl.trim().replace(/\/$/, '');
  }

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
        const { hostUrl, repositories, aiEnabled, pollIntervalSeconds, openIn, authMethod } = msg.data;
        const normalizedHostUrl = SetupPanel.normalizeHostUrl(hostUrl ?? '');
        const safePollIntervalSeconds = Number.isFinite(pollIntervalSeconds) && pollIntervalSeconds >= 30
          ? pollIntervalSeconds
          : 30;

        try {
          new URL(normalizedHostUrl);
        } catch {
          vscode.window.showErrorMessage('GH Tracker: Host URL must be a valid absolute URL (e.g. https://github.com).');
          return;
        }

        // Persist each setting
        const globalTarget = vscode.ConfigurationTarget.Global;
        const c = vscode.workspace.getConfiguration(ConfigService.SECTION);
        await Promise.all([
          c.update('hostUrl',             normalizedHostUrl,   globalTarget),
          c.update('repositories',        repositories,        globalTarget),
          c.update('aiEnabled',           aiEnabled,           globalTarget),
          c.update('pollIntervalSeconds', safePollIntervalSeconds, globalTarget),
          c.update('openIn',              openIn,              globalTarget),
          c.update('authMethod',          authMethod,          globalTarget),
        ]);

        vscode.window.showInformationMessage('GH Tracker: Settings saved!');
        onSave();
        panel.dispose();
      }

      if (msg.command === 'testConnection') {
        try {
          const hostUrl = SetupPanel.normalizeHostUrl(msg.hostUrl ?? '');
          new URL(hostUrl);
          const token = await AuthService.getToken(context, hostUrl, msg.authMethod);
          if (!token) { throw new Error('No token'); }
          const client = clientFactory(token, hostUrl);
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

  <label for="authMethod">Authentication method</label>
  <select id="authMethod">
    <option value="oauth" ${cfg.authMethod === 'oauth' ? 'selected' : ''}>GitHub OAuth (built-in)</option>
    <option value="pat"   ${cfg.authMethod === 'pat'   ? 'selected' : ''}>Personal Access Token</option>
  </select>
  <p class="sub" style="margin-top:2px">OAuth uses VSCode's built-in GitHub login (GitHub.com + GitHub Enterprise). PAT requires a token with repo, read:org, and workflow scopes.</p>

  <button class="secondary" onclick="testConn()" style="margin-top:8px;padding:5px 12px">Test connection</button>
  <div class="status" id="connStatus"></div>

  <label for="repos">Repositories (one per line, org/repo format)</label>
  <textarea id="repos">${cfg.repositories.join('\n')}</textarea>

  <label for="pollInterval">Poll interval (seconds)</label>
  <input id="pollInterval" type="number" min="30" value="${cfg.pollIntervalSeconds}" />

  <label for="openIn">Open events in</label>
  <select id="openIn">
    <option value="vscode"   ${cfg.openIn === 'vscode'   ? 'selected' : ''}>VSCode Simple Browser</option>
    <option value="external" ${cfg.openIn === 'external' ? 'selected' : ''}>External Browser</option>
  </select>

  <div class="toggle-row">
    <input type="checkbox" id="aiEnabled" ${cfg.aiEnabled ? 'checked' : ''} style="width:auto">
    <label for="aiEnabled" style="margin:0">Enable AI features (requires GitHub Copilot)</label>
  </div>

  <button onclick="save()">Save &amp; Start Tracking</button>

  <script>
    const vscode = acquireVsCodeApi();
    const normalizeHostUrl = value => value.trim().replace(/\/$/, '');

    function save() {
      vscode.postMessage({
        command: 'save',
        data: {
          hostUrl:             normalizeHostUrl(document.getElementById('hostUrl').value),
          repositories:        document.getElementById('repos').value.split('\n').map(s => s.trim()).filter(Boolean),
          pollIntervalSeconds: parseInt(document.getElementById('pollInterval').value, 10),
          aiEnabled:           document.getElementById('aiEnabled').checked,
          openIn:              document.getElementById('openIn').value,
          authMethod:          document.getElementById('authMethod').value,
        }
      });
    }

    function testConn() {
      const hostUrl = normalizeHostUrl(document.getElementById('hostUrl').value);
      const authMethod = document.getElementById('authMethod').value;
      document.getElementById('connStatus').textContent = 'Testing\u2026';
      vscode.postMessage({ command: 'testConnection', hostUrl, authMethod });
    }

    window.addEventListener('message', e => {
      const msg = e.data;
      if (msg.command === 'connectionResult') {
        const el = document.getElementById('connStatus');
        if (msg.success) {
          el.className = 'status ok';
          el.textContent = '\u2713 Connected as @' + msg.user.login;
        } else {
          el.className = 'status err';
          el.textContent = '\u2717 ' + msg.error;
        }
      }
    });
  </script>
</body>
</html>`;
  }
}
