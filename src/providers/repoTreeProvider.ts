import * as vscode from 'vscode';
import type { EventStore } from '../storage/eventStore';

export class RepoTreeProvider implements vscode.TreeDataProvider<RepoItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(
    private store: EventStore,
    private repos: string[]
  ) {}

  /** Called by PollService or on config change — triggers a re-render */
  refresh(repos?: string[]): void {
    if (repos) { this.repos = repos; }
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(item: RepoItem): vscode.TreeItem {
    return item;
  }

  getChildren(): RepoItem[] {
    return this.repos.map(repo => {
      const unread    = this.store.getUnreadCount(repo);
      const hasFailure = this.store.hasUnreadFailure(repo);
      return new RepoItem(repo, unread, hasFailure);
    });
  }
}

class RepoItem extends vscode.TreeItem {
  constructor(
    public readonly nameWithOwner: string,
    unreadCount: number,
    hasFailure: boolean
  ) {
    // TreeItemCollapsibleState.None = leaf node (clicking fires a command, not expanding)
    super(nameWithOwner, vscode.TreeItemCollapsibleState.None);

    // The badge number shown on the item (VSCode renders this as a pill)
    this.description = unreadCount > 0 ? `${unreadCount} new` : '';

    // contextValue is matched against `viewItem` in package.json menu conditions
    this.contextValue = 'repo';

    // Icon changes based on state
    this.iconPath = hasFailure
      ? new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'))
      : unreadCount > 0
        ? new vscode.ThemeIcon('bell-dot', new vscode.ThemeColor('notificationsInfoIcon.foreground'))
        : new vscode.ThemeIcon('repo');

    // When the user clicks this item, run the showEvents command and pass this repo as argument
    this.command = {
      command:   'ghTracker.showEvents',
      title:     'Show Events',
      arguments: [nameWithOwner],
    };
  }
}
