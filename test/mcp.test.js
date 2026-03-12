import { describe, it, expect } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';

/**
 * Tests the MCP server tool registration and schema validation.
 * Uses in-memory transport — no real DB needed.
 */

function createTestServer() {
  const server = new McpServer({ name: 'signal-db-test', version: '0.0.1' });

  server.tool(
    'get_messages',
    'Search and filter Signal messages.',
    {
      search: z.string().optional(),
      conv: z.string().optional(),
      unread: z.boolean().optional(),
      unanswered: z.boolean().optional(),
      olderThan: z.number().optional(),
      from: z.string().optional(),
      to: z.string().optional(),
      incoming: z.boolean().optional(),
      outgoing: z.boolean().optional(),
      limit: z.number().optional(),
    },
    async (params) => {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ messages: [], total: 0, params }),
        }],
      };
    }
  );

  server.tool(
    'get_conversations',
    'List or search Signal conversations.',
    {
      query: z.string().optional(),
      type: z.enum(['private', 'group']).optional(),
      limit: z.number().optional(),
    },
    async (params) => {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ conversations: [], params }),
        }],
      };
    }
  );

  server.tool(
    'get_calls',
    'Get recent Signal call history.',
    {
      limit: z.number().optional(),
    },
    async (params) => {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ calls: [], params }),
        }],
      };
    }
  );

  server.tool(
    'get_message_by_id',
    'Retrieve a single Signal message by its ID.',
    {
      id: z.string(),
    },
    async (params) => {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ id: params.id, body: 'test' }),
        }],
      };
    }
  );

  server.tool(
    'get_phone',
    'Look up phone numbers by contact name.',
    {
      query: z.string(),
    },
    async (params) => {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ contacts: [{ name: 'Test', phone: '+420123' }], query: params.query }),
        }],
      };
    }
  );

  return server;
}

async function createConnectedPair() {
  const server = createTestServer();
  const client = new Client({ name: 'test-client', version: '0.0.1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { server, client };
}

describe('MCP Server', () => {
  it('registers all 5 tools', async () => {
    const { client } = await createConnectedPair();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(['get_calls', 'get_conversations', 'get_message_by_id', 'get_messages', 'get_phone']);
  });

  it('get_messages tool has correct parameters', async () => {
    const { client } = await createConnectedPair();
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'get_messages');
    const props = Object.keys(tool.inputSchema.properties);
    expect(props).toContain('search');
    expect(props).toContain('conv');
    expect(props).toContain('unread');
    expect(props).toContain('from');
    expect(props).toContain('to');
    expect(props).toContain('limit');
  });

  it('get_messages returns result with params', async () => {
    const { client } = await createConnectedPair();
    const result = await client.callTool({ name: 'get_messages', arguments: { search: 'hello', limit: 5 } });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.total).toBe(0);
    expect(parsed.params.search).toBe('hello');
    expect(parsed.params.limit).toBe(5);
  });

  it('get_conversations accepts type filter', async () => {
    const { client } = await createConnectedPair();
    const result = await client.callTool({ name: 'get_conversations', arguments: { type: 'private' } });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.params.type).toBe('private');
  });

  it('get_message_by_id requires id parameter', async () => {
    const { client } = await createConnectedPair();
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'get_message_by_id');
    expect(tool.inputSchema.required).toContain('id');
  });

  it('get_message_by_id returns message', async () => {
    const { client } = await createConnectedPair();
    const result = await client.callTool({ name: 'get_message_by_id', arguments: { id: 'abc-123' } });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.id).toBe('abc-123');
    expect(parsed.body).toBe('test');
  });

  it('get_calls accepts limit', async () => {
    const { client } = await createConnectedPair();
    const result = await client.callTool({ name: 'get_calls', arguments: { limit: 10 } });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.params.limit).toBe(10);
  });

  it('get_phone returns contacts', async () => {
    const { client } = await createConnectedPair();
    const result = await client.callTool({ name: 'get_phone', arguments: { query: 'Test' } });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.contacts).toHaveLength(1);
    expect(parsed.contacts[0].phone).toBe('+420123');
    expect(parsed.query).toBe('Test');
  });
});
