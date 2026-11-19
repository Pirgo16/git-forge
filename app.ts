// HTTP surface: git smart HTTP, REST v3, GraphQL and MCP on one process.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { infoRefs, receivePack, uploadPack } from './git.ts';
import { execute } from './gql.ts';
import { handleMcp } from './mcp.ts';
import {
  hot,
  createComment,
  createIssue,
  createLabel,
  createPull,
  createRef,
  createRepo,
  deleteContent,
  deleteRepo,
  getBranch,
  getContent,
  getIssue,
  getPull,
  getRef,
  getRepo,
  isRepo,
  listBranches,
  listCommits,
  listComments,
  listIssues,
  listPulls,
  listRepos,
  mergePull,
  patchIssue,
  patchRepo,
  pullFiles,
  putContent,
  requireRepo,
  userJson,
  type Reply,
  type Repo,
} from './store.ts';

const AUTH = `Bearer ${process.env.MAKEFUN_SHOP_TOKEN ?? ''}`;
const JSON_TYPE = 'application/json';
const RID = '1';

function send(res: ServerResponse, status: number, body: unknown, extra?: Record<string, string | number>): void {
  if (status === 204) {
    res.writeHead(204, { 'x-github-request-id': RID, 'content-length': 0 });
    res.end();
    return;
  }
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body ?? { message: 'Not Found' }));
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': buf.length,
    'x-github-request-id': RID,
    ...extra,
  });
  res.end(buf);
}

function unauth(res: ServerResponse): void {
  send(res, 401, { message: 'Requires authentication' });
}

function authed(req: IncomingMessage): boolean {
  return req.headers.authorization === AUTH;
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function queryOf(search: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!search) return out;
  for (const part of search.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const key = decodeURIComponent(eq < 0 ? part : part.slice(0, eq));
    const value = decodeURIComponent((eq < 0 ? '' : part.slice(eq + 1)).replace(/\+/g, ' '));
    out[key] = value;
  }
  return out;
}

function splitUrl(url: string): { path: string; query: Record<string, string> } {
  const q = url.indexOf('?');
  if (q < 0) return { path: url, query: {} };
  return { path: url.slice(0, q), query: queryOf(url.slice(q + 1)) };
}

function partsOf(path: string): string[] {
  const out: string[] = [];
  for (const part of path.split('/')) if (part) out.push(decodeURIComponent(part));
  return out;
}

function reply(res: ServerResponse, result: Reply): void {
  if (result.status === 204) {
    send(res, 204, null);
    return;
  }
  send(res, result.status, result.body ?? { message: 'Not Found' }, result.link ? { link: result.link } : undefined);
}

async function readJson(req: IncomingMessage): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false }> {
  const buf = await readBody(req, 2 * 1024 * 1024);
  if (buf.length === 0) return { ok: true, value: {} };
  try {
    const value = JSON.parse(buf.toString('utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: true, value: {} };
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}

function gitRoute(path: string): { owner: string; repo: string; rest: string } | null {
  const git = path.indexOf('.git/');
  if (!path.startsWith('/') || git < 1) return null;
  const slash = path.indexOf('/', 1);
  if (slash < 0 || slash >= git) return null;
  return {
    owner: decodeURIComponent(path.slice(1, slash)),
    repo: decodeURIComponent(path.slice(slash + 1, git)),
    rest: path.slice(git + 4),
  };
}

function gitHeaders(kind: string, length: number): Record<string, string | number> {
  return {
    'content-type': kind,
    'content-length': length,
    'cache-control': 'no-cache',
    'x-github-request-id': RID,
  };
}

function serveGit(req: IncomingMessage, res: ServerResponse, path: string, query: Record<string, string>): boolean {
  const route = gitRoute(path);
  if (!route) return false;
  if (!authed(req)) {
    unauth(res);
    return true;
  }
  const repo = requireRepo(route.owner, route.repo);
  if (!isRepo(repo)) {
    send(res, 404, { message: 'Not Found' });
    return true;
  }
  const v2 = req.headers['git-protocol'] === 'version=2';
  if (req.method === 'GET' && route.rest === '/info/refs') {
    const service = query.service ?? '';
    const body = infoRefs(repo.git, service, v2);
    if (!body) {
      send(res, 404, { message: 'Not Found' });
      return true;
    }
    const type = service === 'git-receive-pack'
      ? 'application/x-git-receive-pack-advertisement'
      : 'application/x-git-upload-pack-advertisement';
    res.writeHead(200, gitHeaders(type, body.length));
    res.end(body);
    return true;
  }
  if (req.method === 'POST' && (route.rest === '/git-upload-pack' || route.rest === '/git-receive-pack')) {
    void readBody(req, 64 * 1024 * 1024)
      .then((buf) => {
        const upload = route.rest === '/git-upload-pack';
        const body = upload ? uploadPack(repo.git, buf) : receivePack(repo.git, buf);
        const type = upload ? 'application/x-git-upload-pack-result' : 'application/x-git-receive-pack-result';
        if (!res.headersSent) {
          res.writeHead(200, gitHeaders(type, body.length));
          res.end(body);
        }
      })
      .catch(() => {
        if (!res.headersSent) send(res, 400, { message: 'Bad git request' });
      });
    return true;
  }
  return false;
}

function num(part: string | undefined): number | null {
  if (!part || !/^[1-9][0-9]*$/.test(part)) return null;
  const n = Number(part);
  return Number.isSafeInteger(n) ? n : null;
}

async function rest(req: IncomingMessage, res: ServerResponse, method: string, parts: string[], query: Record<string, string>): Promise<void> {
  if (parts.length === 2 && method === 'GET') {
    send(res, 200, { current_user_url: '/api/v3/user' }, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }
  if (parts[2] === 'meta' && method === 'GET') {
    send(res, 200, { installed_version: '1.0.0' });
    return;
  }
  if (parts[2] === 'user' && parts.length === 3 && method === 'GET') {
    send(res, 200, userJson());
    return;
  }
  if (parts[2] === 'user' && parts[3] === 'repos' && parts.length === 4) {
    if (method === 'GET') {
      const per = Math.min(100, Math.max(1, Number(query.per_page ?? 30) || 30));
      const page = Math.max(1, Number(query.page ?? 1) || 1);
      const listed = listRepos(page, per);
      const host = req.headers.host ?? 'localhost';
      const link = listed.more ? `<http://${host}/api/v3/user/repos?per_page=${per}&page=${page + 1}>; rel="next"` : undefined;
      send(res, 200, listed.repos, link ? { link } : undefined);
      return;
    }
    if (method === 'POST') {
      const body = await readJson(req);
      if (!body.ok) {
        send(res, 400, { message: 'Problems parsing JSON' });
        return;
      }
      const name = body.value.name;
      if (typeof name !== 'string') {
        send(res, 422, { message: 'Validation Failed' });
        return;
      }
      reply(res, createRepo(name, typeof body.value.description === 'string' ? body.value.description : '', body.value.private === true));
      return;
    }
  }
  if (parts[2] !== 'repos' || parts.length < 5) {
    send(res, 404, { message: 'Not Found' });
    return;
  }
  const found = requireRepo(parts[3]!, parts[4]!);
  if (!isRepo(found)) {
    reply(res, found);
    return;
  }
  await repoRoute(req, res, method, found, parts.slice(5), query);
}

async function repoRoute(req: IncomingMessage, res: ServerResponse, method: string, repo: Repo, tail: string[], query: Record<string, string>): Promise<void> {
  if (tail.length === 0) {
    if (method === 'GET') reply(res, getRepo(repo.name));
    else if (method === 'PATCH') {
      const body = await readJson(req);
      if (!body.ok) send(res, 400, { message: 'Problems parsing JSON' });
      else reply(res, patchRepo(repo.name, body.value));
    } else if (method === 'DELETE') reply(res, deleteRepo(repo.name));
    else send(res, 404, { message: 'Not Found' });
    return;
  }
  const head = tail[0];
  if (head === 'branches' && method === 'GET') {
    reply(res, tail.length === 1 ? listBranches(repo.name) : getBranch(repo.name, tail.slice(1).join('/')));
    return;
  }
  if (head === 'commits' && method === 'GET') {
    reply(res, listCommits(repo.name, query.sha));
    return;
  }
  if (head === 'contents') {
    const path = tail.slice(1).join('/');
    if (method === 'GET') reply(res, getContent(repo.name, path, query.ref));
    else if (method === 'PUT' || method === 'DELETE') {
      const body = await readJson(req);
      if (!body.ok) send(res, 400, { message: 'Problems parsing JSON' });
      else reply(res, method === 'PUT' ? putContent(repo.name, path, body.value) : deleteContent(repo.name, path, body.value));
    } else send(res, 404, { message: 'Not Found' });
    return;
  }
  if (head === 'git' && tail[1] === 'refs') {
    if (method === 'POST' && tail.length === 2) {
      const body = await readJson(req);
      if (!body.ok) send(res, 400, { message: 'Problems parsing JSON' });
      else reply(res, createRef(repo.name, body.value.ref, body.value.sha));
      return;
    }
    if (method === 'GET' && tail.length > 2) {
      reply(res, getRef(repo.name, tail.slice(2).join('/')));
      return;
    }
  }
  if (head === 'labels' && method === 'POST') {
    const body = await readJson(req);
    if (!body.ok) send(res, 400, { message: 'Problems parsing JSON' });
    else reply(res, createLabel(repo.name, body.value.name, body.value.color));
    return;
  }
  if (head === 'issues') {
    if (tail.length === 1 && method === 'GET') {
      reply(res, listIssues(repo.name, query));
      return;
    }
    if (tail.length === 1 && method === 'POST') {
      const body = await readJson(req);
      if (!body.ok) send(res, 400, { message: 'Problems parsing JSON' });
      else reply(res, createIssue(repo.name, body.value.title, body.value.body, body.value.labels));
      return;
    }
    const number = num(tail[1]);
    if (number === null) {
      send(res, 404, { message: 'Not Found' });
      return;
    }
    if (tail.length === 2 && method === 'GET') {
      reply(res, getIssue(repo.name, number));
      return;
    }
    if (tail.length === 2 && method === 'PATCH') {
      const body = await readJson(req);
      if (!body.ok) send(res, 400, { message: 'Problems parsing JSON' });
      else reply(res, patchIssue(repo.name, number, body.value));
      return;
    }
    if (tail[2] === 'comments' && tail.length === 3) {
      if (method === 'GET') reply(res, listComments(repo.name, number));
      else if (method === 'POST') {
        const body = await readJson(req);
        if (!body.ok) send(res, 400, { message: 'Problems parsing JSON' });
        else reply(res, createComment(repo.name, number, body.value.body));
      } else send(res, 404, { message: 'Not Found' });
      return;
    }
  }
  if (head === 'pulls') {
    if (tail.length === 1 && method === 'GET') {
      reply(res, listPulls(repo.name, query));
      return;
    }
    if (tail.length === 1 && method === 'POST') {
      const body = await readJson(req);
      if (!body.ok) send(res, 400, { message: 'Problems parsing JSON' });
      else reply(res, createPull(repo.name, body.value));
      return;
    }
    const number = num(tail[1]);
    if (number === null) {
      send(res, 404, { message: 'Not Found' });
      return;
    }
    if (tail.length === 2 && method === 'GET') {
      reply(res, getPull(repo.name, number));
      return;
    }
    if (tail[2] === 'files' && method === 'GET') {
      reply(res, pullFiles(repo.name, number));
      return;
    }
    if (tail[2] === 'merge' && method === 'PUT') {
      reply(res, mergePull(repo.name, number));
      return;
    }
  }
  send(res, 404, { message: 'Not Found' });
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = req.url ?? '/';
  const method = req.method ?? 'GET';
  if (method === 'GET' && (url === '/healthz' || url === '/healthz/')) {
    send(res, 200, { ok: true });
    return;
  }
  if (!authed(req)) {
    unauth(res);
    return;
  }
  const { path, query } = splitUrl(url);
  if (serveGit(req, res, path, query)) return;
  if (path === '/api/graphql' && method === 'POST') {
    const buf = await readBody(req, 2 * 1024 * 1024);
    let payload: unknown;
    try {
      payload = JSON.parse(buf.toString('utf8'));
    } catch {
      send(res, 400, { message: 'Problems parsing JSON' });
      return;
    }
    if (Array.isArray(payload)) {
      const out = payload.map((op) => {
        const item = op && typeof op === 'object' ? (op as { query?: unknown; variables?: unknown }) : {};
        return execute(typeof item.query === 'string' ? item.query : '', (item.variables ?? {}) as Record<string, unknown>);
      });
      send(res, 200, out);
      return;
    }
    const item = payload && typeof payload === 'object' ? (payload as { query?: unknown; variables?: unknown }) : {};
    send(res, 200, execute(typeof item.query === 'string' ? item.query : '', (item.variables ?? {}) as Record<string, unknown>));
    return;
  }
  if (path === '/mcp' && method === 'POST') {
    const buf = await readBody(req, 2 * 1024 * 1024);
    let payload: unknown;
    try {
      payload = JSON.parse(buf.toString('utf8'));
    } catch {
      send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    const result = handleMcp(payload);
    if (result.status === 202) {
      res.writeHead(202, { 'content-type': JSON_TYPE, 'content-length': 0, 'x-github-request-id': RID });
      res.end();
      return;
    }
    send(res, result.status, result.body);
    return;
  }
  const parts = partsOf(path);
  if (parts[0] === 'api' && parts[1] === 'v3') {
    await rest(req, res, method, parts, query);
    return;
  }
  send(res, 404, { message: 'Not Found' });
}

export function createApp(): Server {
  const server = createServer((req, res) => {
    const url = req.url ?? '/';
    if (req.method === 'GET') {
      if (url === '/healthz') {
        const body = Buffer.from('{"ok":true}');
        res.writeHead(200, { 'content-type': JSON_TYPE, 'content-length': body.length, 'x-github-request-id': RID });
        res.end(body);
        return;
      }
      const hit = hot.get(url);
      if (hit) {
        if (req.headers.authorization !== AUTH) {
          unauth(res);
          return;
        }
        res.writeHead(200, hit.headers);
        res.end(hit.body);
        return;
      }
    }
    void handle(req, res).catch(() => {
      if (!res.headersSent) send(res, 500, { message: 'Internal Server Error' });
    });
  });
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;
  server.requestTimeout = 0;
  server.timeout = 0;
  server.maxRequestsPerSocket = 0;
  return server;
}
