// mcp.ts — Model Context Protocol over streamable HTTP at /mcp.
// Speaks the modern 2026-07-28 era (server/discover, no handshake) and the
// legacy handshake era (initialize + notifications/initialized), and exposes
// the github-mcp-server tool names over the forge's own store.

import { Store, VIEWER } from './store.ts';
import type { Repo } from './store.ts';

const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, { type: string; description?: string; enum?: string[] }>;
  required: string[];
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    properties: {
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'list_repos',
    description: 'List the repositories owned by the authenticated user.',
    properties: {},
    required: [],
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'open, closed or all.', enum: ['open', 'closed', 'all'] },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch onto a base branch.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The pull request title.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
      body: { type: 'string', description: 'The pull request body.' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit onto its base branch.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      pull_number: { type: 'integer', description: 'The pull request number.' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
  {
    name: 'add_issue_comment',
    description: 'Add a comment to an issue.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      issue_number: { type: 'integer', description: 'The issue number.' },
      body: { type: 'string', description: 'The comment body.' },
    },
    required: ['owner', 'repo', 'issue_number', 'body'],
  },
];

function toolList(): Record<string, unknown>[] {
  return TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: { type: 'object', properties: tool.properties, required: tool.required },
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textResult(value: unknown): Record<string, unknown> {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return { content: [{ type: 'text', text }], structuredContent: value, isError: false };
}

function errorResult(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    databaseId: repo.databaseId,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return errorResult(`unknown tool ${name}`);
  for (const required of tool.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return errorResult(`missing required argument: ${required}`);
    }
  }
  const fullName = typeof args.full_name === 'string' ? args.full_name : null;
  let owner = typeof args.owner === 'string' ? args.owner : typeof args.owner_login === 'string' ? args.owner_login : '';
  let repoName = typeof args.repo === 'string' ? args.repo : '';
  if (fullName !== null && (owner === '' || repoName === '')) {
    const parts = fullName.split('/');
    if (parts.length === 2) {
      owner = parts[0];
      repoName = parts[1];
    }
  }

  if (name === 'create_repo') {
    const repo = store.createRepo(String(args.name), {
      description: typeof args.description === 'string' ? args.description : '',
      private: args.private === true,
    });
    if (repo === null) return errorResult(`Repository ${String(args.name)} already exists`);
    return textResult(repoJson(repo));
  }
  if (name === 'list_repos') {
    return textResult(store.listRepos().map((r) => repoJson(r)));
  }
  if (name === 'get_repo' || name === 'create_issue' || name === 'list_issues' || name === 'create_pull_request' || name === 'merge_pull_request' || name === 'add_issue_comment') {
    const repo = store.getRepo(owner, repoName);
    if (repo === null) return errorResult(`repository ${owner}/${repoName} not found`);
    if (name === 'get_repo') return textResult(repoJson(repo));
    if (name === 'create_issue') {
      const created = store.createIssue(repo, String(args.title), typeof args.body === 'string' ? args.body : '', []);
      if ('error' in created) return errorResult(created.error);
      return textResult({
        id: created.number,
        number: created.number,
        title: created.title,
        body: created.body,
        state: created.state,
        labels: created.labels.map((l) => ({ name: l.name })),
      });
    }
    if (name === 'list_issues') {
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = repo.issues.filter((i) => state === 'all' || i.state === state);
      return textResult(
        issues.map((i) => ({ id: i.number, number: i.number, title: i.title, body: i.body, state: i.state })),
      );
    }
    if (name === 'create_pull_request') {
      const head = String(args.head);
      const base = String(args.base);
      const created = store.createPull(repo, String(args.title), typeof args.body === 'string' ? args.body : '', head, base);
      if ('error' in created) return errorResult(created.error);
      return textResult({
        number: created.number,
        title: created.title,
        body: created.body,
        state: created.state,
        head: { ref: created.head, sha: created.headSha },
        base: { ref: created.base, sha: created.baseSha },
      });
    }
    if (name === 'merge_pull_request') {
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number.parseInt(String(args.pull_number), 10);
      const pr = repo.pulls.find((p) => p.number === number);
      if (!pr) return errorResult(`pull request #${number} not found`);
      if (pr.state !== 'open') return errorResult(`pull request #${number} is not open`);
      const sha = store.mergePull(repo, pr);
      if (sha === null) return errorResult('merge conflict');
      return textResult({ sha, merged: true, message: 'Pull request successfully merged', number: pr.number, state: pr.state });
    }
    if (name === 'add_issue_comment') {
      const number = typeof args.issue_number === 'number' ? args.issue_number : Number.parseInt(String(args.issue_number), 10);
      const issue = repo.issues.find((i) => i.number === number);
      if (!issue) return errorResult(`issue #${number} not found`);
      const comment = { id: repo.nextCommentId++, body: String(args.body), seq: issue.comments.length + 1 };
      issue.comments.push(comment);
      return textResult({ id: comment.id, body: comment.body });
    }
  }
  return errorResult(`unknown tool ${name}`);
}

export function handleMcp(store: Store, body: unknown): { status: number; body: unknown } {
  if (!isRecord(body)) {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  const id = body.id ?? null;
  const method = typeof body.method === 'string' ? body.method : '';
  const params = isRecord(body.params) ? body.params : {};

  // Notifications carry no id and expect no response body.
  if (method.startsWith('notifications/') || id === null) {
    if (method.startsWith('notifications/')) return { status: 202, body: null };
  }
  const ok = (result: unknown): { status: number; body: unknown } => ({ status: 200, body: { jsonrpc: '2.0', id, result } });
  const err = (code: number, message: string, data?: unknown): { status: number; body: unknown } => ({
    status: 200,
    body: { jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } },
  });

  if (method === 'server/discover') {
    return ok({
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions: 'A GitHub-compatible git forge: create repos, issues and pull requests.',
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    });
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const protocolVersion = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
    return ok({
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (method === 'ping') return ok({});
  if (method === 'tools/list') {
    return ok({ tools: toolList() });
  }
  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    const tool = TOOLS.find((t) => t.name === toolName);
    if (!tool) return err(-32602, `unknown tool ${toolName}`);
    const result = callTool(store, toolName, args);
    return ok(result);
  }
  return err(-32601, `method not found: ${method}`);
}

export { VIEWER };
