import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { hubOrigins, type Config } from '../config.ts';
import type { Db } from '../db.ts';
import type { RateLimiter } from '../ratelimit.ts';
import { tokenMiddleware, type AdminEnv } from './auth.ts';

const string = { type: 'string', minLength: 1 };
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const tools = [
  { name: 'list_artifacts', description: 'List artifacts, working versions and publication status.', inputSchema: schema({}), annotations: { readOnlyHint: true } },
  { name: 'get_artifact', description: 'Get one artifact by its id, including its sharing status.', inputSchema: schema({ id: string }, ['id']), annotations: { readOnlyHint: true } },
  { name: 'create_artifact', description: 'Create a private draft from text source. filename selects HTML, Markdown, JSON or JSX/TSX. Publishing and access changes are separate actions.', inputSchema: schema({ filename: string, content: { type: 'string' }, title: string, slug: string, message: string }, ['filename','content']) },
  { name: 'update_artifact', description: 'Upload a new working version from text source. The client-facing version stays unchanged until publish_artifact.', inputSchema: schema({ id: string, filename: string, content: { type: 'string' }, message: string }, ['id','filename','content']) },
  { name: 'publish_artifact', description: 'Approve a specific version for visitors, keeping the stable link and existing access mode. Use only after the user approves publication.', inputSchema: schema({ id: string, versionId: string }, ['id','versionId']) },
];
const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Stateless Streamable HTTP, JSON responses, protocol 2025-03-26. No browser cookies or cross-origin callers. */
export function registerMcp(app: Hono<AdminEnv>, deps: { db: Db; cfg: Config; loginLimiter: RateLimiter; now: () => number }): void {
  app.use('/mcp', tokenMiddleware(deps.cfg, deps.loginLimiter, deps.db, deps.now), async (c, next) => {
    c.header('Cache-Control', 'no-store');
    const origin = c.req.header('origin');
    if (origin && !hubOrigins(deps.cfg).includes(origin)) return c.json({ error: 'Origin refused' }, 403);
    if (!c.get('viaToken')) return c.json({ error: 'Bearer API key required' }, 401);
    const version = c.req.header('mcp-protocol-version');
    if (version && version !== '2025-03-26') return c.json({ error: 'Unsupported protocol version' }, 400);
    await next();
  });
  app.get('/mcp', c => c.body(null, 405, { Allow: 'POST' }));
  app.delete('/mcp', c => c.body(null, 405, { Allow: 'POST' }));
  app.post('/mcp', bodyLimit({ maxSize: Math.min(deps.cfg.maxUploadBytes + 65536, 2 * 1024 * 1024) }), async c => {
    if (!c.req.header('content-type')?.startsWith('application/json')) return c.json(rpcError(null, -32600, 'JSON required'), 415);
    const accept = c.req.header('accept') ?? '';
    if (!accept.includes('application/json') || !accept.includes('text/event-stream')) return c.json(rpcError(null, -32600, 'Accept application/json and text/event-stream'), 406);
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json(rpcError(null, -32700, 'Parse error'), 400); }
    const available = c.get('apiScope') === 'read' ? tools.slice(0,2) : tools;
    const dispatch = async (msg: unknown): Promise<unknown | null> => {
      if (!object(msg) || msg.jsonrpc !== '2.0' || (msg.id !== undefined && typeof msg.id !== 'string' && typeof msg.id !== 'number' && msg.id !== null)) return rpcError(null, -32600, 'Invalid request');
      if (msg.id === undefined) {
        if (typeof msg.method !== 'string') return rpcError(null, -32600, 'Invalid notification');
        return null;
      }
      const id = msg.id;
      const result = (value: unknown) => ({ jsonrpc: '2.0', id, result: value });
      if (msg.method === 'initialize') return result({ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'blazz-artifacts', version: '0.1.0' }, instructions: 'Create and update drafts, then explicitly approve a version using publish_artifact. Publication preserves the existing access mode; new artifacts are private.' });
      if (msg.method === 'ping') return result({});
      if (msg.method === 'tools/list') return result({ tools: available });
      if (msg.method !== 'tools/call') return rpcError(id, -32601, 'Method not found');
      if (!object(msg.params) || typeof msg.params.name !== 'string') return rpcError(id, -32602, 'Tool name required');
      const name = msg.params.name;
      const tool = available.find(t => t.name === name);
      const failure = (text: string) => result({ content: [{ type: 'text', text }], isError: true });
      if (!tool) return failure('Unknown tool or insufficient API key scope');
      const args = msg.params.arguments ?? {};
      if (!object(args) || Object.keys(args).some(k => !(k in tool.inputSchema.properties)) || tool.inputSchema.required.some(k => typeof args[k] !== 'string' || (k !== 'content' && !args[k])) || Object.entries(args).some(([k,v]) => typeof v !== 'string' || (k !== 'content' && !v))) return rpcError(id, -32602, 'Invalid tool arguments');
      const headers: Record<string,string> = { authorization: c.req.header('authorization')! };
      if (c.req.header('x-forwarded-for')) headers['x-forwarded-for'] = c.req.header('x-forwarded-for')!;
      let path = '/api/artifacts'; let method = 'GET'; let payload: BodyInit | undefined;
      const enc = encodeURIComponent;
      if (tool.name === 'get_artifact') path += `/${enc(args.id as string)}`;
      if (tool.name === 'publish_artifact') {
        path += `/${enc(args.id as string)}/publish`; method = 'POST';
        headers['content-type'] = 'application/json'; payload = JSON.stringify({ versionId: args.versionId });
      }
      if (tool.name === 'create_artifact' || tool.name === 'update_artifact') {
        if (!/^[^/\\]+\.(?:html?|md|markdown|json|jsx|tsx)$/i.test(args.filename as string)) return failure('Use a text source filename ending in .html, .md, .json, .jsx or .tsx');
        if (Buffer.byteLength(args.content as string, 'utf8') > deps.cfg.maxUploadBytes) return failure('Source exceeds upload limit');
        const form = new FormData(); form.set('file', new File([args.content as string], args.filename as string));
        for (const key of ['title','slug','message']) if (typeof args[key] === 'string') form.set(key, args[key] as string);
        payload = form;
        method = tool.name === 'create_artifact' ? 'POST' : 'PUT';
        if (method === 'PUT') path += `/${enc(args.id as string)}/content`;
      }
      // Re-enter the real API with the same credential: scopes, validation, upload limits and publication rules apply there too.
      const response = await app.request(path, { method, headers, body: payload });
      const text = await response.text();
      return response.ok ? result({ content: [{ type: 'text', text }] }) : failure(text);
    };
    if (Array.isArray(body)) {
      if (!body.length || body.length > 20) return c.json(rpcError(null, -32600, 'Batch must contain 1–20 messages'), 400);
      const responses: unknown[] = [];
      for (const item of body) { const response = await dispatch(item); if (response) responses.push(response); }
      return responses.length ? c.json(responses) : c.body(null, 202);
    }
    const response = await dispatch(body);
    return response ? c.json(response) : c.body(null, 202);
  });
}
