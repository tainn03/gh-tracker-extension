import * as vscode from 'vscode';
import { ConfigService }    from './services/configService';
import { AuthService }      from './services/authService';
import { GitHubClient }     from './services/githubClient';
import { PollService }      from './services/pollService';
import { NotifyService }    from './services/notifyService';
import { AIService }        from './services/aiService';
import { EventStore }       from './storage/eventStore';
import { RepoTreeProvider } from './providers/repoTreeProvider';
import { EventTreeProvider } from './providers/eventTreeProvider';
import { SetupPanel }       from './webviews/setupPanel';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  console.log('GH Tracker: activating');

  // ── 1. Initialize storage ───────────────────────────────────────────────
  const store = new EventStore(context.globalStorageUri.fsPath);
  context.subscriptions.push({ dispose: () => store.dispose() });

  // ── 2. Initialize services ──────────────────────────────────────────────
  const aiService     = new AIService();
  const notifyService = new NotifyService();

  // ── 3. Initialize tree providers ────────────────────────────────────────
  const cfg           = ConfigService.get();
  const repoProvider  = new RepoTreeProvider(store, cfg.repositories);
  const eventProvider = new EventTreeProvider(store, cfg.maxEventsShown);

  vscode.window.registerTreeDataProvider('ghTracker.repos',  repoProvider);
  vscode.window.registerTreeDataProvider('ghTracker.events', eventProvider);

  // ── 4. Factory for GitHubClient (re-created when settings change) ───────
  let client: GitHubClient | undefined;

  async function initClient(): Promise<GitHubClient | undefined> {
    const c     = ConfigService.get();
    const token = await AuthService.getToken(context, c.hostUrl);
    if (!token) {
      vscode.window.showErrorMessage('GH Tracker: Authentication failed. Run "GH Tracker: Open Setup".');
      return undefined;
    }
    return new GitHubClient(token, c.hostUrl);
  }

  // ── 5. Initialize and start the poll service ─────────────────────────────
  let pollService: PollService | undefined;

  async function startPolling(): Promise<void> {
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
            score: await aiService.scoreEventUrgency(e, 'current-user')
          })))).filter(x => x.score >= 3).map(x => x.event)
        : events;

      notifyService.notify(toNotify, currentConfig);
      repoProvider.refresh();
      eventProvider.refresh();
    });

    context.subscriptions.push(sub);
    pollService.start();
    console.log(`GH Tracker: polling ${c.repositories.length} repos every ${c.pollIntervalSeconds}s`);
  }

  async function restart(): Promise<void> {
    pollService?.dispose();
    const c = ConfigService.get();
    repoProvider.refresh(c.repositories);
    await startPolling();
  }

  // ── 6. Register all commands ─────────────────────────────────────────────
  context.subscriptions.push(

    vscode.commands.registerCommand('ghTracker.setup', () => {
      SetupPanel.show(context, (token, host) => new GitHubClient(token, host), restart);
    }),

    vscode.commands.registerCommand('ghTracker.refresh', async () => {
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
      eventProvider.showRepo(repo);
      store.markAllRead(repo);
      repoProvider.refresh();
    }),

    vscode.commands.registerCommand('ghTracker.openEvent', (event) => {
      store.markEventRead(event.id);
      vscode.env.openExternal(vscode.Uri.parse(event.url));
      repoProvider.refresh();
    }),

    vscode.commands.registerCommand('ghTracker.aiReview', async (item) => {
      if (!item?.event || !client) { return; }
      const prMatch = item.event.url.match(/\/pull\/(\d+)/);
      if (!prMatch) { return; }
      const files = await client.getPRFiles(item.event.repo, parseInt(prMatch[1], 10));
      await aiService.reviewPR(item.event, files);
    }),

    vscode.commands.registerCommand('ghTracker.markRead', (item) => {
      if (item?.nameWithOwner) {
        store.markAllRead(item.nameWithOwner);
        repoProvider.refresh();
        eventProvider.refresh();
      }
    }),

    // Restart polling when settings change (e.g. user edits settings.json)
    ConfigService.onChange(restart)
  );

  // ── 7. Kick off polling ──────────────────────────────────────────────────
  await startPolling();
}

export function deactivate(): void {
  // VSCode automatically disposes everything in context.subscriptions.
  // SQLite close is handled via the store's dispose registered above.
  console.log('GH Tracker: deactivated');
}
