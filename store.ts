// store.ts — the forge's in-memory store: users, repositories, git objects,
// issues, pull requests, labels and comments. Everything is deterministic:
// fixed timestamps, sequential ids, no clock or randomness in stored state.
//
// The token owner's login is derived the same way the suite derives it: the
// kit's scenario seed is public and fixed, and its first generated user is
// the viewer. We replicate that generator here (FNV-1a + splitmix + xorshift)
// so the forge knows who its one bearer token belongs to without any
// outside service.

import {
  buildCommit,
  buildTree,
  collectReachable,
  hashObject,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  ZERO_OID,
} from './git.ts';
import type { GitObject, GitObjectType, TreeEntry } from './git.ts';

export const FIXED_TIME = '2025-01-01T00:00:00Z';
export const COMMIT_TIMESTAMP = 1700000000;

// --- scenario viewer (replica of the kit's wire.ts generators) -----------------

const U64_MASK = 0xffffffffffffffffn;
function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}
function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}
const SCENARIO_SEED = 0x6a09e667f3bcc909n;
class Rng {
  #state: bigint;
  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }
  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }
  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }
  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }
  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)];
  }
}
const FIRST_NAMES = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];
const LAST_NAMES = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];
function scenarioUsers(): { id: number; login: string; name: string; email: string }[] {
  const rng = new Rng(mix64(SCENARIO_SEED ^ fnv1a64('users')));
  const used = new Set<string>();
  const users: { id: number; login: string; name: string; email: string }[] = [];
  for (let i = 0; i < 12; i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    users.push({ id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid` });
  }
  return users;
}
const USERS = scenarioUsers();
export const VIEWER = USERS[0];
export const STRANGER = USERS[2];

// --- ids ----------------------------------------------------------------------

export function globalId(kind: string, payload: string): string {
  return Buffer.from(`${kind}:${payload}`, 'utf8').toString('base64');
}
export function decodeGlobalId(id: string): { kind: string; payload: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 1) return null;
    return { kind: text.slice(0, colon), payload: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

// --- domain types --------------------------------------------------------------

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}
export interface Comment {
  id: number;
  body: string;
  seq: number;
}
export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: Comment[];
  seq: number;
  closedAt: string | null;
}
export interface PullRequest {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  seq: number;
}
export interface Repo {
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  databaseId: number;
  id: string;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: PullRequest[];
  nextNumber: number;
  nextLabelId: number;
  nextCommentId: number;
  seq: number;
}

export class Store {
  readonly repos = new Map<string, Repo>();
  private nextDatabaseId = 1;
  private nextRepoSeq = 1;

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(name: string, opts: { description?: string; private?: boolean; defaultBranch?: string }): Repo | null {
    const owner = VIEWER.login;
    const key = this.key(owner, name);
    if (this.repos.has(key)) return null;
    const databaseId = this.nextDatabaseId++;
    const repo: Repo = {
      name,
      owner,
      description: opts.description ?? '',
      private: opts.private ?? false,
      defaultBranch: opts.defaultBranch ?? 'main',
      databaseId,
      id: globalId('Repository', `${owner}/${name}`),
      refs: new Map(),
      objects: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      nextNumber: 1,
      nextLabelId: 1,
      nextCommentId: 1,
      seq: this.nextRepoSeq++,
    };
    this.repos.set(key, repo);
    return repo;
  }

  /** A repository only when the path owner is the token owner; any other owner is a 404. */
  getRepo(owner: string, name: string): Repo | null {
    if (owner !== VIEWER.login) return null;
    return this.repos.get(this.key(owner, name)) ?? null;
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.seq - b.seq);
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(this.key(repo.owner, repo.name));
  }

  // --- git objects ------------------------------------------------------------

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  lookup(repo: Repo): (oid: string) => GitObject | undefined {
    return (oid: string) => repo.objects.get(oid);
  }

  refTip(repo: Repo, ref: string): string | null {
    return repo.refs.get(ref) ?? null;
  }

  /** Resolve a branch name, full ref, tag or commit oid to a commit oid (tags peeled). */
  resolveToCommit(repo: Repo, ref: string): string | null {
    let oid: string | null = null;
    if (ref.startsWith('refs/')) oid = repo.refs.get(ref) ?? null;
    else if (repo.refs.has(`refs/heads/${ref}`)) oid = repo.refs.get(`refs/heads/${ref}`)!;
    else if (repo.refs.has(`refs/tags/${ref}`)) oid = repo.refs.get(`refs/tags/${ref}`)!;
    else if (isObjectId(ref)) oid = ref;
    if (oid === null || !repo.objects.has(oid)) return null;
    let object = repo.objects.get(oid)!;
    let guard = 0;
    while (object.type === 'tag' && guard++ < 10) {
      oid = parseTag(object.data).object;
      object = repo.objects.get(oid) ?? object;
      if (!repo.objects.has(oid)) return null;
    }
    return object.type === 'commit' ? oid : null;
  }

  commitOf(repo: Repo, oid: string): { tree: string; parents: string[]; message: string } | null {
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') return null;
    const parsed = parseCommit(object.data);
    return { tree: parsed.tree, parents: parsed.parents, message: parsed.message };
  }

  /** Commits reachable from `tip`, newest first (BFS by generation, parents after children). */
  walkCommits(repo: Repo, tip: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const queue: string[] = [tip];
    while (queue.length) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const commit = this.commitOf(repo, oid);
      if (!commit) continue;
      out.push(oid);
      for (const parent of commit.parents) queue.push(parent);
    }
    return out;
  }

  isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
    if (ancestor === tip) return true;
    const seen = new Set<string>();
    const queue: string[] = [tip];
    while (queue.length) {
      const oid = queue.shift()!;
      if (oid === ancestor) return true;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const commit = this.commitOf(repo, oid);
      if (!commit) continue;
      for (const parent of commit.parents) queue.push(parent);
    }
    return false;
  }

  mergeBase(repo: Repo, a: string, b: string): string | null {
    const ancestorsA = new Set<string>();
    const queueA: string[] = [a];
    while (queueA.length) {
      const oid = queueA.shift()!;
      if (ancestorsA.has(oid)) continue;
      ancestorsA.add(oid);
      const commit = this.commitOf(repo, oid);
      if (commit) for (const parent of commit.parents) queueA.push(parent);
    }
    const queueB: string[] = [b];
    const seenB = new Set<string>();
    while (queueB.length) {
      const oid = queueB.shift()!;
      if (ancestorsA.has(oid)) return oid;
      if (seenB.has(oid)) continue;
      seenB.add(oid);
      const commit = this.commitOf(repo, oid);
      if (commit) for (const parent of commit.parents) queueB.push(parent);
    }
    return null;
  }

  /** Flatten a tree into path -> {oid, mode}. */
  flattenTree(repo: Repo, treeOid: string, prefix = '', out = new Map<string, { oid: string; mode: string }>()): Map<string, { oid: string; mode: string }> {
    const object = repo.objects.get(treeOid);
    if (!object || object.type !== 'tree') return out;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') this.flattenTree(repo, entry.oid, path, out);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
    return out;
  }

  /** Rebuild the tree for `files` (full path map) and store every tree object. */
  buildTreeFromFiles(repo: Repo, files: Map<string, { oid: string; mode: string }>): string {
    interface Node {
      files: Map<string, { oid: string; mode: string }>;
      dirs: Map<string, Node>;
    }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, entry] of files) {
      const segments = path.split('/');
      let node = root;
      for (let i = 0; i < segments.length - 1; i += 1) {
        const name = segments[i];
        if (!node.dirs.has(name)) node.dirs.set(name, make());
        node = node.dirs.get(name)!;
      }
      node.files.set(segments[segments.length - 1], entry);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return build(root);
  }

  makeCommit(repo: Repo, tree: string, parents: string[], message: string): string {
    const identity = `${VIEWER.login} <${VIEWER.email}>`;
    const data = buildCommit({
      tree,
      parents,
      message: message.endsWith('\n') ? message : `${message}\n`,
      author: identity,
      committer: identity,
      timestamp: COMMIT_TIMESTAMP,
    });
    return this.putObject(repo, 'commit', data);
  }

  /** Commit one file change on a branch; creates the branch at the default tip when missing. */
  commitFile(
    repo: Repo,
    branch: string,
    path: string,
    content: Buffer,
    message: string,
  ): { commitSha: string; contentSha: string; isUpdate: boolean } {
    const ref = `refs/heads/${branch}`;
    let tip = repo.refs.get(ref) ?? null;
    let parentTree: string | null = null;
    if (tip === null) {
      const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
      if (defaultTip !== null) {
        tip = defaultTip;
        parentTree = this.commitOf(repo, defaultTip)?.tree ?? null;
      }
    } else {
      parentTree = this.commitOf(repo, tip)?.tree ?? null;
    }
    const files = parentTree === null ? new Map() : this.flattenTree(repo, parentTree);
    const isUpdate = files.has(path);
    const blobOid = this.putObject(repo, 'blob', content);
    files.set(path, { oid: blobOid, mode: '100644' });
    const tree = this.buildTreeFromFiles(repo, files);
    const parents = tip === null ? [] : [tip];
    const commitSha = this.makeCommit(repo, tree, parents, message);
    repo.refs.set(ref, commitSha);
    return { commitSha, contentSha: blobOid, isUpdate };
  }

  deleteFile(repo: Repo, branch: string, path: string, message: string): string | null {
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref);
    if (!tip) return null;
    const commit = this.commitOf(repo, tip);
    if (!commit) return null;
    const files = this.flattenTree(repo, commit.tree);
    if (!files.has(path)) return null;
    files.delete(path);
    const tree = this.buildTreeFromFiles(repo, files);
    const commitSha = this.makeCommit(repo, tree, [tip], message);
    repo.refs.set(ref, commitSha);
    return commitSha;
  }

  // --- diff / merge -------------------------------------------------------------

  diffFiles(
    repo: Repo,
    baseTree: string | null,
    headTree: string | null,
  ): { filename: string; status: 'added' | 'removed' | 'modified'; additions: number; deletions: number; changes: number }[] {
    const base = baseTree === null ? new Map() : this.flattenTree(repo, baseTree);
    const head = headTree === null ? new Map() : this.flattenTree(repo, headTree);
    const paths = new Set([...base.keys(), ...head.keys()]);
    const out: { filename: string; status: 'added' | 'removed' | 'modified'; additions: number; deletions: number; changes: number }[] = [];
    for (const path of [...paths].sort()) {
      const b = base.get(path);
      const h = head.get(path);
      if (b && !h) {
        out.push({ filename: path, status: 'removed', additions: 0, deletions: this.countLines(repo, b.oid), changes: this.countLines(repo, b.oid) });
      } else if (!b && h) {
        const adds = this.countLines(repo, h.oid);
        out.push({ filename: path, status: 'added', additions: adds, deletions: 0, changes: adds });
      } else if (b && h && b.oid !== h.oid) {
        const { additions, deletions } = this.lineDiff(repo, b.oid, h.oid);
        out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
      }
    }
    return out;
  }

  private countLines(repo: Repo, oid: string): number {
    const object = repo.objects.get(oid);
    if (!object) return 0;
    const text = object.data.toString('utf8');
    if (text === '') return 0;
    return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  }

  private lineDiff(repo: Repo, oldOid: string, newOid: string): { additions: number; deletions: number } {
    const oldText = repo.objects.get(oldOid)?.data.toString('utf8') ?? '';
    const newText = repo.objects.get(newOid)?.data.toString('utf8') ?? '';
    const oldLines = new Set(oldText.split('\n'));
    const newLines = new Set(newText.split('\n'));
    let additions = 0;
    let deletions = 0;
    for (const line of newText.split('\n')) if (!oldLines.has(line)) additions += 1;
    for (const line of oldText.split('\n')) if (!newLines.has(line)) deletions += 1;
    return { additions, deletions };
  }

  /** True when merging `headTip` into `baseTip` would conflict (same path changed both ways). */
  mergeConflicts(repo: Repo, headTip: string, baseTip: string): boolean {
    const mb = this.mergeBase(repo, headTip, baseTip);
    if (mb === null) return headTip !== baseTip;
    const mbTree = this.commitOf(repo, mb)?.tree ?? null;
    const headTree = this.commitOf(repo, headTip)?.tree ?? null;
    const baseTree = this.commitOf(repo, baseTip)?.tree ?? null;
    const headDiff = new Map(this.diffFiles(repo, mbTree, headTree).map((d) => [d.filename, d]));
    const baseDiff = new Map(this.diffFiles(repo, mbTree, baseTree).map((d) => [d.filename, d]));
    const headFiles = headTree === null ? new Map() : this.flattenTree(repo, headTree);
    const baseFiles = baseTree === null ? new Map() : this.flattenTree(repo, baseTree);
    for (const path of headDiff.keys()) {
      if (!baseDiff.has(path)) continue;
      const h = headFiles.get(path)?.oid ?? null;
      const b = baseFiles.get(path)?.oid ?? null;
      if (h !== b) return true;
    }
    return false;
  }

  /** Squash-merge a pull request onto its base branch. Returns the merge commit or null on conflict. */
  mergePull(repo: Repo, pr: PullRequest): string | null {
    const headTip = this.resolveToCommit(repo, pr.head);
    const baseTip = this.resolveToCommit(repo, pr.base);
    if (headTip === null || baseTip === null) return null;
    if (this.mergeConflicts(repo, headTip, baseTip)) return null;
    const headTree = this.commitOf(repo, headTip)!.tree;
    const commitSha = this.makeCommit(repo, headTree, [baseTip], `Merge pull request #${pr.number} from ${repo.owner}/${pr.head}`);
    repo.refs.set(`refs/heads/${pr.base}`, commitSha);
    pr.state = 'closed';
    pr.merged = true;
    pr.mergedAt = FIXED_TIME;
    pr.mergeCommitSha = commitSha;
    pr.baseSha = commitSha;
    return commitSha;
  }

  // --- issues / pulls -----------------------------------------------------------

  createIssue(repo: Repo, title: string, body: string, labelNames: string[]): Issue | { error: string } {
    const labels: Label[] = [];
    for (const name of labelNames) {
      const label = repo.labels.get(name);
      if (!label) return { error: `label ${name} does not exist` };
      labels.push(label);
    }
    const issue: Issue = {
      number: repo.nextNumber++,
      title,
      body: body ?? '',
      state: 'open',
      labels,
      comments: [],
      seq: repo.nextNumber,
      closedAt: null,
    };
    issue.seq = repo.issues.length + repo.pulls.length + 1;
    repo.issues.push(issue);
    return issue;
  }

  createPull(repo: Repo, title: string, body: string, head: string, base: string): PullRequest | { error: string } {
    const headTip = this.resolveToCommit(repo, head);
    const baseTip = this.resolveToCommit(repo, base);
    if (headTip === null) return { error: `head branch ${head} does not exist` };
    if (baseTip === null) return { error: `base branch ${base} does not exist` };
    const open = repo.pulls.find((p) => p.state === 'open' && p.head === head && p.base === base);
    if (open) return { error: 'a pull request from this head branch is already open' };
    const pr: PullRequest = {
      number: repo.nextNumber++,
      title,
      body: body ?? '',
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      head,
      base,
      headSha: headTip,
      baseSha: baseTip,
      seq: repo.issues.length + repo.pulls.length + 1,
    };
    repo.pulls.push(pr);
    return pr;
  }

  reachableObjects(repo: Repo, tips: Iterable<string>): Set<string> {
    return collectReachable(tips, this.lookup(repo));
  }
}

export { ZERO_OID };
