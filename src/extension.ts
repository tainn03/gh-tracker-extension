import * as vscode from 'vscode';
import { ConfigService } from './services/configService';
import { AuthService } from './services/authService';
import type { TrackedEvent } from './types';
import { GitHubClient } from './services/githubClient';
import { PollService } from './services/pollService';
import { NotifyService } from './services/notifyService';
import { AIService } from './services/aiService';
import { EventStore } from './storage/eventStore';
import { RepoTreeProvider } from './providers/repoTreeProvider';
import { EventTreeProvider } from './providers/eventTreeProvider';
import { SearchTreeProvider } from './providers/searchTreeProvider';
import { SummaryTreeProvider } from './providers/summaryTreeProvider';
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
  let summaryProvider: SummaryTreeProvider | undefined;

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
  summaryProvider = new SummaryTreeProvider();

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('ghTracker.repos', repoProvider),
    vscode.window.registerTreeDataProvider('ghTracker.events', eventProvider),
    vscode.window.registerTreeDataProvider('ghTracker.search', searchProvider),
    vscode.window.registerTreeDataProvider('ghTracker.summary', summaryProvider),
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

    vscode.commands.registerCommand('ghTracker.aiReview', async (item) => {
      if (!item?.event || !client || !aiService) { return; }
      const prMatch = item.event.url.match(/\/pull\/(\d+)/);
      if (!prMatch) { return; }
      const files = await client.getPRFiles(item.event.repo, parseInt(prMatch[1], 10));
      await aiService.reviewPR(item.event, files, client);
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

    vscode.commands.registerCommand('ghTracker.aiSummary', async () => {
      if (!store || !aiService || !summaryProvider) {
        vscode.window.showErrorMessage('GH Tracker: Storage or AI unavailable');
        return;
      }
      if (!client) {
        vscode.window.showErrorMessage('GH Tracker: GitHub client not available. Open Settings to configure.');
        return;
      }

      // Show the Summary view first
      await vscode.commands.executeCommand('workbench.view.extension.ghTracker');

      // Prompt for custom instruction (pre-filled with cached value)
      const cachedPrompt = context.workspaceState.get<string>('summaryPrompt', '');
      const userPrompt = await vscode.window.showInputBox({
        prompt: 'Nh\u1EADp y\u00EAu c\u1EA7u t\u00F9y ch\u1EC9nh cho AI (\u0111\u1EC3 tr\u1ED1ng n\u1EBFu kh\u00F4ng c\u00F3)',
        placeHolder: 'V\u00ED d\u1EE5: T\u1EADp trung v\u00E0o pipeline failures v\u00E0 PR c\u1EA7n review',
        value: cachedPrompt,
        ignoreFocusOut: true,
      });
      if (userPrompt === undefined) return; // Escape = cancel
      await context.workspaceState.update('summaryPrompt', userPrompt);

      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'GH Tracker: \u0110ang t\u1EA1o b\u00E1o c\u00E1o h\u00F4m nay...',
      }, async (progress) => {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const todayStr = today.toISOString();
        const allEvents = store!.getAllEvents();
        const todayEvents = allEvents.filter(e => e.createdAt >= todayStr);

        if (todayEvents.length === 0) {
          summaryProvider!.setData([]);
          return;
        }

        // Group by repo: separate PR events from non-PR events
        const byRepo = new Map<string, { prEvents: TrackedEvent[]; otherEvents: TrackedEvent[] }>();
        for (const e of todayEvents) {
          const entry = byRepo.get(e.repo) ?? { prEvents: [], otherEvents: [] };
          if (e.type.startsWith('pr_') || e.url.includes('/pull/')) {
            entry.prEvents.push(e);
          } else {
            entry.otherEvents.push(e);
          }
          byRepo.set(e.repo, entry);
        }

        // Process each repo: generate per-PR AI summaries with full context
        const repos: import('./providers/summaryTreeProvider').RepoSummaryData[] = [];

        for (const [repo, group] of byRepo) {
          const prSummaries: import('./providers/summaryTreeProvider').PRSummaryData[] = [];
          const seenPRs = new Set<number>();
          // Map: branch → PR number (for enriching push events)
          const branchToPR = new Map<string, number>();

          for (const prEvent of group.prEvents) {
            const prMatch = prEvent.url.match(/\/pull\/(\d+)/);
            if (!prMatch) continue;
            const prNum = parseInt(prMatch[1], 10);
            if (seenPRs.has(prNum)) continue;
            seenPRs.add(prNum);

            progress.report({ message: 'Ph\u00E2n t\u00EDch PR #' + prNum + ' (' + repo + ')...' });

            const result = await aiService!.generatePRSummary(prEvent, client!, userPrompt);

            // Map the PR's head branch for push event enrichment
            if (result.headBranch) {
              branchToPR.set(result.headBranch, prNum);
            }

            // Derive a clean PR title from the event title
            const cleanTitle = prEvent.title.replace(/^.+\b(PR\s*#\d+\s*:\s*)/i, '').trim() || prEvent.title;

            prSummaries.push({
              prNumber: prNum,
              prTitle: cleanTitle,
              summary: result.summary,
            });
          }

          // Enrich push events: match branch to known PR number
          const pushPRMap = new Map<string, number>();
          for (const ev of group.otherEvents) {
            if (ev.type !== 'push') continue;
            const payload = ev.payload as any;
            const branch = (payload?.ref as string)?.replace('refs/heads/', '') ?? '';
            if (branch && branchToPR.has(branch)) {
              pushPRMap.set(ev.id, branchToPR.get(branch)!);
            }
          }

          repos.push({ repo, prSummaries, otherEvents: group.otherEvents, pushPRMap });
        }

        summaryProvider!.setData(repos);
      });
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
