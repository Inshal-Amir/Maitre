// A real stdio MCP server (official SDK) used by the connector tests.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const notes = [];
const server = new McpServer({ name: 'notes', version: '1.0.0' });
server.registerTool('add_note', { description: 'Add a note', inputSchema: { text: z.string() } }, ({ text }) => {
  notes.push(text);
  return { content: [{ type: 'text', text: `saved note ${notes.length}` }] };
});
server.registerTool('list_notes', { description: 'List notes', inputSchema: {}, annotations: { readOnlyHint: true } }, () => ({
  content: [{ type: 'text', text: notes.join('\n') || 'no notes' }],
}));
server.registerTool('delete_all', { description: 'Delete all notes', inputSchema: {} }, () => ({ content: [{ type: 'text', text: 'nope' }], isError: true }));
await server.connect(new StdioServerTransport());
