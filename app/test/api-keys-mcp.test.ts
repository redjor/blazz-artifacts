import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAdminApp } from '../src/admin/server.ts';
import { hashSecret, sha256 } from '../src/crypto.ts';
import { loginLimiterOptions, RateLimiter } from '../src/ratelimit.ts';
import { setup, setCookies } from './harness.ts';

async function harness() {
  const h = await setup({ adminPasswordHash: await hashSecret('test-password'), apiTokenHash: sha256('legacy') });
  const app = createAdminApp({ ...h, loginLimiter: new RateLimiter(loginLimiterOptions), now: h.clock.now });
  const login = await app.request('/api/login', { method: 'POST', headers: { origin: h.cfg.publicHubUrl, 'content-type': 'application/json' }, body: JSON.stringify({ password: 'test-password' }) });
  const { csrfToken } = await login.json();
  const headers = { cookie: setCookies(login), origin: h.cfg.publicHubUrl, 'x-csrf-token': csrfToken, 'content-type': 'application/json' };
  const create = async (scope: string, extra = {}) => {
    const r = await app.request('/api/keys', { method: 'POST', headers, body: JSON.stringify({ name: 'Agent', scope, ...extra }) });
    assert.equal(r.status, 201); return r.json();
  };
  return { ...h, app, headers, create };
}
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

test('managed API keys are one-time secrets, scoped, independently revoked and expiring', async () => {
  const h = await harness();
  const read = await h.create('read');
  assert.ok(read.token.startsWith('bza_'));
  const list = await (await h.app.request('/api/keys', { headers: h.headers })).json();
  assert.equal(list.length, 1); assert.equal(list[0].token, undefined); assert.equal(list[0].token_hash, undefined);
  const row = h.db.prepare('SELECT token_hash FROM api_keys WHERE id=?').get(read.id) as { token_hash: string };
  assert.equal(row.token_hash, sha256(read.token));
  assert.equal((await h.app.request('/api/artifacts', { headers: bearer(read.token) })).status, 200);
  assert.equal((await h.app.request('/api/artifacts', { method: 'POST', headers: bearer(read.token) })).status, 403);
  assert.equal((await h.app.request('/api/keys', { headers: bearer('legacy') })).status, 403);
  assert.equal((await h.app.request('/api/keys', { method: 'POST', headers: bearer(read.token) })).status, 403);
  assert.equal((await h.app.request(`/api/keys/${read.id}`, { method: 'DELETE', headers: h.headers })).status, 200);
  assert.equal((await h.app.request('/api/artifacts', { headers: bearer(read.token) })).status, 401);
  const expiring = await h.create('full', { expiresAt: new Date(h.clock.now() + 1000).toISOString() });
  assert.equal((await h.app.request('/api/artifacts', { headers: bearer(expiring.token) })).status, 200);
  h.clock.advance(1001);
  assert.equal((await h.app.request('/api/artifacts', { headers: bearer(expiring.token) })).status, 401);
  assert.equal((await h.app.request('/api/artifacts', { headers: bearer('legacy') })).status, 200);
});

test('publish keys cannot change access, delete, bulk mutate, or place new artifacts in shared folders', async () => {
  const h = await harness(); const { token } = await h.create('publish');
  for (const [method, path] of [['PATCH','/api/artifacts/test'], ['POST','/api/artifacts/bulk'], ['DELETE','/api/artifacts/test'], ['POST','/api/artifacts/test/share'], ['POST','/api/projects']]) {
    assert.equal((await h.app.request(path, { method, headers: bearer(token) })).status, 403, `${method} ${path}`);
  }
  for (const fields of [{visibility:'public'}, {project:'client'}, {code:'secret123'}]) {
    const form = new FormData(); form.set('file', new File(['# Test'], 'test.md'));
    for (const [k,v] of Object.entries(fields)) form.set(k,v!);
    assert.equal((await h.app.request('/api/artifacts', {method:'POST',headers:bearer(token),body:form})).status,403);
  }
});

test('MCP stateless initialize, tools and API-backed draft creation enforce the same permissions', async () => {
  const h = await harness(); const read = await h.create('read'); const pub = await h.create('publish');
  const rpc = (token: string, method: string, params = {}, id: number | undefined = 1) => h.app.request('/mcp', { method:'POST', headers:{...bearer(token),'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id: method.startsWith('notifications/') ? undefined : id,method,params}) });
  assert.equal((await h.app.request('/mcp', {method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,401);
  assert.equal((await h.app.request('/mcp', {method:'POST',headers:{...bearer(pub.token),origin:'https://evil.test','content-type':'application/json'},body:'{}'})).status,403);
  const init = await (await rpc(read.token,'initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'test',version:'1'}})).json();
  assert.equal(init.result.protocolVersion,'2025-03-26');
  assert.ok(init.result.capabilities.tools);
  assert.equal((await rpc(read.token,'notifications/initialized',{},undefined)).status,202);
  const listing = await (await rpc(read.token,'tools/list')).json();
  assert.deepEqual(listing.result.tools.map((t: {name:string})=>t.name),['list_artifacts','get_artifact']);
  const denied = await (await rpc(read.token,'tools/call',{name:'create_artifact',arguments:{filename:'hello.md',content:'# Hello'}})).json();
  assert.ok(denied.result.isError);
  const created = await (await rpc(pub.token,'tools/call',{name:'create_artifact',arguments:{filename:'hello.md',content:'# Hello',title:'Hello'}})).json();
  assert.equal(created.result.isError,undefined);
  const artifact = JSON.parse(created.result.content[0].text);
  assert.equal(artifact.visibility,'private');
  assert.equal(artifact.title,'Hello');
  const get = await (await rpc(read.token,'tools/call',{name:'get_artifact',arguments:{id:artifact.id}})).json();
  assert.equal(JSON.parse(get.result.content[0].text).id,artifact.id);
  assert.equal((await h.app.request('/mcp',{headers:bearer(read.token)})).status,405);
});

test('key management requires a session, Origin and CSRF and validates scope and expiry', async () => {
  const h = await harness();
  assert.equal((await h.app.request('/api/keys')).status,401);
  assert.equal((await h.app.request('/api/keys',{method:'POST',headers:{cookie:h.headers.cookie,origin:h.cfg.publicHubUrl,'content-type':'application/json'},body:'{}'})).status,403);
  for (const body of [{name:'',scope:'read'}, {name:'Agent',scope:'admin'}, {name:'Agent',scope:'read',expiresAt:'yesterday'}, {name:'Agent',scope:'read',expiresAt:new Date(h.clock.now()-1).toISOString()}]) {
    assert.equal((await h.app.request('/api/keys',{method:'POST',headers:h.headers,body:JSON.stringify(body)})).status,400);
  }
  const full = await h.create('full');
  assert.equal((await h.app.request('/api/keys',{headers:{...h.headers,...bearer(full.token)}})).status,403);
});

test('MCP validates transport and batches and follows explicit publication for updates', async () => {
  const h = await harness(); const {token} = await h.create('publish');
  const headers = {...bearer(token),'content-type':'application/json',accept:'application/json, text/event-stream'};
  const rpc = async (name: string, args: object) => {
    const response = await h.app.request('/mcp',{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})});
    assert.equal(response.status,200);
    const reply = await response.json(); assert.equal(reply.result.isError,undefined,JSON.stringify(reply));
    return JSON.parse(reply.result.content[0].text);
  };
  assert.equal((await h.app.request('/mcp',{method:'POST',headers:{...headers,accept:'application/json'},body:'{}'})).status,406);
  assert.equal((await h.app.request('/mcp',{method:'POST',headers:{...headers,'mcp-protocol-version':'unknown'},body:'{}'})).status,400);
  assert.equal((await h.app.request('/mcp',{method:'POST',headers,body:'{'})).status,400);
  const batch = await (await h.app.request('/mcp',{method:'POST',headers,body:JSON.stringify([{jsonrpc:'2.0',method:'notifications/initialized'},{jsonrpc:'2.0',id:2,method:'ping'}])})).json();
  assert.deepEqual(batch,[{jsonrpc:'2.0',id:2,result:{}}]);
  const draft = await rpc('create_artifact',{filename:'draft.md',content:'# One'});
  assert.equal(draft.publishedVersionId,null);
  const approved = await rpc('publish_artifact',{id:draft.id,versionId:draft.version.id});
  assert.equal(approved.publishedVersionId,draft.version.id);
  const updated = await rpc('update_artifact',{id:draft.id,filename:'draft.md',content:'# Two'});
  assert.notEqual(updated.version.id,draft.version.id);
  assert.equal(updated.publishedVersionId,draft.version.id);
});
