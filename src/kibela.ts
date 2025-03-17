import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import dotenv from 'dotenv'
import fetch from 'node-fetch'

dotenv.config()

// Configuration constants
const KIBELA_TEAM_NAME = process.env.KIBELA_TEAM_NAME || ''
const KIBELA_ACCESS_TOKEN = process.env.KIBELA_ACCESS_TOKEN || ''
const KIBELA_API_ENDPOINT = `https://${KIBELA_TEAM_NAME}.kibe.la/api/v1`

// トークン対策。　keyにtool名をいれ、valueにそのtoolの実行回数をいれるとかで同じこと聞いたらそれを返す？
// 一旦ちゃんとした情報をうけとるかちぇっくしたいので、この機能は入れない
// const resourceCache: Record<string, any> = {}

interface KibelaGraphQLResponse<T = any> {
  data?: T
  errors?: Array<{
    message: string
    extensions?: {
      code?: string
      waitMilliseconds?: number
    }
  }>
}

interface SearchResultData {
  search: {
    edges: Array<{
      node: {
        __typename: string
        title: string
        contentUpdatedAt: string
        contentSummaryHtml: string
        url: string
        author?: {
          id: string
          realName: string
        }
      }
    }>
  }
  budget?: {
    cost: number | string
  }
}

export function configureServer(server: McpServer): void {
  console.error('KIBELA SERVER CONFIGURATION CALLED')
  console.error(`DEBUG: Using Kibela team: ${KIBELA_TEAM_NAME}`)

  if (!KIBELA_TEAM_NAME || !KIBELA_ACCESS_TOKEN) {
    console.error(
      'ERROR: KIBELA_TEAM_NAME and KIBELA_ACCESS_TOKEN must be set in environment variables',
    )
  }

  const executeKibelaQuery = async <T = any>(
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<KibelaGraphQLResponse<T>> => {
    try {
      const response = await fetch(KIBELA_API_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${KIBELA_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': 'ObsidianKibelaIntegration/1.0',
        },
        body: JSON.stringify({
          query,
          variables,
        }),
      })

      if (!response.ok) {
        throw new Error(`HTTP error: ${response.status} ${response.statusText}`)
      }

      const data = (await response.json()) as KibelaGraphQLResponse<T>

      if (typeof data === 'object' && data !== null) {
        if (typeof data === 'object' && data !== null) {
          if ('errors' in data && Array.isArray(data.errors) && data.errors.length > 0) {
            const errors = data.errors
            const firstError = errors[0]

            if (
              typeof firstError === 'object' &&
              firstError !== null &&
              'extensions' in firstError
            ) {
              const extensions = firstError.extensions

              if (typeof extensions === 'object' && extensions !== null) {
                const errorCode = 'code' in extensions ? (extensions.code as string) : undefined
                const waitTime =
                  'waitMilliseconds' in extensions
                    ? (extensions.waitMilliseconds as number)
                    : undefined

                if (errorCode === 'REQUEST_LIMIT_EXCEEDED') {
                  throw new Error('Query cost exceeds maximum allowed cost per request')
                  // biome-ignore lint/style/noUselessElse: <explanation>
                } else if (
                  errorCode === 'TOKEN_BUDGET_EXHAUSTED' ||
                  errorCode === 'TEAM_BUDGET_EXHAUSTED'
                ) {
                  throw new Error(`Rate limit exceeded. Try again in ${waitTime}ms`)
                }
              }
            }
            throw new Error(`GraphQL error: ${JSON.stringify(errors)}`)
          }
        }
      }

      return data
    } catch (error) {
      console.error('Kibela API error:', error)
      throw error
    }
  }

  server.tool(
    'kibela-search',
    {
      query: z.string().describe('Search query for Kibela notes'),
      limit: z.number().min(1).max(20).default(5).describe('Maximum number of results to return'),
    },
    async ({ query, limit }, _extra) => {
      try {
        console.error(`DEBUG: Searching Kibela for: "${query}", limit: ${limit}`)

        const graphqlQuery = `
        query SearchNotes($query: String!, $first: Int!) {
          search(query: $query, first: $first) {
            edges {
              node {
                __typename
                title
                contentUpdatedAt
                contentSummaryHtml
                url
                author {
                  id
                  realName
                }
              }
            }
          }
          budget {
            cost
          }
        }
      `

        const result = await executeKibelaQuery<SearchResultData>(graphqlQuery, {
          query,
          first: limit,
        })

        const costUsed = result.data?.budget?.cost || 'unknown'
        console.error(`DEBUG: Search query cost: ${costUsed}`)

        if (!result.data) {
          return {
            content: [
              {
                type: 'text',
                text: `Error: No data returned from Kibela API for query "${query}".`,
              },
            ],
          }
        }

        const notes = result.data.search.edges.map((edge) => edge.node)

        if (notes.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: `No notes found matching "${query}".`,
              },
            ],
          }
        }

        let responseText = `Search results for "${query}" in Kibela:\n\n`

        notes.forEach((note, index) => {
          responseText += `${index + 1}. ${note.title}\n`

          if (note.author?.realName) {
            responseText += `   Author: ${note.author.realName}\n`
          }

          responseText += `   URL: ${note.url}\n`

          if (note.contentUpdatedAt) {
            responseText += `   Updated: ${new Date(note.contentUpdatedAt).toLocaleString()}\n`
          }

          if (note.contentSummaryHtml) {
            const textContent = note.contentSummaryHtml.replace(/<[^>]*>/g, '')
            const cleanedText = textContent.replace(/&[^;]+;/g, ' ').trim()
            const preview = cleanedText.substring(0, 100)
            responseText += `   Preview: ${preview}${cleanedText.length > 100 ? '...' : ''}\n\n`
          } else {
            responseText += '\n'
          }
        })

        return {
          content: [
            {
              type: 'text',
              text: responseText,
            },
          ],
        }
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error searching Kibela: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
        }
      }
    },
  )

  server.tool(
    'kibela-content-search',
    {
      query: z.string().describe('Text to search for in file contents'),
      path: z.string().optional().describe('Path to search in (leave empty for root)'),
      limit: z.number().min(1).max(20).default(5).describe('Maximum number of results to return'),
    },
    async ({ query, path, limit }, extra) => {
      try {
        console.error(`DEBUG: Searching Kibela content for: "${query}", limit: ${limit}`)
        const searchQuery = query

        const graphqlQuery = `
        query ContentSearch($query: String!, $first: Int!) {
          search(
            query: $query, 
            first: $first,
            sortBy: RELEVANT
          ) {
            edges {
              node {
                __typename
                title
                contentUpdatedAt
                contentSummaryHtml
                url
                author {
                  id
                  realName
                }
              }
            }
          }
          budget {
            cost
          }
        }
      `

        const result = await executeKibelaQuery(graphqlQuery, {
          query: searchQuery,
          first: limit,
        })

        const costUsed = result.data?.budget?.cost || 'unknown'
        console.error(`DEBUG: Content search query cost: ${costUsed}`)

        if (!result.data) {
          return {
            content: [
              {
                type: 'text',
                text: `Error: No data returned from Kibela API for content search "${query}".`,
              },
            ],
          }
        }

        // 検索結果の配列を取得
        const notes = result.data.search.edges.map((edge: any) => edge.node)

        if (notes.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: `No content found matching "${query}".`,
              },
            ],
          }
        }

        let responseText = `Content search results for "${query}" in Kibela:\n\n`

        notes.forEach((note: any, index: number) => {
          responseText += `${index + 1}. ${note.title}\n`

          if (note.author?.realName) {
            responseText += `   Author: ${note.author.realName}\n`
          }

          responseText += `   URL: ${note.url}\n`

          if (note.contentUpdatedAt) {
            responseText += `   Updated: ${new Date(note.contentUpdatedAt).toLocaleString()}\n`
          }

          if (note.contentSummaryHtml) {
            const textContent = note.contentSummaryHtml.replace(/<[^>]*>/g, '')
            const cleanedText = textContent.replace(/&[^;]+;/g, ' ').trim()

            const lowerQuery = query.toLowerCase()
            const lowerText = cleanedText.toLowerCase()
            const queryIndex = lowerText.indexOf(lowerQuery)

            let preview = ''
            if (queryIndex >= 0) {
              const startIndex = Math.max(0, queryIndex - 40)
              const endIndex = Math.min(cleanedText.length, queryIndex + query.length + 60)
              preview = cleanedText.substring(startIndex, endIndex)

              if (startIndex > 0) preview = `...${preview}`
              if (endIndex < cleanedText.length) preview = `${preview}...`
            } else {
              preview = cleanedText.substring(0, 100) + (cleanedText.length > 100 ? '...' : '')
            }

            responseText += `   Preview: ${preview}\n\n`
          } else {
            responseText += '\n'
          }
        })

        return {
          content: [
            {
              type: 'text',
              text: responseText,
            },
          ],
        }
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error searching Kibela content: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
        }
      }
    },
  )

  server.tool(
    'kibela-view',
    {
      id: z.string().optional().describe('ID of the note to view'),
      url: z.string().optional().describe('URL of the note to view'),
    },
    async ({ id, url }, _extra) => {
      try {
        let note = null

        if (id) {
          console.error(`DEBUG: Fetching Kibela note with ID: ${id}`)
          const numericId = id.match(/^\d+$/) ? id : null

          if (!numericId) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Error: Invalid note ID "${id}". Please provide a numeric ID.`,
                },
              ],
            }
          }

          const pathGraphqlQuery = `
          query GetNoteFromPath {
            noteFromPath(path: "/notes/${numericId}") {
              id
              title
              content
              contentHtml
              url
              publishedAt
              updatedAt
              groups {
                name
              }
              author {
                realName
              }
            }
          }
        `

          const result = await executeKibelaQuery(pathGraphqlQuery)

          if (!result.data || !result.data.noteFromPath) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Error: No data returned from Kibela API for note ID "${id}".`,
                },
              ],
            }
          }

          note = result.data.noteFromPath
        } else if (url) {
          const urlMatch = url.match(/\/notes\/(\d+)/)
          if (!urlMatch || !urlMatch[1]) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: 'Invalid Kibela note URL. Expected format: /notes/{number}',
                },
              ],
            }
          }

          const notePathId = urlMatch[1]
          console.error(`DEBUG: Fetching Kibela note from path: /notes/${notePathId}`)

          const pathGraphqlQuery = `
          query GetNoteFromPath {
            noteFromPath(path: "/notes/${notePathId}") {
              id
              title
              content
              contentHtml
              url
              publishedAt
              updatedAt
              groups {
                name
              }
              author {
                realName
              }
            }
          }
        `

          const result = await executeKibelaQuery(pathGraphqlQuery)

          if (!result.data || !result.data.noteFromPath) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Error: No data returned from Kibela API for note URL "${url}".`,
                },
              ],
            }
          }

          note = result.data.noteFromPath
        } else {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Error: Either id or url must be provided.',
              },
            ],
          }
        }

        return formatNoteResponse(note)
      } catch (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error retrieving Kibela note: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
        }
      }
    },
  )

  function formatNoteResponse(note: any) {
    const { title, contentHtml, url, publishedAt, updatedAt, groups, author } = note

    const publishDate = new Date(publishedAt).toLocaleString('ja-JP')
    const updateDate = new Date(updatedAt).toLocaleString('ja-JP')

    const groupNames = groups.map((g: { name: any }) => g.name).join(', ')

    return {
      content: [
        {
          type: 'text' as const,
          text: `# ${title}\n\n**URL:** ${url}\n**著者:** ${author.realName}\n**公開日:** ${publishDate}\n**更新日:** ${updateDate}\n**グループ:** ${groupNames}\n\n---\n\n${contentHtml}`,
        },
      ],
    }
  }

  server.tool(
    'kibela-recent',
    {
      limit: z.number().min(1).max(20).default(5).describe('Maximum number of results to return'),
      group: z.string().optional().describe('Filter by group name (optional)'),
    },
    async ({ limit, group }) => {
      try {
        console.error(
          `DEBUG: Fetching recent Kibela notes, limit: ${limit}, group: ${group || 'any'}`,
        )

        let graphqlQuery: string
        let variables: Record<string, unknown>

        if (group) {
          graphqlQuery = `
            query RecentNotesByGroup($first: Int!, $groupName: String!) {
              groups(name: $groupName) {
                edges {
                  node {
                    name
                    notes(first: $first, orderBy: {field: PUBLISHED_AT, direction: DESC}) {
                      edges {
                        node {
                          id
                          title
                          url
                          publishedAt
                          updatedAt
                        }
                      }
                    }
                  }
                }
              }
            }
          `
          variables = { first: limit, groupName: group }
        } else {
          // Query for all recent notes
          graphqlQuery = `
            query RecentNotes($first: Int!) {
              notes(first: $first, orderBy: {field: PUBLISHED_AT, direction: DESC}) {
                edges {
                  node {
                    id
                    title
                    url
                    publishedAt
                    updatedAt
                    author {
                      realName
                    }
                  }
                }
              }
            }
          `
          variables = { first: limit }
        }

        const result = await executeKibelaQuery(graphqlQuery, variables)

        let notes: any
        if (group) {
          const groups = result.data.groups?.edges || []
          if (groups.length === 0) {
            return {
              content: [
                {
                  type: 'text',
                  text: `No group found with name "${group}".`,
                },
              ],
            }
          }
          notes = groups[0].node.notes.edges.map((edge: any) => edge.node)
        } else {
          notes = result.data.notes.edges.map((edge: any) => edge.node)
        }

        if (notes.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: group ? `No notes found in group "${group}".` : 'No recent notes found.',
              },
            ],
          }
        }

        let responseText = group
          ? `Recent notes in group "${group}":\n\n`
          : 'Recent notes in Kibela:\n\n'

        notes.forEach((note: any, index: number) => {
          responseText += `${index + 1}. ${note.title}\n`
          if (note.author) {
            responseText += `   Author: ${note.author.name}\n`
          }
          responseText += `   URL: ${note.url}\n`
          responseText += `   Published: ${new Date(note.publishedAt).toLocaleString()}\n\n`
        })

        return {
          content: [
            {
              type: 'text',
              text: responseText,
            },
          ],
        }
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error retrieving recent Kibela notes: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
        }
      }
    },
  )

  server.tool('kibela-groups', {}, async () => {
    try {
      console.error('DEBUG: Fetching Kibela groups')

      const graphqlQuery = `
          query ListGroups {
            groups(first: 100) {
              edges {
                node {
                  id
                  name
                  description
                  notes {
                  totalCount
                  }
                }
              }
            }
          }
        `

      const result = await executeKibelaQuery(graphqlQuery)
      const groups = result.data.groups.edges.map((edge: any) => edge.node)

      if (groups.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: 'No groups found in this Kibela team.',
            },
          ],
        }
      }

      let responseText = 'Kibela Groups:\n\n'

      groups.forEach((group: any, index: number) => {
        responseText += `${index + 1}. ${group.name}\n`
        responseText += `   Notes: ${group.notes.totalCount}\n`
        if (group.description) {
          responseText += `   Description: ${group.description}\n`
        }
        responseText += '\n'
      })

      return {
        content: [
          {
            type: 'text',
            text: responseText,
          },
        ],
      }
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error retrieving Kibela groups: ${error instanceof Error ? error.message : 'Unknown error'}`,
          },
        ],
      }
    }
  })
}
