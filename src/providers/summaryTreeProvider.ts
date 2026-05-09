import * as vscode from 'vscode';
import type { TrackedEvent } from '../types';

class RepoSummaryNode extends vscode.TreeItem {
  constructor(
    public readonly repo: string,
    public readonly children: TrackedEvent[],
    public readonly summary: string
  ) {
    super(repo, vscode.TreeItemCollapsibleState.Expanded);
    this.description = `${children.length} event(s)`;
    this.tooltip = summary || `${children.length} event(s) today`;
    this.iconPath = new vscode.ThemeIcon('repo');
  }
}

class SummaryEventItem extends vscode.TreeItem {
  constructor(public readonly event: TrackedEvent) {
    super(event.title, vscode.TreeItemCollapsibleState.None);
    this.description = new Date(event.createdAt).toLocaleTimeString();
    this.tooltip = `${event.type} \u00B7 ${event.actor} \u00B7 ${new Date(event.createdAt).toLocaleString()}`;
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

export class SummaryTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private repoGroups = new Map<string, TrackedEvent[]>();
  private summaryText = '';
  private loaded = false;

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  setData(repoGroups: Map<string, TrackedEvent[]>, summaryText: string): void {
    this.repoGroups = repoGroups;
    this.summaryText = summaryText;
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
        return [new PlaceholderItem('Run Today Summary to generate')];
      }
      if (this.repoGroups.size === 0) {
        return [new PlaceholderItem('No events today')];
      }
      return Array.from(this.repoGroups.entries()).map(
        ([repo, events]) => new RepoSummaryNode(repo, events, this.summaryText)
      );
    }
    // Children of a repo node — return its events
    if (item instanceof RepoSummaryNode) {
      return item.children.map(e => new SummaryEventItem(e));
    }
    return [];
  }
}
