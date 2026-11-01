// A stdio MCP server that reports one environment variable: proves plugin `${VAR}` values reach the server.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new McpServer({ name: 'env', version: '1.0.0' });
server.registerTool('show_token', { description: 'Show the configured token', inputSchema: {}, annotations: { readOnlyHint: true } }, () => ({
  content: [{ type: 'text', text: `token=${process.env.DEMO_TOKEN ?? ''} root=${process.env.DEMO_ROOT ?? ''}` }],
}));
await server.connect(new StdioServerTransport());
