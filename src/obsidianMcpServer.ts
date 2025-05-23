import { type McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
// biome-ignore lint/style/useNodejsImportProtocol: <explanation>
import fs from 'fs/promises'
// biome-ignore lint/style/useNodejsImportProtocol: <explanation>
import path, { dirname } from 'path'
import { z } from 'zod'
import dotenv from 'dotenv'
dotenv.config()

const OBSIDIAN_VAULT_PATH = process.env.OBSIDIAN_VAULT_PATH || ''
// biome-ignore lint/suspicious/noExplicitAny: <explanation>
const resourceCache: Record<string, any> = {}

interface FileInfo {
  name: string
  path: string
  isDirectory: boolean
  size: number
  modified: string
}

interface FileListResult {
  files: FileInfo[]
  currentPath: string
}

export function configureServer(server: McpServer): void {
  // console.logにするとClaudeの解析でJsonとみなされてエラーになるのでconsole.errorに変更
  console.error('CONFIGURE SERVER FUNCTION CALLED')
  console.error(`DEBUG: Using Obsidian vault path: ${OBSIDIAN_VAULT_PATH}`)

  const getObsidianFiles = async (
    dirPath: string | string[] | undefined = '',
  ): Promise<FileListResult> => {
    const dirPathStr = Array.isArray(dirPath) ? dirPath[0] : dirPath || ''
    // ディレクトリが日本語だった時のケースを考慮する
    const normalizedDirPath = dirPathStr === '/' ? '' : dirPathStr.replace(/^\/+|\/+$/g, '')
    const fullPath = path.join(OBSIDIAN_VAULT_PATH, normalizedDirPath)
    console.warn(`DEBUG: Full path: ${fullPath}`)

    if (!fullPath.startsWith(OBSIDIAN_VAULT_PATH)) {
      throw new Error(`Access denied details:
                       - OBSIDIAN_VAULT_PATH: ${OBSIDIAN_VAULT_PATH}
                       - dirPathStr: ${dirPathStr}
                       - normalizedDirPath: ${normalizedDirPath}
                       - fullPath: ${fullPath}
                       - process.cwd(): ${process.cwd()}
                       - fullPath.startsWith check: ${fullPath.startsWith(OBSIDIAN_VAULT_PATH)}
                       Path does not start with allowed directory`)
    }
    const files = await fs.readdir(fullPath, { withFileTypes: true })
    console.error(`DEBUG: Found ${files.length} files/directories`)

    const fileInfos = await Promise.all(
      files.map(async (dirent) => {
        const filePath = path.join(fullPath, dirent.name)
        // biome-ignore lint/style/useConst: <explanation>
        let isDir = dirent.isDirectory()
        let fileSize = 0
        let modTime = new Date()

        if (!isDir) {
          const fileStats = await fs.stat(filePath)
          fileSize = fileStats.size
          modTime = fileStats.mtime
        }

        return {
          name: dirent.name,
          path: path.relative(OBSIDIAN_VAULT_PATH, filePath),
          isDirectory: isDir,
          size: fileSize,
          modified: modTime.toISOString(),
        }
      }),
    )

    return {
      files: fileInfos,
      currentPath: normalizedDirPath,
    }
  }

  server.resource(
    'obsidian-list',
    new ResourceTemplate('obsidian://{dirPath}/list', { list: undefined }),
    async (uri, { dirPath = '' }) => {
      try {
        console.error(`DEBUG: List resource called with URI: ${uri.href}, dirPath: ${dirPath}`)

        const result = await getObsidianFiles(dirPath)
        resourceCache[uri.href] = result

        console.error(`DEBUG: Returning result with ${result.files.length} items`)

        return {
          contents: [
            {
              uri: uri.href,
              text: JSON.stringify(result),
              mimeType: 'application/json',
            },
          ],
        }
      } catch (error) {
        // エラー処理
        console.error(`DEBUG ERROR: ${error instanceof Error ? error.message : 'Unknown error'}`)
        console.error(`DEBUG ERROR STACK: ${error instanceof Error ? error.stack : ''}`)

        if (error instanceof Error) {
          throw new Error(`Failed to list files: ${error.message}`)
        }
        throw new Error('Failed to list files: Unknown error')
      }
    },
  )

  server.tool(
    'obsidian-search',
    {
      path: z.string().optional().describe('Path to search in (leave empty for root)'),
      query: z.string().optional().describe('Search query (optional)'),
    },
    async ({ path = '', query = '' }) => {
      try {
        // biome-ignore lint/style/useConst: <explanation>
        let result = await getObsidianFiles(path)

        if (query && query.trim() !== '') {
          console.error(`DEBUG: Filtering files with query: ${query}`)
          console.error(`DEBUG: Before filter, ${result.files.length} files`)
          result.files = result.files.filter((file: FileInfo) => file.name.indexOf(query) !== -1)
        }

        let responseText = `Files in ${result.currentPath || 'root'} directory:\n\n`

        if (result.files.length === 0) {
          responseText += 'No files found.'
        } else {
          // biome-ignore lint/complexity/noForEach: <explanation>
          result.files.forEach((file: FileInfo) => {
            const typeIndicator = file.isDirectory ? '[DIR]' : '[FILE]'
            const size = file.isDirectory ? '' : `(${formatFileSize(file.size)})`
            responseText += `${typeIndicator} ${file.name} ${size}\n`
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
        return {
          content: [
            {
              type: 'text',
              text: `Error searching files: ${
                error instanceof Error ? error.message : 'Unknown error'
              }`,
            },
          ],
        }
      }
    },
  )

  server.resource(
    'obsidian-read',
    new ResourceTemplate('obsidian://{filePath}/read', { list: undefined }),
    async (uri, { filePath = '' }) => {
      try {
        console.error(`DEBUG: Read resource called with URI: ${uri.href}, filePath: ${filePath}`)

        const filePathStr = Array.isArray(filePath) ? filePath[0] : filePath || ''

        const { content, fileInfo } = await readObsidianFile(filePathStr)

        const response = {
          content,
          fileInfo,
        }

        resourceCache[uri.href] = response

        return {
          contents: [
            {
              uri: uri.href,
              text: JSON.stringify(response),
              mimeType: 'application/json',
            },
          ],
        }
      } catch (error) {
        console.error(`DEBUG ERROR: ${error instanceof Error ? error.message : 'Unknown error'}`)
        console.error(`DEBUG ERROR STACK: ${error instanceof Error ? error.stack : ''}`)

        throw new Error(
          `Failed to read file: ${error instanceof Error ? error.message : 'Unknown error'}`,
        )
      }
    },
  )

  const readObsidianFile = async (
    filePath: string,
  ): Promise<{ content: string; fileInfo: FileInfo }> => {
    const normalizedPath = filePath.replace(/^\/+|\/+$/g, '')
    const fullPath = path.join(OBSIDIAN_VAULT_PATH, normalizedPath)

    if (!fullPath.startsWith(OBSIDIAN_VAULT_PATH)) {
      console.error('DEBUG: Access denied - path outside allowed directory')
      throw new Error('Access denied: Path outside of allowed directory')
    }

    const fileStats = await fs.stat(fullPath)
    if (!fileStats.isFile()) {
      throw new Error('Not a file: Directory cannot be read as a file')
    }

    const fileInfo: FileInfo = {
      name: path.basename(fullPath),
      path: normalizedPath,
      isDirectory: false,
      size: fileStats.size,
      modified: fileStats.mtime.toISOString(),
    }

    const content = await fs.readFile(fullPath, 'utf-8')
    console.error(`DEBUG: File read successfully, size: ${content.length} bytes`)

    return { content, fileInfo }
  }

  server.tool(
    'obsidian-view',
    {
      path: z.string().describe('Path to the file to view'),
    },
    async ({ path: filePath }) => {
      try {
        const resourceUri = `obsidian://${filePath}/read`

        let fileData: { content: string; fileInfo: FileInfo }

        if (resourceCache[resourceUri]) {
          console.error(`DEBUG: Using cached result for ${resourceUri}`)
          fileData = resourceCache[resourceUri]
        } else {
          try {
            fileData = await readObsidianFile(filePath)
            resourceCache[resourceUri] = fileData
          } catch (err) {
            console.error(`Failed to read file: ${err}`)
            return {
              content: [
                {
                  type: 'text',
                  text: `Error reading file: ${
                    err instanceof Error ? err.message : 'Unknown error'
                  }`,
                },
              ],
            }
          }
        }

        const extension = path.extname(fileData.fileInfo.name).toLowerCase()
        const isMarkdown = extension === '.md'

        let responseText = `File: ${fileData.fileInfo.name}\n`
        responseText += `Size: ${formatFileSize(fileData.fileInfo.size)}\n`
        responseText += `Last Modified: ${new Date(
          fileData.fileInfo.modified,
        ).toLocaleString()}\n\n`
        responseText += `${isMarkdown ? 'Markdown Content' : 'Content'}:\n\n${fileData.content}`

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
              text: `Error viewing file: ${
                error instanceof Error ? error.message : 'Unknown error'
              }`,
            },
          ],
        }
      }
    },
  )

  server.tool(
    'obsidian-content-search',
    {
      query: z.string().describe('Text to search for in file contents'),
      path: z.string().optional().describe('Path to search in (leave empty for root)'),
    },
    async ({ query, path: searchPath = '' }) => {
      try {
        console.error(`DEBUG: Content search started with query: "${query}", path: "${path}"`)
        const fileListResult = await getObsidianFiles(searchPath)
        console.error(`DEBUG: Found ${fileListResult.files.length} files to search in`)

        const searchResults: Array<{
          fileInfo: FileInfo
          content: string
          matches: Array<{
            line: number
            text: string
          }>
        }> = []

        const searchableExtensions = ['.md', '.txt', '.csv', '.json', '.yaml', '.yml']
        const filesToSearch = fileListResult.files.filter((file) => {
          if (file.isDirectory) return false
          const extIndex = file.name.lastIndexOf('.')
          const ext = extIndex !== -1 ? file.name.slice(extIndex).toLowerCase() : ''
          return searchableExtensions.includes(ext)
        })

        for (const file of filesToSearch) {
          try {
            const { content, fileInfo } = await readObsidianFile(file.path)
            const lowerContent = content.toLowerCase()
            const lowerQuery = query.toLowerCase()

            if (lowerContent.includes(lowerQuery)) {
              const lines = content.split('\n')
              const matches = lines
                .map((line, index) => ({
                  line: index + 1,
                  text: line,
                  matches: line.toLowerCase().includes(lowerQuery),
                }))
                .filter((line) => line.matches)
                .map(({ line, text }) => ({ line, text }))
              const limitedMatches = matches.slice(0, 5)

              searchResults.push({
                fileInfo,
                content: content.length > 200 ? `${content.substring(0, 200)}...` : content,
                matches: limitedMatches,
              })
            }
          } catch (err) {
            console.error(`Error searching file ${file.path}: ${err}`)
          }
        }

        console.error(`DEBUG: Search complete, found ${searchResults.length} matching files`)
        let responseText = `Search results for "${query}" in ${
          fileListResult.currentPath || 'root'
        }:\n\n`

        if (searchResults.length === 0) {
          responseText += 'No matches found in any files.'
        } else {
          // biome-ignore lint/complexity/noForEach: <explanation>
          searchResults.forEach((result) => {
            responseText += `${result.fileInfo.name} (${formatFileSize(result.fileInfo.size)})\n`

            if (result.matches.length > 0) {
              responseText += 'Matching lines:\n'
              // biome-ignore lint/complexity/noForEach: <explanation>
              result.matches.forEach((match) => {
                const displayText =
                  match.text.length > 100 ? `${match.text.substring(0, 100)}...` : match.text
                responseText += `  Line ${match.line}: ${displayText}\n`
              })
            }

            responseText += '\n'
          })
          responseText += `Found ${searchResults.length} files containing "${query}".\n`
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
        return {
          content: [
            {
              type: 'text',
              text: `Error searching file contents: ${
                error instanceof Error ? error.message : 'Unknown error'
              }`,
            },
          ],
        }
      }
    },
  )

  server.tool(
    'obsidian-create',
    {
      path: z.string().describe('Path where to create the new file (relative to vault root)'),
      content: z.string().default('').describe('Initial content for the new file'),
      overwrite: z.boolean().default(false).describe('Whether to overwrite if file already exists'),
    },
    async ({ path: filePath, content, overwrite }) => {
      try {
        const normalizedPath = filePath.replace(/^\/+|\/+$/g, '')
        const fullPath = path.join(OBSIDIAN_VAULT_PATH, normalizedPath)

        if (!fullPath.startsWith(OBSIDIAN_VAULT_PATH)) {
          throw new Error('Access denied: Path outside of allowed directory')
        }

        try {
          await fs.access(fullPath)
          if (!overwrite) {
            return {
              content: [
                {
                  type: 'text',
                  text: `File already exists: ${normalizedPath}. Use overwrite=true to replace it.`,
                },
              ],
            }
          }
        } catch {
          console.error(`File does not exist, proceeding to create: ${normalizedPath}`)
        }

        const dirPath = dirname(fullPath)
        try {
          await fs.mkdir(dirPath, { recursive: true })
        } catch (error) {
          console.error(`Error creating directory: ${error}`)
        }

        await fs.writeFile(fullPath, content, 'utf-8')

        const fileStats = await fs.stat(fullPath)

        return {
          content: [
            {
              type: 'text',
              text: `File created successfully: ${normalizedPath}\nSize: ${formatFileSize(fileStats.size)}\nCreated: ${fileStats.birthtime.toLocaleString()}`,
            },
          ],
        }
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error creating file: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
        }
      }
    },
  )

  server.tool(
    'obsidian-update',
    {
      path: z.string().describe('Path to the file to update'),
      content: z.string().describe('New content for the file'),
      append: z
        .boolean()
        .default(false)
        .describe('Whether to append to existing content instead of replacing'),
    },
    async ({ path: filePath, content, append }) => {
      try {
        const normalizedPath = filePath.replace(/^\/+|\/+$/g, '')
        const fullPath = path.join(OBSIDIAN_VAULT_PATH, normalizedPath)

        if (!fullPath.startsWith(OBSIDIAN_VAULT_PATH)) {
          throw new Error('Access denied: Path outside of allowed directory')
        }

        try {
          const fileStats = await fs.stat(fullPath)
          if (!fileStats.isFile()) {
            throw new Error('Path is not a file')
          }
        } catch (error) {
          throw new Error(`File not found: ${normalizedPath}`)
        }

        let finalContent = content

        if (append) {
          const existingContent = await fs.readFile(fullPath, 'utf-8')
          finalContent = `${existingContent}\n${content}`
        }

        await fs.writeFile(fullPath, finalContent, 'utf-8')

        const fileStats = await fs.stat(fullPath)

        return {
          content: [
            {
              type: 'text',
              text: `File updated successfully: ${normalizedPath}\nSize: ${formatFileSize(fileStats.size)}\nModified: ${fileStats.mtime.toLocaleString()}\nOperation: ${append ? 'Appended' : 'Replaced'}`,
            },
          ],
        }
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error updating file: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
        }
      }
    },
  )

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
  }
}
