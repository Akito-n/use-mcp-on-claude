import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { configureServer as ObsidianConfigureServer } from './obsidianMcpServer'
import { configureServer as KibelaConfigureServer } from './kibela'
import { configureServer as BraveSearchConfigureServer } from './braveSearch'
import { configureServer as SlackConfigureServer } from './slack'

async function main() {
  const server = new McpServer({
    name: 'multi-tool-mcp-server',
    version: '1.0.0',
  })

  ObsidianConfigureServer(server)
  KibelaConfigureServer(server)
  BraveSearchConfigureServer(server)
  SlackConfigureServer(server)

  const transport = new StdioServerTransport()
  server.connect(transport)

  process.stdin.resume()
}

main().catch((error) => {
  console.error('Fatal error in main():', error)
  process.exit(1)
})
