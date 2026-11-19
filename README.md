# github-core-clone-01 — GitHub Core Clone

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/adhy22/github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/adhy22/github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in a single process, written in
TypeScript with only the Node.js standard library. No UI: the suite, not a
browser, is the client.

## Run

```sh
node --experimental-strip-types main.ts
```

`main.ts` is the trial lifecycle: it binds an ephemeral port, registers it
with `$MAKEFUN_ENV_URL`, then polls `$MAKEFUN_ENV_URL/done` until the trial
ends and exits 0. `MAKEFUN_ENV_URL` unset exits 1.

To run the server on your own (development / local checks), set the token and
call the exported factory from a small script:

```ts
process.env.MAKEFUN_SHOP_TOKEN = 'dev-token';
import { createApp } from './app.ts';
const app = await createApp();
console.log('listening on', app.address().port);
```

## Surfaces

| Surface | Route | Notes |
| --- | --- | --- |
| Git smart HTTP | `/{owner}/{repo}.git` | upload-pack protocol v2 + v0, receive-pack v0; SHA-1, plain packs, no deltas on write |
| REST v3 | `/api/v3` | repos, issues, pull requests, contents, git refs/commits, labels |
| GraphQL v4 | `/api/graphql` | viewer, repository, node, issues/PRs, mutations, `__type` introspection, batched requests |
| MCP | `/mcp` | streamable HTTP JSON-RPC 2.0, modern `server/discover` (2026-07-28) and legacy `initialize` eras |
| Health | `/healthz` | `{"ok": true}` |

## Auth

Every API call carries `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`. No token
returns 401 JSON `{"message": ...}`. When `MAKEFUN_SHOP_TOKEN` is set, the
token must match exactly; with it unset (local development only) any
non-empty Bearer token is accepted. A repository belongs to the login the
token names (`adaiversen` in the trial scenario); the same repo name under
another owner returns 404, never 403.

## Storage

All state lives in memory in this process: git objects (SHA-1), refs, trees,
issues, pull requests, labels and comments. Commit timestamps are fixed, so
two runs on the same instance leave the same exported state. There is no
database, no git binary, no outside service and no package manager at run
time.

## Layout

- `main.ts` — trial lifecycle (bind ephemeral port, register, poll `/done`).
- `app.ts` — HTTP server, REST v3 router, auth, pagination, request ids.
- `git.ts` — object model, SHA-1, pkt-line codec, pack read/write.
- `gitserver.ts` — info/refs, upload-pack (v2/v0, shallow/deepen, thin packs), receive-pack.
- `store.ts` — forge state: repos, commits, trees, diff/merge-base, issues, PRs, labels.
- `graphql.ts` — small GraphQL parser/executor for the documents the suite sends.
- `mcp.ts` — MCP `server/discover`/`initialize`/`tools/list`/`tools/call`.
- `tests/smoke.test.ts` — boots the server and exercises REST, git, GraphQL and MCP.

## Limits

- Source under 16 MiB total, 8 MiB per file; stdlib only.
- `filter` fetch capability is deliberately not advertised (no suite check uses it).
- GraphQL implements the operations the suite sends; it is not a general
  GraphQL server.

## License

MIT — see `LICENSE`.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
