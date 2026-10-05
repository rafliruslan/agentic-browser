/**
 * The Linear actions an agent may take through the relay, as its own app user.
 *
 * Not a generic GraphQL proxy. Each action is a fixed query with validated
 * arguments, so a prompt-injected agent can do only what is listed here:
 * read, search, create, update (status, priority, title, description, assignee,
 * due date, estimate, parent), comment, apply or remove existing labels, move an
 * issue between projects and cycles, and archive or unarchive. No delete, no new
 * labels, projects or cycles, no workspace changes. Everything done here shows in
 * Linear as the agent (its app user), never as a person, and a change made for a
 * requester says whose request it was.
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
  'list_labels',
  'set_labels',
  'list_projects',
  'set_project',
  'list_cycles',
  'set_cycle',
  'archive_issue',
  'unarchive_issue',
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

/**
 * Who asked for this change, by name, so a change made as the agent still says
 * whose request it was. The id comes from the bridge (never from the agent), and
 * anything that is not a Linear user id is ignored.
 */
async function requesterName(requester, gql) {
  if (typeof requester !== 'string' || !UUID.test(requester)) return null;
  try {
    const d = await gql('query($id:String!){ user(id:$id){ name } }', { id: requester });
    return d?.user?.name ?? null;
  } catch {
    return null;
  }
}

/** Leave a note saying whose request a change was, when the bridge told us. */
async function audit(issueId, what, requester, gql) {
  const asked = await requesterName(requester, gql);
  if (!asked) return;
  await gql('mutation($input:CommentCreateInput!){ commentCreate(input:$input){ success } }', {
    input: { issueId, body: `${what} at ${asked}'s request.` },
  }).catch(() => {});
}

function nameList(v, label) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > 20) fail(`${label} must be a list of up to 20 names`);
  return v.map((n) => text(n, label, { max: 60, required: true }));
}

const issueUpdateById = (id, input) =>
  ['mutation($id:String!,$input:IssueUpdateInput!){ issueUpdate(id:$id, input:$input){ success issue{ identifier } } }', { id, input }];

export async function runAction(action, args, gql, { requester } = {}) {
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
      let description = text(a.description, 'description', { max: 20000 });
      const asked = await requesterName(requester, gql);
      if (asked) description = `${description ? `${description}\n\n` : ''}Requested by ${asked}.`;
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
      const due = text(a.dueDate, 'dueDate', { max: 10 });
      if (due) {
        if (due === 'none') input.dueDate = null;
        else if (/^\d{4}-\d{2}-\d{2}$/.test(due)) input.dueDate = due;
        else fail('dueDate must be YYYY-MM-DD, or "none"');
      }
      if (a.estimate !== undefined && a.estimate !== null) {
        if (!Number.isInteger(a.estimate) || a.estimate < 0 || a.estimate > 100) fail('estimate must be a whole number from 0 to 100');
        input.estimate = a.estimate;
      }
      if (a.parent !== undefined && a.parent !== null && a.parent !== '') {
        if (a.parent === 'none') input.parentId = null;
        else input.parentId = (await resolveIssue(issueRef(a.parent), gql)).id;
      }
      if (Object.keys(input).length === 0) fail('Nothing to change: give status, priority, title, description, assignee, dueDate, estimate or parent');
      const d = await gql(
        'mutation($id:String!,$input:IssueUpdateInput!){ issueUpdate(id:$id, input:$input){ success issue{ identifier title url state{ name } assignee{ name } priority } } }',
        { id: issue.id, input },
      );
      if (!d.issueUpdate?.success) fail('Linear did not update the issue');
      const u = d.issueUpdate.issue;
      const asked = await requesterName(requester, gql);
      if (asked) {
        // The change shows in Linear as the agent's; this says whose request it was.
        const changed = Object.keys(input).map((k) => k.replace(/Id$/, '')).join(', ');
        await gql('mutation($input:CommentCreateInput!){ commentCreate(input:$input){ success } }', {
          input: { issueId: issue.id, body: `Updated (${changed}) at ${asked}'s request.` },
        }).catch(() => {});
      }
      return { id: u.identifier, title: u.title, url: u.url, status: u.state?.name ?? null, assignee: u.assignee?.name ?? null, priority: u.priority };
    }
    case 'add_comment': {
      const id = issueRef(a.id);
      let body = text(a.body, 'body', { max: 8000, required: true });
      const asked = await requesterName(requester, gql);
      if (asked) body = `${body}\n\nRequested by ${asked}.`;
      const issue = await resolveIssue(id, gql);
      const d = await gql('mutation($input:CommentCreateInput!){ commentCreate(input:$input){ success comment{ id url } } }', {
        input: { issueId: issue.id, body },
      });
      if (!d.commentCreate?.success) fail('Linear did not post the comment');
      return { posted: true, issue: issue.identifier, url: d.commentCreate.comment?.url ?? issue.url };
    }
    case 'list_labels': {
      const d = await gql('query{ issueLabels(first:250){ nodes{ name team{ key } } } }', {});
      const key = a.team ? text(a.team, 'team', { max: 10 }).toUpperCase() : null;
      return d.issueLabels.nodes
        .filter((l) => !key || !l.team || l.team.key === key)
        .map((l) => ({ name: l.name, team: l.team?.key ?? 'workspace' }));
    }
    case 'set_labels': {
      const id = issueRef(a.id);
      const add = nameList(a.add, 'add');
      const remove = nameList(a.remove, 'remove');
      if (!add.length && !remove.length) fail('Give add and/or remove, as lists of existing label names');
      const d = await gql(
        'query($id:String!){ issue(id:$id){ id identifier team{ key } labels{ nodes{ id name } } } issueLabels(first:250){ nodes{ id name team{ key } } } }',
        { id },
      );
      if (!d?.issue) fail(`No issue ${id}`);
      const pool = d.issueLabels.nodes.filter((l) => !l.team || l.team.key === d.issue.team.key);
      const byName = new Map(pool.map((l) => [l.name.toLowerCase(), l]));
      const find = (n) => byName.get(n.toLowerCase()) ?? fail(`No label "${n}" for ${d.issue.team.key}. Options: ${pool.map((l) => l.name).join(', ')}`);
      const current = new Map(d.issue.labels.nodes.map((l) => [l.id, l.name]));
      for (const n of add) { const l = find(n); current.set(l.id, l.name); }
      for (const n of remove) current.delete(find(n).id);
      const m = await gql(...issueUpdateById(d.issue.id, { labelIds: [...current.keys()] }));
      if (!m.issueUpdate?.success) fail('Linear did not update the labels');
      await audit(d.issue.id, `Labels set to ${[...current.values()].join(', ') || 'none'}`, requester, gql);
      return { id: d.issue.identifier, labels: [...current.values()] };
    }
    case 'list_projects': {
      const d = await gql('query{ projects(first:100){ nodes{ name state } } }', {});
      return d.projects.nodes;
    }
    case 'set_project': {
      const id = issueRef(a.id);
      const wanted = text(a.project, 'project', { max: 120, required: true });
      const issue = await resolveIssue(id, gql);
      let projectId = null;
      if (wanted !== 'none') {
        const d = await gql('query{ projects(first:100){ nodes{ id name } } }', {});
        const hit = d.projects.nodes.find((p) => p.name.toLowerCase() === wanted.toLowerCase());
        if (!hit) fail(`No project "${wanted}". Options: ${d.projects.nodes.map((p) => p.name).join(', ')}`);
        projectId = hit.id;
      }
      const m = await gql(...issueUpdateById(issue.id, { projectId }));
      if (!m.issueUpdate?.success) fail('Linear did not move the issue');
      await audit(issue.id, `Project set to ${wanted}`, requester, gql);
      return { id: issue.identifier, project: wanted };
    }
    case 'list_cycles': {
      const key = text(a.team, 'team', { max: 10, required: true });
      if (!TEAM_KEY.test(key)) fail('team must be a team key like OPS');
      const d = await gql(
        'query($k:String!){ cycles(first:12, filter:{ team:{ key:{ eq:$k } } }){ nodes{ number name startsAt endsAt isActive } } }',
        { k: key.toUpperCase() },
      );
      return d.cycles.nodes;
    }
    case 'set_cycle': {
      const id = issueRef(a.id);
      const issue = await resolveIssue(id, gql);
      let cycleId = null;
      let label = 'none';
      if (a.cycle !== 'none') {
        if (!Number.isInteger(a.cycle) || a.cycle < 1) fail('cycle must be a cycle number from list_cycles, or "none"');
        const d = await gql(
          'query($k:String!,$n:Float!){ cycles(first:1, filter:{ team:{ key:{ eq:$k } }, number:{ eq:$n } }){ nodes{ id number } } }',
          { k: issue.team.key, n: a.cycle },
        );
        const hit = d.cycles.nodes[0];
        if (!hit) fail(`No cycle ${a.cycle} in ${issue.team.key}`);
        cycleId = hit.id;
        label = String(hit.number);
      }
      const m = await gql(...issueUpdateById(issue.id, { cycleId }));
      if (!m.issueUpdate?.success) fail('Linear did not move the issue');
      await audit(issue.id, `Cycle set to ${label}`, requester, gql);
      return { id: issue.identifier, cycle: label };
    }
    case 'archive_issue':
    case 'unarchive_issue': {
      const id = issueRef(a.id);
      const issue = await resolveIssue(id, gql);
      const archive = action === 'archive_issue';
      // Before archiving: an archived issue can no longer take a comment.
      if (archive) await audit(issue.id, 'Archived', requester, gql);
      const m = await gql(
        archive ? 'mutation($id:String!){ issueArchive(id:$id){ success } }' : 'mutation($id:String!){ issueUnarchive(id:$id){ success } }',
        { id: issue.id },
      );
      if (!(archive ? m.issueArchive?.success : m.issueUnarchive?.success)) fail(`Linear did not ${archive ? 'archive' : 'unarchive'} the issue`);
      if (!archive) await audit(issue.id, 'Unarchived', requester, gql);
      return { id: issue.identifier, archived: archive };
    }
    default:
      fail(`Unknown action ${String(action).slice(0, 40)}. Known: ${ACTIONS.join(', ')}`);
  }
}
