import * as vscode from 'vscode';
import type { TrackedEvent } from '../types';
import { ConfigService } from './configService';

export class NotifyService {
  notify(events: TrackedEvent[]): void {
    const cfg = ConfigService.get();
    const filter = cfg.eventFilter;
    // Apply event type filter
    const hasTypes = filter.eventTypes.length > 0;
    const hasActors = filter.actors.length > 0;
    let filtered = events;
    if (hasTypes) {
      const typeSet = new Set(filter.eventTypes);
      filtered = filtered.filter(e => typeSet.has(e.type));
    }
    if (hasActors) {
      filtered = filtered.filter(e => filter.actors.includes(e.actor));
    }

    if (filtered.length === 0) return;

    // Sort oldest-first so the newest toast notification appears last
    const sorted = [...filtered].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );
    for (const event of sorted) {
      const isFailure = event.type === 'workflow_failed';
      const showMsg   = isFailure
        ? vscode.window.showWarningMessage.bind(vscode.window)
        : vscode.window.showInformationMessage.bind(vscode.window);

      showMsg(`GH Tracker: ${event.title}`, 'Open', 'Dismiss').then(choice => {
        if (choice === 'Open') {
          vscode.env.openExternal(vscode.Uri.parse(event.url));
        }
      }, () => {
        // User dismissed — no action needed
      });
    }
  }
}
