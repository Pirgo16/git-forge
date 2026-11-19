// A small GraphQL parser and executor for the documents gh and the suite send.
import {
  VIEWER,
  type Issue,
  type Pull,
  type Repo,
  findByGid,
  issueGid,
  mergeable,
  pullGid,
  repoByName,
  repoGid,
  createComment,
  createIssue,
  createPull,
  mergePull,
  patchIssue,
} from './store.ts';

const UNKNOWN = Symbol('unknown');

interface Field {
  kind: 'field';
  alias?: string;
  name: string;
  args: { name: string; value: Value }[];
  selection?: Sel[];
}
interface Frag {
  kind: 'frag';
  on: string;
  selection: Sel[];
}
type Sel = Field | Frag;

type Value =
  | { k: 'var'; name: string }
  | { k: 'int'; n: number }
  | { k: 'str'; s: string }
  | { k: 'enum'; s: string }
  | { k: 'bool'; b: boolean }
  | { k: 'null' }
  | { k: 'list'; v: Value[] }
  | { k: 'obj'; f: { name: string; value: Value }[] };

class Parser {
  private i = 0;
  private readonly s: string;
  constructor(source: string) {
    this.s = source;
  }

  private skip(): void {
    const s = this.s;
    while (this.i < s.length) {
      const c = s[this.i]!;
      if (c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === ',') this.i += 1;
      else if (c === '#') while (this.i < s.length && s[this.i] !== '\n') this.i += 1;
      else break;
    }
  }

  private peek(): string {
    this.skip();
    return this.s[this.i] ?? '';
  }

  private eat(ch: string): void {
    if (this.peek() !== ch) throw new Error(`expected ${ch}`);
    this.i += 1;
  }

  private name(): string {
    this.skip();
    const start = this.i;
    if (!/[A-Za-z_]/.test(this.s[this.i] ?? '')) throw new Error('expected name');
    this.i += 1;
    while (/[A-Za-z0-9_]/.test(this.s[this.i] ?? '')) this.i += 1;
    return this.s.slice(start, this.i);
  }

  private string(): string {
    this.eat('"');
    let out = '';
    while (this.i < this.s.length) {
      const c = this.s[this.i++]!;
      if (c === '"') return out;
      if (c === '\\') {
        const n = this.s[this.i++] ?? '';
        out += n === 'n' ? '\n' : n === 't' ? '\t' : n;
      } else out += c;
    }
    throw new Error('unterminated string');
  }

  private type(): void {
    if (this.peek() === '[') {
      this.eat('[');
      this.type();
      this.eat(']');
    } else this.name();
    if (this.peek() === '!') this.eat('!');
  }

  private value(): Value {
    const c = this.peek();
    if (c === '$') {
      this.eat('$');
      return { k: 'var', name: this.name() };
    }
    if (c === '"') return { k: 'str', s: this.string() };
    if (c === '[') {
      this.eat('[');
      const v: Value[] = [];
      while (this.peek() !== ']') v.push(this.value());
      this.eat(']');
      return { k: 'list', v };
    }
    if (c === '{') {
      this.eat('{');
      const f: { name: string; value: Value }[] = [];
      while (this.peek() !== '}') {
        const name = this.name();
        this.eat(':');
        f.push({ name, value: this.value() });
      }
      this.eat('}');
      return { k: 'obj', f };
    }
    if (c === '-' || (c >= '0' && c <= '9')) {
      this.skip();
      const start = this.i;
      if (this.s[this.i] === '-') this.i += 1;
      while (/[0-9]/.test(this.s[this.i] ?? '')) this.i += 1;
      return { k: 'int', n: Number(this.s.slice(start, this.i)) };
    }
    const name = this.name();
    if (name === 'true') return { k: 'bool', b: true };
    if (name === 'false') return { k: 'bool', b: false };
    if (name === 'null') return { k: 'null' };
    return { k: 'enum', s: name };
  }

  private args(): { name: string; value: Value }[] {
    this.eat('(');
    const args: { name: string; value: Value }[] = [];
    while (this.peek() !== ')') {
      const name = this.name();
      this.eat(':');
      args.push({ name, value: this.value() });
    }
    this.eat(')');
    return args;
  }

  private selection(): Sel {
    if (this.peek() === '.') {
      this.eat('.');
      this.eat('.');
      this.eat('.');
      if (this.name() !== 'on') throw new Error('expected on');
      const on = this.name();
      return { kind: 'frag', on, selection: this.selectionSet() };
    }
    const first = this.name();
    let alias: string | undefined;
    let name = first;
    if (this.peek() === ':') {
      this.eat(':');
      alias = first;
      name = this.name();
    }
    const args = this.peek() === '(' ? this.args() : [];
    const selection = this.peek() === '{' ? this.selectionSet() : undefined;
    return { kind: 'field', alias, name, args, selection };
  }

  private selectionSet(): Sel[] {
    this.eat('{');
    const sels: Sel[] = [];
    while (this.peek() !== '}') sels.push(this.selection());
    this.eat('}');
    return sels;
  }

  parse(): Sel[] {
    const head = this.peek();
    if (head !== '{') {
      const kw = this.name();
      if (kw !== 'query' && kw !== 'mutation') throw new Error(`unexpected ${kw}`);
      if (this.peek() !== '(' && this.peek() !== '{') this.name();
      if (this.peek() === '(') {
        this.eat('(');
        while (this.peek() !== ')') {
          this.eat('$');
          this.name();
          this.eat(':');
          this.type();
        }
        this.eat(')');
      }
    }
    return this.selectionSet();
  }
}

function evalValue(value: Value, vars: Record<string, unknown>): unknown {
  switch (value.k) {
    case 'var': return Object.prototype.hasOwnProperty.call(vars, value.name) ? vars[value.name] : null;
    case 'int': return value.n;
    case 'str': return value.s;
    case 'enum': return value.s;
    case 'bool': return value.b;
    case 'null': return null;
    case 'list': return value.v.map((item) => evalValue(item, vars));
    case 'obj': {
      const out: Record<string, unknown> = {};
      for (const field of value.f) out[field.name] = evalValue(field.value, vars);
      return out;
    }
    default: return null;
  }
}

function argsOf(field: Field, vars: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = evalValue(arg.value, vars);
  return out;
}

const SCHEMA: Record<string, { fields?: string[]; enums?: string[] }> = {
  Issue: { fields: ['id', 'number', 'title', 'state', 'body', 'author', 'comments', 'labels', 'url'] },
  PullRequest: { fields: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'files', 'url'] },
  Repository: {
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description'],
  },
  SearchType: { enums: ['ISSUE', 'REPOSITORY', 'USER', 'PULL_REQUEST'] },
};

function typeOf(name: string): Record<string, unknown> | null {
  const schema = SCHEMA[name];
  if (!schema) return null;
  return {
    __typename: '__Type',
    name,
    fields: (schema.fields ?? []).map((field) => ({ __typename: '__Field', name: field })),
    enumValues: (schema.enums ?? []).map((field) => ({ __typename: '__EnumValue', name: field })),
  };
}

function issueNode(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    __typename: 'Issue',
    id: issueGid(repo, issue),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state === 'closed' ? 'CLOSED' : 'OPEN',
  };
}

function pullNode(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    __typename: 'PullRequest',
    id: pullGid(repo, pull),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.merged ? 'MERGED' : pull.state === 'closed' ? 'CLOSED' : 'OPEN',
    merged: pull.merged,
    headRefName: pull.head,
    baseRefName: pull.base,
    _repo: repo.name,
    _pull: pull.number,
  };
}

function repoNode(repo: Repo): Record<string, unknown> {
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const hasBranch = repo.git.refs.has(headRef);
  return {
    __typename: 'Repository',
    id: repoGid(repo),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${VIEWER}/${repo.name}`,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    owner: { __typename: 'User', login: VIEWER },
    defaultBranchRef: hasBranch ? { __typename: 'Ref', name: repo.defaultBranch } : null,
    description: repo.description,
    _repo: repo.name,
  };
}

function known(obj: Record<string, unknown>, name: string): unknown {
  if (name === '__typename') return obj.__typename;
  if (name.startsWith('_')) return UNKNOWN;
  if (!(name in obj)) return UNKNOWN;
  return obj[name];
}

function repoField(obj: Record<string, unknown>, field: Field, vars: Record<string, unknown>): unknown {
  const simple = known(obj, field.name);
  if (simple !== UNKNOWN && field.name !== 'issue' && field.name !== 'issues' && field.name !== 'pullRequest' && field.name !== 'pullRequests') return simple;
  const repo = repoByName(String(obj._repo));
  if (!repo) return null;
  const args = argsOf(field, vars);
  if (field.name === 'issue') {
    const issue = repo.issues.find((item) => item.number === args.number);
    return issue ? issueNode(repo, issue) : null;
  }
  if (field.name === 'issues') return issuesConnection(repo, args);
  if (field.name === 'pullRequest') {
    const pull = repo.pulls.find((item) => item.number === args.number);
    return pull ? pullNode(repo, pull) : null;
  }
  if (field.name === 'pullRequests') {
    const first = typeof args.first === 'number' ? args.first : 30;
    return {
      __typename: 'PullRequestConnection',
      nodes: repo.pulls.slice(0, first).map((pull) => pullNode(repo, pull)),
    };
  }
  return simple;
}

function issuesConnection(repo: Repo, args: Record<string, unknown>): Record<string, unknown> {
  let list = repo.issues.slice();
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const want = new Set(states.map((state) => String(state).toUpperCase()));
    list = list.filter((issue) => want.has(issue.state === 'closed' ? 'CLOSED' : 'OPEN'));
  }
  const order = args.orderBy;
  const desc = Boolean(order && typeof order === 'object' && (order as { direction?: string }).direction === 'DESC');
  list.sort((a, b) => (desc ? b.number - a.number : a.number - b.number));
  if (typeof args.after === 'string' && args.after !== '') {
    const cursor = Number(args.after);
    if (Number.isFinite(cursor)) list = list.filter((issue) => (desc ? issue.number < cursor : issue.number > cursor));
  }
  const first = typeof args.first === 'number' ? args.first : 30;
  const page = list.slice(0, Math.max(0, first));
  const last = page[page.length - 1];
  return {
    __typename: 'IssueConnection',
    nodes: page.map((issue) => issueNode(repo, issue)),
    pageInfo: { __typename: 'PageInfo', hasNextPage: list.length > first, endCursor: last ? String(last.number) : null },
  };
}

function pullField(obj: Record<string, unknown>, field: Field, vars: Record<string, unknown>): unknown {
  if (field.name !== 'files' && field.name !== 'mergeable') return known(obj, field.name);
  const repo = repoByName(String(obj._repo));
  const pull = repo?.pulls.find((item) => item.number === obj._pull);
  if (!repo || !pull) return null;
  if (field.name === 'mergeable') return mergeable(repo, pull);
  const args = argsOf(field, vars);
  const first = typeof args.first === 'number' ? args.first : 100;
  const base = repo.git.refs.get(`refs/heads/${pull.base}`);
  const head = repo.git.refs.get(`refs/heads/${pull.head}`);
  const files = base && head ? diffFilesOf(repo, base, head) : [];
  return { __typename: 'PullRequestChangedFileConnection', nodes: files.slice(0, first) };
}

function diffFilesOf(repo: Repo, base: string, head: string): Record<string, unknown>[] {
  const { diffFiles } = requireDiff();
  return diffFiles(repo.git, base, head).map((file) => ({ __typename: 'PullRequestChangedFile', path: file.filename }));
}

function requireDiff(): { diffFiles: typeof import('./git.ts').diffFiles } {
  return { diffFiles: (git, base, head) => importDiff(git, base, head) };
}

function importDiff(git: Repo['git'], base: string, head: string): { filename: string }[] {
  // Local import kept as a direct call via the binding below.
  return diffFilesDirect(git, base, head);
}

import { diffFiles as diffFilesDirect } from './git.ts';

function resolve(obj: Record<string, unknown>, field: Field, vars: Record<string, unknown>): unknown {
  switch (obj.__typename) {
    case 'Query':
    case 'Mutation':
      return root(field, vars);
    case 'Repository':
      return repoField(obj, field, vars);
    case 'PullRequest':
      return pullField(obj, field, vars);
    case 'User':
    case 'Ref':
    case 'Issue':
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestChangedFileConnection':
    case 'PullRequestChangedFile':
    case 'PageInfo':
    case '__Type':
    case '__Field':
    case '__EnumValue':
    case 'CreateIssuePayload':
    case 'CloseIssuePayload':
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload':
    case 'AddCommentPayload':
    case 'IssueCommentEdge':
    case 'IssueComment':
      return known(obj, field.name);
    default:
      return known(obj, field.name);
  }
}

function inputOf(args: Record<string, unknown>): Record<string, unknown> {
  const input = args.input;
  return input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
}

function root(field: Field, vars: Record<string, unknown>): unknown {
  const args = argsOf(field, vars);
  if (field.name === 'viewer') return { __typename: 'User', login: VIEWER };
  if (field.name === '__type') return typeOf(String(args.name ?? ''));
  if (field.name === 'repository') {
    if (args.owner !== VIEWER) return null;
    const repo = repoByName(String(args.name ?? ''));
    return repo ? repoNode(repo) : null;
  }
  if (field.name === 'node') {
    const found = findByGid(String(args.id ?? ''));
    if (!found) return null;
    if (found.issue) return issueNode(found.repo, found.issue);
    if (found.pull) return pullNode(found.repo, found.pull);
    return repoNode(found.repo);
  }
  if (field.name === 'createIssue') {
    const input = inputOf(args);
    const found = findByGid(String(input.repositoryId ?? ''));
    if (!found) return null;
    const reply = createIssue(found.repo.name, input.title, input.body ?? '', undefined);
    if (reply.status !== 201) return null;
    const issue = found.repo.issues[found.repo.issues.length - 1];
    return issue ? { __typename: 'CreateIssuePayload', issue: issueNode(found.repo, issue) } : null;
  }
  if (field.name === 'closeIssue') {
    const input = inputOf(args);
    const found = findByGid(String(input.issueId ?? ''));
    if (!found?.issue) return null;
    patchIssue(found.repo.name, found.issue.number, { state: 'closed' });
    return { __typename: 'CloseIssuePayload', issue: issueNode(found.repo, found.issue) };
  }
  if (field.name === 'createPullRequest') {
    const input = inputOf(args);
    const found = findByGid(String(input.repositoryId ?? ''));
    if (!found) return null;
    const reply = createPull(found.repo.name, {
      title: input.title,
      body: input.body,
      head: input.headRefName,
      base: input.baseRefName,
    });
    if (reply.status !== 201) return null;
    const pull = found.repo.pulls[found.repo.pulls.length - 1];
    return pull ? { __typename: 'CreatePullRequestPayload', pullRequest: pullNode(found.repo, pull) } : null;
  }
  if (field.name === 'mergePullRequest') {
    const input = inputOf(args);
    const found = findByGid(String(input.pullRequestId ?? ''));
    if (!found?.pull) return null;
    const reply = mergePull(found.repo.name, found.pull.number);
    if (reply.status !== 200) return { __typename: 'MergePullRequestPayload', pullRequest: pullNode(found.repo, found.pull), _error: true };
    return { __typename: 'MergePullRequestPayload', pullRequest: pullNode(found.repo, found.pull) };
  }
  if (field.name === 'addComment') {
    const input = inputOf(args);
    const found = findByGid(String(input.subjectId ?? ''));
    if (!found?.issue) return null;
    const reply = createComment(found.repo.name, found.issue.number, input.body ?? '');
    if (reply.status !== 201 || !reply.body || typeof reply.body !== 'object') return null;
    const comment = reply.body as { id: number; body: string };
    const stored = found.issue.comments[found.issue.comments.length - 1];
    return {
      __typename: 'AddCommentPayload',
      commentEdge: {
        __typename: 'IssueCommentEdge',
        node: { __typename: 'IssueComment', id: stored?.gid ?? String(comment.id), body: comment.body },
      },
    };
  }
  return UNKNOWN;
}

function project(value: unknown, selection: Sel[] | undefined, errors: { message: string }[], vars: Record<string, unknown>): unknown {
  if (value == null) return null;
  if (Array.isArray(value)) return value.map((item) => project(item, selection, errors, vars));
  if (!selection) return value;
  if (typeof value !== 'object') return value;
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const sel of selection) {
    if (sel.kind === 'frag') {
      if (obj.__typename === sel.on) Object.assign(out, project(obj, sel.selection, errors, vars));
      continue;
    }
    const key = sel.alias ?? sel.name;
    const resolved = resolve(obj, sel, vars);
    if (resolved === UNKNOWN) {
      errors.push({ message: `Cannot query field "${sel.name}" on type "${String(obj.__typename)}".` });
      continue;
    }
    out[key] = sel.selection ? project(resolved, sel.selection, errors, vars) : resolved;
  }
  return out;
}

export function execute(query: string, variables?: Record<string, unknown>): { data: unknown; errors?: { message: string }[] } {
  let selection: Sel[];
  try {
    selection = new Parser(query).parse();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'parse error' }] };
  }
  const errors: { message: string }[] = [];
  const data = project({ __typename: 'Query' }, selection, errors, variables ?? {});
  if (errors.length > 0) return { data, errors };
  return { data };
}
