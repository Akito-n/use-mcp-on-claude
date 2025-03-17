import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { configureServer as ObsidianConfigureServer } from './obsidianMcpServer'
import { configureServer as KibelaConfigureServer } from './kibela'
import { z } from 'zod'

async function main() {
  const server = new McpServer({
    name: 'obsidian-search',
    version: '1.0.0',
  })

  ObsidianConfigureServer(server)
  KibelaConfigureServer(server)

  const resources: Record<string, string> = {}

  server.resource(
    'greeting',
    new ResourceTemplate('greeting://{name}', { list: undefined }),
    async (uri, { name }) => {
      resources[`greeting://${name}`] = `Hello, ${name}!`

      return {
        contents: [
          {
            uri: uri.href,
            text: `Hello, ${name}!`,
          },
        ],
      }
    },
  )

  server.tool('greet', { name: z.string().describe('The name to greet') }, async ({ name }) => {
    const resourceUri = `greeting://${name}`

    const greeting = resources[resourceUri] || (await generateGreeting(name))

    return {
      content: [{ type: 'text', text: greeting }],
    }
  })

  async function generateGreeting(name: string) {
    return `Hello, ${name}! (generated directly)`
  }

  const transport = new StdioServerTransport()
  server.connect(transport)

  process.stdin.resume()
}

main().catch((error) => {
  console.error('Fatal error in main():', error)
  process.exit(1)
})
