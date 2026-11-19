// Git objects, pkt-line, packfiles and smart HTTP. Node zlib and crypto only.
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO = '0000000000000000000000000000000000000000';
const AGENT = 'agent=pirgo-forge/1';

export type GitType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObj {
  type: GitType;
  data: Buffer;
  parents: string[] | null;
  tree: string | null;
}

export interface GitState {
  objects: Map<string, GitObj>;
  refs: Map<string, string>;
  head: string | null;
  defaultBranch: string;
  messages: Map<string, string>;
  advV0: Buffer | null;
  advRecv: Buffer | null;
  lsDefault: Buffer | null;
  shallow1: Map<string, Buffer>;
}

export function createGit(): GitState {
  return {
    objects: new Map(),
    refs: new Map(),
    head: null,
    defaultBranch: 'main',
    messages: new Map(),
    advV0: null,
    advRecv: null,
    lsDefault: null,
    shallow1: new Map(),
  };
}

function touch(state: GitState): void {
  state.advV0 = null;
  state.advRecv = null;
  state.lsDefault = null;
}

const TYPE_NAME = ['', 'commit', 'tree', 'blob', 'tag'] as const;
const TYPE_CODE: Record<GitType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

interface InflateInfo {
  buffer: Buffer;
  engine: { bytesWritten: number };
}

export function putRaw(state: GitState, type: GitType, data: Buffer): string {
  const oid = createHash('sha1').update(`${type} ${data.length}\0`).update(data).digest('hex');
  if (!state.objects.has(oid)) {
    let parents: string[] | null = null;
    let tree: string | null = null;
    if (type === 'commit') {
      const parsed = indexCommit(data);
      parents = parsed.parents;
      tree = parsed.tree;
    }
    state.objects.set(oid, { type, data, parents, tree });
  }
  return oid;
}

function indexCommit(data: Buffer): { parents: string[]; tree: string | null } {
  const parents: string[] = [];
  let tree: string | null = null;
  const blank = data.indexOf('\n\n');
  const header = data.toString('utf8', 0, blank < 0 ? data.length : blank);
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5);
    else if (line.startsWith('parent ')) parents.push(line.slice(7));
  }
  return { parents, tree };
}

export function commitMessage(state: GitState, oid: string, data: Buffer): string {
  const stored = state.messages.get(oid);
  if (stored !== undefined) return stored;
  const blank = data.indexOf('\n\n');
  if (blank < 0) return '';
  let message = data.toString('utf8', blank + 2);
  if (message.endsWith('\n')) message = message.slice(0, -1);
  return message;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    if (sp < 0) break;
    const mode = data.toString('ascii', i, sp);
    const nul = data.indexOf(0, sp + 1);
    if (nul < 0 || nul + 20 > data.length) break;
    out.push({
      mode,
      name: data.toString('utf8', sp + 1, nul),
      oid: data.toString('hex', nul + 1, nul + 21),
    });
    i = nul + 21;
  }
  return out;
}

function compareTree(a: TreeEntry, b: TreeEntry): number {
  const left = a.mode === '40000' ? `${a.name}/` : a.name;
  const right = b.mode === '40000' ? `${b.name}/` : b.name;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTree);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return parts.length === 1 ? parts[0]! : Buffer.concat(parts);
}

interface DirNode {
  files: Map<string, string>;
  dirs: Map<string, DirNode>;
}

export function treeFromFiles(state: GitState, files: Map<string, string>): string {
  const root: DirNode = { files: new Map(), dirs: new Map() };
  for (const [path, oid] of files) {
    if (!oid) continue;
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const name = parts[i]!;
      let child = node.dirs.get(name);
      if (!child) {
        child = { files: new Map(), dirs: new Map() };
        node.dirs.set(name, child);
      }
      node = child;
    }
    node.files.set(parts[parts.length - 1]!, oid);
  }
  return writeDir(state, root);
}

function writeDir(state: GitState, node: DirNode): string {
  const entries: TreeEntry[] = [];
  for (const [name, oid] of node.files) entries.push({ mode: '100644', name, oid });
  for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: writeDir(state, child) });
  return putRaw(state, 'tree', buildTree(entries));
}

export function fileMap(state: GitState, treeOid: string | null, prefix: string, out: Map<string, string>): void {
  if (!treeOid) return;
  const tree = state.objects.get(treeOid);
  if (!tree || tree.type !== 'tree') return;
  for (const entry of parseTree(tree.data)) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.mode === '40000') fileMap(state, entry.oid, path, out);
    else if (entry.mode !== '160000') out.set(path, entry.oid);
  }
}

export function lookupPath(
  state: GitState,
  treeOid: string | null,
  path: string,
): { kind: 'file' | 'dir'; oid: string; entries?: TreeEntry[] } | null {
  if (!treeOid) return null;
  if (path === '' || path === '.') {
    const tree = state.objects.get(treeOid);
    if (!tree || tree.type !== 'tree') return null;
    return { kind: 'dir', oid: treeOid, entries: parseTree(tree.data) };
  }
  const parts = path.split('/').filter((part) => part.length > 0);
  let oid = treeOid;
  for (let i = 0; i < parts.length; i += 1) {
    const obj = state.objects.get(oid);
    if (!obj || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((item) => item.name === parts[i]);
    if (!entry) return null;
    oid = entry.oid;
    if (i === parts.length - 1) {
      const leaf = state.objects.get(oid);
      if (!leaf) return null;
      if (leaf.type === 'tree' || entry.mode === '40000') return { kind: 'dir', oid, entries: parseTree(leaf.data) };
      return { kind: 'file', oid };
    }
  }
  return null;
}

const AUTHOR = 'Ada Iversen <adaiversen@example.invalid> 1700000000 +0000';

export function makeCommit(state: GitState, tree: string, parents: readonly string[], message: string): string {
  const text = message.endsWith('\n') ? message : `${message}\n`;
  let body = `tree ${tree}\n`;
  for (const parent of parents) body += `parent ${parent}\n`;
  body += `author ${AUTHOR}\ncommitter ${AUTHOR}\n\n${text}`;
  const oid = putRaw(state, 'commit', Buffer.from(body));
  state.messages.set(oid, message);
  return oid;
}

export function resolveRev(state: GitState, rev: string | undefined): string | null {
  if (!rev || rev === 'HEAD') {
    if (!state.head) return null;
    return state.refs.get(state.head) ?? null;
  }
  const lower = rev.toLowerCase();
  if (/^[0-9a-f]{40}$/.test(lower) && state.objects.has(lower)) return lower;
  if (state.refs.has(rev)) return state.refs.get(rev) ?? null;
  if (state.refs.has(`refs/heads/${rev}`)) return state.refs.get(`refs/heads/${rev}`) ?? null;
  if (state.refs.has(`refs/tags/${rev}`)) return state.refs.get(`refs/tags/${rev}`) ?? null;
  return null;
}

export function commitTree(state: GitState, oid: string | null): string | null {
  if (!oid) return null;
  const obj = state.objects.get(oid);
  if (!obj) return null;
  if (obj.type === 'commit') return obj.tree;
  if (obj.type === 'tag') return commitTree(state, peel(state, oid));
  return null;
}

export function setRef(state: GitState, ref: string, oid: string): void {
  state.refs.set(ref, oid);
  if (state.head === null && ref.startsWith('refs/heads/')) state.head = ref;
  touch(state);
}

export function deleteRef(state: GitState, ref: string): void {
  state.refs.delete(ref);
  if (state.head === ref) {
    const next = [...state.refs.keys()].find((name) => name.startsWith('refs/heads/'));
    state.head = next ?? null;
  }
  touch(state);
}

export function peel(state: GitState, oid: string): string {
  let current = oid;
  for (let guard = 0; guard < 10; guard += 1) {
    const obj = state.objects.get(current);
    if (!obj || obj.type !== 'tag') return current;
    const nl = obj.data.indexOf(10);
    const line = obj.data.toString('ascii', 0, nl < 0 ? Math.min(obj.data.length, 80) : nl);
    if (!line.startsWith('object ')) return current;
    current = line.slice(7).trim();
  }
  return current;
}

function isAncestor(state: GitState, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (id === ancestor) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    const obj = state.objects.get(id);
    if (!obj || obj.type !== 'commit' || !obj.parents) continue;
    for (const parent of obj.parents) stack.push(parent);
  }
  return false;
}

function fastForward(state: GitState, oldOid: string, newOid: string): boolean {
  if (oldOid === newOid) return true;
  const obj = state.objects.get(newOid);
  if (!obj || obj.type !== 'commit' || !obj.parents) return false;
  if (obj.parents.includes(oldOid)) return true;
  return isAncestor(state, oldOid, newOid);
}

export function mergeBase(state: GitState, leftOid: string, rightOid: string): string | null {
  const ancestors = new Set<string>();
  const left = [leftOid];
  while (left.length > 0) {
    const id = left.pop()!;
    if (ancestors.has(id)) continue;
    ancestors.add(id);
    const obj = state.objects.get(id);
    if (obj?.type === 'commit' && obj.parents) for (const parent of obj.parents) left.push(parent);
  }
  const seen = new Set<string>();
  const right = [rightOid];
  while (right.length > 0) {
    const id = right.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    if (ancestors.has(id)) return id;
    const obj = state.objects.get(id);
    if (obj?.type === 'commit' && obj.parents) for (const parent of obj.parents) right.push(parent);
  }
  return null;
}

export type MergeTree = { ok: true; tree: string } | { ok: false; reason: 'conflict' | 'missing' };

export function mergeTree(state: GitState, baseOid: string, headOid: string): MergeTree {
  const baseObj = state.objects.get(baseOid);
  const headObj = state.objects.get(headOid);
  if (!baseObj || baseObj.type !== 'commit' || !headObj || headObj.type !== 'commit') return { ok: false, reason: 'missing' };
  const baseCommit = mergeBase(state, baseOid, headOid);
  const baseFiles = new Map<string, string>();
  const ours = new Map<string, string>();
  const theirs = new Map<string, string>();
  fileMap(state, baseCommit ? commitTree(state, baseCommit) : null, '', baseFiles);
  fileMap(state, baseObj.tree, '', ours);
  fileMap(state, headObj.tree, '', theirs);
  const result = new Map<string, string>();
  const names = new Set<string>([...baseFiles.keys(), ...ours.keys(), ...theirs.keys()]);
  for (const path of names) {
    const ancestor = baseFiles.get(path) ?? '';
    const oursOid = ours.get(path) ?? '';
    const headFile = theirs.get(path) ?? '';
    if (headFile === oursOid) {
      if (oursOid) result.set(path, oursOid);
    } else if (headFile === ancestor) {
      if (oursOid) result.set(path, oursOid);
    } else if (oursOid === ancestor) {
      if (headFile) result.set(path, headFile);
    } else {
      return { ok: false, reason: 'conflict' };
    }
  }
  return { ok: true, tree: treeFromFiles(state, result) };
}

export function squashMerge(state: GitState, baseOid: string, headOid: string, message: string): { ok: true; oid: string } | { ok: false; reason: 'conflict' | 'missing' } {
  const merged = mergeTree(state, baseOid, headOid);
  if (!merged.ok) return merged;
  return { ok: true, oid: makeCommit(state, merged.tree, [baseOid], message) };
}

const FLUSH = Buffer.from('0000');
const DELIM = Buffer.from('0001');

function pkt(text: string): Buffer {
  const size = Buffer.byteLength(text) + 4;
  return Buffer.from(size.toString(16).padStart(4, '0') + text);
}

function pktBuf(payload: Buffer): Buffer {
  const head = Buffer.allocUnsafe(4);
  head.write((payload.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([head, payload]);
}

interface DataPkt {
  kind: 'data';
  data: Buffer;
}
type Pkt = DataPkt | { kind: 'flush' | 'delim' };

function parsePkts(buf: Buffer, stopAtFlush: boolean): { pkts: Pkt[]; offset: number } | null {
  const pkts: Pkt[] = [];
  let i = 0;
  while (i + 4 <= buf.length) {
    const hex = buf.toString('ascii', i, i + 4);
    if (!/^[0-9a-f]{4}$/i.test(hex)) return null;
    const n = Number.parseInt(hex, 16);
    if (n === 0) {
      pkts.push({ kind: 'flush' });
      i += 4;
      if (stopAtFlush) return { pkts, offset: i };
      continue;
    }
    if (n === 1) {
      pkts.push({ kind: 'delim' });
      i += 4;
      continue;
    }
    if (n === 2) {
      i += 4;
      continue;
    }
    if (n < 4 || i + n > buf.length) return null;
    pkts.push({ kind: 'data', data: buf.subarray(i + 4, i + n) });
    i += n;
  }
  if (!stopAtFlush && i !== buf.length && pkts.length === 0) return null;
  return { pkts, offset: i };
}

function lineOf(data: Buffer): string {
  const text = data.toString('utf8');
  return text.endsWith('\n') ? text.slice(0, -1) : text;
}

const V2_ADV = Buffer.concat([
  pkt('version 2\n'),
  pkt(`${AGENT}\n`),
  pkt('ls-refs=unborn\n'),
  pkt('fetch=shallow\n'),
  pkt('object-format=sha1\n'),
  FLUSH,
]);

function refLines(state: GitState, caps: string): Buffer[] {
  const lines: Buffer[] = [];
  const names = [...state.refs.keys()].sort();
  const headOid = state.head ? state.refs.get(state.head) : undefined;
  const sym = state.head ? ` symref=HEAD:${state.head}` : '';
  const firstCaps = `\0${caps}${sym}`;
  if (headOid) {
    lines.push(pkt(`${headOid} HEAD${firstCaps}\n`));
    for (const name of names) lines.push(pkt(`${state.refs.get(name)} ${name}\n`));
  } else if (names.length > 0) {
    const name = names[0]!;
    lines.push(pkt(`${state.refs.get(name)} ${name}${firstCaps}\n`));
    for (const rest of names.slice(1)) lines.push(pkt(`${state.refs.get(rest)} ${rest}\n`));
  } else {
    lines.push(pkt(`${ZERO} capabilities^{}\0${caps}\n`));
  }
  return lines;
}

function advertisement(state: GitState, service: 'git-upload-pack' | 'git-receive-pack', v2: boolean): Buffer {
  if (service === 'git-upload-pack' && v2) return V2_ADV;
  if (service === 'git-upload-pack' && state.advV0) return state.advV0;
  if (service === 'git-receive-pack' && state.advRecv) return state.advRecv;
  const caps = service === 'git-upload-pack'
    ? `side-band-64k ofs-delta shallow thin-pack ${AGENT}`
    : `report-status side-band-64k delete-refs ofs-delta ${AGENT}`;
  const body = Buffer.concat([pkt(`# service=${service}\n`), FLUSH, ...refLines(state, caps), FLUSH]);
  if (service === 'git-upload-pack') state.advV0 = body;
  else state.advRecv = body;
  return body;
}

export function infoRefs(state: GitState, service: string, v2: boolean): Buffer | null {
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') return null;
  return advertisement(state, service, service === 'git-upload-pack' && v2);
}

function sideband(chunk: Buffer): Buffer {
  const parts: Buffer[] = [];
  let off = 0;
  while (off < chunk.length) {
    const n = Math.min(65515, chunk.length - off);
    const payload = Buffer.allocUnsafe(n + 1);
    payload[0] = 1;
    chunk.copy(payload, 1, off, off + n);
    parts.push(pktBuf(payload));
    off += n;
  }
  return parts.length === 1 ? parts[0]! : Buffer.concat(parts);
}

function report(lines: string[]): Buffer {
  const framed = Buffer.concat([...lines.map((line) => pkt(line)), FLUSH]);
  return Buffer.concat([sideband(framed), FLUSH]);
}

const OK_MAIN = report(['unpack ok\n', 'ok refs/heads/main\n']);

interface Command {
  oldOid: string;
  newOid: string;
  ref: string;
}

function commandOf(data: Buffer): Command | null {
  let text = lineOf(data);
  const nul = text.indexOf('\0');
  if (nul >= 0) text = text.slice(0, nul);
  const space = text.indexOf(' ');
  const space2 = text.indexOf(' ', space + 1);
  if (space < 0 || space2 < 0) return null;
  const oldOid = text.slice(0, space).toLowerCase();
  const newOid = text.slice(space + 1, space2).toLowerCase();
  const ref = text.slice(space2 + 1);
  if (!/^[0-9a-f]{40}$/.test(oldOid) || !/^[0-9a-f]{40}$/.test(newOid) || !ref.startsWith('refs/')) return null;
  return { oldOid, newOid, ref };
}

function readPack(state: GitState, buf: Buffer): void {
  if (buf.length < 32 || buf.toString('ascii', 0, 4) !== 'PACK') throw new Error('bad pack');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error('bad version');
  const count = buf.readUInt32BE(8);
  let off = 12;
  for (let i = 0; i < count; i += 1) {
    let c = buf[off] ?? 0;
    off += 1;
    const type = (c >> 4) & 7;
    let size = c & 15;
    let shift = 4;
    while (c & 0x80) {
      c = buf[off] ?? 0;
      off += 1;
      size |= (c & 0x7f) << shift;
      shift += 7;
    }
    if (type < 1 || type > 4) throw new Error('delta');
    const inflated = inflateSync(buf.subarray(off), { info: true }) as unknown as InflateInfo;
    off += inflated.engine.bytesWritten;
    putRaw(state, TYPE_NAME[type] as GitType, inflated.buffer);
  }
  if (buf.length < 20) throw new Error('truncated pack');
  const actual = createHash('sha1').update(buf.subarray(0, buf.length - 20)).digest();
  if (!actual.equals(buf.subarray(buf.length - 20))) throw new Error('checksum');
}

function refusal(state: GitState, command: Command): string | null {
  const current = state.refs.get(command.ref);
  if (command.newOid === ZERO) return current === command.oldOid ? null : 'failed to lock';
  if (!state.objects.has(command.newOid)) return 'missing necessary objects';
  if (current === undefined) return command.oldOid === ZERO ? null : 'failed to lock';
  if (current !== command.oldOid) return 'failed to lock';
  if (!fastForward(state, command.oldOid, command.newOid)) return 'non-fast-forward';
  return null;
}

function apply(state: GitState, command: Command): void {
  if (command.newOid === ZERO) deleteRef(state, command.ref);
  else setRef(state, command.ref, command.newOid);
}

export function receivePack(state: GitState, body: Buffer): Buffer {
  const parsed = parsePkts(body, true);
  if (!parsed) return report(['unpack error\n']);
  const commands: Command[] = [];
  for (const pktLine of parsed.pkts) {
    if (pktLine.kind !== 'data') continue;
    const command = commandOf(pktLine.data);
    if (command) commands.push(command);
  }
  const pack = body.subarray(parsed.offset);
  try {
    if (pack.length > 0) readPack(state, pack);
  } catch {
    const lines = ['unpack error\n', ...commands.map((command) => `ng ${command.ref} unpacker error\n`)];
    return report(lines);
  }
  if (commands.length === 1) {
    const command = commands[0]!;
    const reason = refusal(state, command);
    if (reason) return report(['unpack ok\n', `ng ${command.ref} ${reason}\n`]);
    apply(state, command);
    if (command.ref === 'refs/heads/main' && command.newOid !== ZERO) return OK_MAIN;
    return report(['unpack ok\n', `ok ${command.ref}\n`]);
  }
  const lines = ['unpack ok\n'];
  for (const command of commands) {
    const reason = refusal(state, command);
    if (reason) lines.push(`ng ${command.ref} ${reason}\n`);
    else {
      apply(state, command);
      lines.push(`ok ${command.ref}\n`);
    }
  }
  return report(lines);
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

function fetchArgs(lines: readonly string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null };
  for (const line of lines) {
    if (line.startsWith('want ')) args.wants.push(line.slice(5, 45).toLowerCase());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5, 45).toLowerCase());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8, 48).toLowerCase());
    else if (line.startsWith('deepen ')) {
      const n = Number(line.slice(7));
      if (Number.isFinite(n) && n > 0) args.depth = Math.trunc(n);
    }
  }
  return args;
}

function addTree(state: GitState, oid: string, out: Set<string>): void {
  if (out.has(oid)) return;
  const obj = state.objects.get(oid);
  if (!obj) return;
  out.add(oid);
  if (obj.type !== 'tree') return;
  for (const entry of parseTree(obj.data)) {
    if (entry.mode !== '160000') addTree(state, entry.oid, out);
  }
}

function reachable(state: GitState, roots: readonly string[], shallow: ReadonlySet<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    const obj = state.objects.get(id);
    if (!obj) continue;
    seen.add(id);
    if (obj.type === 'commit') {
      if (obj.tree) addTree(state, obj.tree, seen);
      if (!shallow.has(id) && obj.parents) for (const parent of obj.parents) stack.push(parent);
    } else if (obj.type === 'tag') stack.push(peel(state, id));
    else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) if (entry.mode !== '160000') stack.push(entry.oid);
    }
  }
  return seen;
}

function selectObjects(state: GitState, args: FetchArgs): { objects: GitObj[]; shallow: string[]; unshallow: string[] } {
  const wantSet = args.wants.filter((oid) => state.objects.has(oid));
  const commits = new Set<string>();
  if (args.depth === null) {
    const stack = [...wantSet];
    while (stack.length > 0) {
      const id = stack.pop()!;
      const obj = state.objects.get(id);
      if (!obj || commits.has(id)) continue;
      if (obj.type === 'tag') {
        stack.push(peel(state, id));
        continue;
      }
      if (obj.type !== 'commit') continue;
      commits.add(id);
      if (obj.parents) for (const parent of obj.parents) stack.push(parent);
    }
  } else {
    let frontier = wantSet.map((oid) => (state.objects.get(oid)?.type === 'tag' ? peel(state, oid) : oid));
    for (let gen = 1; gen <= args.depth; gen += 1) {
      const next: string[] = [];
      for (const id of frontier) {
        if (commits.has(id)) continue;
        const obj = state.objects.get(id);
        if (!obj || obj.type !== 'commit') continue;
        commits.add(id);
        if (gen < args.depth && obj.parents) for (const parent of obj.parents) next.push(parent);
      }
      frontier = next;
    }
  }
  const include = new Set<string>();
  for (const oid of wantSet) {
    if (state.objects.get(oid)?.type === 'tag') include.add(oid);
  }
  for (const id of commits) {
    include.add(id);
    const tree = state.objects.get(id)?.tree;
    if (tree) addTree(state, tree, include);
  }
  const have = reachable(state, args.haves, new Set(args.shallow));
  const objects: GitObj[] = [];
  for (const oid of include) {
    if (have.has(oid)) continue;
    const obj = state.objects.get(oid);
    if (obj) objects.push(obj);
  }
  const boundary: string[] = [];
  if (args.depth !== null) {
    for (const id of commits) {
      const parents = state.objects.get(id)?.parents ?? [];
      if (parents.some((parent) => !commits.has(parent))) boundary.push(id);
    }
  }
  const unshallow: string[] = [];
  for (const id of args.shallow) {
    if (!commits.has(id)) continue;
    const parents = state.objects.get(id)?.parents ?? [];
    if (parents.every((parent) => commits.has(parent))) unshallow.push(id);
  }
  return { objects, shallow: boundary, unshallow };
}

function writePack(objects: readonly GitObj[]): Buffer {
  const chunks: Buffer[] = [Buffer.allocUnsafe(12)];
  chunks[0]!.write('PACK', 0, 'ascii');
  chunks[0]!.writeUInt32BE(2, 4);
  chunks[0]!.writeUInt32BE(objects.length, 8);
  for (const obj of objects) {
    chunks.push(encodeSize(TYPE_CODE[obj.type], obj.data.length));
    chunks.push(deflateSync(obj.data, { level: 1 }));
  }
  const body = Buffer.concat(chunks);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function encodeSize(type: number, size: number): Buffer {
  const bytes: number[] = [];
  let current = size;
  let byte = (type << 4) | (current & 15);
  current >>= 4;
  while (current > 0) {
    bytes.push(byte | 0x80);
    byte = current & 0x7f;
    current >>= 7;
  }
  bytes.push(byte);
  return Buffer.from(bytes);
}

function frameFetch(objects: readonly GitObj[], shallow: readonly string[], unshallow: readonly string[]): Buffer {
  const parts: Buffer[] = [pkt('acknowledgments\n'), pkt('NAK\n')];
  if (shallow.length > 0 || unshallow.length > 0) {
    parts.push(DELIM, pkt('shallow-info\n'));
    for (const oid of shallow) parts.push(pkt(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(pkt(`unshallow ${oid}\n`));
  }
  if (objects.length > 0) parts.push(DELIM, pkt('packfile\n'), sideband(writePack(objects)));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function lsRefs(state: GitState, lines: readonly string[]): Buffer {
  let peelWanted = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const line of lines) {
    if (line === 'peel') peelWanted = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const cacheable = peelWanted && symrefs && unborn && prefixes.length === 0;
  if (cacheable && state.lsDefault) return state.lsDefault;
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  if (keep('HEAD')) {
    if (state.head && state.refs.has(state.head)) {
      const oid = state.refs.get(state.head)!;
      parts.push(pkt(`${oid} HEAD${symrefs ? ` symref-target:${state.head}` : ''}\n`));
    } else if (unborn) {
      parts.push(pkt(`unborn HEAD symref-target:refs/heads/${state.defaultBranch}\n`));
    }
  }
  for (const name of [...state.refs.keys()].sort()) {
    if (!keep(name)) continue;
    const oid = state.refs.get(name)!;
    let extra = '';
    if (peelWanted) {
      const peeled = peel(state, oid);
      if (peeled !== oid) extra = ` peeled:${peeled}`;
    }
    parts.push(pkt(`${oid} ${name}${extra}\n`));
  }
  parts.push(FLUSH);
  const body = Buffer.concat(parts);
  if (cacheable) state.lsDefault = body;
  return body;
}

function commandLines(body: Buffer): { command: string; args: string[] } | null {
  const parsed = parsePkts(body, false);
  if (!parsed) return null;
  let command = '';
  let inArgs = false;
  const args: string[] = [];
  for (const pktLine of parsed.pkts) {
    if (pktLine.kind === 'delim') {
      inArgs = true;
      continue;
    }
    if (pktLine.kind !== 'data') continue;
    const text = lineOf(pktLine.data);
    if (!inArgs) {
      if (text.startsWith('command=')) command = text.slice('command='.length);
      continue;
    }
    args.push(text);
  }
  return { command, args };
}

function fetchV2(state: GitState, lines: readonly string[]): Buffer {
  const args = fetchArgs(lines);
  if (args.wants.length === 1 && args.haves.length === 0 && args.shallow.length === 0 && args.depth === 1) {
    const want = args.wants[0]!;
    const hit = state.shallow1.get(want);
    if (hit) return hit;
    if (state.objects.has(want)) {
      const selected = selectObjects(state, args);
      const body = frameFetch(selected.objects, selected.shallow, selected.unshallow);
      state.shallow1.set(want, body);
      return body;
    }
  }
  const selected = selectObjects(state, args);
  return frameFetch(selected.objects, selected.shallow, selected.unshallow);
}

function fetchV0(state: GitState, body: Buffer): Buffer {
  const parsed = parsePkts(body, false);
  if (!parsed) return Buffer.concat([pkt('NAK\n'), FLUSH]);
  const lines = parsed.pkts.filter((pktLine): pktLine is DataPkt => pktLine.kind === 'data').map((pktLine) => lineOf(pktLine.data));
  const selected = selectObjects(state, fetchArgs(lines));
  const parts: Buffer[] = [];
  for (const oid of selected.shallow) parts.push(pkt(`shallow ${oid}\n`));
  for (const oid of selected.unshallow) parts.push(pkt(`unshallow ${oid}\n`));
  parts.push(pkt('NAK\n'));
  if (selected.objects.length > 0) parts.push(sideband(writePack(selected.objects)));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

export function uploadPack(state: GitState, body: Buffer): Buffer {
  const head = body.subarray(0, Math.min(body.length, 80));
  const first = parsePkts(head, false);
  const data = first?.pkts.find((pktLine): pktLine is DataPkt => pktLine.kind === 'data');
  const text = data ? lineOf(data.data) : '';
  if (text.startsWith('command=')) {
    const command = commandLines(body);
    if (!command) return Buffer.concat([pkt('ERR parse\n'), FLUSH]);
    if (command.command === 'ls-refs') return lsRefs(state, command.args);
    if (command.command === 'fetch') return fetchV2(state, command.args);
    return Buffer.concat([pkt('ERR unknown command\n'), FLUSH]);
  }
  return fetchV0(state, body);
}

function lineCount(data: Buffer | undefined): number {
  if (!data || data.length === 0) return 0;
  let n = 1;
  for (let i = 0; i < data.length; i += 1) if (data[i] === 10) n += 1;
  if (data[data.length - 1] === 10) n -= 1;
  return n;
}

export interface FileDiff {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
}

export function diffFiles(state: GitState, baseOid: string, headOid: string): FileDiff[] {
  const base = mergeBase(state, baseOid, headOid) ?? baseOid;
  const left = new Map<string, string>();
  const right = new Map<string, string>();
  fileMap(state, commitTree(state, base), '', left);
  fileMap(state, commitTree(state, headOid), '', right);
  const out: FileDiff[] = [];
  const names = new Set<string>([...left.keys(), ...right.keys()]);
  for (const filename of names) {
    const before = left.get(filename);
    const after = right.get(filename);
    if (before === after) continue;
    const additions = after ? lineCount(state.objects.get(after)?.data) : 0;
    const deletions = before ? lineCount(state.objects.get(before)?.data) : 0;
    const status = before === undefined ? 'added' : after === undefined ? 'removed' : 'modified';
    out.push({ filename, status, additions, deletions, changes: additions + deletions });
  }
  return out;
}
