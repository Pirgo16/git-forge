// Repositories, issues, pull requests and the contents API, on one git store.
import {
  type GitState,
  ZERO,
  commitMessage,
  commitTree,
  createGit,
  diffFiles,
  fileMap,
  lookupPath,
  makeCommit,
  mergeTree,
  putRaw,
  resolveRev,
  setRef,
  squashMerge,
  treeFromFiles,
} from './git.ts';

export const VIEWER = 'adaiversen';
const MERGED_AT = '2026-01-01T00:00:00Z';

export interface Hot {
  body: Buffer;
  headers: { 'content-type': string; 'content-length': number; 'x-github-request-id': string };
}

export const hot = new Map<string, Hot>();

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: { name: string }[];
  comments: { id: number; gid: string; body: string }[];
  cache: Hot;
}

export interface Pull {
  number: number;
  title: string;
  body: string;
  head: string;
  base: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeSha: string | null;
}

export interface Repo {
  id: number;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  git: GitState;
  labels: Map<string, string>;
  issues: Issue[];
  pulls: Pull[];
  nextIssue: number;
  nextPull: number;
}

export interface Reply {
  status: number;
  body?: unknown;
  link?: string;
}

const store = {
  nextRepo: 1,
  nextIssueId: 1,
  nextComment: 1,
  repos: [] as Repo[],
  byName: new Map<string, Repo>(),
  byId: new Map<number, Repo>(),
};

export function repoByName(name: string): Repo | undefined {
  return store.byName.get(name);
}

export function repoById(id: number): Repo | undefined {
  return store.byId.get(id);
}

function gid(text: string): string {
  return Buffer.from(text).toString('base64url');
}

export function repoGid(repo: Repo): string {
  return gid(`R:${repo.id}`);
}

export function issueGid(repo: Repo, issue: Issue): string {
  return gid(`I:${repo.id}:${issue.number}`);
}

export function pullGid(repo: Repo, pull: Pull): string {
  return gid(`P:${repo.id}:${pull.number}`);
}

export function parseGid(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const parts = text.split(':');
    const kind = parts.shift();
    if (!kind) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

export function findByGid(id: string): { repo: Repo; issue?: Issue; pull?: Pull } | null {
  const parsed = parseGid(id);
  if (!parsed) return null;
  if (parsed.kind === 'R') {
    const repo = repoById(Number(parsed.parts[0]));
    return repo ? { repo } : null;
  }
  if (parsed.kind === 'I') {
    const repo = repoById(Number(parsed.parts[0]));
    const issue = repo?.issues.find((item) => item.number === Number(parsed.parts[1]));
    return repo && issue ? { repo, issue } : null;
  }
  if (parsed.kind === 'P') {
    const repo = repoById(Number(parsed.parts[0]));
    const pull = repo?.pulls.find((item) => item.number === Number(parsed.parts[1]));
    return repo && pull ? { repo, pull } : null;
  }
  return null;
}

function issuePath(repo: Repo, number: number): string {
  return `/api/v3/repos/${VIEWER}/${repo.name}/issues/${number}`;
}

function renderIssue(repo: Repo, issue: Issue): void {
  const labels = issue.labels.length === 0
    ? '[]'
    : `[${issue.labels.map((label) => `{"name":${JSON.stringify(label.name)}}`).join(',')}]`;
  const body = Buffer.from(
    `{"id":${issue.id},"number":${issue.number},"title":${JSON.stringify(issue.title)},"body":${JSON.stringify(issue.body)},"state":"${issue.state}","labels":${labels}}`,
  );
  issue.cache = {
    body,
    headers: { 'content-type': 'application/json', 'content-length': body.length, 'x-github-request-id': '1' },
  };
  hot.set(issuePath(repo, issue.number), issue.cache);
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${VIEWER}/${repo.name}`,
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    owner: { login: VIEWER },
  };
}

export function createRepo(name: string, description: string, isPrivate: boolean): Reply {
  if (!name || name.length > 100) return { status: 422, body: { message: 'Repository name is invalid' } };
  if (store.byName.has(name)) return { status: 422, body: { message: 'Repository creation failed: name already exists' } };
  const repo: Repo = {
    id: store.nextRepo,
    name,
    description: description ?? '',
    isPrivate,
    defaultBranch: 'main',
    git: createGit(),
    labels: new Map(),
    issues: [],
    pulls: [],
    nextIssue: 1,
    nextPull: 1,
  };
  store.nextRepo += 1;
  repo.git.defaultBranch = repo.defaultBranch;
  store.repos.push(repo);
  store.byName.set(name, repo);
  store.byId.set(repo.id, repo);
  return { status: 201, body: repoJson(repo) };
}

export function getRepo(name: string): Reply {
  const repo = store.byName.get(name);
  if (!repo) return { status: 404, body: { message: 'Not Found' } };
  return { status: 200, body: repoJson(repo) };
}

export function patchRepo(name: string, patch: { description?: unknown; private?: unknown }): Reply {
  const repo = store.byName.get(name);
  if (!repo) return { status: 404, body: { message: 'Not Found' } };
  if (typeof patch.description === 'string') repo.description = patch.description;
  if (typeof patch.private === 'boolean') repo.isPrivate = patch.private;
  return { status: 200, body: repoJson(repo) };
}

export function deleteRepo(name: string): Reply {
  const repo = store.byName.get(name);
  if (!repo) return { status: 404, body: { message: 'Not Found' } };
  for (const issue of repo.issues) hot.delete(issuePath(repo, issue.number));
  store.byName.delete(name);
  store.byId.delete(repo.id);
  const index = store.repos.indexOf(repo);
  if (index >= 0) store.repos.splice(index, 1);
  return { status: 204 };
}

export function listRepos(page: number, perPage: number): { repos: Record<string, unknown>[]; more: boolean } {
  const start = (page - 1) * perPage;
  const slice = store.repos.slice(start, start + perPage);
  return { repos: slice.map(repoJson), more: start + perPage < store.repos.length };
}

export function userJson(): Record<string, unknown> {
  return { login: VIEWER, id: 1000, name: 'ada iversen', email: 'adaiversen@example.invalid' };
}

function tipOf(repo: Repo, rev?: string): string | null {
  if (rev) return resolveRev(repo.git, rev);
  return repo.git.refs.get(`refs/heads/${repo.defaultBranch}`) ?? resolveRev(repo.git, 'HEAD');
}

function branchParent(repo: Repo, branch: string): { ref: string; parent: string | null; tree: string | null } {
  const ref = `refs/heads/${branch}`;
  const oid = repo.git.refs.get(ref);
  if (oid) return { ref, parent: oid, tree: commitTree(repo.git, oid) };
  if (branch !== repo.defaultBranch) {
    const base = repo.git.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (base) return { ref, parent: base, tree: commitTree(repo.git, base) };
  }
  return { ref, parent: null, tree: null };
}

export function putContent(repoName: string, path: string, input: { message?: unknown; content?: unknown; branch?: unknown; sha?: unknown }): Reply {
  const repo = store.byName.get(repoName);
  if (!repo) return { status: 404, body: { message: 'Not Found' } };
  if (typeof input.message !== 'string' || typeof input.content !== 'string') return { status: 422, body: { message: 'Validation Failed' } };
  const branch = typeof input.branch === 'string' && input.branch !== '' ? input.branch : repo.defaultBranch;
  const bytes = Buffer.from(input.content, 'base64');
  const located = branchParent(repo, branch);
  const files = new Map<string, string>();
  fileMap(repo.git, located.tree, '', files);
  const existing = files.get(path);
  const sha = typeof input.sha === 'string' ? input.sha.toLowerCase() : undefined;
  if (existing) {
    if (!sha) return { status: 422, body: { message: 'sha is required to update a file' } };
    if (sha !== existing) return { status: 409, body: { message: 'sha does not match' } };
  }
  const blob = putRaw(repo.git, 'blob', bytes);
  files.set(path, blob);
  const tree = treeFromFiles(repo.git, files);
  const commit = makeCommit(repo.git, tree, located.parent ? [located.parent] : [], input.message);
  setRef(repo.git, located.ref, commit);
  const created = !existing;
  return {
    status: created ? 201 : 200,
    body: { content: { sha: blob, encoding: 'base64' }, commit: { sha: commit } },
  };
}

export function getContent(repoName: string, path: string, rev?: string): Reply {
  const repo = store.byName.get(repoName);
  if (!repo) return { status: 404, body: { message: 'Not Found' } };
  const tip = tipOf(repo, rev);
  const tree = commitTree(repo.git, tip);
  const found = lookupPath(repo.git, tree, path);
  if (!found) return { status: 404, body: { message: 'Not Found' } };
  if (found.kind === 'dir') {
    const prefix = path === '' || path === '.' ? '' : path.replace(/\/+$/, '');
    const entries = (found.entries ?? []).map((entry) => ({
      type: entry.mode === '40000' ? 'dir' : 'file',
      name: entry.name,
      path: prefix ? `${prefix}/${entry.name}` : entry.name,
      sha: entry.oid,
    }));
    return { status: 200, body: entries };
  }
  const blob = repo.git.objects.get(found.oid);
  if (!blob) return { status: 404, body: { message: 'Not Found' } };
  const name = path.split('/').pop() ?? path;
  return {
    status: 200,
    body: {
      type: 'file',
      encoding: 'base64',
      name,
      path,
      content: blob.data.toString('base64'),
      sha: found.oid,
      size: blob.data.length,
    },
  };
}

export function deleteContent(repoName: string, path: string, input: { message?: unknown; sha?: unknown; branch?: unknown }): Reply {
  const repo = store.byName.get(repoName);
  if (!repo) return { status: 404, body: { message: 'Not Found' } };
  if (typeof input.message !== 'string' || typeof input.sha !== 'string') return { status: 422, body: { message: 'Validation Failed' } };
  const branch = typeof input.branch === 'string' && input.branch !== '' ? input.branch : repo.defaultBranch;
  const located = branchParent(repo, branch);
  if (!located.parent) return { status: 404, body: { message: 'Not Found' } };
  const files = new Map<string, string>();
  fileMap(repo.git, located.tree, '', files);
  const existing = files.get(path);
  if (!existing) return { status: 404, body: { message: 'Not Found' } };
  if (input.sha.toLowerCase() !== existing) return { status: 409, body: { message: 'sha does not match' } };
  files.delete(path);
  const tree = treeFromFiles(repo.git, files);
  const commit = makeCommit(repo.git, tree, [located.parent], input.message);
  setRef(repo.git, located.ref, commit);
  return { status: 200, body: { commit: { sha: commit } } };
}

export function createRef(repoName: string, ref: unknown, sha: unknown): Reply {
  const repo = store.byName.get(repoName);
  if (!repo) return { status: 404, body: { message: 'Not Found' } };
  if (typeof ref !== 'string' || !ref.startsWith('refs/') || typeof sha !== 'string' || !/^[0-9a-f]{40}$/i.test(sha)) {
    return { status: 422, body: { message: 'Validation Failed' } };
  }
  const oid = sha.toLowerCase();
  if (!repo.git.objects.has(oid)) return { status: 422, body: { message: 'Object does not exist' } };
  if (repo.git.refs.has(ref)) return { status: 422, body: { message: 'Reference already exists' } };
  setRef(repo.git, ref, oid);
  return { status: 201, body: { ref, object: { sha: oid, type: repo.git.objects.get(oid)?.type ?? 'commit' } } };
}

export function getRef(repoName: string, ref: string): Reply {
  const repo = store.byName.get(repoName);
  if (!repo) return { status: 404, body: { message: 'Not Found' } };
  const full = ref.startsWith('refs/') ? ref : `refs/${ref}`;
  const oid = repo.git.refs.get(full);
  if (!oid) return { status: 404, body: { message: 'Not Found' } };
  return { status: 200, body: { ref: full, object: { sha: oid, type: repo.git.objects.get(oid)?.type ?? 'commit' } } };
}

export function listBranches(repoName: string): Reply {
  const repo = store.byName.get(repoName);
  if (!repo) return { status: 404, body: { message: 'Not Found' } };
  const branches = [];
  for (const [ref, oid] of repo.git.refs) {
    if (!ref.startsWith('refs/heads/')) continue;
    branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha: oid } });
  }
  return { status: 200, body: branches };
}

export function getBranch(repoName: string, name: string): Reply {
  const repo = store.byName.get(repoName);
  if (!repo) return { status: 404, body: { message: 'Not Found' } };
  const oid = repo.git.refs.get(`refs/heads/${name}`);
  if (!oid) return { status: 404, body: { message: 'Not Found' } };
  return { status: 200, body: { name, commit: { sha: oid } } };
}

export function listCommits(repoName: string, rev?: string): Reply {
  const repo = store.byName.get(repoName);
  if (!repo) return { status: 404, body: { message: 'Not Found' } };
  let oid = tipOf(repo, rev);
  const commits = [];
  const seen = new Set<string>();
  for (let guard = 0; oid && guard < 1000 && !seen.has(oid); guard += 1) {
    seen.add(oid);
    const obj = repo.git.objects.get(oid);
    if (!obj || obj.type !== 'commit') break;
    commits.push({ sha: oid, commit: { message: commitMessage(repo.git, oid, obj.data) } });
    oid = obj.parents && obj.parents.length > 0 ? obj.parents[0]! : null;
  }
  return { status: 200, body: commits };
}

export function createLabel(repoName: string, name: unknown, color: unknown): Reply {
  const repo = store.byName.get(repoName);
  if (!repo) return { status: 404, body: { message: 'Not Found' } };
  if (typeof name !== 'string' || name === '') return { status: 422, body: { message: 'Validation Failed' } };
  repo.labels.set(name, typeof color === 'string' ? color : 'ededed');
  return { status: 201, body: { name, color: repo.labels.get(name) } };
}

function labelList(input: unknown): string[] | Reply {
  if (input === undefined) return [];
  if (!Array.isArray(input)) return { status: 422, body: { message: 'Validation Failed' } };
  const names: string[] = [];
  for (const item of input) {
    if (typeof item === 'string') names.push(item);
    else if (item && typeof item === 'object' && typeof (item as { name?: unknown }).name === 'string') names.push((item as { name: string }).name);
    else return { status: 422, body: { message: 'Validation Failed' } };
  }
  return names;
}

export function createIssue(repoName: string, title: unknown, body: unknown, labels: unknown): Reply {
  const repo = store.byName.get(repoName);
  if (!repo) return { status: 404, body: { message: 'Not Found' } };
  if (typeof title !== 'string' || title === '') return { status: 422, body: { message: 'Validation Failed' } };
  const names = labelList(labels);
  if (!Array.isArray(names)) return names;
  for (const name of names) {
    if (!repo.labels.has(name)) return { status: 422, body: { message: `Label ${name} does not exist` } };
  }
  const issue: Issue = {
    id: store.nextIssueId,
    number: repo.nextIssue,
    title,
    body: typeof body === 'string' ? body : '',
    state: 'open',
    labels: names.map((name) => ({ name })),
    comments: [],
    cache: undefined as unknown as Hot,
  };
  store.nextIssueId += 1;
  repo.nextIssue += 1;
  repo.issues.push(issue);
  renderIssue(repo, issue);
  return { status: 201, body: issue.cache.body, link: undefined };
}

export function issueHot(repoName: string, number: number): Hot | null {
  const repo = store.byName.get(repoName);
  const issue = repo?.issues.find((item) => item.number === number);
  return issue ? issue.cache : null;
}

export function getIssue(repoName: string, number: number): Reply {
  const hotIssue = issueHot(repoName, number);
  if (!hotIssue) return { status: 404, body: { message: 'Not Found' } };
  return { status: 200, body: hotIssue.body };
}

export function patchIssue(repoName: string, number: number, patch: { state?: unknown; title?: unknown; body?: unknown }): Reply {
  const repo = store.byName.get(repoName);
  const issue = repo?.issues.find((item) => item.number === number);
  if (!repo || !issue) return { status: 404, body: { message: 'Not Found' } };
  if (patch.state === 'closed' || patch.state === 'open') issue.state = patch.state;
  if (typeof patch.title === 'string') issue.title = patch.title;
  if (typeof patch.body === 'string') issue.body = patch.body;
  renderIssue(repo, issue);
  return { status: 200, body: issue.cache.body };
}

export function listIssues(repoName: string, query: { state?: string; sort?: string; direction?: string; per_page?: string; page?: string }): Reply {
  const repo = store.byName.get(repoName);
  if (!repo) return { status: 404, body: { message: 'Not Found' } };
  const state = query.state ?? 'open';
  let list = repo.issues.filter((issue) => state === 'all' || issue.state === state);
  if ((query.direction ?? 'desc') === 'desc') list = list.slice().reverse();
  const per = clampPage(query.per_page, 30);
  const page = clampPage(query.page, 1);
  const slice = list.slice((page - 1) * per, page * per);
  return { status: 200, body: slice.map((issue) => JSON.parse(issue.cache.body.toString('utf8')) as unknown) };
}

export function createComment(repoName: string, number: number, text: unknown): Reply {
  const repo = store.byName.get(repoName);
  const issue = repo?.issues.find((item) => item.number === number);
  if (!repo || !issue) return { status: 404, body: { message: 'Not Found' } };
  if (typeof text !== 'string') return { status: 422, body: { message: 'Validation Failed' } };
  const id = store.nextComment;
  store.nextComment += 1;
  const comment = { id, gid: gid(`C:${id}`), body: text };
  issue.comments.push(comment);
  return { status: 201, body: { id, body: text } };
}

export function listComments(repoName: string, number: number): Reply {
  const repo = store.byName.get(repoName);
  const issue = repo?.issues.find((item) => item.number === number);
  if (!repo || !issue) return { status: 404, body: { message: 'Not Found' } };
  return { status: 200, body: issue.comments.map((comment) => ({ id: comment.id, body: comment.body })) };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  const head = repo.git.refs.get(`refs/heads/${pull.head}`) ?? ZERO;
  const base = repo.git.refs.get(`refs/heads/${pull.base}`) ?? ZERO;
  const body: Record<string, unknown> = {
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    merged: pull.merged,
    head: { ref: pull.head, sha: head },
    base: { ref: pull.base, sha: base },
  };
  if (pull.mergeSha) {
    body.merged_at = pull.mergedAt;
    body.merge_commit_sha = pull.mergeSha;
  }
  return body;
}

export function createPull(repoName: string, input: { title?: unknown; body?: unknown; head?: unknown; base?: unknown }): Reply {
  const repo = store.byName.get(repoName);
  if (!repo) return { status: 404, body: { message: 'Not Found' } };
  if (typeof input.title !== 'string' || typeof input.head !== 'string' || typeof input.base !== 'string') {
    return { status: 422, body: { message: 'Validation Failed' } };
  }
  if (!repo.git.refs.has(`refs/heads/${input.head}`) || !repo.git.refs.has(`refs/heads/${input.base}`)) {
    return { status: 422, body: { message: 'Validation Failed' } };
  }
  const pull: Pull = {
    number: repo.nextPull,
    title: input.title,
    body: typeof input.body === 'string' ? input.body : '',
    head: input.head,
    base: input.base,
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeSha: null,
  };
  repo.nextPull += 1;
  repo.pulls.push(pull);
  return { status: 201, body: pullJson(repo, pull) };
}

export function getPull(repoName: string, number: number): Reply {
  const repo = store.byName.get(repoName);
  const pull = repo?.pulls.find((item) => item.number === number);
  if (!repo || !pull) return { status: 404, body: { message: 'Not Found' } };
  return { status: 200, body: pullJson(repo, pull) };
}

export function listPulls(repoName: string, query: { state?: string; per_page?: string; page?: string }): Reply {
  const repo = store.byName.get(repoName);
  if (!repo) return { status: 404, body: { message: 'Not Found' } };
  const state = query.state ?? 'open';
  let list = repo.pulls.filter((pull) => state === 'all' || (state === 'closed' ? pull.state === 'closed' : pull.state === 'open' && !pull.merged));
  const per = clampPage(query.per_page, 30);
  const page = clampPage(query.page, 1);
  list = list.slice((page - 1) * per, page * per);
  return { status: 200, body: list.map((pull) => pullJson(repo, pull)) };
}

export function pullFiles(repoName: string, number: number): Reply {
  const repo = store.byName.get(repoName);
  const pull = repo?.pulls.find((item) => item.number === number);
  if (!repo || !pull) return { status: 404, body: { message: 'Not Found' } };
  const base = repo.git.refs.get(`refs/heads/${pull.base}`);
  const head = repo.git.refs.get(`refs/heads/${pull.head}`);
  if (!base || !head) return { status: 200, body: [] };
  return { status: 200, body: diffFiles(repo.git, base, head) };
}

export function mergePull(repoName: string, number: number): Reply {
  const repo = store.byName.get(repoName);
  const pull = repo?.pulls.find((item) => item.number === number);
  if (!repo || !pull) return { status: 404, body: { message: 'Not Found' } };
  if (pull.state !== 'open' || pull.merged) return { status: 405, body: { message: 'Pull request is not mergeable' } };
  const base = repo.git.refs.get(`refs/heads/${pull.base}`);
  const head = repo.git.refs.get(`refs/heads/${pull.head}`);
  if (!base || !head) return { status: 405, body: { message: 'Pull request is not mergeable' } };
  const merged = squashMerge(repo.git, base, head, pull.title);
  if (!merged.ok) return { status: 405, body: { message: merged.reason === 'conflict' ? 'Merge conflict' : 'Pull request is not mergeable' } };
  setRef(repo.git, `refs/heads/${pull.base}`, merged.oid);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = MERGED_AT;
  pull.mergeSha = merged.oid;
  return { status: 200, body: { merged: true, sha: merged.oid, message: pull.title } };
}

export function mergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  const base = repo.git.refs.get(`refs/heads/${pull.base}`);
  const head = repo.git.refs.get(`refs/heads/${pull.head}`);
  if (!base || !head) return 'UNKNOWN';
  if (pull.merged) return 'MERGEABLE';
  const merged = mergeTree(repo.git, base, head);
  if (!merged.ok) return merged.reason === 'conflict' ? 'CONFLICTING' : 'UNKNOWN';
  return 'MERGEABLE';
}

function clampPage(value: string | undefined, fallback: number): number {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(100, Math.trunc(n));
}

export function requireRepo(owner: string, name: string): Repo | Reply {
  if (owner !== VIEWER) return { status: 404, body: { message: 'Not Found' } };
  const repo = store.byName.get(name);
  if (!repo) return { status: 404, body: { message: 'Not Found' } };
  return repo;
}

export function isRepo(value: Repo | Reply): value is Repo {
  return (value as Repo).git !== undefined;
}
