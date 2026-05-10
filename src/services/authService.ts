import * as vscode from 'vscode';

export class AuthService {
  private static readonly SECRET_KEY = 'ghTracker.token';

  /**
   * Main entry point. For github.com, tries the built-in OAuth provider first.
   * For GHE (any other host), falls back to a PAT prompt stored in SecretStorage.
   */
  static async getToken(
    context: vscode.ExtensionContext,
    hostUrl: string
  ): Promise<string | undefined> {
    const isGithubDotCom = hostUrl.replace(/\/$/, '') === 'https://github.com';

    if (isGithubDotCom) {
      return AuthService.getOAuthToken();
    } else {
      return AuthService.getPATToken(context, hostUrl);
    }
  }

  /**
   * VSCode's built-in GitHub authentication. This opens the browser-based OAuth
   * flow automatically and returns a token with the requested scopes.
   * 'createIfNone: true' means VSCode will prompt the user if no session exists.
   */
  private static async getOAuthToken(): Promise<string | undefined> {
    try {
      const session = await vscode.authentication.getSession(
        'github',
        ['repo', 'read:org', 'workflow'],
        { createIfNone: true }
      );
      return session.accessToken;
    } catch {
      vscode.window.showErrorMessage('GH Tracker: GitHub authentication failed.');
      return undefined;
    }
  }

  /**
   * For GHE: check SecretStorage first (so the user doesn't re-enter every session),
   * then prompt if not found.
   */
  private static async getPATToken(
    context: vscode.ExtensionContext,
    hostUrl: string
  ): Promise<string | undefined> {
    // Try cached token first
    const cached = await context.secrets.get(AuthService.SECRET_KEY);
    if (cached) { return cached; }

    // Prompt user for PAT
    const pat = await vscode.window.showInputBox({
      title: `GH Tracker — Personal Access Token for ${hostUrl}`,
      prompt: 'Enter a token with repo, read:org, and workflow scopes',
      password: true,          // ← renders as •••• in the input box
      ignoreFocusOut: true,    // ← don't dismiss when user clicks away
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
