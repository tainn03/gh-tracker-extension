import * as vscode from 'vscode';
import type { TrackedEvent } from '../types';
import type { ExtensionConfig } from '../types';

/** Events that are always considered "important" (bypass the 'failures-only' filter) */
const IMPORTANT_TYPES = new Set([
  'pr_opened', 'pr_merged', 'workflow_failed', 'review_requested', 'pr_ready'
]);

export class NotifyService {
  notify(events: TrackedEvent[], config: ExtensionConfig): void {
    for (const event of events) {
      if (!this.shouldNotify(event, config)) { continue; }

      const isFailure = event.type === 'workflow_failed';
      const showMsg   = isFailure
        ? vscode.window.showWarningMessage.bind(vscode.window)
        : vscode.window.showInformationMessage.bind(vscode.window);

      // showWarningMessage / showInformationMessage accept action button labels as extra args.
      // The returned promise resolves with the label the user clicked, or undefined if dismissed.
      showMsg(`GH Tracker: ${event.title}`, 'Open', 'Dismiss').then(choice => {
        if (choice === 'Open') {
          vscode.env.openExternal(vscode.Uri.parse(event.url));
        }
      }, () => {
        // User dismissed — no action needed
      });
    }
  }

  private shouldNotify(event: TrackedEvent, config: ExtensionConfig): boolean {
    if (config.notificationLevel === 'all') { return true; }
    if (config.notificationLevel === 'failures-only') {
      return event.type === 'workflow_failed';
    }
    // 'important': only fire for high-signal event types
    return IMPORTANT_TYPES.has(event.type);
  }
}
