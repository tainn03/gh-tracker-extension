import * as vscode from 'vscode';
import type { EventStore } from '../storage/eventStore';
import type { TrackedEvent, EventType } from '../types';

export class EventTreeProvider implements vscode.TreeDataProvider<EventItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private currentRepo: string | undefined;

  constructor(private store: EventStore, private maxEvents: number) {}

  showRepo(repo: string): void {
    this.currentRepo = repo;
    this._onDidChangeTreeData.fire();
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(item: EventItem): vscode.TreeItem { return item; }

  getChildren(): EventItem[] {
    if (!this.currentRepo) { return []; }
    const events = this.store.getEventsForRepo(this.currentRepo, this.maxEvents);
    return events.map(e => new EventItem(e));
  }
}

const EVENT_ICONS: Record<EventType, string> = {
  pr_opened:        'git-pull-request',
  pr_closed:        'git-pull-request-closed',
  pr_merged:        'git-merge',
  pr_review:        'eye',
  pr_comment:       'comment',
  pr_ready:         'pass',
  push:             'arrow-up',
  workflow_failed:  'error',
  workflow_passed:  'pass-filled',
  review_requested: 'person',
  label_changed:    'tag',
  branch_created:   'git-branch',
  branch_deleted:   'trash',
  release_published:'package',
  unknown:          'circle-outline',
};

class EventItem extends vscode.TreeItem {
  constructor(public readonly event: TrackedEvent) {
    super(event.title, vscode.TreeItemCollapsibleState.None);

    this.description = new Date(event.createdAt).toLocaleTimeString();
    this.tooltip     = `${event.type} · ${event.actor} · ${new Date(event.createdAt).toLocaleString()}`;

    // dimmed icon for events already seen
    const iconName = EVENT_ICONS[event.type] ?? 'circle-outline';
    this.iconPath   = new vscode.ThemeIcon(
      iconName,
      event.seen ? undefined : new vscode.ThemeColor('notificationsInfoIcon.foreground')
    );

    // 'event_pr' context value enables the "AI Review" right-click option in menus
    this.contextValue = event.type.startsWith('pr_') ? 'event_pr' : 'event';

    this.command = {
      command:   'ghTracker.openEvent',
      title:     'Open Event',
      arguments: [event],
    };
  }
}
