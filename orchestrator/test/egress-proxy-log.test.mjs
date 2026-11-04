import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const imports = [
  "import { createServer } from 'node:http';",
  "import { connect } from 'node:net';",
  "import { request as httpsRequest } from 'node:https';",
  "import { readFileSync } from 'node:fs';",
];
const classes = ['KEY_UNAVAILABLE', 'HTTP_PATH_DENIED', 'MODEL_AUTH_DENIED', 'UPSTREAM_ERROR', 'MODEL_FORWARD', 'CONNECT_DENIED', 'CONNECT_ALLOWED', 'LISTENING'];
const goodToken = 'SYNTHETIC_VALID_TOKEN_123456789';
const badToken = 'SYNTHETIC_DENIED_TOKEN_123456789';
const expiredToken = 'SYNTHETIC_EXPIRED_TOKEN_123456789';
const key = 'SYNTHETIC_KEY_MEMORY_ONLY_123456789';
const keyPath = '/synthetic/KEY_PATH_SENTINEL';
const tokenPath = '/synthetic/TOKEN_PATH_SENTINEL';
const errorText = 'SYNTHETIC_FREE_ERROR_SENTINEL';
const execution = 'SYNTHETIC_EXECUTION_SENTINEL';
const check = (value) => assert.ok(value, 'PROXY_LOG_SEMANTICS');

function boot(body, missingKey = false) {
  const frames = [], sites = [], reads = [], requests = [], connections = [], deferred = [];
  let handler, connectHandler, listens = 0, exitCode = null;
  const exitSentinel = {};
  function stream() {
    const events = {};
    return { events, writes: [], pipes: [], destroyed: false,
      on(name, fn) { events[name] = fn; return this; },
      write(value) { this.writes.push(value); },
      pipe(target) { this.pipes.push(target); return target; },
      destroy() { this.destroyed = true; },
    };
  }
  const server = {
    on(name, fn) { check(name === 'connect'); connectHandler = fn; return this; },
    listen(port, host, fn) { check(port === 8888 && host === '0.0.0.0'); listens++; fn(); },
  };
  const context = {
    console: { error(...args) { frames.push(args); } },
    process: { env: { GLM_KEY_FILE: keyPath, MODEL_TOKENS_FILE: tokenPath }, exit(code) { exitCode = code; throw exitSentinel; } },
    createServer(fn) { handler = fn; return server; },
    readFileSync(path, encoding) {
      check(encoding === 'utf8'); reads.push(path);
      if (path === keyPath) { if (missingKey) throw new Error(errorText); return key; }
      check(path === tokenPath);
      return JSON.stringify({
        [goodToken]: { expires_at: '2999-01-01T00:00:00Z', execution_id: execution },
        [expiredToken]: { expires_at: '2000-01-01T00:00:00Z', execution_id: execution },
        SYNTHETIC_NO_EXPIRY: { execution_id: execution },
      });
    },
    httpsRequest(options, callback) { const up = stream(); requests.push({ options, callback, up }); return up; },
    connect(port, host, callback) { const up = stream(); connections.push({ port, host, up }); deferred.push(callback); return up; },
  };
  try { vm.runInNewContext(body, context, { timeout: 1000 }); }
  catch (e) { if (e !== exitSentinel) throw new Error('PROXY_LOG_FIXTURE_FAILURE'); }
  function capture(site, fn) { const n = frames.length; fn(); check(frames.length === n + 1); sites.push(site); }
  function request(url, headers = {}) {
    const req = { url, method: 'POST', headers, pipes: [], pipe(target) { this.pipes.push(target); } };
    const res = { headersSent: false, status: null, body: null,
      writeHead(code) { this.status = code; this.headersSent = true; }, end(value) { this.body = value; },
    };
    handler(req, res); return { req, res };
  }
  function socket() { const s = stream(); s.ends = []; s.end = (value) => s.ends.push(value); return s; }
  return { frames, sites, reads, requests, connections, deferred, capture, request, socket,
    connect(req, client, head) { connectHandler(req, client, head); },
    get listens() { return listens; }, get exitCode() { return exitCode; } };
}

test('proxy explicit logs are fixed events with unchanged component behavior', () => {
  let body = readFileSync(new URL('../docker/egress-proxy.mjs', import.meta.url), 'utf8');
  check((body.match(/^import .*;$/gm) || []).length === 4);
  for (const line of imports) { check(body.split(line).length === 2); body = body.replace(line, ''); }
  const missing = boot(body, true);
  check(missing.exitCode === 1 && missing.listens === 0 && missing.frames.length === 1 && missing.reads.length === 1);
  missing.sites.push('KEY_UNAVAILABLE');
  const b = boot(body);
  check(b.exitCode === null && b.listens === 1 && b.frames.length === 1);
  b.sites.push('LISTENING');
  let result;
  b.capture('HTTP_PATH_DENIED', () => { result = b.request('/SYNTHETIC_PATH_SENTINEL'); });
  check(result.res.status === 403 && result.res.body === 'forbidden path\n');
  for (const url of ['/api/anthropic/s/' + badToken + '/v1/messages', '/api/anthropic/v1/messages', '/api/anthropic/s/' + expiredToken + '/v1/messages']) {
    b.capture('MODEL_AUTH_DENIED', () => { result = b.request(url); });
    check(result.res.status === 401 && result.res.body === 'model authorization required\n');
  }
  b.capture('MODEL_AUTH_DENIED', () => { result = b.request('/api/anthropic/v1/messages', { 'x-jarvis-exec': badToken }); });
  check(result.res.status === 401 && result.res.body === 'model authorization required\n' && b.requests.length === 0);
  b.capture('MODEL_FORWARD', () => { result = b.request('/api/anthropic/s/' + goodToken + '/v1/messages', { host: 'SYNTHETIC_HOST_SENTINEL' }); });
  const first = b.requests[0];
  check(first.options.host === 'open.bigmodel.cn' && first.options.port === 443 && first.options.path === '/api/anthropic/v1/messages' && first.options.method === 'POST');
  check(first.options.headers.host === 'open.bigmodel.cn' && first.options.headers.authorization === 'Bearer ' + key && result.req.pipes[0] === first.up);
  b.capture('UPSTREAM_ERROR', () => first.up.events.error(new Error(errorText)));
  check(result.res.status === 502 && result.res.body === 'upstream error\n');
  b.capture('MODEL_FORWARD', () => { result = b.request('/api/anthropic/v1/messages', { 'x-jarvis-exec': goodToken }); });
  check(b.requests[1].options.path === '/api/anthropic/v1/messages');
  let responsePipes = 0;
  b.requests[1].callback({ statusCode: 201, headers: {}, pipe(target) { check(target === result.res); responsePipes++; } });
  check(result.res.status === 201 && responsePipes === 1);
  b.capture('UPSTREAM_ERROR', () => b.requests[1].up.events.error(new Error(errorText)));
  check(result.res.status === 201 && result.res.body === null);
  const denied = b.socket();
  b.capture('CONNECT_DENIED', () => b.connect({ url: 'SYNTHETIC_DENIED_HOST:443' }, denied, 'SYNTHETIC_HEAD'));
  check(denied.ends[0] === 'HTTP/1.1 403 Forbidden\r\n\r\n' && b.connections.length === 0);
  const client = b.socket();
  b.connect({ url: 'open.bigmodel.cn:443' }, client, 'SYNTHETIC_HEAD');
  check(b.connections.length === 1 && b.frames.length === b.sites.length);
  b.capture('CONNECT_ALLOWED', () => b.deferred.shift()());
  const conn = b.connections[0];
  check(conn.host === 'open.bigmodel.cn' && conn.port === 443 && client.writes[0] === 'HTTP/1.1 200 Connection Established\r\n\r\n');
  check(conn.up.writes[0] === 'SYNTHETIC_HEAD' && conn.up.pipes[0] === client && client.pipes[0] === conn.up);
  conn.up.events.error(); client.events.error();
  check(client.ends[0] === 'HTTP/1.1 502 Bad Gateway\r\n\r\n' && conn.up.destroyed);
  check(b.requests.length === 2 && b.connections.length === 1 && b.reads.filter(x => x === keyPath).length === 1 && b.reads.filter(x => x === tokenPath).length === 6);
  const frames = [...missing.frames, ...b.frames], sites = [...missing.sites, ...b.sites];
  check(classes.every(x => sites.includes(x)) && frames.length === sites.length);
  console.log('PROXY_LOG_COVERAGE ' + JSON.stringify({ kind: 'PROXY_LOG_COVERAGE', sites: 8, semanticChecksPassed: true, forwardCount: 2, connectCount: 1 }));
  const sentinels = [goodToken, badToken, expiredToken, badToken.slice(0, 6), key, keyPath, tokenPath, errorText, execution, 'SYNTHETIC_PATH_SENTINEL', 'SYNTHETIC_HOST_SENTINEL', 'SYNTHETIC_DENIED_HOST'];
  const valid = frames.every((args, i) => {
    if (args.length !== 1 || typeof args[0] !== 'string' || sentinels.some(x => args[0].includes(x))) return false;
    try { const value = JSON.parse(args[0]); return Object.keys(value).sort().join(',') === 'class,kind' && value.kind === 'EGRESS_PROXY_EVENT' && value.class === sites[i] && classes.includes(value.class); }
    catch { return false; }
  });
  assert.ok(valid, 'PROXY_LOG_FIXED_SCHEMA');
  console.log('PROXY_LOG_COMPONENT ' + JSON.stringify({ kind: 'PROXY_LOG_COMPONENT', fixedSchema: true, sites: 8, semanticChecksPassed: true }));
});
