// app.ts — the forge's HTTP server: REST v3 under /api/v3, git smart HTTP
// under /{owner}/{repo}.git, GraphQL at /api/graphql and MCP at /mcp.
// Node standard library only. Every REST reply is JSON with a non-empty
// X-GitHub-Request-Id; errors carry a JSON {message}.

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { hashObject, isObjectId, parseCommit, parseTree } from './git.ts';
import { infoRefsReceive, infoRefsUpload, receivePack, uploadPackV0, uploadPackV2 } from './gitserver.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { FIXED_TIME, Store, VIEWER, decodeGlobalId, globalId } from './store.ts';
import type { Issue, PullRequest, Repo } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

export const store = new Store();
let requestCounter = 0;

function requestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = status === 204 ? '' : `${JSON.stringify(body)}\n`;
  const headers: Record<string, string> = { 'x-github-request-id': requestId(), ...extra };
  if (status !== 204) {
    headers['content-type'] = JSON_TYPE;
    headers['content-length'] = String(Buffer.byteLength(text));
  }
  res.writeHead(status, headers);
  res.end(text);
}

function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': String(body.length),
    'x-github-request-id': requestId(),
  });
  res.end(body);
}

function notFound(res: ServerResponse, message = 'Not Found'): void {
  sendJson(res, 404, { message });
}

function unauthorized(res: ServerResponse): void {
  sendJson(res, 401, { message: 'Bad credentials' });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Parse a JSON body; returns null when there is no body, throws on malformed JSON. */
function parseJsonBody(raw: Buffer): unknown {
  const text = raw.toString('utf8').trim();
  if (text === '') return null;
  return JSON.parse(text);
}

function authed(req: IncomingMessage): boolean {
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  if (expected === '') return token !== '';
  return token === expected;
}

function pathOf(req: IncomingMessage): string {
  try {
    return decodeURIComponent(new URL(req.url ?? '/', 'http://entry').pathname);
  } catch {
    return '/';
  }
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

// --- REST view builders ----------------------------------------------------------

function repoView(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: repo.id,
    databaseId: repo.databaseId,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User', avatar_url: null },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: FIXED_TIME,
    updated_at: FIXED_TIME,
    pushed_at: FIXED_TIME,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    clone_url: `https://example.invalid/${repo.owner}/${repo.name}.git`,
    git_url: `git://example.invalid/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@example.invalid:${repo.owner}/${repo.name}.git`,
    homepage: null,
    language: null,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    archived: false,
    disabled: false,
    visibility: repo.private ? 'private' : 'public',
    fork: false,
    size: 0,
  };
}

function issueView(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: repo.databaseId * 100000 + issue.number,
    node_id: globalId('Issue', `${repo.owner}/${repo.name}#${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((l) => ({ id: l.id, name: l.name, color: l.color, description: l.description })),
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    assignee: null,
    assignees: [],
    created_at: FIXED_TIME,
    updated_at: FIXED_TIME,
    closed_at: issue.closedAt,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    comments: issue.comments.length,
    comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
  };
}

function pullView(repo: Repo, pr: PullRequest): Record<string, unknown> {
  return {
    id: repo.databaseId * 100000 + pr.number,
    node_id: globalId('PullRequest', `${repo.owner}/${repo.name}#${pr.number}`),
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    merged: pr.merged,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    head: { ref: pr.head, sha: pr.headSha, label: `${repo.owner}:${pr.head}` },
    base: { ref: pr.base, sha: pr.baseSha, label: `${repo.owner}:${pr.base}` },
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: FIXED_TIME,
    updated_at: FIXED_TIME,
    closed_at: pr.state === 'closed' ? FIXED_TIME : null,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pr.number}`,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pr.number}`,
  };
}

function paginate<T>(items: T[], query: URLSearchParams, req: IncomingMessage, path: string): { page: T[]; link: string | null } {
  const perPage = Math.min(100, Math.max(1, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  let link: string | null = null;
  if (start + perPage < items.length) {
    const host = req.headers.host ?? 'localhost';
    const url = new URL(`http://${host}${path}`);
    url.searchParams.set('per_page', String(perPage));
    url.searchParams.set('page', String(page + 1));
    link = `<${url.toString()}>; rel="next"`;
  }
  return { page: slice, link };
}

function linkHeader(res: ServerResponse, link: string | null): Record<string, string> {
  return link === null ? {} : { link };
}

// --- git ref helpers ---------------------------------------------------------------

function branchTip(repo: Repo, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

function commitView(repo: Repo, sha: string): Record<string, unknown> | null {
  const object = repo.objects.get(sha);
  if (!object || object.type !== 'commit') return null;
  const parsed = parseCommit(object.data);
  return {
    sha,
    commit: {
      message: parsed.message.replace(/\n$/, ''),
      author: { name: VIEWER.login, email: VIEWER.email, date: FIXED_TIME },
      committer: { name: VIEWER.login, email: VIEWER.email, date: FIXED_TIME },
      tree: { sha: parsed.tree },
    },
    parents: parsed.parents.map((p) => ({ sha: p })),
    author: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    committer: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
  };
}

// --- the server ----------------------------------------------------------------------

export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const path = pathOf(req);
      const method = req.method ?? 'GET';
      const query = queryOf(req);

      if (method === 'GET' && path === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      // --- git smart HTTP ---------------------------------------------------------
      const gitMatch = /^\/([^/]+)\/([^/]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
      if (gitMatch) {
        if (!authed(req)) {
          unauthorized(res);
          return;
        }
        const owner = gitMatch[1];
        const repoName = gitMatch[2];
        const service = gitMatch[3];
        const repo = store.getRepo(owner, repoName);
        if (repo === null) {
          notFound(res, 'Not Found');
          return;
        }
        if (service === 'info/refs') {
          const serviceParam = query.get('service') ?? '';
          if (serviceParam === 'git-upload-pack') {
            const v2 = (req.headers['git-protocol'] ?? '') === 'version=2';
            sendBuffer(res, 200, infoRefsUpload(repo, v2), 'application/x-git-upload-pack-advertisement');
            return;
          }
          if (serviceParam === 'git-receive-pack') {
            sendBuffer(res, 200, infoRefsReceive(repo), 'application/x-git-receive-pack-advertisement');
            return;
          }
          sendJson(res, 400, { message: 'unknown service' });
          return;
        }
        const body = await readBody(req);
        try {
          if (service === 'git-upload-pack') {
            const v2 = (req.headers['git-protocol'] ?? '') === 'version=2';
            const out = v2 ? uploadPackV2(store, repo, body) : uploadPackV0(store, repo, body);
            sendBuffer(res, 200, out, 'application/x-git-upload-pack-result');
          } else {
            const out = receivePack(store, repo, body);
            sendBuffer(res, 200, out, 'application/x-git-receive-pack-result');
          }
        } catch {
          sendJson(res, 400, { message: 'malformed git request' });
        }
        return;
      }

      // --- GraphQL ------------------------------------------------------------------
      if (path === '/api/graphql') {
        if (method !== 'POST') {
          sendJson(res, 405, { message: 'Method Not Allowed' });
          return;
        }
        const raw = await readBody(req);
        let parsed: unknown;
        try {
          parsed = parseJsonBody(raw);
        } catch {
          sendJson(res, 400, { message: 'malformed JSON body' });
          return;
        }
        if (!authed(req)) {
          unauthorized(res);
          return;
        }
        const answer = executeGraphQL(store, parsed);
        sendJson(res, 200, answer);
        return;
      }

      // --- MCP ------------------------------------------------------------------------
      if (path === '/mcp') {
        const raw = await readBody(req);
        if (method !== 'POST') {
          sendJson(res, 405, { message: 'Method Not Allowed' });
          return;
        }
        // A body that is not JSON is a JSON-RPC parse error (HTTP 400, -32700),
        // whatever the auth state is.
        let parsed: unknown;
        try {
          parsed = parseJsonBody(raw);
        } catch {
          sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
          return;
        }
        if (!authed(req)) {
          unauthorized(res);
          return;
        }
        const { status, body } = handleMcp(store, parsed);
        if (status === 202) {
          res.writeHead(202, { 'x-github-request-id': requestId(), 'content-length': '0' });
          res.end();
          return;
        }
        sendJson(res, status, body);
        return;
      }

      // --- REST v3 ----------------------------------------------------------------------
      if (path === '/api/v3' || path.startsWith('/api/v3/')) {
        await handleRest(req, res, path, method, query);
        return;
      }

      notFound(res);
    })().catch(() => {
      if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
      else res.end();
    });
  });
}

async function handleRest(req: IncomingMessage, res: ServerResponse, path: string, method: string, query: URLSearchParams): Promise<void> {
  const segments = path.split('/').filter((s) => s !== '');
  // segments[0..1] are api/v3; the rest is the resource path.
  const rest = segments.slice(2);

  // JSON body parsing for methods that carry one.
  let body: unknown = null;
  let bodyPresent = false;
  if (method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE') {
    const raw = await readBody(req);
    if (raw.length > 0) {
      bodyPresent = true;
      try {
        body = parseJsonBody(raw);
      } catch {
        sendJson(res, 400, { message: 'malformed JSON body' });
        return;
      }
    }
  }
  void bodyPresent;
  const obj = isRecord(body) ? body : {};

  if (!authed(req)) {
    unauthorized(res);
    return;
  }

  // API root and meta.
  if (rest.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
      return;
    }
    notFound(res);
    return;
  }
  if (rest.length === 1 && rest[0] === 'meta' && method === 'GET') {
    sendJson(res, 200, { installed_version: '1.0.0', verifiable_password_authentication: true });
    return;
  }
  if (rest.length === 1 && rest[0] === 'rate_limit' && method === 'GET') {
    sendJson(res, 200, {
      resources: { core: { limit: 5000, remaining: 5000, reset: 1700000000, used: 0 } },
      rate: { limit: 5000, remaining: 5000, reset: 1700000000, used: 0 },
    });
    return;
  }
  if (rest.length === 1 && rest[0] === 'user') {
    if (method === 'GET') {
      sendJson(res, 200, {
        login: VIEWER.login,
        id: VIEWER.id,
        node_id: globalId('User', VIEWER.login),
        name: VIEWER.name,
        email: VIEWER.email,
        type: 'User',
        avatar_url: null,
        html_url: `https://example.invalid/${VIEWER.login}`,
        url: '/api/v3/user',
      });
      return;
    }
    notFound(res);
    return;
  }
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'GET') {
      const { page, link } = paginate(store.listRepos().map((r) => repoView(r)), query, req, path);
      sendJson(res, 200, page, linkHeader(res, link));
      return;
    }
    if (method === 'POST') {
      const name = typeof obj.name === 'string' ? obj.name.trim() : '';
      if (name === '' || /[^A-Za-z0-9._-]/.test(name)) {
        sendJson(res, 422, { message: 'name is invalid' });
        return;
      }
      const repo = store.createRepo(name, {
        description: typeof obj.description === 'string' ? obj.description : '',
        private: obj.private === true,
        defaultBranch: typeof obj.default_branch === 'string' ? obj.default_branch : 'main',
      });
      if (repo === null) {
        sendJson(res, 422, { message: 'Repository already exists' });
        return;
      }
      sendJson(res, 201, repoView(repo));
      return;
    }
    notFound(res);
    return;
  }

  // /repos/{owner}/{repo}[/...]
  if (rest[0] !== 'repos' || rest.length < 3) {
    notFound(res);
    return;
  }
  const owner = rest[1];
  const repoName = rest[2];
  const repo = store.getRepo(owner, repoName);
  if (repo === null) {
    notFound(res, 'Not Found');
    return;
  }
  const tail = rest.slice(3);

  // GET / PATCH / DELETE /repos/{o}/{r}
  if (tail.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, repoView(repo));
      return;
    }
    if (method === 'PATCH') {
      if (typeof obj.description === 'string') repo.description = obj.description;
      if (typeof obj.private === 'boolean') repo.private = obj.private;
      sendJson(res, 200, repoView(repo));
      return;
    }
    if (method === 'DELETE') {
      store.deleteRepo(repo);
      sendJson(res, 204, null);
      return;
    }
    notFound(res);
    return;
  }

  // Branches.
  if (tail[0] === 'branches') {
    if (tail.length === 1 && method === 'GET') {
      const branches = [...repo.refs.keys()]
        .filter((r) => r.startsWith('refs/heads/'))
        .map((r) => r.slice('refs/heads/'.length))
        .sort()
        .map((name) => ({ name, commit: { sha: repo.refs.get(`refs/heads/${name}`)! }, protected: false }));
      sendJson(res, 200, branches);
      return;
    }
    if (tail.length >= 2 && method === 'GET') {
      const branch = tail.slice(1).join('/');
      const tip = branchTip(repo, branch);
      if (tip === null) {
        notFound(res, 'Branch not found');
        return;
      }
      sendJson(res, 200, { name: branch, commit: { sha: tip }, protected: false });
      return;
    }
    notFound(res);
    return;
  }

  // Commits.
  if (tail[0] === 'commits') {
    if (tail.length === 1 && method === 'GET') {
      const ref = query.get('sha') ?? repo.defaultBranch;
      const tip = store.resolveToCommit(repo, ref);
      if (tip === null) {
        sendJson(res, 200, []);
        return;
      }
      const walked = store.walkCommits(repo, tip);
      const views = walked.map((sha) => commitView(repo, sha)).filter((v): v is Record<string, unknown> => v !== null);
      const { page } = paginate(views, query, req, path);
      sendJson(res, 200, page);
      return;
    }
    if (tail.length === 2 && method === 'GET') {
      const view = commitView(repo, tail[1]);
      if (view === null) {
        notFound(res, 'Commit not found');
        return;
      }
      sendJson(res, 200, view);
      return;
    }
    notFound(res);
    return;
  }

  // Contents.
  if (tail[0] === 'contents') {
    const filePath = tail.slice(1).join('/');
    const refParam = query.get('ref') ?? undefined;
    if (method === 'GET') {
      const tip = refParam === undefined ? branchTip(repo, repo.defaultBranch) : store.resolveToCommit(repo, refParam);
      if (tip === null) {
        notFound(res, 'Not Found');
        return;
      }
      const commit = store.commitOf(repo, tip);
      if (!commit) {
        notFound(res, 'Not Found');
        return;
      }
      const files = store.flattenTree(repo, commit.tree);
      if (filePath === '') {
        // Root directory listing.
        const entries = dirEntries(repo, files, '');
        sendJson(res, 200, entries);
        return;
      }
      const file = files.get(filePath);
      if (file) {
        const object = repo.objects.get(file.oid);
        const content = object ? object.data.toString('base64') : '';
        sendJson(res, 200, {
          type: 'file',
          encoding: 'base64',
          size: object ? object.data.length : 0,
          name: filePath.split('/').pop(),
          path: filePath,
          content,
          sha: file.oid,
          url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${filePath}`,
          download_url: null,
        });
        return;
      }
      const prefix = `${filePath}/`;
      const hasChildren = [...files.keys()].some((p) => p.startsWith(prefix));
      if (hasChildren) {
        sendJson(res, 200, dirEntries(repo, files, filePath));
        return;
      }
      notFound(res, 'Not Found');
      return;
    }
    if (method === 'PUT') {
      const message = typeof obj.message === 'string' ? obj.message : 'update';
      const contentB64 = typeof obj.content === 'string' ? obj.content : '';
      let content: Buffer;
      try {
        content = Buffer.from(contentB64.replace(/\s+/g, ''), 'base64');
      } catch {
        sendJson(res, 422, { message: 'content is not valid base64' });
        return;
      }
      const branch = typeof obj.branch === 'string' && obj.branch !== '' ? obj.branch : repo.defaultBranch;
      const tip = branchTip(repo, branch);
      const existing = tip === null ? null : store.flattenTree(repo, store.commitOf(repo, tip)?.tree ?? '').get(filePath) ?? null;
      if (typeof obj.sha === 'string' && obj.sha !== '') {
        if (existing === null) {
          sendJson(res, 422, { message: 'file does not exist' });
          return;
        }
        if (existing.oid.toLowerCase() !== obj.sha.toLowerCase()) {
          sendJson(res, 409, { message: 'sha does not match the current file' });
          return;
        }
      }
      const result = store.commitFile(repo, branch, filePath, content, message);
      sendJson(res, result.isUpdate ? 200 : 201, {
        content: {
          name: filePath.split('/').pop(),
          path: filePath,
          sha: result.contentSha,
          size: content.length,
          encoding: 'base64',
          type: 'file',
        },
        commit: { sha: result.commitSha, message },
      });
      return;
    }
    if (method === 'DELETE') {
      const branch = typeof obj.branch === 'string' && obj.branch !== '' ? obj.branch : repo.defaultBranch;
      const tip = branchTip(repo, branch);
      if (tip === null) {
        notFound(res, 'Not Found');
        return;
      }
      const files = store.flattenTree(repo, store.commitOf(repo, tip)?.tree ?? '');
      if (!files.has(filePath)) {
        notFound(res, 'Not Found');
        return;
      }
      const message = typeof obj.message === 'string' ? obj.message : 'delete';
      const commitSha = store.deleteFile(repo, branch, filePath, message);
      if (commitSha === null) {
        notFound(res, 'Not Found');
        return;
      }
      sendJson(res, 200, { commit: { sha: commitSha, message } });
      return;
    }
    notFound(res);
    return;
  }

  // Git data: refs.
  if (tail[0] === 'git' && tail[1] === 'refs') {
    if (method === 'POST' && tail.length === 2) {
      const ref = typeof obj.ref === 'string' ? obj.ref : '';
      const sha = typeof obj.sha === 'string' ? obj.sha : '';
      if (!/^refs\/(heads|tags)\//.test(ref) || !isObjectId(sha) || !repo.objects.has(sha)) {
        sendJson(res, 422, { message: 'invalid ref or sha' });
        return;
      }
      if (repo.refs.has(ref)) {
        sendJson(res, 422, { message: 'Reference already exists' });
        return;
      }
      repo.refs.set(ref, sha);
      const type = repo.objects.get(sha)!.type;
      sendJson(res, 201, { ref, object: { sha, type }, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/refs/${ref}` });
      return;
    }
    if (method === 'GET' && tail.length === 2) {
      const refs = sortedRefViews(repo);
      sendJson(res, 200, refs);
      return;
    }
    if (method === 'GET' && tail.length >= 3) {
      const ref = tail.slice(2).join('/');
      const full = ref.startsWith('refs/') ? ref : `refs/${ref}`;
      const oid = repo.refs.get(full) ?? repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(`refs/tags/${ref}`) ?? null;
      if (oid === null) {
        notFound(res, 'Reference not found');
        return;
      }
      const type = repo.objects.get(oid)?.type ?? 'commit';
      sendJson(res, 200, { ref: full, object: { sha: oid, type }, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/refs/${full}` });
      return;
    }
    notFound(res);
    return;
  }

  // Git data: single commit.
  if (tail[0] === 'git' && tail[1] === 'commits' && tail.length === 3 && method === 'GET') {
    const view = commitView(repo, tail[2]);
    if (view === null) {
      notFound(res, 'Commit not found');
      return;
    }
    sendJson(res, 200, view);
    return;
  }

  // Labels.
  if (tail[0] === 'labels') {
    if (tail.length === 1 && method === 'GET') {
      sendJson(res, 200, [...repo.labels.values()].map((l) => ({ id: l.id, name: l.name, color: l.color, description: l.description })));
      return;
    }
    if (tail.length === 1 && method === 'POST') {
      const name = typeof obj.name === 'string' ? obj.name : '';
      if (name === '') {
        sendJson(res, 422, { message: 'name is required' });
        return;
      }
      const existing = repo.labels.get(name);
      if (existing) {
        sendJson(res, 201, { id: existing.id, name: existing.name, color: existing.color, description: existing.description });
        return;
      }
      const label = {
        id: repo.nextLabelId++,
        name,
        color: typeof obj.color === 'string' ? obj.color : 'ededed',
        description: typeof obj.description === 'string' ? obj.description : '',
      };
      repo.labels.set(name, label);
      sendJson(res, 201, { id: label.id, name: label.name, color: label.color, description: label.description });
      return;
    }
    notFound(res);
    return;
  }

  // Issues.
  if (tail[0] === 'issues') {
    if (tail.length === 1 && method === 'POST') {
      const title = typeof obj.title === 'string' ? obj.title : '';
      const bodyText = typeof obj.body === 'string' ? obj.body : '';
      const labelNames: string[] = [];
      if (Array.isArray(obj.labels)) {
        for (const entry of obj.labels) {
          if (typeof entry === 'string') labelNames.push(entry);
          else if (isRecord(entry) && typeof entry.name === 'string') labelNames.push(entry.name);
        }
      }
      const created = store.createIssue(repo, title, bodyText, labelNames);
      if ('error' in created) {
        sendJson(res, 422, { message: created.error });
        return;
      }
      sendJson(res, 201, issueView(repo, created));
      return;
    }
    if (tail.length === 1 && method === 'GET') {
      let issues = [...repo.issues];
      const state = query.get('state') ?? 'open';
      if (state === 'open' || state === 'closed') issues = issues.filter((i) => i.state === state);
      const sort = query.get('sort') ?? 'created';
      const direction = query.get('direction') ?? 'desc';
      if (sort === 'created') {
        issues.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      }
      const { page, link } = paginate(issues.map((i) => issueView(repo, i)), query, req, path);
      sendJson(res, 200, page, linkHeader(res, link));
      return;
    }
    if (tail.length === 2) {
      const number = Number.parseInt(tail[1], 10);
      const issue = repo.issues.find((i) => i.number === number);
      if (!issue) {
        notFound(res, 'Issue not found');
        return;
      }
      if (method === 'GET') {
        sendJson(res, 200, issueView(repo, issue));
        return;
      }
      if (method === 'PATCH') {
        if (obj.state === 'open' || obj.state === 'closed') {
          issue.state = obj.state;
          issue.closedAt = obj.state === 'closed' ? FIXED_TIME : null;
        }
        if (typeof obj.title === 'string') issue.title = obj.title;
        if (typeof obj.body === 'string') issue.body = obj.body;
        sendJson(res, 200, issueView(repo, issue));
        return;
      }
      notFound(res);
      return;
    }
    if (tail.length === 3 && tail[2] === 'comments') {
      const number = Number.parseInt(tail[1], 10);
      const issue = repo.issues.find((i) => i.number === number);
      if (!issue) {
        notFound(res, 'Issue not found');
        return;
      }
      if (method === 'GET') {
        sendJson(
          res,
          200,
          issue.comments.map((c) => ({
            id: c.id,
            node_id: globalId('IssueComment', `${repo.owner}/${repo.name}#${issue.number}#${c.id}`),
            body: c.body,
            user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
            created_at: FIXED_TIME,
            updated_at: FIXED_TIME,
          })),
        );
        return;
      }
      if (method === 'POST') {
        const bodyText = typeof obj.body === 'string' ? obj.body : '';
        const comment = { id: repo.nextCommentId++, body: bodyText, seq: issue.comments.length + 1 };
        issue.comments.push(comment);
        sendJson(res, 201, {
          id: comment.id,
          node_id: globalId('IssueComment', `${repo.owner}/${repo.name}#${issue.number}#${comment.id}`),
          body: comment.body,
          user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
          created_at: FIXED_TIME,
          updated_at: FIXED_TIME,
        });
        return;
      }
      notFound(res);
      return;
    }
    notFound(res);
    return;
  }

  // Pull requests.
  if (tail[0] === 'pulls') {
    if (tail.length === 1 && method === 'POST') {
      const title = typeof obj.title === 'string' ? obj.title : '';
      const bodyText = typeof obj.body === 'string' ? obj.body : '';
      const head = stripOwnerPrefix(typeof obj.head === 'string' ? obj.head : '');
      const base = stripOwnerPrefix(typeof obj.base === 'string' ? obj.base : repo.defaultBranch);
      const created = store.createPull(repo, title, bodyText, head, base);
      if ('error' in created) {
        sendJson(res, 422, { message: created.error });
        return;
      }
      sendJson(res, 201, pullView(repo, created));
      return;
    }
    if (tail.length === 1 && method === 'GET') {
      let pulls = [...repo.pulls];
      const state = query.get('state') ?? 'open';
      if (state === 'open' || state === 'closed') pulls = pulls.filter((p) => p.state === state);
      pulls.sort((a, b) => b.seq - a.seq);
      const { page, link } = paginate(pulls.map((p) => pullView(repo, p)), query, req, path);
      sendJson(res, 200, page, linkHeader(res, link));
      return;
    }
    if (tail.length >= 2) {
      const number = Number.parseInt(tail[1], 10);
      const pr = repo.pulls.find((p) => p.number === number);
      if (!pr) {
        notFound(res, 'Pull request not found');
        return;
      }
      if (tail.length === 2 && method === 'GET') {
        sendJson(res, 200, pullView(repo, pr));
        return;
      }
      if (tail.length === 3 && tail[2] === 'files' && method === 'GET') {
        const headTip = store.resolveToCommit(repo, pr.head);
        const baseTip = store.resolveToCommit(repo, pr.base);
        const mb = headTip !== null && baseTip !== null ? store.mergeBase(repo, headTip, baseTip) : null;
        const mbTree = mb === null ? null : store.commitOf(repo, mb)?.tree ?? null;
        const headTree = headTip === null ? null : store.commitOf(repo, headTip)?.tree ?? null;
        const files = store.diffFiles(repo, mbTree, headTree);
        sendJson(res, 200, files);
        return;
      }
      if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
        if (pr.state !== 'open') {
          sendJson(res, 405, { message: 'Pull request is already closed' });
          return;
        }
        const sha = store.mergePull(repo, pr);
        if (sha === null) {
          sendJson(res, 405, { message: 'Merge conflict' });
          return;
        }
        sendJson(res, 200, { sha, merged: true, message: `Pull request successfully merged` });
        return;
      }
      notFound(res);
      return;
    }
    notFound(res);
    return;
  }

  notFound(res);
}

function stripOwnerPrefix(ref: string): string {
  let out = ref;
  if (out.startsWith('refs/heads/')) out = out.slice('refs/heads/'.length);
  const colon = out.indexOf(':');
  if (colon >= 0) out = out.slice(colon + 1);
  return out;
}

function sortedRefViews(repo: Repo): { ref: string; object: { sha: string; type: string } }[] {
  return [...repo.refs.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([ref, sha]) => ({ ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } }));
}

function dirEntries(
  repo: Repo,
  files: Map<string, { oid: string; mode: string }>,
  dir: string,
): Record<string, unknown>[] {
  const prefix = dir === '' ? '' : `${dir}/`;
  const seen = new Map<string, { type: string; oid: string; size: number }>();
  for (const [path, entry] of files) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) {
      seen.set(rest, { type: 'file', oid: entry.oid, size: repo.objects.get(entry.oid)?.data.length ?? 0 });
    } else {
      const name = rest.slice(0, slash);
      if (!seen.has(name)) seen.set(name, { type: 'dir', oid: '', size: 0 });
    }
  }
  const out: Record<string, unknown>[] = [];
  for (const [name, entry] of [...seen.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const entryPath = prefix + name;
    let sha = entry.oid;
    if (entry.type === 'dir') {
      // The tree object for this directory.
      const tip = branchTip(repo, repo.defaultBranch);
      sha = findTreeSha(repo, tip, entryPath) ?? '';
    }
    out.push({
      type: entry.type,
      name,
      path: entryPath,
      sha,
      size: entry.type === 'file' ? entry.size : 0,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${entryPath}`,
      download_url: entry.type === 'file' ? null : undefined,
    });
  }
  return out;
}

function findTreeSha(repo: Repo, tip: string | null, dirPath: string): string | null {
  if (tip === null) return null;
  const commit = store.commitOf(repo, tip);
  if (!commit) return null;
  let treeOid = commit.tree;
  for (const segment of dirPath.split('/')) {
    const object = repo.objects.get(treeOid);
    if (!object || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((e) => e.name === segment);
    if (!entry) return null;
    treeOid = entry.oid;
  }
  return treeOid;
}

export { decodeGlobalId, hashObject };
