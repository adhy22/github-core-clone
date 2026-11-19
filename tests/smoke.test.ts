// tests/smoke.test.ts — boots the forge on an ephemeral port and exercises
// the four surfaces end to end. Run with:
//   node --experimental-strip-types --test tests/smoke.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../app.ts';

const TOKEN = 'smoke-token';
// The forge reads the expected token from the environment on every request.
process.env.MAKEFUN_SHOP_TOKEN = TOKEN;

async function boot(): Promise<{ base: string; close: () => Promise<void> }> {
  const app = await createApp();
  await new Promise<void>((resolve, reject) => {
    app.once('error', reject);
    app.listen(0, () => resolve());
  });
  const address = app.address();
  if (address === null || typeof address === 'string') throw new Error('server did not bind');
  const port = address.port;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        app.close(() => resolve());
      }),
  };
}

async function api(base: string, path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

test('healthz and root', async () => {
  const { base, close } = await boot();
  try {
    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);
    const root = await api(base, '/api/v3/');
    assert.equal(root.status, 200);
    assert.equal(typeof root.body.current_user_url, 'string');
  } finally {
    await close();
  }
});

test('REST repo + issue + pull request flow', async () => {
  const { base, close } = await boot();
  try {
    const created = await api(base, '/api/v3/user/repos', {
      method: 'POST',
      body: JSON.stringify({ name: 'smoke-repo', description: 'smoke' }),
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.name, 'smoke-repo');

    const put = await api(base, '/api/v3/repos/adaiversen/smoke-repo/contents/README.md', {
      method: 'PUT',
      body: JSON.stringify({ message: 'add readme', content: Buffer.from('hello\n').toString('base64') }),
    });
    assert.equal(put.status, 201);
    assert.equal(put.body.content.encoding, 'base64');

    const got = await api(base, '/api/v3/repos/adaiversen/smoke-repo/contents/README.md');
    assert.equal(got.status, 200);
    assert.equal(Buffer.from(got.body.content, 'base64').toString(), 'hello\n');

    const issue = await api(base, '/api/v3/repos/adaiversen/smoke-repo/issues', {
      method: 'POST',
      body: JSON.stringify({ title: 'smoke issue', body: 'body' }),
    });
    assert.equal(issue.status, 201);
    assert.equal(issue.body.number, 1);

    const listed = await api(base, '/api/v3/repos/adaiversen/smoke-repo/issues?state=open');
    assert.equal(listed.status, 200);
    assert.equal(listed.body.length, 1);

    const closed = await api(base, '/api/v3/repos/adaiversen/smoke-repo/issues/1', {
      method: 'PATCH',
      body: JSON.stringify({ state: 'closed' }),
    });
    assert.equal(closed.status, 200);
    assert.equal(closed.body.state, 'closed');

    // 401 without a token.
    const anon = await fetch(`${base}/api/v3/user`);
    assert.equal(anon.status, 401);
    // 404, never 403, for a repo under another owner.
    const stranger = await api(base, '/api/v3/repos/someone-else/smoke-repo');
    assert.equal(stranger.status, 404);
  } finally {
    await close();
  }
});

test('GraphQL viewer + repository + mutation', async () => {
  const { base, close } = await boot();
  try {
    const query = await api(base, '/api/graphql', {
      method: 'POST',
      body: JSON.stringify({ query: 'query { viewer { login } }' }),
    });
    assert.equal(query.status, 200);
    assert.equal(query.body.data.viewer.login, 'adaiversen');

    await api(base, '/api/v3/user/repos', { method: 'POST', body: JSON.stringify({ name: 'gql-repo' }) });
    const mutation = await api(base, '/api/graphql', {
      method: 'POST',
      body: JSON.stringify({
        query: 'mutation CreateIssue($input: CreateIssueInput!) { createIssue(input: $input) { issue { number title } } }',
        variables: { input: { repositoryId: Buffer.from('Repository:adaiversen/gql-repo').toString('base64'), title: 'gql issue' } },
      }),
    });
    assert.equal(mutation.status, 200);
    assert.equal(mutation.body.data.createIssue.issue.number, 1);
    assert.equal(mutation.body.data.createIssue.issue.title, 'gql issue');
  } finally {
    await close();
  }
});

test('MCP discover, tools/list and tools/call', async () => {
  const { base, close } = await boot();
  try {
    const discover = await api(base, '/mcp', {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: {} }),
    });
    assert.equal(discover.status, 200);
    assert.ok((discover.body.result.supportedVersions as string[]).includes('2026-07-28'));

    const list = await api(base, '/mcp', {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    assert.equal(list.status, 200);
    const names = (list.body.result.tools as { name: string }[]).map((t) => t.name);
    for (const needed of ['create_repo', 'get_repo', 'create_issue', 'list_issues', 'create_pull_request', 'merge_pull_request']) {
      assert.ok(names.includes(needed), `missing tool ${needed}`);
    }

    const call = await api(base, '/mcp', {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'create_repo', arguments: { name: 'mcp-repo' } },
      }),
    });
    assert.equal(call.status, 200);
    assert.equal(call.body.result.isError, false);
    const created = JSON.parse(call.body.result.content[0].text);
    assert.equal(created.name, 'mcp-repo');
  } finally {
    await close();
  }
});

test('git info/refs for an empty repo', async () => {
  const { base, close } = await boot();
  try {
    await api(base, '/api/v3/user/repos', { method: 'POST', body: JSON.stringify({ name: 'git-repo' }) });
    const res = await fetch(`${base}/adaiversen/git-repo.git/info/refs?service=git-upload-pack`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(res.status, 200);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.ok(buf.toString('ascii').includes('capabilities^{}'));
    const missing = await fetch(`${base}/adaiversen/nope.git/info/refs?service=git-upload-pack`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(missing.status, 404);
  } finally {
    await close();
  }
});
