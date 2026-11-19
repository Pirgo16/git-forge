// MCP streamable HTTP: discover, tools/list and tools/call on the same store.
import {
  VIEWER,
  createIssue,
  createPull,
  createRepo,
  getRepo,
  listIssues,
  mergePull,
  repoByName,
} from './store.ts';

const SERVER = { name: 'pirgo-forge', version: '1.0.0' };

const TOOLS = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        private: { type: 'boolean' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string' }, repo: { type: 'string' } },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Open an issue on a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string' } },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from head into base.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        title: { type: 'string' },
        head: { type: 'string' },
        base: { type: 'string' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        pull_number: { type: 'integer' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
] as const;

function textResult(value: unknown, isError = false): Record<string, unknown> {
  const text = JSON.stringify(value);
  const result: Record<string, unknown> = { content: [{ type: 'text', text }], structuredContent: value };
  if (isError) result.isError = true;
  return result;
}

function missing(args: Record<string, unknown>, names: readonly string[]): boolean {
  for (const name of names) {
    const value = args[name];
    if (value === undefined || value === null || value === '') return true;
  }
  return false;
}

function owned(args: Record<string, unknown>): boolean {
  return args.owner === VIEWER && typeof args.repo === 'string' && repoByName(args.repo) !== undefined;
}

function call(name: string, args: Record<string, unknown>): Record<string, unknown> {
  if (name === 'create_repo') {
    if (missing(args, ['name'])) return textResult({ message: 'missing required arguments' }, true);
    const reply = createRepo(String(args.name), typeof args.description === 'string' ? args.description : '', args.private === true);
    if (reply.status !== 201) return textResult(reply.body ?? { message: 'failed' }, true);
    return textResult(reply.body);
  }
  if (name === 'get_repo') {
    if (missing(args, ['owner', 'repo'])) return textResult({ message: 'missing required arguments' }, true);
    if (!owned(args)) return textResult({ message: 'Not Found' }, true);
    const reply = getRepo(String(args.repo));
    if (reply.status !== 200) return textResult(reply.body, true);
    return textResult(reply.body);
  }
  if (name === 'create_issue') {
    if (missing(args, ['owner', 'repo', 'title'])) return textResult({ message: 'missing required arguments' }, true);
    if (!owned(args)) return textResult({ message: 'Not Found' }, true);
    const reply = createIssue(String(args.repo), args.title, args.body ?? '', undefined);
    if (reply.status !== 201) return textResult({ message: 'failed' }, true);
    const repo = repoByName(String(args.repo))!;
    const issue = repo.issues[repo.issues.length - 1]!;
    return textResult({ number: issue.number, title: issue.title, id: issue.id, state: issue.state });
  }
  if (name === 'list_issues') {
    if (missing(args, ['owner', 'repo'])) return textResult({ message: 'missing required arguments' }, true);
    if (!owned(args)) return textResult({ message: 'Not Found' }, true);
    const state = typeof args.state === 'string' ? args.state : 'open';
    const reply = listIssues(String(args.repo), { state, per_page: '100', direction: 'desc' });
    return textResult({ issues: reply.body });
  }
  if (name === 'create_pull_request') {
    if (missing(args, ['owner', 'repo', 'title', 'head', 'base'])) return textResult({ message: 'missing required arguments' }, true);
    if (!owned(args)) return textResult({ message: 'Not Found' }, true);
    const reply = createPull(String(args.repo), { title: args.title, head: args.head, base: args.base, body: args.body });
    if (reply.status !== 201) return textResult(reply.body ?? { message: 'failed' }, true);
    return textResult(reply.body);
  }
  if (name === 'merge_pull_request') {
    if (missing(args, ['owner', 'repo', 'pull_number'])) return textResult({ message: 'missing required arguments' }, true);
    if (!owned(args)) return textResult({ message: 'Not Found' }, true);
    const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
    if (!Number.isInteger(number)) return textResult({ message: 'missing required arguments' }, true);
    const reply = mergePull(String(args.repo), number);
    if (reply.status !== 200) return textResult(reply.body ?? { message: 'failed' }, true);
    return textResult({ ...(reply.body as object), number });
  }
  return { error: true };
}

export function handleMcp(payload: unknown): { status: number; body: unknown } {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  const msg = payload as { id?: unknown; method?: unknown; params?: unknown };
  const id = msg.id ?? null;
  const method = typeof msg.method === 'string' ? msg.method : '';
  const params = msg.params && typeof msg.params === 'object' ? (msg.params as Record<string, unknown>) : {};
  if (method === 'server/discover' || method === 'initialize') {
    return {
      status: 200,
      body: {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2026-07-28',
          supportedVersions: ['2026-07-28'],
          serverInfo: SERVER,
          capabilities: { tools: {} },
          _meta: { 'io.modelcontextprotocol/serverInfo': SERVER },
        },
      },
    };
  }
  if (method === 'notifications/initialized') return { status: 202, body: null };
  if (method === 'tools/list') return { status: 200, body: { jsonrpc: '2.0', id, result: { tools: TOOLS } } };
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = params.arguments && typeof params.arguments === 'object' ? (params.arguments as Record<string, unknown>) : {};
    const known = TOOLS.some((tool) => tool.name === name);
    if (!known) return { status: 200, body: { jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown tool: ${name}` } } };
    const result = call(name, args);
    if (result.error === true) return { status: 200, body: { jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown tool: ${name}` } } };
    return { status: 200, body: { jsonrpc: '2.0', id, result } };
  }
  return { status: 200, body: { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } } };
}
