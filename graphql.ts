// graphql.ts — a small GraphQL executor for the documents gh and
// github-mcp-server actually send: viewer/repository/issue/pull-request
// reads, __type introspection, node(id:), batched operations, and the
// create/close/merge/addComment mutations. Unknown fields are reported in
// an `errors` array with HTTP 200; unknown repositories read null.

import { FIXED_TIME, Store, VIEWER, decodeGlobalId, globalId } from './store.ts';
import type { Issue, PullRequest, Repo } from './store.ts';

// --- tokenizer -------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'spread'; value: '...' };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@&|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let value = '';
      i += 1;
      while (i < input.length && input[i] !== '"') {
        if (input[i] === '\\' && i + 1 < input.length) {
          const esc = input[i + 1];
          if (esc === 'n') value += '\n';
          else if (esc === 't') value += '\t';
          else if (esc === 'r') value += '\r';
          else value += esc;
          i += 2;
        } else {
          value += input[i];
          i += 1;
        }
      }
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch) && (ch !== '-' || /[0-9]/.test(input[i + 1] ?? ''))) {
      let j = i;
      if (input[j] === '-') j += 1;
      while (j < input.length && /[0-9]/.test(input[j])) j += 1;
      let isFloat = false;
      if (input[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < input.length && /[0-9]/.test(input[j])) j += 1;
      }
      const value = input.slice(i, j);
      tokens.push(isFloat ? { kind: 'float', value } : { kind: 'int', value });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < input.length && /[_A-Za-z0-9]/.test(input[j])) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    i += 1;
  }
  return tokens;
}

// --- parser ----------------------------------------------------------------------

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Record<string, unknown>;
  children: SelectionNode[];
}
interface FragmentSpreadNode {
  kind: 'spread';
  name: string;
}
interface InlineFragmentNode {
  kind: 'inline';
  typeCondition: string | null;
  children: SelectionNode[];
}
type SelectionNode = FieldNode | FragmentSpreadNode | InlineFragmentNode;
interface OperationNode {
  kind: 'operation';
  operation: 'query' | 'mutation';
  name: string | null;
  varDefs: Record<string, string>;
  selections: SelectionNode[];
}
interface FragmentNode {
  kind: 'fragment';
  name: string;
  typeCondition: string;
  selections: SelectionNode[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  private readonly variables: Record<string, unknown>;

  constructor(tokens: Token[], variables: Record<string, unknown>) {
    this.tokens = tokens;
    this.variables = variables;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }
  private next(): Token {
    return this.tokens[this.pos++]!;
  }
  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}`);
  }
  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name');
    return token.value;
  }

  parseDocument(): { operations: OperationNode[]; fragments: Map<string, FragmentNode> } {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.pos < this.tokens.length) {
      const token = this.peek()!;
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        operations.push(this.parseOperation());
      } else if (token.kind === 'name' && token.value === 'fragment') {
        const fragment = this.parseFragment();
        fragments.set(fragment.name, fragment);
      } else if (token.kind === 'punct' && token.value === '{') {
        operations.push({
          kind: 'operation',
          operation: 'query',
          name: null,
          varDefs: {},
          selections: this.parseSelectionSet(),
        });
      } else {
        this.pos += 1;
      }
    }
    return { operations, fragments };
  }

  private parseOperation(): OperationNode {
    const operation = this.next().value as 'query' | 'mutation';
    let name: string | null = null;
    const token = this.peek();
    if (token?.kind === 'name') name = this.next().value;
    const varDefs: Record<string, string> = {};
    if (this.peek()?.kind === 'punct' && this.peek()!.value === '(') {
      this.next();
      while (!(this.peek()?.kind === 'punct' && this.peek()!.value === ')')) {
        if (this.peek()?.kind === 'punct' && this.peek()!.value === '$') {
          this.next();
          const varName = this.expectName();
          if (this.peek()?.kind === 'punct' && this.peek()!.value === ':') {
            this.next();
            varDefs[varName] = this.parseTypeName();
          }
          if (this.peek()?.kind === 'punct' && this.peek()!.value === '=') {
            this.next();
            this.parseValue();
          }
        } else {
          this.pos += 1;
        }
      }
      this.expectPunct(')');
    }
    const selections = this.parseSelectionSet();
    return { kind: 'operation', operation, name, varDefs, selections };
  }

  private parseTypeName(): string {
    let out = '';
    while (this.pos < this.tokens.length) {
      const token = this.peek()!;
      if (token.kind === 'name') out += this.next().value;
      else if (token.kind === 'punct' && (token.value === '[' || token.value === ']' || token.value === '!')) out += this.next().value;
      else break;
    }
    return out;
  }

  private parseFragment(): FragmentNode {
    this.next(); // fragment
    const name = this.expectName();
    this.expectName(); // on
    const typeCondition = this.expectName();
    const selections = this.parseSelectionSet();
    return { kind: 'fragment', name, typeCondition, selections };
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek()?.kind === 'punct' && this.peek()!.value === '}')) {
      if (this.pos >= this.tokens.length) throw new Error('unterminated selection set');
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek()!;
    if (token.kind === 'spread') {
      this.next();
      const next = this.peek();
      if (next?.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { kind: 'inline', typeCondition, children: this.parseSelectionSet() };
      }
      if (next?.kind === 'name') {
        return { kind: 'spread', name: this.next().value };
      }
      return { kind: 'inline', typeCondition: null, children: this.parseSelectionSet() };
    }
    let alias: string | null = null;
    let name = this.expectName();
    if (this.peek()?.kind === 'punct' && this.peek()!.value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args: Record<string, unknown> = {};
    if (this.peek()?.kind === 'punct' && this.peek()!.value === '(') {
      this.next();
      while (!(this.peek()?.kind === 'punct' && this.peek()!.value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args[argName] = this.parseValue();
      }
      this.expectPunct(')');
    }
    // Directives (@...) are ignored.
    while (this.peek()?.kind === 'punct' && this.peek()!.value === '@') {
      this.next();
      this.expectName();
      if (this.peek()?.kind === 'punct' && this.peek()!.value === '(') {
        this.next();
        let depth = 1;
        while (depth > 0 && this.pos < this.tokens.length) {
          const t = this.next();
          if (t.kind === 'punct' && t.value === '(') depth += 1;
          if (t.kind === 'punct' && t.value === ')') depth -= 1;
        }
      }
    }
    const children = this.peek()?.kind === 'punct' && this.peek()!.value === '{' ? this.parseSelectionSet() : [];
    return { kind: 'field', alias, name, args, children };
  }

  parseValue(): unknown {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { __variable: this.expectName() };
    if (token.kind === 'string') return token.value;
    if (token.kind === 'int') return Number.parseInt(token.value, 10);
    if (token.kind === 'float') return Number.parseFloat(token.value);
    if (token.kind === 'punct' && token.value === '[') {
      const list: unknown[] = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()!.value === ']')) list.push(this.parseValue());
      this.expectPunct(']');
      return list;
    }
    if (token.kind === 'punct' && token.value === '{') {
      const object: Record<string, unknown> = {};
      while (!(this.peek()?.kind === 'punct' && this.peek()!.value === '}')) {
        const key = this.expectName();
        this.expectPunct(':');
        object[key] = this.parseValue();
      }
      this.expectPunct('}');
      return object;
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return true;
      if (token.value === 'false') return false;
      if (token.value === 'null') return null;
      return { __enum: token.value };
    }
    throw new Error('unexpected value token');
  }
}

function resolveVariables(value: unknown, variables: Record<string, unknown>): unknown {
  if (value !== null && typeof value === 'object') {
    if ('__variable' in (value as Record<string, unknown>)) {
      return variables[(value as { __variable: string }).__variable] ?? null;
    }
    if ('__enum' in (value as Record<string, unknown>)) {
      return (value as { __enum: string }).__enum;
    }
    if (Array.isArray(value)) return value.map((v) => resolveVariables(v, variables));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = resolveVariables(v, variables);
    return out;
  }
  return value;
}

function resolveArgs(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(field.args)) out[k] = resolveVariables(v, variables);
  return out;
}

// --- schema knowledge ---------------------------------------------------------------

const ISSUE_FIELDS = [
  'id', 'number', 'title', 'body', 'state', 'url', 'createdAt', 'updatedAt', 'author', 'labels',
  'comments', 'closed', 'closedAt', 'repository', 'assignees', 'milestone',
];
const PULL_REQUEST_FIELDS = [
  'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
  'headRefOid', 'baseRefOid', 'files', 'url', 'createdAt', 'updatedAt', 'author', 'commits',
  'mergeCommit', 'closedAt', 'isDraft',
];
const REPOSITORY_FIELDS = [
  'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
  'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private',
  'url', 'createdAt', 'updatedAt', 'homepageUrl', 'forkCount', 'stargazerCount', 'isPrivate',
];
const SEARCH_TYPE_VALUES = [
  'ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'MILESTONE',
  'ORGANIZATION', 'PROJECT', 'CODE', 'PACKAGE', 'TOPIC', 'WIKI', 'MARKETPLACE',
];

// --- executor ------------------------------------------------------------------------

interface Ctx {
  store: Store;
  errors: { message: string }[];
  fragments: Map<string, FragmentNode>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stateOf(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}
function prStateOf(pr: PullRequest): string {
  if (pr.merged) return 'MERGED';
  return pr.state === 'open' ? 'OPEN' : 'CLOSED';
}

function issueNode(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    __typename: 'Issue',
    __repo: repo,
    __issue: issue,
    id: globalId('Issue', `${repo.owner}/${repo.name}#${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: stateOf(issue),
    url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    createdAt: FIXED_TIME,
    updatedAt: FIXED_TIME,
  };
}

function prNode(repo: Repo, pr: PullRequest): Record<string, unknown> {
  return {
    __typename: 'PullRequest',
    __repo: repo,
    __pr: pr,
    id: globalId('PullRequest', `${repo.owner}/${repo.name}#${pr.number}`),
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: prStateOf(pr),
    merged: pr.merged,
    headRefName: pr.head,
    baseRefName: pr.base,
    headRefOid: pr.headSha,
    baseRefOid: pr.baseSha,
    url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pr.number}`,
    createdAt: FIXED_TIME,
    updatedAt: FIXED_TIME,
  };
}

function repoNode(repo: Repo): Record<string, unknown> {
  const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  return {
    __typename: 'Repository',
    __repo: repo,
    id: repo.id,
    databaseId: repo.databaseId,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: { __typename: 'User', login: repo.owner, id: VIEWER.id },
    defaultBranchRef: tip === null ? null : { __typename: 'Ref', name: repo.defaultBranch, target: { oid: tip } },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    description: repo.description,
    private: repo.private,
    url: `https://example.invalid/${repo.owner}/${repo.name}`,
    createdAt: FIXED_TIME,
    updatedAt: FIXED_TIME,
  };
}

function decodeCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const n = Number.parseInt(text.slice('cursor:'.length), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}
function encodeCursor(seq: number): string {
  return Buffer.from(`cursor:${seq}`, 'utf8').toString('base64');
}

function issuesConnection(repo: Repo, args: Record<string, unknown>): Record<string, unknown> {
  let issues = [...repo.issues];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s)));
    issues = issues.filter((i) => wanted.has(stateOf(i)));
  }
  let descending = true;
  const orderBy = args.orderBy;
  if (isRecord(orderBy)) {
    if (orderBy.direction === 'ASC') descending = false;
    if (orderBy.direction === 'DESC') descending = true;
  }
  issues.sort((a, b) => (descending ? b.seq - a.seq : a.seq - b.seq));
  const afterSeq = decodeCursor(args.after);
  if (afterSeq !== null) {
    issues = issues.filter((i) => (descending ? i.seq < afterSeq : i.seq > afterSeq));
  }
  const first = typeof args.first === 'number' ? args.first : 100;
  const page = issues.slice(0, first);
  const hasNextPage = issues.length > page.length;
  const endCursor = page.length > 0 ? encodeCursor(page[page.length - 1].seq) : null;
  return {
    __typename: 'IssueConnection',
    __nodes: page.map((i) => issueNode(repo, i)),
    nodes: page.map((i) => issueNode(repo, i)),
    totalCount: issues.length,
    pageInfo: {
      hasNextPage,
      hasPreviousPage: false,
      startCursor: page.length > 0 ? encodeCursor(page[0].seq) : null,
      endCursor,
    },
  };
}

function pullsConnection(repo: Repo, args: Record<string, unknown>): Record<string, unknown> {
  let pulls = [...repo.pulls];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s)));
    pulls = pulls.filter((p) => wanted.has(prStateOf(p)));
  }
  pulls.sort((a, b) => b.seq - a.seq);
  const first = typeof args.first === 'number' ? args.first : 100;
  const page = pulls.slice(0, first);
  return {
    __typename: 'PullRequestConnection',
    __nodes: page.map((p) => prNode(repo, p)),
    nodes: page.map((p) => prNode(repo, p)),
    totalCount: pulls.length,
    pageInfo: {
      hasNextPage: pulls.length > page.length,
      hasPreviousPage: false,
      startCursor: null,
      endCursor: page.length > 0 ? encodeCursor(page[page.length - 1].seq) : null,
    },
  };
}

function typeNode(name: string): Record<string, unknown> | null {
  if (name === 'Issue') {
    return { __typename: '__Type', name: 'Issue', kind: 'OBJECT', fields: ISSUE_FIELDS.map((n) => ({ name: n })), enumValues: null };
  }
  if (name === 'PullRequest') {
    return { __typename: '__Type', name: 'PullRequest', kind: 'OBJECT', fields: PULL_REQUEST_FIELDS.map((n) => ({ name: n })), enumValues: null };
  }
  if (name === 'Repository') {
    return { __typename: '__Type', name: 'Repository', kind: 'OBJECT', fields: REPOSITORY_FIELDS.map((n) => ({ name: n })), enumValues: null };
  }
  if (name === 'SearchType') {
    return { __typename: '__Type', name: 'SearchType', kind: 'ENUM', fields: null, enumValues: SEARCH_TYPE_VALUES.map((n) => ({ name: n })) };
  }
  if (name === 'IssueState') {
    return { __typename: '__Type', name: 'IssueState', kind: 'ENUM', fields: null, enumValues: ['OPEN', 'CLOSED'].map((n) => ({ name: n })) };
  }
  if (name === 'User') {
    return { __typename: '__Type', name: 'User', kind: 'OBJECT', fields: ['id', 'login', 'name', 'email'].map((n) => ({ name: n })), enumValues: null };
  }
  return null;
}

function resolveNodeById(store: Store, id: string): Record<string, unknown> | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null) return null;
  if (decoded.kind === 'Repository') {
    const [owner, name] = decoded.payload.split('/');
    const repo = store.getRepo(owner, name);
    return repo === null ? null : repoNode(repo);
  }
  if (decoded.kind === 'Issue' || decoded.kind === 'PullRequest') {
    const match = /^([^/]+)\/([^#]+)#(\d+)$/.exec(decoded.payload);
    if (!match) return null;
    const repo = store.getRepo(match[1], match[2]);
    if (repo === null) return null;
    const number = Number.parseInt(match[3], 10);
    if (decoded.kind === 'Issue') {
      const issue = repo.issues.find((i) => i.number === number);
      return issue ? issueNode(repo, issue) : null;
    }
    const pr = repo.pulls.find((p) => p.number === number);
    return pr ? prNode(repo, pr) : null;
  }
  return null;
}

function executeSelections(
  ctx: Ctx,
  parent: Record<string, unknown>,
  typeName: string,
  selections: SelectionNode[],
  variables: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment) {
        const sub = executeSelections(ctx, parent, fragment.typeCondition, fragment.selections, variables);
        Object.assign(out, sub);
      }
      continue;
    }
    if (selection.kind === 'inline') {
      if (selection.typeCondition === null || selection.typeCondition === typeName) {
        const sub = executeSelections(ctx, parent, selection.typeCondition ?? typeName, selection.children, variables);
        Object.assign(out, sub);
      }
      continue;
    }
    const field = selection as FieldNode;
    const key = field.alias ?? field.name;
    const value = resolveField(ctx, parent, typeName, field, variables);
    out[key] = value;
  }
  return out;
}

function unknownField(ctx: Ctx, typeName: string, fieldName: string): null {
  ctx.errors.push({ message: `Cannot query field "${fieldName}" on type "${typeName}".` });
  return null;
}

function resolveField(
  ctx: Ctx,
  parent: Record<string, unknown>,
  typeName: string,
  field: FieldNode,
  variables: Record<string, unknown>,
): unknown {
  const args = resolveArgs(field, variables);
  const name = field.name;
  const children = field.children;

  const sub = (value: Record<string, unknown> | null, childType: string): unknown => {
    if (value === null) return null;
    if (children.length === 0) return value;
    return executeSelections(ctx, value, childType, children, variables);
  };

  if (typeName === 'Query') {
    if (name === 'viewer') {
      const user: Record<string, unknown> = { __typename: 'User', login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email };
      return sub(user, 'User');
    }
    if (name === 'repository') {
      const repo = ctx.store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
      if (repo === null) return null;
      return sub(repoNode(repo), 'Repository');
    }
    if (name === 'node') {
      const node = resolveNodeById(ctx.store, String(args.id ?? ''));
      if (node === null) return null;
      return sub(node, String(node.__typename ?? 'Repository'));
    }
    if (name === '__type') {
      const node = typeNode(String(args.name ?? ''));
      if (node === null) return null;
      return sub(node, '__Type');
    }
    if (name === '__schema') {
      const node: Record<string, unknown> = { __typename: '__Schema', queryType: { name: 'Query' }, types: ['Query', 'Repository', 'Issue', 'PullRequest', 'User'].map((n) => ({ name: n })) };
      return sub(node, '__Schema');
    }
    return unknownField(ctx, 'Query', name);
  }

  if (typeName === 'Mutation') {
    return resolveMutation(ctx, name, args, children, variables);
  }

  if (typeName === 'Repository') {
    const repo = parent.__repo as Repo;
    if (name === 'issue') {
      const issue = repo.issues.find((i) => i.number === Number(args.number));
      if (!issue) return null;
      return sub(issueNode(repo, issue), 'Issue');
    }
    if (name === 'issues') return sub(issuesConnection(repo, args), 'IssueConnection');
    if (name === 'pullRequest') {
      const pr = repo.pulls.find((p) => p.number === Number(args.number));
      if (!pr) return null;
      return sub(prNode(repo, pr), 'PullRequest');
    }
    if (name === 'pullRequests') return sub(pullsConnection(repo, args), 'PullRequestConnection');
    if (name === 'owner') {
      const user: Record<string, unknown> = { __typename: 'User', login: repo.owner, id: VIEWER.id };
      return sub(user, 'User');
    }
    if (name === 'defaultBranchRef') {
      const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
      if (tip === null) return null;
      return sub({ __typename: 'Ref', name: repo.defaultBranch, target: { oid: tip } }, 'Ref');
    }
    if (name in parent) {
      const value = parent[name];
      if (value !== null && typeof value === 'object' && children.length > 0) return sub(value as Record<string, unknown>, name === 'owner' ? 'User' : 'Repository');
      return value;
    }
    return unknownField(ctx, 'Repository', name);
  }

  if (typeName === 'Issue') {
    if (name === 'author') {
      const user: Record<string, unknown> = { __typename: 'User', login: VIEWER.login, id: VIEWER.id };
      return sub(user, 'User');
    }
    if (name === 'repository') {
      const repo = parent.__repo as Repo;
      return sub(repoNode(repo), 'Repository');
    }
    if (name === 'labels') {
      const issue = parent.__issue as Issue;
      return { nodes: issue.labels.map((l) => ({ name: l.name, color: l.color })) };
    }
    if (name === 'comments') {
      const issue = parent.__issue as Issue;
      const repo = parent.__repo as Repo;
      return {
        nodes: issue.comments.map((c) => ({
          __typename: 'IssueComment',
          id: globalId('IssueComment', `${repo.owner}/${repo.name}#${issue.number}#${c.id}`),
          body: c.body,
        })),
        totalCount: issue.comments.length,
      };
    }
    if (name in parent) return parent[name];
    return unknownField(ctx, 'Issue', name);
  }

  if (typeName === 'PullRequest') {
    const repo = parent.__repo as Repo;
    const pr = parent.__pr as PullRequest;
    if (name === 'mergeable') {
      if (pr.merged) return 'UNKNOWN';
      const headTip = ctx.store.resolveToCommit(repo, pr.head);
      const baseTip = ctx.store.resolveToCommit(repo, pr.base);
      if (headTip === null || baseTip === null) return 'UNKNOWN';
      return ctx.store.mergeConflicts(repo, headTip, baseTip) ? 'CONFLICTING' : 'MERGEABLE';
    }
    if (name === 'files') {
      const headTip = ctx.store.resolveToCommit(repo, pr.head);
      const baseTip = ctx.store.resolveToCommit(repo, pr.base);
      const mb = headTip !== null && baseTip !== null ? ctx.store.mergeBase(repo, headTip, baseTip) : null;
      const mbTree = mb === null ? null : ctx.store.commitOf(repo, mb)?.tree ?? null;
      const headTree = headTip === null ? null : ctx.store.commitOf(repo, headTip)?.tree ?? null;
      const diffs = ctx.store.diffFiles(repo, mbTree, headTree);
      const first = typeof args.first === 'number' ? args.first : 100;
      const nodes = diffs.slice(0, first).map((d) => ({
        __typename: 'PullRequestChangedFile',
        path: d.filename,
        additions: d.additions,
        deletions: d.deletions,
        changes: d.changes,
        status: d.status.toUpperCase(),
      }));
      return { __typename: 'PullRequestChangedFileConnection', nodes, totalCount: diffs.length };
    }
    if (name === 'author') {
      const user: Record<string, unknown> = { __typename: 'User', login: VIEWER.login, id: VIEWER.id };
      return sub(user, 'User');
    }
    if (name in parent) return parent[name];
    return unknownField(ctx, 'PullRequest', name);
  }

  if (typeName === 'IssueConnection' || typeName === 'PullRequestConnection' || typeName === 'PullRequestChangedFileConnection') {
    if (name === 'nodes') {
      const nodes = (parent.__nodes ?? parent.nodes ?? []) as Record<string, unknown>[];
      const childType = typeName === 'IssueConnection' ? 'Issue' : typeName === 'PullRequestConnection' ? 'PullRequest' : 'PullRequestChangedFile';
      return nodes.map((node) => (children.length === 0 ? node : executeSelections(ctx, node, childType, children, variables)));
    }
    if (name === 'edges') {
      const nodes = (parent.__nodes ?? parent.nodes ?? []) as Record<string, unknown>[];
      return nodes.map((node) => ({ node, cursor: null }));
    }
    if (name === 'pageInfo') {
      const pageInfo = parent.pageInfo as Record<string, unknown>;
      return sub(pageInfo, 'PageInfo');
    }
    if (name in parent) return parent[name];
    return unknownField(ctx, typeName, name);
  }

  if (typeName === '__Type') {
    if (name === 'fields') return parent.fields ?? null;
    if (name === 'enumValues') return parent.enumValues ?? null;
    if (name in parent) return parent[name];
    return unknownField(ctx, '__Type', name);
  }

  if (typeName === 'User' || typeName === 'Ref' || typeName === 'PageInfo' || typeName === '__Schema' || typeName === 'PullRequestChangedFile' || typeName === 'IssueComment') {
    if (name in parent) {
      const value = parent[name];
      if (value !== null && typeof value === 'object' && children.length > 0) return sub(value as Record<string, unknown>, name);
      return value;
    }
    return unknownField(ctx, typeName, name);
  }

  // Mutation payloads (CreateIssuePayload, ...) and comment edges: execute the
  // requested sub-selections against the nested object instead of leaking it raw.
  if (name in parent) {
    const value = parent[name];
    if (value !== null && typeof value === 'object' && !Array.isArray(value) && children.length > 0) {
      const record = value as Record<string, unknown>;
      const childType =
        typeof record.__typename === 'string'
          ? record.__typename
          : name === 'issue'
            ? 'Issue'
            : name === 'pullRequest'
              ? 'PullRequest'
              : name === 'commentEdge'
                ? 'IssueCommentEdge'
                : name === 'node'
                  ? 'IssueComment'
                  : typeName;
      return executeSelections(ctx, record, childType, children, variables);
    }
    return value;
  }
  return unknownField(ctx, typeName, name);
}

function resolveMutation(
  ctx: Ctx,
  name: string,
  args: Record<string, unknown>,
  children: SelectionNode[],
  variables: Record<string, unknown>,
): unknown {
  const input = isRecord(args.input) ? args.input : {};
  const payloadType = name === 'createIssue' ? 'CreateIssuePayload' : name === 'closeIssue' ? 'CloseIssuePayload' : name === 'createPullRequest' ? 'CreatePullRequestPayload' : name === 'mergePullRequest' ? 'MergePullRequestPayload' : name === 'addComment' ? 'AddCommentPayload' : 'Mutation';
  const wrap = (inner: Record<string, unknown>): unknown => {
    if (children.length === 0) return inner;
    return executeSelections(ctx, { __typename: payloadType, ...inner }, payloadType, children, variables);
  };

  if (name === 'createIssue') {
    const repo = findRepoByGlobalId(ctx.store, String(input.repositoryId ?? ''));
    if (repo === null) {
      ctx.errors.push({ message: 'repository not found for createIssue' });
      return wrap({});
    }
    const created = ctx.store.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
    if ('error' in created) {
      ctx.errors.push({ message: created.error });
      return wrap({});
    }
    return wrap({ issue: issueNode(repo, created) });
  }
  if (name === 'closeIssue') {
    const found = findIssueByGlobalId(ctx.store, String(input.issueId ?? ''));
    if (found === null) {
      ctx.errors.push({ message: 'issue not found for closeIssue' });
      return wrap({});
    }
    found.issue.state = 'closed';
    found.issue.closedAt = FIXED_TIME;
    return wrap({ issue: issueNode(found.repo, found.issue) });
  }
  if (name === 'createPullRequest') {
    const repo = findRepoByGlobalId(ctx.store, String(input.repositoryId ?? ''));
    if (repo === null) {
      ctx.errors.push({ message: 'repository not found for createPullRequest' });
      return wrap({});
    }
    const head = String(input.headRefName ?? '');
    const base = String(input.baseRefName ?? repo.defaultBranch);
    const created = ctx.store.createPull(repo, String(input.title ?? ''), String(input.body ?? ''), head, base);
    if ('error' in created) {
      ctx.errors.push({ message: created.error });
      return wrap({});
    }
    return wrap({ pullRequest: prNode(repo, created) });
  }
  if (name === 'mergePullRequest') {
    const found = findPullByGlobalId(ctx.store, String(input.pullRequestId ?? ''));
    if (found === null) {
      ctx.errors.push({ message: 'pull request not found for mergePullRequest' });
      return wrap({});
    }
    if (found.pr.state !== 'open') {
      ctx.errors.push({ message: 'pull request is not open' });
      return wrap({ pullRequest: prNode(found.repo, found.pr) });
    }
    const sha = ctx.store.mergePull(found.repo, found.pr);
    if (sha === null) {
      ctx.errors.push({ message: 'merge conflict' });
      return wrap({ pullRequest: prNode(found.repo, found.pr) });
    }
    return wrap({ pullRequest: prNode(found.repo, found.pr) });
  }
  if (name === 'addComment') {
    const found = findIssueByGlobalId(ctx.store, String(input.subjectId ?? ''));
    if (found === null) {
      ctx.errors.push({ message: 'subject not found for addComment' });
      return wrap({});
    }
    const comment = { id: found.repo.nextCommentId++, body: String(input.body ?? ''), seq: found.issue.comments.length + 1 };
    found.issue.comments.push(comment);
    const node = {
      __typename: 'IssueComment',
      id: globalId('IssueComment', `${found.repo.owner}/${found.repo.name}#${found.issue.number}#${comment.id}`),
      body: comment.body,
    };
    const edge = { node };
    if (children.length === 0) return { commentEdge: edge };
    const payload: Record<string, unknown> = { __typename: payloadType, commentEdge: edge };
    return executeSelections(ctx, payload, payloadType, children, variables);
  }
  ctx.errors.push({ message: `Cannot query field "${name}" on type "Mutation".` });
  return wrap({});
}

function findRepoByGlobalId(store: Store, id: string): Repo | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'Repository') return null;
  const [owner, name] = decoded.payload.split('/');
  return store.getRepo(owner, name);
}

function findIssueByGlobalId(store: Store, id: string): { repo: Repo; issue: Issue } | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'Issue') return null;
  const match = /^([^/]+)\/([^#]+)#(\d+)$/.exec(decoded.payload);
  if (!match) return null;
  const repo = store.getRepo(match[1], match[2]);
  if (repo === null) return null;
  const issue = repo.issues.find((i) => i.number === Number.parseInt(match[3], 10));
  return issue ? { repo, issue } : null;
}

function findPullByGlobalId(store: Store, id: string): { repo: Repo; pr: PullRequest } | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'PullRequest') return null;
  const match = /^([^/]+)\/([^#]+)#(\d+)$/.exec(decoded.payload);
  if (!match) return null;
  const repo = store.getRepo(match[1], match[2]);
  if (repo === null) return null;
  const pr = repo.pulls.find((p) => p.number === Number.parseInt(match[3], 10));
  return pr ? { repo, pr } : null;
}

// --- entry point -------------------------------------------------------------------

export function executeGraphQL(store: Store, body: unknown): unknown {
  const operations: { query: string; variables?: Record<string, unknown>; operationName?: string }[] = [];
  if (Array.isArray(body)) {
    for (const entry of body) {
      if (isRecord(entry) && typeof entry.query === 'string') {
        operations.push({
          query: entry.query,
          variables: isRecord(entry.variables) ? (entry.variables as Record<string, unknown>) : {},
          operationName: typeof entry.operationName === 'string' ? entry.operationName : undefined,
        });
      }
    }
  } else if (isRecord(body) && typeof body.query === 'string') {
    operations.push({
      query: body.query,
      variables: isRecord(body.variables) ? (body.variables as Record<string, unknown>) : {},
      operationName: typeof body.operationName === 'string' ? body.operationName : undefined,
    });
  } else {
    return { errors: [{ message: 'request body must carry a query string' }] };
  }

  const results = operations.map((operation) => executeOne(store, operation.query, operation.variables ?? {}, operation.operationName));
  return Array.isArray(body) ? results : results[0];
}

function executeOne(store: Store, query: string, variables: Record<string, unknown>, operationName?: string): Record<string, unknown> {
  let parsed: { operations: OperationNode[]; fragments: Map<string, FragmentNode> };
  try {
    parsed = new Parser(tokenize(query), variables).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : 'syntax error' }] };
  }
  const operation = operationName !== undefined ? parsed.operations.find((o) => o.name === operationName) : parsed.operations[0];
  if (!operation) return { errors: [{ message: `unknown operation ${operationName ?? ''}` }] };
  const ctx: Ctx = { store, errors: [], fragments: parsed.fragments };
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const root: Record<string, unknown> = { __typename: rootType };
  const data = executeSelections(ctx, root, rootType, operation.selections, variables);
  const out: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) out.errors = ctx.errors;
  return out;
}
