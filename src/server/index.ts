// ── Column types ──────────────────────────────────────────

export interface ColumnType {
  _sqlType: string;
}

export function string(): ColumnType {
  return { _sqlType: "TEXT" };
}

export function number(): ColumnType {
  return { _sqlType: "REAL" };
}

export function boolean(): ColumnType {
  return { _sqlType: "INTEGER" };
}

// ── Table ──────────────────────────────────────────────────

export function table<T extends Record<string, ColumnType>>(
  columns: T
): T {
  return columns;
}

// ── Context ────────────────────────────────────────────────

export interface CapsuleAuth {
  isGuest: boolean;
  userId: string;
  displayName?: string;
  picture?: string;
}

export interface CapsuleLog {
  info(msg: string, data?: any): void;
  error(msg: string, data?: any): void;
}

export interface CapsuleDbTable {
  where(column: string, value: string): QueryBuilder;
  orderBy(column: string, dir: "asc" | "desc"): QueryBuilder;
  all(): any[];
  get(id: string): any;
  insert(data: Record<string, any>): any;
  update(id: string, data: Record<string, any>): any;
  delete(id: string): void;
}

export interface QueryBuilder {
  orderBy(column: string, dir: "asc" | "desc"): QueryBuilder;
  limit(n: number): QueryBuilder;
  all(): any[];
}

export interface CapsuleDb {
  [tableName: string]: CapsuleDbTable;
}

export interface CapsuleContext {
  auth: CapsuleAuth;
  db: CapsuleDb;
  env: Record<string, string>;
  log: CapsuleLog;
}

// ── Handlers ───────────────────────────────────────────────

export type QueryHandler<TResult = any> = (ctx: CapsuleContext) => TResult | Promise<TResult>;

export type MutationHandler<TArgs extends any[] = any[], TResult = any> = (
  ctx: CapsuleContext,
  ...args: TArgs
) => TResult | Promise<TResult>;

export interface EndpointRequest {
  headers: Headers;
  query: Record<string, string>;
  json<T>(): Promise<T>;
  text(): Promise<string>;
  bytes(): Promise<ArrayBuffer>;
}

export interface EndpointResponse {
  body: string | null;
  status: number;
  headers: Record<string, string>;
}

export type EndpointHandler = (
  ctx: CapsuleContext,
  req: EndpointRequest
) => EndpointResponse | Promise<EndpointResponse>;

// ── Response helpers ───────────────────────────────────────

export function json(body: any, init?: { status?: number; headers?: Record<string, string> }): EndpointResponse {
  return {
    body: JSON.stringify(body),
    status: init?.status ?? 200,
    headers: { "content-type": "application/json", ...init?.headers },
  };
}

export function text(body: string, init?: { status?: number; headers?: Record<string, string> }): EndpointResponse {
  return {
    body,
    status: init?.status ?? 200,
    headers: { "content-type": "text/plain", ...init?.headers },
  };
}

// ── Capsule definition ─────────────────────────────────────

export interface CapsuleDefinition {
  schema: Record<string, Record<string, ColumnType>>;
  queries: Record<string, QueryHandler>;
  mutations: Record<string, MutationHandler>;
  endpoints?: Record<string, EndpointDefinition>;
}

interface EndpointDefinition {
  _method: string;
  _path: string;
  handler: EndpointHandler;
}

export function capsule(def: {
  schema: Record<string, Record<string, ColumnType>>;
  queries: Record<string, QueryHandler>;
  mutations: Record<string, MutationHandler>;
  endpoints?: Record<
    string,
    (ctx: CapsuleContext, req: EndpointRequest) => EndpointResponse | Promise<EndpointResponse>
  >;
}): CapsuleDefinition {
  return {
    schema: def.schema,
    queries: def.queries,
    mutations: def.mutations,
    endpoints: def.endpoints as unknown as Record<string, EndpointDefinition>,
  };
}

export function query<T>(handler: QueryHandler<T>): QueryHandler<T> {
  return handler;
}

export function mutation<TArgs extends any[], TResult>(
  handler: MutationHandler<TArgs, TResult>
): MutationHandler<TArgs, TResult> {
  return handler;
}

export function endpoint(
  opts: { method: string; path: string },
  handler: EndpointHandler
): EndpointDefinition {
  return {
    _method: opts.method,
    _path: opts.path,
    handler,
  };
}
