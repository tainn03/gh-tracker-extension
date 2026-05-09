import * as vscode from 'vscode';
import type { TrackedEvent } from '../types';

export class NotifyService {
  notify(events: TrackedEvent[]): void {
    // Sort oldest-first so the newest toast notification appears last
    const sorted = [...events].sort(
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
