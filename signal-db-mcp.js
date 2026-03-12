#!/usr/bin/env node

/**
 * MCP (Model Context Protocol) server for browsing a local Signal Desktop database.
 *
 * Exposes the same read-only query functionality as the CLI via stdio transport.
 * Tools: get_messages, get_conversations, get_calls, get_message_by_id.
 *
 * IMPORTANT: No console.log — stdout is the JSON-RPC channel.
 */

import os from 'os';
import path from 'path';
import dotenv from 'dotenv';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import pkg from './package.json' with { type: 'json' };

import {
  openDB,
  formatDate,
  getMessages,
  getConversations,
  findConversations,
  getCalls,
  getMessageById,
} from './lib/signal-db.js';

// Load env (same locations as CLI)
dotenv.config({ quiet: true });
dotenv.config({ path: path.join(os.homedir(), '.signal-db-cli', '.env'), quiet: true });

// Validate key
if (!process.env.SIGNAL_DECRYPTION_KEY) {
  console.error('SIGNAL_DECRYPTION_KEY is not set. Set it in .env or ~/.signal-db-cli/.env');
  process.exit(1);
}

// Open DB once (read-only, long-lived process)
let db;
try {
  db = openDB();
} catch (err) {
  console.error(`Failed to open Signal database: ${err.message}`);
  process.exit(1);
}

const server = new McpServer({
  name: 'signal-db',
  version: pkg.version,
});

// --- Tool: get_messages ---
server.tool(
  'get_messages',
  'Search and filter Signal messages. Supports full-text search, conversation filter, unread/unanswered filters, date ranges (ISO or relative like 5h/3d), and direction filters.',
  {
    search: z.string().optional().describe('Full-text search query (spaces=OR, commas=AND, prefix matching)'),
    conv: z.string().optional().describe('Conversation name, phone number, or UUID to filter by'),
    unread: z.boolean().optional().describe('Only unread incoming messages'),
    unanswered: z.boolean().optional().describe('Only unanswered incoming messages'),
    olderThan: z.number().optional().describe('Hours threshold for unanswered filter (default 24)'),
    from: z.string().optional().describe('Start date (ISO like 2025-01-15, or relative like 5h/3d/10m)'),
    to: z.string().optional().describe('End date (ISO or relative)'),
    incoming: z.boolean().optional().describe('Only incoming messages'),
    outgoing: z.boolean().optional().describe('Only outgoing messages'),
    limit: z.number().optional().describe('Max results (default 20)'),
  },
  async (params) => {
    const result = getMessages(db, {
      search: params.search,
      conv: params.conv,
      unread: params.unread ?? false,
      unanswered: params.unanswered ?? false,
      olderThan: params.olderThan ?? 24,
      from: params.from,
      to: params.to,
      incoming: params.incoming ?? false,
      outgoing: params.outgoing ?? false,
      limit: params.limit ?? 20,
    });

    if (result.error) {
      return { content: [{ type: 'text', text: result.error }], isError: true };
    }

    const messages = result.messages.map((m) => ({
      ...m,
      date: formatDate(m.sent_at),
    }));

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ messages, total: result.total, conversationName: result.conversationName }, null, 2),
      }],
    };
  }
);

// --- Tool: get_conversations ---
server.tool(
  'get_conversations',
  'List or search Signal conversations. Without a query, lists recent conversations. With a query, searches by name/phone/ID.',
  {
    query: z.string().optional().describe('Search conversations by name, phone number, or ID'),
    type: z.enum(['private', 'group']).optional().describe('Filter by conversation type'),
    limit: z.number().optional().describe('Max results (default 50)'),
  },
  async (params) => {
    let convs;
    if (params.query) {
      convs = findConversations(db, params.query);
    } else {
      convs = getConversations(db, {
        type: params.type ?? null,
        limit: params.limit ?? 50,
      });
    }

    const enriched = convs.map((c) => ({
      ...c,
      lastActive: formatDate(c.active_at),
    }));

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ conversations: enriched }, null, 2),
      }],
    };
  }
);

// --- Tool: get_calls ---
server.tool(
  'get_calls',
  'Get recent Signal call history.',
  {
    limit: z.number().optional().describe('Max results (default 20)'),
  },
  async (params) => {
    const calls = getCalls(db, params.limit ?? 20);
    const enriched = calls.map((c) => ({
      ...c,
      date: formatDate(c.timestamp),
    }));

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ calls: enriched }, null, 2),
      }],
    };
  }
);

// --- Tool: get_message_by_id ---
server.tool(
  'get_message_by_id',
  'Retrieve a single Signal message by its ID, including full body text.',
  {
    id: z.string().describe('Message ID'),
  },
  async (params) => {
    const msg = getMessageById(db, params.id);
    if (!msg) {
      return { content: [{ type: 'text', text: 'Message not found' }], isError: true };
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ ...msg, date: formatDate(msg.sent_at) }, null, 2),
      }],
    };
  }
);

// --- Tool: get_phone ---
server.tool(
  'get_phone',
  'Look up phone numbers by contact name.',
  {
    query: z.string().describe('Contact name to search for'),
  },
  async (params) => {
    const convs = findConversations(db, params.query).filter((c) => c.e164);
    const contacts = convs.map((c) => ({ name: c.name, phone: c.e164 }));

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ contacts }, null, 2),
      }],
    };
  }
);

// Connect via stdio
const transport = new StdioServerTransport();
await server.connect(transport);
