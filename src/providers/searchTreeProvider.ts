import * as vscode from 'vscode';
import type { TrackedEvent } from '../types';

class SearchResultItem extends vscode.TreeItem {
  constructor(
    public readonly event: TrackedEvent,
    public readonly relevance: string
  ) {
    super(event.title, vscode.TreeItemCollapsibleState.None);
    this.description = `${event.repo} \u00B7 ${relevance}`;
    this.tooltip = `${event.type} \u00B7 ${event.actor} \u00B7 ${new Date(event.createdAt).toLocaleString()}`;
    this.iconPath = new vscode.ThemeIcon('search');
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
    this.description = '';
    this.iconPath = new vscode.ThemeIcon('search-stop');
  }
}

export class SearchTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private results: Array<{ event: TrackedEvent; relevance: string }> | undefined;
  private lastQuery = '';

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  setResults(results: Array<{ event: TrackedEvent; relevance: string }>, query: string): void {
    this.results = results;
    this.lastQuery = query;
    this.refresh();
  }

  getTreeItem(item: vscode.TreeItem): vscode.TreeItem {
    return item;
  }

  getChildren(): vscode.TreeItem[] {
    if (!this.results) {
      return [new PlaceholderItem('Run AI Search to find events')];
    }
    if (this.results.length === 0) {
      return [new PlaceholderItem(`No results for "${this.lastQuery}"`)];
    }
    return this.results.map(r => new SearchResultItem(r.event, r.relevance));
  }
}
