import * as vscode from 'vscode';
import { ConfigService } from './services/configService';
import { AuthService } from './services/authService';
import { GitHubClient } from './services/githubClient';
import { PollService } from './services/pollService';
import { NotifyService } from './services/notifyService';
import { AIService } from './services/aiService';
import { EventStore } from './storage/eventStore';
import { RepoTreeProvider } from './providers/repoTreeProvider';
import { EventTreeProvider } from './providers/eventTreeProvider';
import { SetupPanel } from './webviews/setupPanel';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  console.log('GH Tracker: activating');

  // ── 1. Initialize storage & services (wrapped in try-catch so a DB failure   ──
  //     doesn't prevent command registration — commands must survive partial
  //     activation to avoid "command not found" errors.                         ──
  let store: EventStore | undefined;
  let repoProvider: RepoTreeProvider | undefined;
  let eventProvider: EventTreeProvider | undefined;
  let aiService: AIService | undefined;
  let notifyService: NotifyService | undefined;
  let client: GitHubClient | undefined;

  try {
    store = new EventStore(context.globalStorageUri.fsPath);
    context.subscriptions.push({ dispose: () => store!.dispose() });

    aiService = new AIService();
    notifyService = new NotifyService();

    const cfg = ConfigService.get();
    repoProvider = new RepoTreeProvider(store, cfg.repositories);
    eventProvider = new EventTreeProvider(store, cfg.maxEventsShown);

    context.subscriptions.push(
      vscode.window.registerTreeDataProvider('ghTracker.repos', repoProvider),
      vscode.window.registerTreeDataProvider('ghTracker.events', eventProvider),
    );
  } catch (err) {
    console.error('GH Tracker: Failed to initialize storage/services:', err);
  }

  // ── 2. Status bar — notification level badge ─────────────────────────────────
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  statusBarItem.command = 'ghTracker.openSettings';
  statusBarItem.tooltip = 'GH Tracker — Click to change notification level';
  context.subscriptions.push(statusBarItem);

  function updateNotiBadge(): void {
    const cfg = ConfigService.get();
    const labels: Record<string, string> = {
      'all': 'ALL',
      'important': 'IMPORTANT',
      'failures-only': 'FAILURES',
    };
    statusBarItem.text = `$(bell) ${labels[cfg.notificationLevel] ?? cfg.notificationLevel}`;
    statusBarItem.show();
  }
  updateNotiBadge();

  // ── 3. GitHubClient factory (re-created when settings change) ────────────────
  async function initClient(): Promise<GitHubClient | undefined> {
    const c = ConfigService.get();
    const token = await AuthService.getToken(context, c.hostUrl);
    if (!token) {
      vscode.window.showErrorMessage('GH Tracker: Authentication failed. Run "GH Tracker: Open Setup".');
      return undefined;
    }
    return new GitHubClient(token, c.hostUrl);
  }

  // ── 4. Poll service ──────────────────────────────────────────────────────────
  let pollService: PollService | undefined;

  async function startPolling(): Promise<void> {
    if (!store || !aiService || !notifyService || !repoProvider || !eventProvider) {
      // Storage unavailable — can't poll
      return;
    }

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
          score: await aiService!.scoreEventUrgency(e, 'current-user')
        })))).filter(x => x.score >= 3).map(x => x.event)
        : events;

      notifyService!.notify(toNotify, currentConfig);
      repoProvider!.refresh();
      eventProvider!.refresh();
    });

    context.subscriptions.push(sub);
    pollService.start();
    console.log(`GH Tracker: polling ${c.repositories.length} repos every ${c.pollIntervalSeconds}s`);
  }

  async function restart(): Promise<void> {
    pollService?.dispose();
    const c = ConfigService.get();
    repoProvider?.refresh(c.repositories);
    await startPolling();
  }

  // ── 5. Register commands FIRST (before any fallible init) ────────────────────
  //     This ensures commands survive partial activation failures.
  context.subscriptions.push(

    vscode.commands.registerCommand('ghTracker.setup', () => {
      SetupPanel.show(context, (token, host) => new GitHubClient(token, host), restart);
    }),

    vscode.commands.registerCommand('ghTracker.refresh', async () => {
      if (!store) {
        vscode.window.showErrorMessage('GH Tracker: Storage unavailable');
        return;
      }
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
      if (!eventProvider || !store || !repoProvider) { return; }
      eventProvider.showRepo(repo);
      store.markAllRead(repo);
      repoProvider.refresh();
    }),

    vscode.commands.registerCommand('ghTracker.openEvent', (event) => {
      if (!store || !repoProvider) { return; }
      store.markEventRead(event.id);
      vscode.env.openExternal(vscode.Uri.parse(event.url));
      repoProvider.refresh();
    }),

    vscode.commands.registerCommand('ghTracker.aiReview', async (item) => {
      if (!item?.event || !client || !aiService) { return; }
      const prMatch = item.event.url.match(/\/pull\/(\d+)/);
      if (!prMatch) { return; }
      const files = await client.getPRFiles(item.event.repo, parseInt(prMatch[1], 10));
      await aiService.reviewPR(item.event, files);
    }),

    vscode.commands.registerCommand('ghTracker.markRead', (item) => {
      if (!item?.nameWithOwner || !store || !repoProvider || !eventProvider) { return; }
      store.markAllRead(item.nameWithOwner);
      repoProvider.refresh();
      eventProvider.refresh();
    }),

    vscode.commands.registerCommand('ghTracker.openSettings', () => {
      vscode.commands.executeCommand('workbench.action.openSettings', '@gh-tracker');
    }),

    // Restart polling + update badge when settings change
    ConfigService.onChange(() => {
      updateNotiBadge();
      restart();
    })
  );

  // ── 5. Kick off polling (silently skip if storage is unavailable) ────────────
  await startPolling();
}

export function deactivate(): void {
  console.log('GH Tracker: deactivated');
}
