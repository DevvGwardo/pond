// ── Column types ──────────────────────────────────────────

export interface ColumnType {
  _sqlType: string
}

export function string(): ColumnType {
  return { _sqlType: "TEXT" }
}

export function number(): ColumnType {
  return { _sqlType: "REAL" }
}

export function boolean(): ColumnType {
  return { _sqlType: "INTEGER" }
}

// ── Table ──────────────────────────────────────────────────

export function table<T extends Record<string, ColumnType>>(columns: T): T {
  return columns
}

// ── Context ────────────────────────────────────────────────

export interface CapsuleAuth {
  isGuest: boolean
  userId: string
  displayName?: string
  picture?: string
  email?: string
}

export interface CapsuleLog {
  info(msg: string, data?: any): void
  error(msg: string, data?: any): void
}

export interface CapsuleDbTable {
  where(column: string, value: any): QueryBuilder
  orderBy(column: string, dir: "asc" | "desc"): QueryBuilder
  limit(n: number): QueryBuilder
  all(): any[]
  get(id: string): any
  insert(data: Record<string, any>): any
  update(id: string, data: Record<string, any>): any
  delete(id: string): void
}

export interface QueryBuilder {
  orderBy(column: string, dir: "asc" | "desc"): QueryBuilder
  limit(n: number): QueryBuilder
  all(): any[]
}

export interface CapsuleDb {
  [tableName: string]: CapsuleDbTable
}

export interface AiCompleteOptions {
  prompt: string
  model?: string
  system?: string
  maxTokens?: number
  temperature?: number
}

export interface CapsuleAi {
  complete(opts: AiCompleteOptions): Promise<string>
  stream(opts: AiCompleteOptions): AsyncIterable<string>
}

export interface CapsuleBlob {
  put(
    key: string,
    bytes: Uint8Array | ArrayBuffer | Buffer | string,
    options?: { contentType?: string },
  ): Promise<{ key: string; size: number }>
  get(key: string): Promise<{ bytes: Buffer; contentType: string } | null>
  delete(key: string): Promise<void>
  list(prefix?: string): Promise<Array<{ key: string; size: number; contentType: string }>>
}

export interface CapsuleContext {
  auth: CapsuleAuth
  db: CapsuleDb
  env: Record<string, string>
  log: CapsuleLog
  ai: CapsuleAi
  blob: CapsuleBlob
}

// ── Handlers ───────────────────────────────────────────────

export type QueryHandler<TArgs extends any[] = any[], TResult = any> = (
  ctx: CapsuleContext,
  ...args: TArgs
) => TResult | Promise<TResult>

export type MutationHandler<TArgs extends any[] = any[], TResult = any> = (
  ctx: CapsuleContext,
  ...args: TArgs
) => TResult | Promise<TResult>

export interface EndpointRequest {
  headers: Headers
  query: Record<string, string>
  json<T>(): Promise<T>
  text(): Promise<string>
  bytes(): Promise<ArrayBuffer>
}

export interface EndpointResponse {
  body: string | null
  status: number
  headers: Record<string, string>
}

export type EndpointHandler = (
  ctx: CapsuleContext,
  req: EndpointRequest,
) => EndpointResponse | Promise<EndpointResponse>

export interface SocketLike {
  send(data: string): void
  close(code?: number, reason?: string): void
  on(event: "message", listener: (data: string) => void): void
  on(event: "close", listener: () => void): void
}

export type SocketHandler = (ctx: CapsuleContext, socket: SocketLike) => void | Promise<void>

interface SocketDefinition {
  _kind: "socket"
  handler: SocketHandler
}

// ── Response helpers ───────────────────────────────────────

export function json(body: any, init?: { status?: number; headers?: Record<string, string> }): EndpointResponse {
  return {
    body: JSON.stringify(body),
    status: init?.status ?? 200,
    headers: { "content-type": "application/json", ...init?.headers },
  }
}

export function text(body: string, init?: { status?: number; headers?: Record<string, string> }): EndpointResponse {
  return {
    body,
    status: init?.status ?? 200,
    headers: { "content-type": "text/plain", ...init?.headers },
  }
}

// ── Rate limits ────────────────────────────────────────────

export interface RouteRateLimit {
  perMinute?: number
  perHour?: number
  by?: "ip" | "user"
}

// ── Capsule definition ─────────────────────────────────────

export interface CapsuleDefinition {
  schema: Record<string, Record<string, ColumnType>>
  queries: Record<string, QueryHandler>
  mutations: Record<string, MutationHandler>
  endpoints?: Record<string, EndpointDefinition>
  sockets?: Record<string, SocketDefinition>
  allowedOrigins?: string[]
  rateLimit?: Record<string, RouteRateLimit>
  public?: boolean
  title?: string
  description?: string
}

interface EndpointDefinition {
  _method: string
  _path: string
  handler: EndpointHandler
}

export function capsule(def: {
  schema: Record<string, Record<string, ColumnType>>
  queries: Record<string, QueryHandler>
  mutations: Record<string, MutationHandler>
  endpoints?: Record<
    string,
    EndpointDefinition | ((ctx: CapsuleContext, req: EndpointRequest) => EndpointResponse | Promise<EndpointResponse>)
  >
  sockets?: Record<string, SocketDefinition>
  allowedOrigins?: string[]
  rateLimit?: Record<string, RouteRateLimit>
  public?: boolean
  title?: string
  description?: string
}): CapsuleDefinition {
  return {
    schema: def.schema,
    queries: def.queries,
    mutations: def.mutations,
    endpoints: def.endpoints as unknown as Record<string, EndpointDefinition>,
    sockets: def.sockets,
    allowedOrigins: def.allowedOrigins,
    rateLimit: def.rateLimit,
    public: def.public,
    title: def.title,
    description: def.description,
  }
}

export function query<TArgs extends any[], TResult>(
  handler: QueryHandler<TArgs, TResult>,
): QueryHandler<TArgs, TResult> {
  return handler
}

export function mutation<TArgs extends any[], TResult>(
  handler: MutationHandler<TArgs, TResult>,
): MutationHandler<TArgs, TResult> {
  return handler
}

export function endpoint(opts: { method: string; path: string }, handler: EndpointHandler): EndpointDefinition {
  return {
    _method: opts.method,
    _path: opts.path,
    handler,
  }
}

export function socket(handler: SocketHandler): SocketDefinition {
  return { _kind: "socket", handler }
}
