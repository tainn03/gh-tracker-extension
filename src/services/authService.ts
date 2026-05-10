import * as vscode from 'vscode';

export class AuthService {
  private static readonly SECRET_KEY = 'ghTracker.token';

  /**
   * Main entry point. Uses the configured authMethod setting to decide
   * between OAuth (built-in VSCode GitHub login) and PAT (user-supplied
   * personal access token stored in SecretStorage).
   *
   * Unlike the previous URL-based auto-detection, this relies entirely on
   * the user's explicit choice in settings — OAuth works for any host,
   * PAT works for any host.
   *
   * @param allowPrompt  When true (default), creates a new OAuth session
   *                     if none exists, showing the sign-in dialog. Pass
   *                     false for background operations to avoid dialogs.
   */
  static async getToken(
    context: vscode.ExtensionContext,
    hostUrl: string,
    authMethod: 'oauth' | 'pat',
    allowPrompt: boolean = true
  ): Promise<string | undefined> {
    if (authMethod === 'pat') {
      return AuthService.getPATToken(context, hostUrl, allowPrompt);
    }
    return AuthService.getOAuthToken(allowPrompt);
  }

  /**
   * VSCode's built-in GitHub authentication. This opens the browser-based OAuth
   * flow automatically and returns a token with the requested scopes.
   */
  private static async getOAuthToken(allowPrompt: boolean): Promise<string | undefined> {
    try {
      const session = await vscode.authentication.getSession(
        'github',
        ['repo', 'read:org', 'workflow'],
        allowPrompt ? { createIfNone: true } : { createIfNone: false, silent: true }
      );
      return session?.accessToken;
    } catch {
      if (allowPrompt) {
        vscode.window.showErrorMessage('GH Tracker: GitHub authentication failed.');
      }
      return undefined;
    }
  }

  /**
   * Read a PAT from SecretStorage (keychain-backed). Prompts the user
   * only when `allowPrompt` is true and no cached token exists.
   */
  private static async getPATToken(
    context: vscode.ExtensionContext,
    hostUrl: string,
    allowPrompt: boolean
  ): Promise<string | undefined> {
    // Try cached token first
    const cached = await context.secrets.get(AuthService.SECRET_KEY);
    if (cached) { return cached; }

    if (!allowPrompt) { return undefined; }

    // Prompt user for PAT
    const pat = await vscode.window.showInputBox({
      title: `GH Tracker — Personal Access Token for ${hostUrl}`,
      prompt: 'Enter a token with repo, read:org, and workflow scopes',
      password: true,
      ignoreFocusOut: true,
    });

    if (pat) {
      await context.secrets.store(AuthService.SECRET_KEY, pat);
    }

    return pat;
  }

  /** Call this when the user logs out or the token becomes invalid */
  static async clearToken(context: vscode.ExtensionContext): Promise<void> {
    await context.secrets.delete(AuthService.SECRET_KEY);
  }
}
