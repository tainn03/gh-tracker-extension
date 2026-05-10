# GitHub Enterprise Tracker

<p align="center">
  <picture>
    <source srcset="usecase.png" media="(prefers-color-scheme: dark)">
    <source srcset="usecase.png" media="(prefers-color-scheme: light)">
    <img src="usecase.png" alt="GH Tracker in action" width="738">
  </picture>
</p>

Real-time event tracking for GitHub / GHE repositories directly in VSCode. Polls repositories for PRs, pushes, workflow runs, and more — with AI-powered summaries, code reviews, and failure investigations.

## Features

| Feature | Description |
|---------|-------------|
| **Multi-repo tracking** | Monitor any number of GitHub.com or GitHub Enterprise repositories |
| **Real-time polling** | Configurable interval (30s+) — new events appear automatically |
| **Toast notifications** | Smart notification level: all events, important only, or failures only |
| **Event filtering** | Filter by event type (PR, push, workflow, etc.) and/or specific actors |
| **Sidebar tree views** | Repository list with unread badges + per-repo event list |
| **Event actions** | Open in VSCode Simple Browser or external browser; mark read |
| **AI Summarize** | One-click AI summary of any event with full context (PR diffs, commit messages, workflow logs) using Copilot LM API |
| **AI PR Review** | Full code review including diff, comments, reviews, and inline feedback |
| **AI Failure Investigation** | Root-cause analysis with log tail for failed CI/CD pipelines |
| **AI Event Search** | Natural-language semantic search across stored events |
| **Flexible auth** | Built-in GitHub OAuth or PAT-based authentication |
| **Persistent storage** | JSON file-backed event history with 30-day auto-cleanup |
| **Open source** | MIT-licensed, contributions welcome |

## Commands

| Command | Description |
|---------|-------------|
| `GH Tracker: Open Setup` | Configure host, auth, repos, and preferences |
| `GH Tracker: Refresh Now` | Force an immediate poll cycle |
| `GH Tracker: Add Repository` | Add a repo in `org/repo` format |
| `GH Tracker: Remove Repository` | Remove a tracked repo |
| `GH Tracker: Mark All Read` | Mark all events in a repo as read |
| `GH Tracker: Open Settings` | Open VSCode settings filtered to GH Tracker |
| `GH Tracker: AI Summarize Event` | Generate a detailed summary of a selected event |
| `GH Tracker: AI Review PR` | Run a full code review on a PR event |
| `GH Tracker: AI Investigate Failure` | Analyze a failed workflow run |
| `GH Tracker: AI Event Search` | Search events by natural language query |
| `GH Tracker: Filter Notifications...` | Set event type and actor filters |

## Development

1. `npm install`
2. `npm run watch`
3. Press `F5` to start debugging.

```bash
# Type-check
npx tsc --noEmit

# Lint
npm run lint

# Package
npm run package
```
