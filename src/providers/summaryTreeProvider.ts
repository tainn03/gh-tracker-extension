import * as vscode from 'vscode';
import type { TrackedEvent } from '../types';

// ── Data types passed from the command handler ───────────────────────────

export interface PRSummaryData {
  prNumber: number;
  prTitle: string;
  summary: string;
}

export interface RepoSummaryData {
  repo: string;
  prSummaries: PRSummaryData[];
  otherEvents: TrackedEvent[];
  /** Map from event.id → PR number for push events on a known PR branch */
  pushPRMap?: Map<string, number>;
}

// ── Tree item classes ────────────────────────────────────────────────────

class RepoNode extends vscode.TreeItem {
  constructor(
    public readonly data: RepoSummaryData
  ) {
    super(data.repo, vscode.TreeItemCollapsibleState.Expanded);
    const prCount = data.prSummaries.length;
    const evCount = data.otherEvents.length;
    const parts: string[] = [];
    if (prCount) parts.push(prCount + ' PR');
    if (evCount) parts.push(evCount + ' event');
    this.description = parts.join(', ');
    this.tooltip = data.repo + '\n' + parts.join(', ');
    this.iconPath = new vscode.ThemeIcon('repo');
    this.contextValue = 'repo';
  }
}

class PRSummaryNode extends vscode.TreeItem {
  constructor(
    public readonly data: PRSummaryData
  ) {
    super('PR #' + data.prNumber + ': ' + data.prTitle, vscode.TreeItemCollapsibleState.Collapsed);
    this.description = '';
    this.tooltip = 'PR #' + data.prNumber + '\n' + data.prTitle + '\n\u2014\u2014\u2014\n' + data.summary;
    this.iconPath = new vscode.ThemeIcon('git-pull-request');
  }
}

class SummaryLeafItem extends vscode.TreeItem {
  constructor(summary: string) {
    super(summary.length > 120 ? summary.slice(0, 120) + '\u2026' : summary, vscode.TreeItemCollapsibleState.None);
    this.description = '';
    this.tooltip = summary;
    this.iconPath = new vscode.ThemeIcon('comment-discussion');
  }
}

class SummaryEventItem extends vscode.TreeItem {
  constructor(
    public readonly event: TrackedEvent,
    prNumber?: number
  ) {
    const label = prNumber
      ? 'PR #' + prNumber + ' | ' + event.title
      : event.title;
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = new Date(event.createdAt).toLocaleTimeString();
    this.tooltip = (prNumber ? 'PR #' + prNumber + ' | ' : '') + event.type + ' \u00B7 ' + event.actor + ' \u00B7 ' + new Date(event.createdAt).toLocaleString();
    this.iconPath = new vscode.ThemeIcon(
      event.type === 'workflow_failed' ? 'error'
      : event.type === 'workflow_passed' ? 'pass-filled'
      : event.type.startsWith('pr_') ? 'git-pull-request'
      : event.type === 'issue_opened' ? 'issues'
      : event.type === 'issue_closed' ? 'pass'
      : event.type === 'fork' ? 'repo-forked'
      : event.type === 'watch' ? 'star'
      : event.type === 'release_published' ? 'package'
      : event.type === 'push' ? 'arrow-up'
      : 'bell'
    );
    this.command = {
      command: 'ghTracker.openEvent',
      title: 'Open Event',
      arguments: [event],
    };
  }
}

class PlaceholderItem extends vscode.TreeItem {
  constructor(message: string) {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon('info');
  }
}

// ── Provider ─────────────────────────────────────────────────────────────

export class SummaryTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private repoList: RepoSummaryData[] = [];
  private loaded = false;

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  setData(repos: RepoSummaryData[]): void {
    this.repoList = repos;
    this.loaded = true;
    this.refresh();
  }

  getTreeItem(item: vscode.TreeItem): vscode.TreeItem {
    return item;
  }

  getChildren(item?: vscode.TreeItem): vscode.TreeItem[] {
    if (!item) {
      // Root level — return repo nodes or placeholder
      if (!this.loaded) {
        return [new PlaceholderItem('Nh\u1EA5n n\u00FAt Today Summary \u0111\u1EC3 t\u1EA1o b\u00E1o c\u00E1o')];
      }
      if (this.repoList.length === 0) {
        return [new PlaceholderItem('Kh\u00F4ng c\u00F3 s\u1EF1 ki\u1EC7n h\u00F4m nay')];
      }
      return this.repoList.map(r => new RepoNode(r));
    }

    // PR node — return summary leaf
    if (item instanceof PRSummaryNode) {
      return [new SummaryLeafItem(item.data.summary)];
    }

    // Repo node — return PR nodes first, then non-PR event items
    if (item instanceof RepoNode) {
      const children: vscode.TreeItem[] = [];
      for (const pr of item.data.prSummaries) {
        children.push(new PRSummaryNode(pr));
      }
      for (const ev of item.data.otherEvents) {
        const prNum = item.data.pushPRMap?.get(ev.id);
        children.push(new SummaryEventItem(ev, prNum));
      }
      return children;
    }

    return [];
  }
}
