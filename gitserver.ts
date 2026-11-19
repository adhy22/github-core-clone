// gitserver.ts — git smart HTTP: info/refs (protocol v2 and v0), upload-pack
// (ls-refs, fetch, shallow/deepen) and receive-pack (push with report-status).
// The client is the suite's own git client; there is no git binary anywhere.

import {
  decodePktLines,
  encodePktLine,
  encodePktLines,
  hashObject,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  readPack,
  writePack,
  ZERO_OID,
} from './git.ts';
import type { GitObject, GitObjectType } from './git.ts';
import { FIXED_TIME, VIEWER } from './store.ts';
import type { Repo, Store } from './store.ts';

const AGENT = 'forge/1.0';
const V2_CAPS = ['agent=forge/1.0', 'object-format=sha1', 'ls-refs=unborn', 'fetch=shallow'];
const V0_UPLOAD_CAPS = `agent=${AGENT} symref=HEAD:refs/heads/main multi_ack_detailed side-band-64k thin-pack ofs-delta shallow object-format=sha1`;
const V0_RECEIVE_CAPS = `agent=${AGENT} report-status report-status-v2 side-band-64k ofs-delta delete-refs object-format=sha1`;

export interface RefLine {
  name: string;
  oid: string;
  unborn?: boolean;
}

function sortedRefs(repo: Repo): { name: string; oid: string }[] {
  return [...repo.refs.entries()].map(([name, oid]) => ({ name, oid })).sort((a, b) => (a.name < b.name ? -1 : 1));
}

function defaultTip(repo: Repo): string | null {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
}

/** Peel an annotated tag ref to its target commit, or null when it is not a tag. */
function peeledOid(repo: Repo, oid: string): string | null {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'tag') return null;
  try {
    const target = parseTag(object.data).object;
    const targetObject = repo.objects.get(target);
    if (targetObject && targetObject.type === 'tag') return peeledOid(repo, target);
    return target;
  } catch {
    return null;
  }
}

// --- info/refs ------------------------------------------------------------------

export function infoRefsUpload(repo: Repo, version2: boolean): Buffer {
  if (version2) {
    const lines: (string | 'flush')[] = ['version 2\n'];
    for (const cap of V2_CAPS) lines.push(`${cap}\n`);
    lines.push('flush');
    return encodePktLines(lines);
  }
  const parts: Buffer[] = [encodePktLine('# service=git-upload-pack\n'), Buffer.from('0000', 'ascii')];
  const tip = defaultTip(repo);
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${V0_UPLOAD_CAPS}\n`));
  } else {
    parts.push(encodePktLine(`${tip ?? refs[0].oid} HEAD\0${V0_UPLOAD_CAPS}\n`));
    for (const ref of refs) {
      parts.push(encodePktLine(`${ref.oid} ${ref.name}\n`));
      const peeled = peeledOid(repo, ref.oid);
      if (peeled !== null) parts.push(encodePktLine(`${peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(parts);
}

export function infoRefsReceive(repo: Repo): Buffer {
  const parts: Buffer[] = [encodePktLine('# service=git-receive-pack\n'), Buffer.from('0000', 'ascii')];
  const tip = defaultTip(repo);
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${V0_RECEIVE_CAPS}\n`));
  } else {
    parts.push(encodePktLine(`${tip ?? refs[0].oid} HEAD\0${V0_RECEIVE_CAPS}\n`));
    for (const ref of refs) {
      parts.push(encodePktLine(`${ref.oid} ${ref.name}\n`));
      const peeled = peeledOid(repo, ref.oid);
      if (peeled !== null) parts.push(encodePktLine(`${peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(parts);
}

// --- ls-refs (v2) -----------------------------------------------------------------

export function lsRefsV2(repo: Repo, body: Buffer): Buffer {
  const { packets } = decodePktLines(body);
  let peel = false;
  let symrefs = false;
  const prefixes: string[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').trim();
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const tip = defaultTip(repo);
  const lines: string[] = [];
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  if (keep('HEAD')) {
    if (tip === null) lines.push(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
    else if (symrefs) lines.push(`${tip} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
    else lines.push(`${tip} HEAD\n`);
  }
  for (const ref of sortedRefs(repo)) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel) {
      const peeled = peeledOid(repo, ref.oid);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    lines.push(`${line}\n`);
  }
  lines.push('flush');
  return encodePktLines(lines as unknown as (string | 'flush')[]);
}

// --- fetch ------------------------------------------------------------------------

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  filter: string | null;
}

function parseFetchArgs(packets: { kind: string; payload?: Buffer }[]): FetchRequest {
  const req: FetchRequest = { wants: [], haves: [], shallow: [], depth: null, filter: null };
  for (const packet of packets) {
    if (packet.kind !== 'data' || !packet.payload) continue;
    const line = packet.payload.toString('utf8').trim();
    if (line.startsWith('want ')) req.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) req.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) req.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) req.depth = Number.parseInt(line.slice(7), 10);
    else if (line.startsWith('filter ')) req.filter = line.slice(7).trim();
  }
  return req;
}

/** Commits to include for a fetch, plus the shallow boundary oids. */
function planFetch(
  store: Store,
  repo: Repo,
  req: FetchRequest,
): { commits: Set<string>; shallowOut: string[]; unshallowOut: string[] } {
  const included = new Set<string>();
  const shallowOut: string[] = [];
  const unshallowOut: string[] = [];
  // Resolve wants to commits (tags peeled).
  const wantCommits: string[] = [];
  for (const want of req.wants) {
    const commit = store.resolveToCommit(repo, want);
    if (commit !== null) wantCommits.push(commit);
  }
  if (req.depth !== null && Number.isFinite(req.depth) && req.depth > 0) {
    // BFS by generation: want is depth 1.
    const depthOf = new Map<string, number>();
    const queue: string[] = [];
    for (const c of wantCommits) {
      if (!depthOf.has(c)) {
        depthOf.set(c, 1);
        queue.push(c);
      }
    }
    while (queue.length) {
      const oid = queue.shift()!;
      const d = depthOf.get(oid)!;
      included.add(oid);
      if (d >= req.depth) {
        const commit = store.commitOf(repo, oid);
        if (commit && commit.parents.length > 0) shallowOut.push(oid);
        continue;
      }
      const commit = store.commitOf(repo, oid);
      if (!commit) continue;
      for (const parent of commit.parents) {
        if (!depthOf.has(parent)) {
          depthOf.set(parent, d + 1);
          queue.push(parent);
        }
      }
    }
    for (const old of req.shallow) {
      if (included.has(old) && !shallowOut.includes(old)) unshallowOut.push(old);
    }
  } else if (req.shallow.length > 0) {
    // No deepen: honour the client's existing shallow boundaries (do not cross them).
    const queue: string[] = [...wantCommits];
    const seen = new Set<string>();
    while (queue.length) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      included.add(oid);
      if (req.shallow.includes(oid)) {
        shallowOut.push(oid);
        continue;
      }
      const commit = store.commitOf(repo, oid);
      if (!commit) continue;
      for (const parent of commit.parents) queue.push(parent);
    }
  } else {
    for (const oid of store.walkCommits(repo, wantCommits[0] ?? '')) included.add(oid);
    for (const c of wantCommits.slice(1)) for (const oid of store.walkCommits(repo, c)) included.add(oid);
  }
  return { commits: included, shallowOut, unshallowOut };
}

function fetchPack(store: Store, repo: Repo, req: FetchRequest): { pack: Buffer; shallow: string[]; unshallow: string[] } {
  const { commits, shallowOut, unshallowOut } = planFetch(store, repo, req);
  // Objects reachable from the included commits (their trees/blobs), plus any
  // wanted tag objects themselves.
  const wanted = new Set<string>();
  for (const oid of req.wants) {
    if (repo.objects.has(oid)) wanted.add(oid);
  }
  const includedObjects = new Set<string>();
  for (const commitOid of commits) {
    const commit = store.commitOf(repo, commitOid);
    if (!commit) continue;
    includedObjects.add(commitOid);
    const flat = store.flattenTree(repo, commit.tree);
    for (const entry of flat.values()) includedObjects.add(entry.oid);
    // The tree objects themselves, walked down from the root tree.
    const queue: string[] = [commit.tree];
    const seenTrees = new Set<string>();
    while (queue.length) {
      const treeOid = queue.shift()!;
      if (seenTrees.has(treeOid)) continue;
      seenTrees.add(treeOid);
      includedObjects.add(treeOid);
      const object = repo.objects.get(treeOid);
      if (!object || object.type !== 'tree') continue;
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '40000') queue.push(entry.oid);
      }
    }
  }
  for (const oid of wanted) {
    const object = repo.objects.get(oid);
    if (object && object.type === 'tag') includedObjects.add(oid);
  }
  // Exclude everything the client's haves already reach (thin-pack rule).
  // A have that is also a shallow boundary is held shallowly: the client has
  // that commit and its tree/blobs, but not its ancestors, so only those
  // objects are excluded — otherwise a deepen could never deliver the parent.
  const excluded = new Set<string>();
  const shallowSet = new Set(req.shallow);
  for (const have of req.haves) {
    const commit = store.resolveToCommit(repo, have);
    if (commit === null) continue;
    if (shallowSet.has(commit)) {
      excluded.add(commit);
      const parsed = store.commitOf(repo, commit);
      if (parsed) {
        const flat = store.flattenTree(repo, parsed.tree);
        for (const entry of flat.values()) excluded.add(entry.oid);
        const queue: string[] = [parsed.tree];
        const seenTrees = new Set<string>();
        while (queue.length) {
          const treeOid = queue.shift()!;
          if (seenTrees.has(treeOid)) continue;
          seenTrees.add(treeOid);
          excluded.add(treeOid);
          const object = repo.objects.get(treeOid);
          if (!object || object.type !== 'tree') continue;
          for (const entry of parseTree(object.data)) {
            if (entry.mode === '40000') queue.push(entry.oid);
          }
        }
      }
      continue;
    }
    try {
      for (const oid of store.reachableObjects(repo, [commit])) excluded.add(oid);
    } catch {
      // A have the server cannot resolve is ignored.
    }
  }
  const objects: GitObject[] = [];
  for (const oid of includedObjects) {
    if (excluded.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object) objects.push(object);
  }
  // Deterministic order: commits first (by oid), then trees, then blobs.
  const rank = (t: GitObjectType): number => (t === 'commit' ? 0 : t === 'tag' ? 1 : t === 'tree' ? 2 : 3);
  objects.sort((a, b) => rank(a.type) - rank(b.type) || (hashObject(a.type, a.data) < hashObject(b.type, b.data) ? -1 : 1));
  return { pack: writePack(objects), shallow: shallowOut, unshallow: unshallowOut };
}

function sidebandPackets(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 65514;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    out.push(encodePktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  return out;
}

export function uploadPackV2(store: Store, repo: Repo, body: Buffer): Buffer {
  const { packets, rawOffset } = decodePktLines(body);
  void rawOffset;
  const lines = packets.filter((p) => p.kind === 'data').map((p) => (p as { payload: Buffer }).payload.toString('utf8').trim());
  const command = lines.find((l) => l.startsWith('command='))?.slice('command='.length) ?? '';
  if (command === 'ls-refs') return lsRefsV2(repo, body);
  if (command !== 'fetch') throw new Error(`unsupported upload-pack command ${command}`);
  const req = parseFetchArgs(packets);
  const { pack, shallow, unshallow } = fetchPack(store, repo, req);
  const parts: Buffer[] = [];
  parts.push(encodePktLine('acknowledgments\n'));
  parts.push(encodePktLine('NAK\n'));
  parts.push(Buffer.from('0000', 'ascii'));
  if (shallow.length > 0 || unshallow.length > 0) {
    parts.push(encodePktLine('shallow-info\n'));
    for (const oid of shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
    parts.push(Buffer.from('0000', 'ascii'));
  }
  parts.push(encodePktLine('packfile\n'));
  for (const packet of sidebandPackets(pack)) parts.push(packet);
  parts.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(parts);
}

export function uploadPackV0(store: Store, repo: Repo, body: Buffer): Buffer {
  const { packets } = decodePktLines(body);
  const req = parseFetchArgs(packets);
  const { pack, shallow, unshallow } = fetchPack(store, repo, req);
  const parts: Buffer[] = [];
  parts.push(encodePktLine('NAK\n'));
  for (const oid of shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
  for (const packet of sidebandPackets(pack)) parts.push(packet);
  return Buffer.concat(parts);
}

// --- receive-pack -------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function receivePack(store: Store, repo: Repo, body: Buffer): Buffer {
  const { packets, rawOffset } = decodePktLines(body);
  const commands: PushCommand[] = [];
  let requestedSideband = false;
  let unpackOk = true;
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8');
    const nul = text.indexOf('\0');
    const head = nul >= 0 ? text.slice(0, nul) : text;
    if (nul >= 0) {
      const caps = text.slice(nul + 1).trim().split(/\s+/);
      if (caps.includes('side-band-64k')) requestedSideband = true;
    }
    const line = head.replace(/\n$/, '');
    const parts = line.split(' ');
    if (parts.length >= 3 && isObjectId(parts[0]) && isObjectId(parts[1])) {
      commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
    }
  }
  const packBytes = body.subarray(rawOffset);
  if (packBytes.length > 0) {
    try {
      const read = readPack(packBytes, { resolveBase: (oid) => repo.objects.get(oid) });
      for (const [oid, object] of read.objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch {
      unpackOk = false;
    }
  }
  const reportLines: string[] = [];
  reportLines.push(unpackOk ? 'unpack ok\n' : 'unpack unpacker error\n');
  for (const command of commands) {
    if (!unpackOk) {
      reportLines.push(`ng ${command.ref} unpack failed\n`);
      continue;
    }
    const current = repo.refs.get(command.ref) ?? null;
    let reason: string | null = null;
    if (!/^refs\/(heads|tags)\//.test(command.ref)) {
      reason = 'invalid ref';
    } else if (command.oldOid !== (current ?? ZERO_OID)) {
      reason = current === null ? 'ref does not exist' : 'old oid mismatch';
    } else if (command.newOid === ZERO_OID) {
      if (current === null) reason = 'ref does not exist';
    } else {
      const object = repo.objects.get(command.newOid);
      if (!object) {
        reason = 'missing object';
      } else if (command.ref.startsWith('refs/heads/') && object.type !== 'commit') {
        reason = 'not a commit';
      } else if (command.ref.startsWith('refs/heads/') && current !== null && current !== ZERO_OID) {
        if (!store.isAncestor(repo, current, command.newOid)) reason = 'non-fast-forward';
      }
    }
    if (reason === null) {
      if (command.newOid === ZERO_OID) repo.refs.delete(command.ref);
      else repo.refs.set(command.ref, command.newOid);
      reportLines.push(`ok ${command.ref}\n`);
    } else {
      reportLines.push(`ng ${command.ref} ${reason}\n`);
    }
  }
  const report = encodePktLines([...reportLines, 'flush']);
  if (!requestedSideband) return report;
  // Wrap the report pkt-lines in sideband band 1.
  const { packets: reportPackets } = decodePktLines(report);
  const parts: Buffer[] = [];
  for (const packet of reportPackets) {
    if (packet.kind === 'data') {
      parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), packet.payload])));
    } else if (packet.kind === 'flush') {
      parts.push(Buffer.from('0000', 'ascii'));
    }
  }
  return Buffer.concat(parts);
}

export { FIXED_TIME, VIEWER };
