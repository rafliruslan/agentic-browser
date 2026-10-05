/**
 * The Linear actions an agent may take through the relay, as its own app user.
 *
 * Not a generic GraphQL proxy. Each action is a fixed query with validated
 * arguments, so a prompt-injected agent can do only what is listed here:
 * read, search, create, update, comment. No delete, no archive, no project,
 * cycle, label or workspace changes. Everything done here shows in Linear as the
 * agent (its app user), never as a person.
 *
 * Pure: `gql(query, variables)` is passed in and returns `data` or throws, so
 * node --test runs it without Linear.
 */

export const ACTIONS = [
  'list_teams',
  'list_users',
  'search_issues',
  'get_issue',
  'create_issue',
  'update_issue',
  'add_comment',
];

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9]{0,9}-\d{1,9}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TEAM_KEY = /^[A-Za-z][A-Za-z0-9]{0,9}$/;

export class ActionError extends Error {}

const fail = (msg) => {
  throw new ActionError(msg);
};

function text(v, name, { max, required = false } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) fail(`${name} is required`);
    return undefined;
  }
  if (typeof v !== 'string') fail(`${name} must be text`);
  if (v.length > max) fail(`${name} is too long (max ${max} characters)`);
  return v;
}

function issueRef(v) {
  const id = text(v, 'id', { max: 64, required: true });
  if (!IDENTIFIER.test(id) && !UUID.test(id)) fail('id must look like OPS-123');
  return id;
}

function priority(v) {
  if (v === undefined || v === null) return undefined;
  if (!Number.isInteger(v) || v < 0 || v > 4) fail('priority must be 0 (none), 1 (urgent), 2 (high), 3 (medium) or 4 (low)');
  return v;
}

const clip = (s, n) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n)}...` : s ?? null);

const issueSummary = (i) => ({
  id: i.identifier,
  title: i.title,
  url: i.url,
  status: i.state?.name ?? null,
  assignee: i.assignee?.name ?? null,
  team: i.team?.key ?? null,
});

/** Resolve an OPS-123 style id to the issue's UUID and its team's states. */
async function resolveIssue(id, gql) {
  const data = await gql(
    'query($id:String!){ issue(id:$id){ id identifier url team{ key states{ nodes{ id name } } } } }',
    { id },
  );
  if (!data?.issue) fail(`No issue ${id}`);
  return data.issue;
}

export async function runAction(action, args, gql) {
  const a = args && typeof args === 'object' ? args : {};
  switch (action) {
    case 'list_teams': {
      const d = await gql('query{ teams(first:50){ nodes{ key name } } }', {});
      return d.teams.nodes;
    }
    case 'list_users': {
      const d = await gql('query{ users(first:100, filter:{ active:{ eq:true } }){ nodes{ id name displayName } } }', {});
      return d.users.nodes.map((u) => ({ id: u.id, name: u.name, displayName: u.displayName }));
    }
    case 'search_issues': {
      const q = text(a.query, 'query', { max: 200, required: true });
      const n = Number.isInteger(a.limit) ? Math.min(Math.max(a.limit, 1), 20) : 10;
      const d = await gql(
        'query($q:String!,$n:Int!){ issues(first:$n, filter:{ searchableContent:{ contains:$q } }){ nodes{ identifier title url state{ name } assignee{ name } team{ key } } } }',
        { q, n },
      );
      return d.issues.nodes.map(issueSummary);
    }
    case 'get_issue': {
      const id = issueRef(a.id);
      const d = await gql(
        'query($id:String!){ issue(id:$id){ identifier title description url priority state{ name } assignee{ name } team{ key } labels{ nodes{ name } } comments(first:15){ nodes{ body createdAt user{ name } } } } }',
        { id },
      );
      if (!d?.issue) fail(`No issue ${id}`);
      const i = d.issue;
      return {
        ...issueSummary(i),
        priority: i.priority,
        description: clip(i.description, 4000),
        labels: i.labels.nodes.map((l) => l.name),
        comments: i.comments.nodes.map((c) => ({ by: c.user?.name ?? 'someone', at: c.createdAt, body: clip(c.body, 1000) })),
      };
    }
    case 'create_issue': {
      const key = text(a.team, 'team', { max: 10, required: true });
      if (!TEAM_KEY.test(key)) fail('team must be a team key like OPS');
      const title = text(a.title, 'title', { max: 300, required: true });
      const description = text(a.description, 'description', { max: 20000 });
      const p = priority(a.priority);
      let assigneeId;
      if (a.assignee !== undefined && a.assignee !== null && a.assignee !== '') {
        if (!UUID.test(String(a.assignee))) fail('assignee must be a user id from list_users');
        assigneeId = a.assignee;
      }
      const t = await gql('query($k:String!){ teams(filter:{ key:{ eq:$k } }){ nodes{ id key } } }', { k: key.toUpperCase() });
      const team = t.teams.nodes[0];
      if (!team) fail(`No team ${key}`);
      const input = { teamId: team.id, title, ...(description ? { description } : {}), ...(p !== undefined ? { priority: p } : {}), ...(assigneeId ? { assigneeId } : {}) };
      const d = await gql('mutation($input:IssueCreateInput!){ issueCreate(input:$input){ success issue{ identifier title url } } }', { input });
      if (!d.issueCreate?.success) fail('Linear did not create the issue');
      return d.issueCreate.issue;
    }
    case 'update_issue': {
      const id = issueRef(a.id);
      const issue = await resolveIssue(id, gql);
      const input = {};
      const title = text(a.title, 'title', { max: 300 });
      if (title) input.title = title;
      const description = text(a.description, 'description', { max: 20000 });
      if (description !== undefined) input.description = description;
      const p = priority(a.priority);
      if (p !== undefined) input.priority = p;
      if (a.status !== undefined && a.status !== null && a.status !== '') {
        const wanted = text(a.status, 'status', { max: 60 }).toLowerCase();
        const state = issue.team.states.nodes.find((s) => s.name.toLowerCase() === wanted);
        if (!state) fail(`No status "${a.status}" in ${issue.team.key}. Options: ${issue.team.states.nodes.map((s) => s.name).join(', ')}`);
        input.stateId = state.id;
      }
      if (a.assignee !== undefined && a.assignee !== null && a.assignee !== '') {
        if (a.assignee === 'none') input.assigneeId = null;
        else if (UUID.test(String(a.assignee))) input.assigneeId = a.assignee;
        else fail('assignee must be a user id from list_users, or "none"');
      }
      if (Object.keys(input).length === 0) fail('Nothing to change: give status, priority, title, description or assignee');
      const d = await gql(
        'mutation($id:String!,$input:IssueUpdateInput!){ issueUpdate(id:$id, input:$input){ success issue{ identifier title url state{ name } assignee{ name } priority } } }',
        { id: issue.id, input },
      );
      if (!d.issueUpdate?.success) fail('Linear did not update the issue');
      const u = d.issueUpdate.issue;
      return { id: u.identifier, title: u.title, url: u.url, status: u.state?.name ?? null, assignee: u.assignee?.name ?? null, priority: u.priority };
    }
    case 'add_comment': {
      const id = issueRef(a.id);
      const body = text(a.body, 'body', { max: 8000, required: true });
      const issue = await resolveIssue(id, gql);
      const d = await gql('mutation($input:CommentCreateInput!){ commentCreate(input:$input){ success comment{ id url } } }', {
        input: { issueId: issue.id, body },
      });
      if (!d.commentCreate?.success) fail('Linear did not post the comment');
      return { posted: true, issue: issue.identifier, url: d.commentCreate.comment?.url ?? issue.url };
    }
    default:
      fail(`Unknown action ${String(action).slice(0, 40)}. Known: ${ACTIONS.join(', ')}`);
  }
}
