import type { TrackedEvent, EventType } from '../types';

export function normalizeEvent(raw: any, repo: string): TrackedEvent {
  const base = {
    id: String(raw.id),
    repo,
    actor: raw.actor?.login ?? 'unknown',
    createdAt: raw.created_at ?? new Date().toISOString(),
    seen: false,
    payload: raw.payload,
  };

  switch (raw.type) {
    case 'PullRequestEvent': {
      const pr = raw.payload.pull_request;
      const action = raw.payload.action; // 'opened', 'closed', 'reopened', 'ready_for_review'
      const merged = pr?.merged;

      let type: EventType = 'pr_opened';
      let verb = 'opened';

      if (action === 'closed' && merged) { type = 'pr_merged'; verb = 'merged'; }
      else if (action === 'closed') { type = 'pr_closed'; verb = 'closed'; }
      else if (action === 'ready_for_review') { type = 'pr_ready'; verb = 'marked ready'; }

      return {
        ...base, type,
        title: `${base.actor} ${verb} PR #${pr?.number}: ${pr?.title ?? ''}`,
        url: pr?.html_url ?? '',
      };
    }

    case 'PullRequestReviewEvent': {
      const pr = raw.payload.pull_request;
      const review = raw.payload.review;
      return {
        ...base, type: 'pr_review',
        title: `${base.actor} reviewed PR #${pr?.number}: ${review?.state ?? ''}`,
        url: review?.html_url ?? pr?.html_url ?? '',
      };
    }

    case 'PullRequestReviewCommentEvent': {
      const pr = raw.payload.pull_request;
      const comment = raw.payload.comment;
      return {
        ...base, type: 'pr_comment',
        title: `${base.actor} commented on PR #${pr?.number}`,
        url: comment?.html_url ?? pr?.html_url ?? '',
      };
    }

    case 'IssueCommentEvent': {
      const issue = raw.payload.issue;
      const comment = raw.payload.comment;
      // IssueCommentEvent fires for plain issues AND pull requests.
      // Detect PR by checking for pull_request in the issue payload.
      const isPR = !!issue?.pull_request;
      return {
        ...base,
        type: isPR ? 'pr_comment' : 'issue_comment',
        title: `${base.actor} commented on #${issue?.number}: ${issue?.title ?? ''}`,
        url: comment?.html_url ?? issue?.html_url ?? '',
      };
    }

    case 'PushEvent': {
      const commits = raw.payload.commits ?? [];
      const branch = (raw.payload.ref as string)?.replace('refs/heads/', '') ?? '';
      return {
        ...base, type: 'push',
        title: `${base.actor} pushed a commit to ${branch}`,
        // Link to the compare view for the full push
        url: `https://github.com/${repo}/compare/${raw.payload.before}...${raw.payload.head}`,
      };
    }

    case 'WorkflowRunEvent': {
      const run = raw.payload.workflow_run;
      const action = raw.payload.action; // 'requested', 'in_progress', 'completed'
      const conclusion = run?.conclusion;

      // Only map 'completed' runs to passed/failed; skip non-terminal states
      if (action !== 'completed' || !conclusion) {
        return {
          ...base, type: 'unknown',
          title: `${base.actor} triggered ${run?.name ?? 'Pipeline'} (${action ?? 'unknown'}) on ${run?.head_branch ?? 'unknown'}`,
          url: run?.html_url ?? '',
        };
      }

      const failed = conclusion === 'failure';
      return {
        ...base,
        type: failed ? 'workflow_failed' : 'workflow_passed',
        title: `${failed ? '❌' : '✅'} ${run?.name ?? 'Pipeline'} ${conclusion} on ${run?.head_branch}`,
        url: run?.html_url ?? '',
      };
    }

    case 'CreateEvent': {
      const refType = raw.payload.ref_type; // 'branch' or 'tag'
      return {
        ...base, type: 'branch_created',
        title: `${base.actor} created ${refType} "${raw.payload.ref}"`,
        url: `https://github.com/${repo}/tree/${raw.payload.ref}`,
      };
    }

    case 'DeleteEvent': {
      return {
        ...base, type: 'branch_deleted',
        title: `${base.actor} deleted ${raw.payload.ref_type} "${raw.payload.ref}"`,
        url: `https://github.com/${repo}`,
      };
    }

    case 'ReleaseEvent': {
      const release = raw.payload.release;
      return {
        ...base, type: 'release_published',
        title: `${base.actor} released ${release?.tag_name}: ${release?.name ?? ''}`,
        url: release?.html_url ?? '',
      };
    }

    case 'IssuesEvent': {
      const issue = raw.payload.issue;
      const action = raw.payload.action; // 'opened', 'closed', 'reopened', 'assigned', 'labeled', ...

      let type: EventType;
      let verb: string;

      if (action === 'closed') {
        type = 'issue_closed';
        verb = 'closed';
      } else {
        // opened, reopened, assigned, labeled, unlabeled, milestoned, demilestoned
        type = 'issue_opened';
        verb = action === 'opened' ? 'opened' : (action ?? 'updated');
      }

      return {
        ...base, type,
        title: `${base.actor} ${verb} issue #${issue?.number}: ${issue?.title ?? ''}`,
        url: issue?.html_url ?? '',
      };
    }

    case 'ForkEvent': {
      const forkee = raw.payload.forkee;
      return {
        ...base, type: 'fork',
        title: `${base.actor} forked ${repo} → ${forkee?.full_name ?? forkee?.name ?? 'unknown'}`,
        url: forkee?.html_url ?? `https://github.com/${repo}`,
      };
    }

    case 'WatchEvent': {
      return {
        ...base, type: 'watch',
        title: `${base.actor} starred ${repo}`,
        url: `https://github.com/${repo}`,
      };
    }

    default:
      return {
        ...base, type: 'unknown',
        title: `${raw.type} by ${base.actor}`,
        url: `https://github.com/${repo}`,
      };
  }
}
