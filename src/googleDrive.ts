import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import dotenv from 'dotenv'
import fs from 'node:fs/promises'
import { authenticate } from '@google-cloud/local-auth'
import { google } from 'googleapis'

dotenv.config()

const drive = google.drive('v3')

const CREDENTIALS_PATH = process.env.GDRIVE_CREDENTIALS_PATH || './.gdrive-server-credentials.json'
const OAUTH_PATH = process.env.GDRIVE_OAUTH_PATH || './gcp-oauth.keys.json'

export async function authenticateAndSaveCredentials() {
  console.error('Launching Google Drive auth flow…')

  try {
    // OAuth設定ファイルの存在を確認
    const oauthExists = await fs
      .access(OAUTH_PATH)
      .then(() => {
        console.error('OAuth key file exists at', OAUTH_PATH)
        return true
      })
      .catch(() => {
        console.error('OAuth key file NOT found at', OAUTH_PATH)
        return false
      })

    if (!oauthExists) {
      throw new Error(`OAuth key file not found at ${OAUTH_PATH}`)
    }

    const auth = await authenticate({
      keyfilePath: OAUTH_PATH,
      scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    })

    await fs.writeFile(CREDENTIALS_PATH, JSON.stringify(auth.credentials))
    console.error('Google Drive credentials saved successfully.')
    return auth
  } catch (error) {
    console.error('Authentication failed:', error)
    throw error
  }
}

export async function loadCredentials() {
  try {
    const credentialsExists = await fs
      .access(CREDENTIALS_PATH)
      .then(() => {
        console.error('Credentials file exists at', CREDENTIALS_PATH)
        return true
      })
      .catch(() => {
        console.error('Credentials file NOT found at', CREDENTIALS_PATH)
        return false
      })

    if (!credentialsExists) {
      console.error('Google Drive credentials not found. Please run authentication first.')
      throw new Error('Google Drive credentials not found')
    }

    const credentialsData = await fs.readFile(CREDENTIALS_PATH, 'utf-8')
    const credentials = JSON.parse(credentialsData)

    const auth = new google.auth.OAuth2()
    auth.setCredentials(credentials)

    if (auth.credentials.expiry_date) {
      console.error('Token expiry:', new Date(auth.credentials.expiry_date).toISOString())
      console.error('Token expired:', Date.now() > auth.credentials.expiry_date)
    }

    google.options({ auth })

    console.error('Google Drive credentials loaded successfully.')
    return auth
  } catch (error) {
    console.error('Failed to load Google Drive credentials:', error)
    throw error
  }
}

/**
 * サーバーの設定
 */
export async function configureServer(server: McpServer): Promise<void> {
  console.error('Configuring Google Drive MCP Server')

  try {
    await loadCredentials()
    console.error('Google Drive credentials loaded successfully')
  } catch (error) {
    console.error('Google Drive credentials not found, attempting to authenticate...')
    try {
      await authenticateAndSaveCredentials()
      console.error('Google Drive authentication completed successfully')
    } catch (authError) {
      console.error('Failed to authenticate with Google Drive:', authError)
      console.error('Please run authentication manually with: npm run gdrive-auth')
    }
  }

  // ファイル検索ツール
  server.tool(
    'gdrive_search',
    {
      query: z.string().describe('Search query for Google Drive files'),
      limit: z.number().min(1).max(20).default(10).describe('Maximum number of results to return'),
    },
    async ({ query, limit }) => {
      try {
        try {
          await loadCredentials()
        } catch (error) {
          return {
            content: [
              {
                type: 'text',
                text: `Error loading Google Drive credentials: ${error instanceof Error ? error.message : 'Unknown error'}. Please make sure to authenticate first.`,
              },
            ],
          }
        }

        console.error(`DEBUG: Searching Google Drive for: "${query}", limit: ${limit}`)

        const escapedQuery = query.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
        const formattedQuery = `fullText contains '${escapedQuery}'`
        const res = await drive.files.list({
          q: formattedQuery,
          pageSize: limit,
          fields: 'files(id, name, mimeType, modifiedTime, size, webViewLink)',
        })

        const files = res.data.files || []

        if (files.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: `No files found matching "${query}" in Google Drive.`,
              },
            ],
          }
        }

        let responseText = `Search results for "${query}" in Google Drive:\n\n`

        files.forEach((file: any, index: number) => {
          responseText += `${index + 1}. ${file.name}\n`
          responseText += ` Type: ${formatMimeType(file.mimeType)}\n`

          if (file.modifiedTime) {
            responseText += ` Modified: ${new Date(file.modifiedTime).toLocaleString()}\n`
          }

          if (file.size) {
            responseText += ` Size: ${formatFileSize(Number.parseInt(file.size))}\n`
          }

          responseText += ` ID: ${file.id}\n`

          if (file.webViewLink) {
            responseText += ` Link: ${file.webViewLink}\n`
          }

          responseText += '\n'
        })

        responseText += `Found ${files.length} file(s) matching "${query}".`

        return {
          content: [
            {
              type: 'text',
              text: responseText,
            },
          ],
        }
      } catch (error) {
        console.error('Error in gdrive_search:', error)
        return {
          content: [
            {
              type: 'text',
              text: `Error searching Google Drive: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
        }
      }
    },
  )

  server.tool(
    'gdrive_summarize',
    {
      file_id: z.string().describe('Google Drive file ID to summarize'),
    },
    async ({ file_id }) => {
      try {
        try {
          await loadCredentials()
        } catch (error) {
          return {
            content: [
              {
                type: 'text',
                text: `Error loading Google Drive credentials: ${error instanceof Error ? error.message : 'Unknown error'}. Please make sure to authenticate first.`,
              },
            ],
          }
        }

        console.error(`DEBUG: Summarizing Google Drive file with ID: "${file_id}"`)
        const fileMetadata = await drive.files.get({
          fileId: file_id,
          fields: 'name,mimeType,modifiedTime,size,webViewLink',
        })

        if (!fileMetadata.data) {
          throw new Error(`File not found with ID: ${file_id}`)
        }

        const { name, mimeType, modifiedTime, size, webViewLink } = fileMetadata.data
        let fileContent = ''
        let contentType = ''

        if (mimeType?.startsWith('application/vnd.google-apps')) {
          let exportMimeType: string

          switch (mimeType) {
            case 'application/vnd.google-apps.document':
              exportMimeType = 'text/plain'
              contentType = 'Google Document'
              break
            case 'application/vnd.google-apps.spreadsheet':
              exportMimeType = 'text/csv'
              contentType = 'Google Spreadsheet'
              break
            case 'application/vnd.google-apps.presentation':
              exportMimeType = 'text/plain'
              contentType = 'Google Presentation'
              break
            default:
              exportMimeType = 'text/plain'
              contentType = 'Google Workspace file'
          }
          const res = await drive.files.export(
            { fileId: file_id, mimeType: exportMimeType },
            { responseType: 'text' },
          )

          fileContent = res.data as string
        } else if (mimeType?.startsWith('text/') || mimeType === 'application/json') {
          const res = await drive.files.get(
            { fileId: file_id, alt: 'media' },
            { responseType: 'arraybuffer' },
          )

          fileContent = Buffer.from(res.data as ArrayBuffer).toString('utf-8')
          contentType = mimeType
        } else {
          return {
            content: [
              {
                type: 'text',
                text: `Unable to summarize binary file: ${name} (${formatMimeType(mimeType || '')})`,
              },
            ],
          }
        }

        // コンテンツの最初の1000文字までを概略とする
        const contentPreview =
          fileContent.length > 1000 ? `${fileContent.substring(0, 1000)}...` : fileContent

        let responseText = `File Summary for: ${name}\n\n`
        responseText += `Type: ${contentType}\n`

        if (modifiedTime) {
          responseText += `Modified: ${new Date(modifiedTime).toLocaleString()}\n`
        }

        if (size) {
          responseText += `Size: ${formatFileSize(Number.parseInt(size))}\n`
        }

        if (webViewLink) {
          responseText += `Link: ${webViewLink}\n`
        }

        responseText += `ID: ${file_id}\n\n`
        responseText += `Content Preview:\n\n${contentPreview}`

        return {
          content: [
            {
              type: 'text',
              text: responseText,
            },
          ],
        }
      } catch (error) {
        console.error('Error in gdrive_summarize:', error)
        return {
          content: [
            {
              type: 'text',
              text: `Error summarizing Google Drive file: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
        }
      }
    },
  )

  server.tool(
    'gdrive_list',
    {
      folder_id: z
        .string()
        .optional()
        .describe('Google Drive folder ID to list contents (leave empty for root)'),
      limit: z.number().min(1).max(50).default(20).describe('Maximum number of items to return'),
    },
    async ({ folder_id, limit }) => {
      try {
        try {
          await loadCredentials()
        } catch (error) {
          return {
            content: [
              {
                type: 'text',
                text: `Error loading Google Drive credentials: ${error instanceof Error ? error.message : 'Unknown error'}. Please make sure to authenticate first.`,
              },
            ],
          }
        }

        console.error(
          `DEBUG: Listing Google Drive folder: "${folder_id || 'root'}", limit: ${limit}`,
        )
        let query = ''

        if (folder_id) {
          query = `'${folder_id}' in parents`
        } else {
          query = `'root' in parents`
        }
        const res = await drive.files.list({
          q: query,
          pageSize: limit,
          fields: 'files(id, name, mimeType, modifiedTime, size)',
        })

        const files = res.data.files || []

        if (files.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: 'No items found in the specified Google Drive folder.',
              },
            ],
          }
        }

        let responseText = `Contents of folder ${folder_id || 'root'} in Google Drive:\n\n`

        const folders = files.filter(
          (file: any) => file.mimeType === 'application/vnd.google-apps.folder',
        )
        const documents = files.filter(
          (file: any) => file.mimeType !== 'application/vnd.google-apps.folder',
        )

        // フォルダの一覧
        if (folders.length > 0) {
          responseText += 'Folders:\n'
          folders.forEach((folder: any, index: number) => {
            responseText += `${index + 1}. ${folder.name}\n`
            responseText += ` ID: ${folder.id}\n`
            responseText += ` Modified: ${new Date(folder.modifiedTime).toLocaleString()}\n\n`
          })
        }

        // ファイルの一覧
        if (documents.length > 0) {
          responseText += 'Files:\n'
          documents.forEach((file: any, index: number) => {
            responseText += `${index + 1}. ${file.name}\n`
            responseText += ` Type: ${formatMimeType(file.mimeType)}\n`
            responseText += ` ID: ${file.id}\n`

            if (file.modifiedTime) {
              responseText += ` Modified: ${new Date(file.modifiedTime).toLocaleString()}\n`
            }

            if (file.size) {
              responseText += ` Size: ${formatFileSize(Number.parseInt(file.size))}\n`
            }

            responseText += '\n'
          })
        }

        return {
          content: [
            {
              type: 'text',
              text: responseText,
            },
          ],
        }
      } catch (error) {
        console.error('Error in gdrive_list:', error)
        return {
          content: [
            {
              type: 'text',
              text: `Error listing Google Drive folder: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
        }
      }
    },
  )
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

function formatMimeType(mimeType: string): string {
  const mimeTypeMap: { [key: string]: string } = {
    'application/vnd.google-apps.document': 'Google Document',
    'application/vnd.google-apps.spreadsheet': 'Google Spreadsheet',
    'application/vnd.google-apps.presentation': 'Google Presentation',
    'application/vnd.google-apps.drawing': 'Google Drawing',
    'application/vnd.google-apps.folder': 'Google Drive Folder',
    'application/vnd.google-apps.form': 'Google Form',
    'application/pdf': 'PDF',
    'text/plain': 'Text File',
    'text/html': 'HTML File',
    'text/css': 'CSS File',
    'text/javascript': 'JavaScript File',
    'text/csv': 'CSV File',
    'application/json': 'JSON File',
    'application/xml': 'XML File',
    'application/zip': 'ZIP Archive',
    'image/jpeg': 'JPEG Image',
    'image/png': 'PNG Image',
    'image/gif': 'GIF Image',
    'image/svg+xml': 'SVG Image',
    'audio/mpeg': 'MP3 Audio',
    'video/mp4': 'MP4 Video',
  }

  return mimeTypeMap[mimeType] || mimeType
}
