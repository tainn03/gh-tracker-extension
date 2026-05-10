import * as vscode from 'vscode';
import { ConfigService } from './services/configService';
import { AuthService } from './services/authService';
import type { TrackedEvent, EventType } from './types';
import { GitHubClient } from './services/githubClient';
import { PollService } from './services/pollService';
import { NotifyService } from './services/notifyService';
import { AIService } from './services/aiService';
import { EventStore } from './storage/eventStore';
import { RepoTreeProvider } from './providers/repoTreeProvider';
import { EventTreeProvider } from './providers/eventTreeProvider';
import { SearchTreeProvider } from './providers/searchTreeProvider';
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
  let searchProvider: SearchTreeProvider | undefined;

  try {
    store = new EventStore(context.globalStorageUri.fsPath);
    context.subscriptions.push({ dispose: () => store!.dispose() });

    aiService = new AIService();
    notifyService = new NotifyService();
  } catch (err) {
    console.error('GH Tracker: Failed to initialize storage/services:', err);
  }

  // Create ALL tree providers unconditionally
  const cfg = ConfigService.get();
  repoProvider = new RepoTreeProvider(store!, cfg.repositories);
  eventProvider = new EventTreeProvider(store!, cfg.maxEventsShown);
  searchProvider = new SearchTreeProvider();

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('ghTracker.repos', repoProvider),
    vscode.window.registerTreeDataProvider('ghTracker.events', eventProvider),
    vscode.window.registerTreeDataProvider('ghTracker.search', searchProvider),
  );

  // ── 2. GitHubClient factory (re-created when settings change) ────────────────
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
    if (!store || !notifyService || !repoProvider || !eventProvider) {
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
      notifyService!.notify(events);
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
      if (!store || !repoProvider || !event?.url) { return; }
      const uri = vscode.Uri.parse(event.url);
      if (!uri.scheme.startsWith('http')) {
        vscode.window.showWarningMessage(`GH Tracker: Invalid event URL — "${event.url}"`);
        return;
      }
      store.markEventRead(event.id);
      const cfg = ConfigService.get();
      if (cfg.openIn === 'external') {
        vscode.env.openExternal(uri);
      } else {
        vscode.commands.executeCommand('simpleBrowser.show', event.url);
      }
      repoProvider.refresh();
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

    // ── New AI commands ───────────────────────────────────────────────

    vscode.commands.registerCommand('ghTracker.aiSummarize', async (item) => {
      if (!item?.event || !client || !aiService) { return; }
      await aiService.summarizeEvent(item.event, client);
    }),

    vscode.commands.registerCommand('ghTracker.aiInvestigate', async (item) => {
      if (!item?.event || !client || !aiService) { return; }
      await aiService.investigateFailure(item.event, client);
    }),

    vscode.commands.registerCommand('ghTracker.aiReview', async (item) => {
      if (!item?.event || !client || !aiService) {
        vscode.window.showErrorMessage('GH Tracker: No event selected or AI unavailable');
        return;
      }
      await aiService.reviewPR(item.event, client);
    }),

    vscode.commands.registerCommand('ghTracker.aiSearch', async () => {
      if (!store || !aiService || !searchProvider) {
        vscode.window.showErrorMessage('GH Tracker: Storage or AI unavailable');
        return;
      }
      // Show the Search view first so results appear
      await vscode.commands.executeCommand('workbench.view.extension.ghTracker');

      const query = await vscode.window.showInputBox({
        prompt: 'Search events (natural language query)',
        placeHolder: 'e.g. PR reviews, pipeline failures, releases needing attention',
        ignoreFocusOut: true,
      });
      if (!query) return;

      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'GH Tracker: Searching events...',
      }, async () => {
        const allEvents = store!.getAllEvents();
        const results = await aiService!.searchEvents(query, allEvents);
        searchProvider!.setResults(results, query);
      });
    }),

    vscode.commands.registerCommand('ghTracker.setNotifyFilter', async () => {
      const cfg = ConfigService.get();
      const current = cfg.eventFilter;

      const pick = await vscode.window.showQuickPick([
        { label: '$(filter) Filter by Event Type',      description: 'Show/hide specific event types', picked: true },
        { label: '$(person) Filter by Actor',           description: 'Show events from specific users only' },
        { label: '$(clear-all) Clear All Filters',      description: 'Remove all type and actor filters' },
        { label: '$(info) Show Current Filter',         description: current.eventTypes.length + ' type(s), ' + current.actors.length + ' actor(s)' },
      ], { placeHolder: 'Choose filter action', title: 'GH Tracker: Event Filter', ignoreFocusOut: true });
      if (!pick) return;

      const section = vscode.workspace.getConfiguration(ConfigService.SECTION);

      if (pick.label.includes('Clear All')) {
        await section.update('eventFilter', {}, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage('GH Tracker: All filters cleared');
        eventProvider?.refresh();
        return;
      }

      if (pick.label.includes('Show Current')) {
        const parts: string[] = [];
        if (current.eventTypes.length > 0) parts.push('Types: ' + current.eventTypes.join(', '));
        if (current.actors.length > 0) parts.push('Actors: ' + current.actors.join(', '));
        if (parts.length === 0) parts.push('No filters active — showing all events');
        vscode.window.showInformationMessage('GH Tracker Filter: ' + parts.join(' | '));
        return;
      }

      if (pick.label.includes('Event Type')) {
        const ALL_EVENT_TYPES: EventType[] = [
          'pr_opened', 'pr_closed', 'pr_merged', 'pr_review', 'pr_comment',
          'issue_comment', 'pr_ready', 'push', 'workflow_failed', 'workflow_passed',
          'review_requested', 'label_changed', 'branch_created', 'branch_deleted',
          'release_published', 'issue_opened', 'issue_closed', 'fork', 'watch', 'unknown',
        ];
        const items = ALL_EVENT_TYPES.map(type => ({
          label: type,
          picked: current.eventTypes.length === 0 || current.eventTypes.includes(type),
          description: current.eventTypes.length === 0 || current.eventTypes.includes(type) ? '(shown)' : '(hidden)',
        }));
        const selected = await vscode.window.showQuickPick(items, {
          canPickMany: true,
          placeHolder: 'Select event types to show (deselect to hide)',
          title: 'GH Tracker: Filter Event Types',
          ignoreFocusOut: true,
        });
        if (!selected) return;
        const selectedTypes = selected.map(s => s.label);
        const allSelected = ALL_EVENT_TYPES.every(t => selectedTypes.includes(t));
        await section.update('eventFilter', {
          eventTypes: allSelected ? [] : selectedTypes,
          actors: current.actors,
        }, vscode.ConfigurationTarget.Global);
        eventProvider?.refresh();
        const count = allSelected ? 0 : selectedTypes.length;
        if (count === 0) {
          vscode.window.showInformationMessage('GH Tracker: Showing all event types');
        } else {
          vscode.window.showInformationMessage('GH Tracker: Showing ' + count + ' event type(s)');
        }
        return;
      }

      if (pick.label.includes('Actor')) {
        const input = await vscode.window.showInputBox({
          prompt: 'Enter GitHub usernames (comma-separated) to filter by',
          placeHolder: 'e.g. octocat, torvalds',
          value: current.actors.join(', '),
          ignoreFocusOut: true,
        });
        if (input === undefined) return; // cancelled
        const actors = input.split(',').map(a => a.trim()).filter(Boolean);
        await section.update('eventFilter', {
          eventTypes: current.eventTypes,
          actors,
        }, vscode.ConfigurationTarget.Global);
        eventProvider?.refresh();
        if (actors.length === 0) {
          vscode.window.showInformationMessage('GH Tracker: Showing all actors');
        } else {
          vscode.window.showInformationMessage('GH Tracker: Filtering by ' + actors.length + ' actor(s)');
        }
        return;
      }
    }),

    // Restart polling when settings change
    ConfigService.onChange(() => {
      restart();
    })
  );

  // ── 5. Kick off polling (silently skip if storage is unavailable) ────────────
  await startPolling();
}

export function deactivate(): void {
  console.log('GH Tracker: deactivated');
}
