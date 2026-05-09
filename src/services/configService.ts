import * as vscode from 'vscode';
import type { ExtensionConfig } from '../types';

export class ConfigService {
  static readonly SECTION = 'ghTracker';

  /** Read the current config snapshot from VSCode settings */
  static get(): ExtensionConfig {
    const cfg = vscode.workspace.getConfiguration(ConfigService.SECTION);
    return {
      hostUrl:             cfg.get<string>('hostUrl', 'https://github.com').replace(/\/$/, ''),
      repositories:        cfg.get<string[]>('repositories', []),
      pollIntervalSeconds: cfg.get<number>('pollIntervalSeconds', 60),
      aiEnabled:           cfg.get<boolean>('aiEnabled', false),
      notificationLevel:   cfg.get<'all'|'important'|'failures-only'>('notificationLevel', 'important'),
      maxEventsShown:      cfg.get<number>('maxEventsShown', 10),
    };
  }

  /** Add a new repo to the persistent settings list */
  static async addRepository(nameWithOwner: string): Promise<void> {
    const cfg = vscode.workspace.getConfiguration(ConfigService.SECTION);
    const current = cfg.get<string[]>('repositories', []);
    if (!current.includes(nameWithOwner)) {
      await cfg.update('repositories', [...current, nameWithOwner], vscode.ConfigurationTarget.Global);
    }
  }

  static async removeRepository(nameWithOwner: string): Promise<void> {
    const cfg = vscode.workspace.getConfiguration(ConfigService.SECTION);
    const current = cfg.get<string[]>('repositories', []);
    await cfg.update(
      'repositories',
      current.filter(r => r !== nameWithOwner),
      vscode.ConfigurationTarget.Global
    );
  }

  /** Returns a disposable you can push to context.subscriptions */
  static onChange(handler: () => void): vscode.Disposable {
    return vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration(ConfigService.SECTION)) {
        handler();
      }
    });
  }
}
