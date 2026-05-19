import assert from 'node:assert/strict';
import {
  buildSseMessageEndpoint,
  getSseJsonBodyLimit,
  isSseRequestAuthorized,
} from './dist/src/mcp-server/transport/sse.js';

function createRequest({ query = {}, headers = {} } = {}) {
  return { query, headers };
}

assert.equal(
  buildSseMessageEndpoint(undefined),
  '/messages',
  'no token should keep the legacy message endpoint',
);

assert.equal(
  buildSseMessageEndpoint('abc 123&x=1'),
  '/messages?token=abc+123%26x%3D1',
  'token should be URL encoded before it is advertised to the SSE client',
);

assert.equal(
  isSseRequestAuthorized(createRequest({ query: { token: 'secret' } }), 'secret'),
  true,
  'matching token query parameter should authorize the request',
);

assert.equal(
  isSseRequestAuthorized(createRequest({ query: { token: 'wrong' } }), 'secret'),
  false,
  'wrong token query parameter should reject the request',
);

assert.equal(
  isSseRequestAuthorized(
    createRequest({ headers: { authorization: 'Bearer secret' } }),
    'secret',
  ),
  true,
  'Bearer token should also be accepted for non-ChatGPT clients',
);

assert.equal(
  isSseRequestAuthorized(createRequest(), undefined),
  true,
  'missing configured token should preserve unauthenticated local SSE behavior',
);

delete process.env.MCP_SSE_JSON_LIMIT;
assert.equal(
  getSseJsonBodyLimit(),
  '16mb',
  'SSE JSON body limit should default to 16mb for ChatGPT clients',
);

process.env.MCP_SSE_JSON_LIMIT = '24mb';
assert.equal(
  getSseJsonBodyLimit(),
  '24mb',
  'SSE JSON body limit should support environment override',
);
delete process.env.MCP_SSE_JSON_LIMIT;

console.log('SSE auth helpers verified');
