// @airmcp-dev/core — __tests__/tool-error.test.ts
//
// tools/call 에러 결과의 isError 전달 (MCP 스펙 server/tools, Error Handling).
// 입력 검증 실패, 핸들러 예외, 핸들러가 돌려준 { isError: true }는
// 결과에 isError: true로 남아야 클라이언트가 실패로 처리한다.

import { describe, it, expect } from 'vitest';
import { defineServer } from '../src/server/define-server.js';
import { defineTool } from '../src/tool/define-tool.js';
import { MiddlewareChain } from '../src/middleware/chain.js';

function makeServer() {
  return defineServer({
    name: 'iserror-test',
    version: '1.0.0',
    logging: { level: 'silent' },
    tools: [
      defineTool('add', {
        params: { a: 'number', b: 'number' },
        handler: async ({ a, b }) => a + b,
      }),
      defineTool('fail', {
        handler: async () => {
          throw new Error('upstream API failed');
        },
      }),
      defineTool('explicit', {
        handler: async () => ({
          content: [{ type: 'text', text: 'record not found' }],
          isError: true,
        }),
      }),
      defineTool('stats', {
        outputSchema: { count: 'number' },
        handler: async () => ({
          content: [{ type: 'text', text: '{"error":"quota exceeded"}' }],
          isError: true,
        }),
      }),
    ],
  });
}

/** 프로토콜 엔진을 그대로 쓰는 fetch 핸들러로 tools/call을 보낸다 */
async function callTool(name: string, args: Record<string, any>) {
  const res = await makeServer().fetch!(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    }),
  );
  return ((await res.json()) as any).result;
}

describe('tools/call isError propagation', () => {
  it('should not set isError on a successful call', async () => {
    const result = await callTool('add', { a: 1, b: 2 });
    expect(result.content).toEqual([{ type: 'text', text: '3' }]);
    expect(result.isError).toBeUndefined();
  });

  it('should set isError on input validation failures', async () => {
    const result = await callTool('add', { a: 'x', b: 1 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('[Validation]');
  });

  it('should set isError when the handler throws', async () => {
    const result = await callTool('fail', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('upstream API failed');
  });

  it('should keep isError from a handler that returns { content, isError: true }', async () => {
    const result = await callTool('explicit', {});
    expect(result).toEqual({
      content: [{ type: 'text', text: 'record not found' }],
      isError: true,
    });
  });

  it('should not attach structuredContent to an error result', async () => {
    const result = await callTool('stats', {});
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
  });
});

describe('MiddlewareChain.executeTool', () => {
  const ctx = () => ({ requestId: 'r1', serverName: 's1', startedAt: Date.now(), state: {} });

  it('should mark an unhandled handler exception as isError', async () => {
    const chain = new MiddlewareChain();
    const tool = {
      name: 'boom',
      handler: async () => {
        throw new Error('boom');
      },
    };
    expect(await chain.executeTool(tool, {}, ctx())).toEqual({
      content: [{ type: 'text', text: 'Error: boom' }],
      isError: true,
    });
  });

  it('should keep isError from an abortResponse', async () => {
    const chain = new MiddlewareChain();
    chain.add({
      name: 'deny',
      before: async () => ({
        abort: true,
        abortResponse: { content: [{ type: 'text', text: 'denied' }], isError: true },
      }),
    });
    const result = await chain.executeTool({ name: 't', handler: async () => 'ok' }, {}, ctx());
    expect(result).toEqual({ content: [{ type: 'text', text: 'denied' }], isError: true });
  });

  it('should keep execute() returning the content array', async () => {
    const chain = new MiddlewareChain();
    const result = await chain.execute({ name: 't', handler: async () => 'ok' }, {}, ctx());
    expect(result).toEqual([{ type: 'text', text: 'ok' }]);
  });
});
