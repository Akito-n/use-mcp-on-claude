import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import dotenv from 'dotenv'

dotenv.config()

const BRAVE_API_KEY = process.env.BRAVE_API_KEY
if (!BRAVE_API_KEY) {
  console.error(
    'Warning: BRAVE_API_KEY environment variable is not set. Brave search will not work properly.',
  )
}

const RATE_LIMIT = {
  perSecond: 1,
  perMonth: 15000,
}

const requestCount = {
  second: 0,
  month: 0,
  lastReset: Date.now(),
}

function checkRateLimit() {
  const now = Date.now()
  if (now - requestCount.lastReset > 1000) {
    requestCount.second = 0
    requestCount.lastReset = now
  }

  if (requestCount.month >= RATE_LIMIT.perMonth) {
    throw new Error('Monthly rate limit exceeded')
  }
  requestCount.second++
  requestCount.month++
}

// フリープランのAPIキーを使用している場合には、リクエスト間に1秒の時間を置く必要がある
async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

interface BraveWeb {
  web?: {
    results?: Array<{
      title: string
      description: string
      url: string
      language?: string
      published?: string
      rank?: number
    }>
  }
  locations?: {
    results?: Array<{
      id: string
      title?: string
    }>
  }
}

interface BraveLocation {
  id: string
  name: string
  address: {
    streetAddress?: string
    addressLocality?: string
    addressRegion?: string
    postalCode?: string
  }
  coordinates?: {
    latitude: number
    longitude: number
  }
  phone?: string
  rating?: {
    ratingValue?: number
    ratingCount?: number
  }
  openingHours?: string[]
  priceRange?: string
}

interface BravePoiResponse {
  results: BraveLocation[]
}

interface BraveDescription {
  descriptions: { [id: string]: string }
}

async function performWebSearch(query: string, count = 10, offset = 0) {
  checkRateLimit()
  const url = new URL('https://api.search.brave.com/res/v1/web/search')
  url.searchParams.set('q', query)
  url.searchParams.set('count', Math.min(count, 20).toString()) // API limit
  url.searchParams.set('offset', offset.toString())

  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'Accept-Encoding': 'gzip',
      'X-Subscription-Token': BRAVE_API_KEY || '',
    },
  })

  if (!response.ok) {
    throw new Error(
      `Brave API error: ${response.status} ${response.statusText}\n${await response.text()}`,
    )
  }

  const data = (await response.json()) as BraveWeb

  const results = (data.web?.results || []).map((result) => ({
    title: result.title || '',
    description: result.description || '',
    url: result.url || '',
  }))

  return results
    .map((r) => `Title: ${r.title}\nDescription: ${r.description}\nURL: ${r.url}`)
    .join('\n\n')
}

// ローカル検索を実行する関数
async function performLocalSearch(query: string, count = 5) {
  checkRateLimit()
  const webUrl = new URL('https://api.search.brave.com/res/v1/web/search')
  webUrl.searchParams.set('q', query)
  webUrl.searchParams.set('search_lang', 'en')
  webUrl.searchParams.set('result_filter', 'locations')
  webUrl.searchParams.set('count', Math.min(count, 20).toString())

  const webResponse = await fetch(webUrl, {
    headers: {
      Accept: 'application/json',
      'Accept-Encoding': 'gzip',
      'X-Subscription-Token': BRAVE_API_KEY || '',
    },
  })

  if (!webResponse.ok) {
    throw new Error(
      `Brave API error: ${webResponse.status} ${webResponse.statusText}\n${await webResponse.text()}`,
    )
  }

  const webData = (await webResponse.json()) as BraveWeb
  const locationIds =
    webData.locations?.results
      ?.filter((r): r is { id: string; title?: string } => r.id != null)
      .map((r) => r.id) || []

  if (locationIds.length === 0) {
    // リクエスト間に少し時間を置く
    await delay(1100) // 1.1秒待機してレート制限を回避
    return performWebSearch(query, count)
  }

  await delay(1100) // 1.1秒待機してレート制限を回避

  const poisData = await getPoisData(locationIds)

  await delay(1100) // 1.1秒待機してレート制限を回避

  const descriptionsData = await getDescriptionsData(locationIds)

  return formatLocalResults(poisData, descriptionsData)
}

// POI(Point of Interest)データを取得する関数
async function getPoisData(ids: string[]): Promise<BravePoiResponse> {
  if (requestCount.month >= RATE_LIMIT.perMonth) {
    throw new Error('Monthly rate limit exceeded')
  }
  requestCount.month++

  const url = new URL('https://api.search.brave.com/res/v1/local/pois')
  ids.filter(Boolean).forEach((id) => url.searchParams.append('ids', id))
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'Accept-Encoding': 'gzip',
      'X-Subscription-Token': BRAVE_API_KEY || '',
    },
  })

  if (!response.ok) {
    throw new Error(
      `Brave API error: ${response.status} ${response.statusText}\n${await response.text()}`,
    )
  }

  const poisResponse = (await response.json()) as BravePoiResponse
  return poisResponse
}

async function getDescriptionsData(ids: string[]): Promise<BraveDescription> {
  if (requestCount.month >= RATE_LIMIT.perMonth) {
    throw new Error('Monthly rate limit exceeded')
  }
  requestCount.month++

  const url = new URL('https://api.search.brave.com/res/v1/local/descriptions')
  ids.filter(Boolean).forEach((id) => url.searchParams.append('ids', id))
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'Accept-Encoding': 'gzip',
      'X-Subscription-Token': BRAVE_API_KEY || '',
    },
  })

  if (!response.ok) {
    throw new Error(
      `Brave API error: ${response.status} ${response.statusText}\n${await response.text()}`,
    )
  }

  const descriptionsData = (await response.json()) as BraveDescription
  return descriptionsData
}

function formatLocalResults(poisData: BravePoiResponse, descData: BraveDescription): string {
  return (
    (poisData.results || [])
      .map((poi) => {
        const address =
          [
            poi.address?.streetAddress ?? '',
            poi.address?.addressLocality ?? '',
            poi.address?.addressRegion ?? '',
            poi.address?.postalCode ?? '',
          ]
            .filter((part) => part !== '')
            .join(', ') || 'N/A'

        return `Name: ${poi.name}
Address: ${address}
Phone: ${poi.phone || 'N/A'}
Rating: ${poi.rating?.ratingValue ?? 'N/A'} (${poi.rating?.ratingCount ?? 0} reviews)
Price Range: ${poi.priceRange || 'N/A'}
Hours: ${(poi.openingHours || []).join(', ') || 'N/A'}
Description: ${descData.descriptions[poi.id] || 'No description available'}
`
      })
      .join('\n---\n') || 'No local results found'
  )
}

const webSearchSchema = z.object({
  query: z.string().describe('Search query (max 400 chars, 50 words)'),
  count: z.number().default(10).describe('Number of results (1-20, default 10)'),
  offset: z.number().default(0).describe('Pagination offset (max 9, default 0)'),
})

const localSearchSchema = z.object({
  query: z.string().describe("Local search query (e.g. 'pizza near Central Park')"),
  count: z.number().default(5).describe('Number of results (1-20, default 5)'),
})

export function configureServer(server: McpServer) {
  console.error('Configuring Brave Search MCP Server')

  server.tool(
    'brave_web_search',
    'Performs a web search using the Brave Search API, ideal for general queries, news, articles, and online content. ' +
      'Use this for broad information gathering, recent events, or when you need diverse web sources. ' +
      'Supports pagination, content filtering, and freshness controls. ' +
      'Maximum 20 results per request, with offset for pagination.',
    webSearchSchema.shape,
    async (params, extra) => {
      try {
        if (!BRAVE_API_KEY) {
          throw new Error('BRAVE_API_KEY environment variable is not set')
        }

        const { query, count, offset } = params
        const results = await performWebSearch(query, count, offset)
        return {
          content: [{ type: 'text', text: results }],
          isError: false,
        }
      } catch (error: any) {
        console.error('Error in brave_web_search:', error)
        return {
          content: [{ type: 'text', text: `Error: ${error.message}` }],
          isError: true,
        }
      }
    },
  )

  server.tool(
    'brave_local_search',
    "Searches for local businesses and places using Brave's Local Search API. " +
      'Best for queries related to physical locations, businesses, restaurants, services, etc. ' +
      'Returns detailed information including business names, addresses, ratings, phone numbers, and opening hours. ' +
      "Use this when the query implies 'near me' or mentions specific locations. " +
      'Automatically falls back to web search if no local results are found.',
    localSearchSchema.shape,
    async (params, extra) => {
      try {
        if (!BRAVE_API_KEY) {
          throw new Error('BRAVE_API_KEY environment variable is not set')
        }

        const { query, count } = params
        const results = await performLocalSearch(query, count)
        return {
          content: [{ type: 'text', text: results }],
          isError: false,
        }
      } catch (error: any) {
        console.error('Error in brave_local_search:', error)
        return {
          content: [{ type: 'text', text: `Error: ${error.message}` }],
          isError: true,
        }
      }
    },
  )
}
