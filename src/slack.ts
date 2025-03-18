import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import dotenv from 'dotenv'

dotenv.config()

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN
const SLACK_TEAM_ID = process.env.SLACK_TEAM_ID || ''

if (!SLACK_BOT_TOKEN || !SLACK_TEAM_ID) {
  console.error('Warning: SLACK_BOT_TOKEN and SLACK_TEAM_ID environment variables must be set')
}

class SlackClient {
  private botHeaders: { Authorization: string; 'Content-Type': string }

  constructor(botToken: string) {
    this.botHeaders = {
      Authorization: `Bearer ${botToken}`,
      'Content-Type': 'application/json',
    }
  }

  async getChannels(limit = 100, cursor?: string): Promise<any> {
    const params = new URLSearchParams({
      types: 'public_channel',
      exclude_archived: 'true',
      limit: Math.min(limit, 200).toString(),
      team_id: SLACK_TEAM_ID,
    })

    if (cursor) {
      params.append('cursor', cursor)
    }

    const response = await fetch(`https://slack.com/api/conversations.list?${params}`, {
      headers: this.botHeaders,
    })

    return response.json()
  }

  async postMessage(channel_id: string, text: string): Promise<any> {
    const response = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: this.botHeaders,
      body: JSON.stringify({
        channel: channel_id,
        text: text,
      }),
    })

    return response.json()
  }

  async postReply(channel_id: string, thread_ts: string, text: string): Promise<any> {
    const response = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: this.botHeaders,
      body: JSON.stringify({
        channel: channel_id,
        thread_ts: thread_ts,
        text: text,
      }),
    })

    return response.json()
  }

  async addReaction(channel_id: string, timestamp: string, reaction: string): Promise<any> {
    const response = await fetch('https://slack.com/api/reactions.add', {
      method: 'POST',
      headers: this.botHeaders,
      body: JSON.stringify({
        channel: channel_id,
        timestamp: timestamp,
        name: reaction,
      }),
    })

    return response.json()
  }

  async getChannelHistory(channel_id: string, limit = 10): Promise<any> {
    const params = new URLSearchParams({
      channel: channel_id,
      limit: limit.toString(),
    })

    const response = await fetch(`https://slack.com/api/conversations.history?${params}`, {
      headers: this.botHeaders,
    })

    return response.json()
  }

  async getThreadReplies(channel_id: string, thread_ts: string): Promise<any> {
    const params = new URLSearchParams({
      channel: channel_id,
      ts: thread_ts,
    })

    const response = await fetch(`https://slack.com/api/conversations.replies?${params}`, {
      headers: this.botHeaders,
    })

    return response.json()
  }

  async getUsers(limit = 100, cursor?: string): Promise<any> {
    const params = new URLSearchParams({
      limit: Math.min(limit, 200).toString(),
      team_id: SLACK_TEAM_ID,
    })

    if (cursor) {
      params.append('cursor', cursor)
    }

    const response = await fetch(`https://slack.com/api/users.list?${params}`, {
      headers: this.botHeaders,
    })

    return response.json()
  }

  async getUserProfile(user_id: string): Promise<any> {
    const params = new URLSearchParams({
      user: user_id,
      include_labels: 'true',
    })

    const response = await fetch(`https://slack.com/api/users.profile.get?${params}`, {
      headers: this.botHeaders,
    })

    return response.json()
  }

  async getUnrepliedMentions(channel_id: string, user_id: string, hours = 24): Promise<any> {
    const oldest = Math.floor(Date.now() / 1000 - hours * 3600).toString()

    const params = new URLSearchParams({
      channel: channel_id,
      oldest: oldest,
    })

    const historyResponse = await fetch(`https://slack.com/api/conversations.history?${params}`, {
      headers: this.botHeaders,
    })

    const history = await historyResponse.json()

    if (!history.ok) {
      return { ok: false, error: history.error }
    }

    const mentionRegex = new RegExp(`<@${user_id}>`)
    const mentionMessages = history.messages.filter(
      (msg: any) => mentionRegex.test(msg.text) && !msg.thread_ts,
    )
    const unrepliedMentions = []

    for (const msg of mentionMessages) {
      const repliesParams = new URLSearchParams({
        channel: channel_id,
        ts: msg.ts,
      })

      const repliesResponse = await fetch(
        `https://slack.com/api/conversations.replies?${repliesParams}`,
        { headers: this.botHeaders },
      )

      const replies = await repliesResponse.json()

      if (!replies.ok) continue

      const userReplied = replies.messages.slice(1).some((reply: any) => reply.user === user_id)

      if (!userReplied) {
        unrepliedMentions.push({
          message: msg,
          timestamp: msg.ts,
          text: msg.text,
          user: msg.user,
          permalink: await this.getPermalink(channel_id, msg.ts),
        })
      }
    }

    return { ok: true, mentions: unrepliedMentions }
  }

  async getRecentActivity(channel_id: string, hours = 24): Promise<any> {
    const oldest = Math.floor(Date.now() / 1000 - hours * 3600).toString()

    const params = new URLSearchParams({
      channel: channel_id,
      oldest: oldest,
      limit: '100',
    })

    const historyResponse = await fetch(`https://slack.com/api/conversations.history?${params}`, {
      headers: this.botHeaders,
    })

    const history = await historyResponse.json()

    if (!history.ok) {
      return { ok: false, error: history.error }
    }

    const messagesWithThreads = []
    for (const msg of history.messages) {
      if (msg.thread_ts && msg.thread_ts === msg.ts) {
        const repliesParams = new URLSearchParams({
          channel: channel_id,
          ts: msg.ts,
        })

        const repliesResponse = await fetch(
          `https://slack.com/api/conversations.replies?${repliesParams}`,
          { headers: this.botHeaders },
        )

        const replies = await repliesResponse.json()

        if (replies.ok) {
          messagesWithThreads.push({
            ...msg,
            replies: replies.messages.slice(1), // リプレイだけど最初のメッセージも入ってくる
            permalink: await this.getPermalink(channel_id, msg.ts),
          })
        } else {
          messagesWithThreads.push({
            ...msg,
            permalink: await this.getPermalink(channel_id, msg.ts),
          })
        }
      } else if (!msg.thread_ts) {
        messagesWithThreads.push({
          ...msg,
          permalink: await this.getPermalink(channel_id, msg.ts),
        })
      }
    }

    return {
      ok: true,
      messages: messagesWithThreads,
      channel_info: await this.getChannelInfo(channel_id),
    }
  }

  async getPermalink(channel_id: string, message_ts: string): Promise<string> {
    const params = new URLSearchParams({
      channel: channel_id,
      message_ts: message_ts,
    })

    const response = await fetch(`https://slack.com/api/chat.getPermalink?${params}`, {
      headers: this.botHeaders,
    })

    const result = await response.json()
    return result.ok ? result.permalink : ''
  }

  async getChannelInfo(channel_id: string): Promise<any> {
    const params = new URLSearchParams({
      channel: channel_id,
    })

    const response = await fetch(`https://slack.com/api/conversations.info?${params}`, {
      headers: this.botHeaders,
    })

    const result = await response.json()
    return result.ok ? result.channel : {}
  }
}

export function configureServer(server: McpServer): void {
  console.error('Configuring Slack MCP Server')

  if (!SLACK_BOT_TOKEN || !SLACK_TEAM_ID) {
    console.error('ERROR: SLACK_BOT_TOKEN and SLACK_TEAM_ID must be set in environment variables')
    return
  }

  const slackClient = new SlackClient(SLACK_BOT_TOKEN)

  server.tool(
    'slack_list_channels',
    'List public channels in the workspace',
    {
      limit: z
        .number()
        .default(100)
        .describe('Maximum number of channels to return (default 100, max 200)'),
      cursor: z.string().optional().describe('Pagination cursor for next page of results'),
    },
    async ({ limit, cursor }, _extra) => {
      try {
        const response = await slackClient.getChannels(limit, cursor)

        if (!response.ok) {
          return {
            content: [{ type: 'text', text: `Error: ${response.error}` }],
            isError: true,
          }
        }

        // 結果をフォーマットして返す
        let responseText = 'Channels in workspace:\n\n'
        if (response.channels.length === 0) {
          responseText += 'No channels found.'
        } else {
          response.channels.forEach((channel: any, index: number) => {
            responseText += `${index + 1}. #${channel.name} (ID: ${channel.id})\n`
            if (channel.purpose.value) {
              responseText += `   Purpose: ${channel.purpose.value}\n`
            }
            responseText += `   Members: ${channel.num_members}\n`
            responseText += '\n'
          })
        }

        if (response.response_metadata?.next_cursor) {
          responseText += `\nMore channels available. Use cursor: ${response.response_metadata.next_cursor}`
        }

        return {
          content: [{ type: 'text', text: responseText }],
        }
      } catch (error) {
        console.error('Error in slack_list_channels:', error)
        return {
          content: [
            {
              type: 'text',
              text: `Error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        }
      }
    },
  )

  server.tool(
    'slack_post_message',
    'Post a new message to a Slack channel',
    {
      channel_id: z.string().describe('The ID of the channel to post to'),
      text: z.string().describe('The message text to post'),
    },
    async ({ channel_id, text }, _extra) => {
      try {
        const response = await slackClient.postMessage(channel_id, text)

        if (!response.ok) {
          return {
            content: [{ type: 'text', text: `Error posting message: ${response.error}` }],
            isError: true,
          }
        }

        return {
          content: [
            {
              type: 'text',
              text: `Message successfully posted to <#${channel_id}> with timestamp ${response.ts}`,
            },
          ],
        }
      } catch (error) {
        console.error('Error in slack_post_message:', error)
        return {
          content: [
            {
              type: 'text',
              text: `Error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        }
      }
    },
  )

  server.tool(
    'slack_reply_to_thread',
    'Reply to a specific message thread in Slack',
    {
      channel_id: z.string().describe('The ID of the channel containing the thread'),
      thread_ts: z.string().describe('The timestamp of the parent message'),
      text: z.string().describe('The reply text'),
    },
    async ({ channel_id, thread_ts, text }, _extra) => {
      try {
        const response = await slackClient.postReply(channel_id, thread_ts, text)

        if (!response.ok) {
          return {
            content: [{ type: 'text', text: `Error posting reply: ${response.error}` }],
            isError: true,
          }
        }

        return {
          content: [
            {
              type: 'text',
              text: `Reply successfully posted to thread in <#${channel_id}>`,
            },
          ],
        }
      } catch (error) {
        console.error('Error in slack_reply_to_thread:', error)
        return {
          content: [
            {
              type: 'text',
              text: `Error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        }
      }
    },
  )

  server.tool(
    'slack_add_reaction',
    'Add an emoji reaction to a message',
    {
      channel_id: z.string().describe('The ID of the channel containing the message'),
      timestamp: z.string().describe('The timestamp of the message to react to'),
      reaction: z.string().describe('The name of the emoji reaction (without ::)'),
    },
    async ({ channel_id, timestamp, reaction }, _extra) => {
      try {
        const response = await slackClient.addReaction(channel_id, timestamp, reaction)

        if (!response.ok) {
          return {
            content: [{ type: 'text', text: `Error adding reaction: ${response.error}` }],
            isError: true,
          }
        }

        return {
          content: [
            {
              type: 'text',
              text: `Reaction :${reaction}: added to message in <#${channel_id}>`,
            },
          ],
        }
      } catch (error) {
        console.error('Error in slack_add_reaction:', error)
        return {
          content: [
            {
              type: 'text',
              text: `Error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        }
      }
    },
  )

  server.tool(
    'slack_get_channel_history',
    'Get recent messages from a channel',
    {
      channel_id: z.string().describe('The ID of the channel'),
      limit: z.number().default(10).describe('Number of messages to retrieve (default 10)'),
    },
    async ({ channel_id, limit }, _extra) => {
      try {
        const response = await slackClient.getChannelHistory(channel_id, limit)

        if (!response.ok) {
          return {
            content: [
              { type: 'text', text: `Error retrieving channel history: ${response.error}` },
            ],
            isError: true,
          }
        }

        let responseText = `Recent messages in <#${channel_id}>:\n\n`

        if (response.messages.length === 0) {
          responseText += 'No messages found.'
        } else {
          for (let i = 0; i < response.messages.length; i++) {
            const msg = response.messages[i]
            const timestamp = new Date(Number(msg.ts.split('.')[0]) * 1000).toLocaleString()

            responseText += `[${timestamp}] `

            if (msg.user) {
              responseText += `<@${msg.user}>: `
            }

            responseText += `${msg.text}\n`

            if (msg.thread_ts && msg.reply_count > 0) {
              responseText += `   (${msg.reply_count} ${msg.reply_count === 1 ? 'reply' : 'replies'} in thread)\n`
            }

            responseText += '\n'
          }
        }

        return {
          content: [{ type: 'text', text: responseText }],
        }
      } catch (error) {
        console.error('Error in slack_get_channel_history:', error)
        return {
          content: [
            {
              type: 'text',
              text: `Error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        }
      }
    },
  )

  server.tool(
    'slack_get_thread_replies',
    'Get all replies in a message thread',
    {
      channel_id: z.string().describe('The ID of the channel containing the thread'),
      thread_ts: z.string().describe('The timestamp of the parent message'),
    },
    async ({ channel_id, thread_ts }, _extra) => {
      try {
        const response = await slackClient.getThreadReplies(channel_id, thread_ts)

        if (!response.ok) {
          return {
            content: [{ type: 'text', text: `Error retrieving thread replies: ${response.error}` }],
            isError: true,
          }
        }

        const parentTimestamp = new Date(Number(thread_ts.split('.')[0]) * 1000).toLocaleString()

        let responseText = `Thread replies in <#${channel_id}> (parent message from ${parentTimestamp}):\n\n`

        if (response.messages.length <= 1) {
          responseText += 'No replies found in this thread.'
        } else {
          const parentMsg = response.messages[0]
          responseText += `Parent: <@${parentMsg.user}>: ${parentMsg.text}\n\n`
          for (let i = 1; i < response.messages.length; i++) {
            const msg = response.messages[i]
            const timestamp = new Date(Number(msg.ts.split('.')[0]) * 1000).toLocaleString()

            responseText += `[${timestamp}] <@${msg.user}>: ${msg.text}\n\n`
          }
        }

        return {
          content: [{ type: 'text', text: responseText }],
        }
      } catch (error) {
        console.error('Error in slack_get_thread_replies:', error)
        return {
          content: [
            {
              type: 'text',
              text: `Error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        }
      }
    },
  )

  server.tool(
    'slack_get_users',
    'Get a list of all users in the workspace with their basic profile information',
    {
      limit: z
        .number()
        .default(100)
        .describe('Maximum number of users to return (default 100, max 200)'),
      cursor: z.string().optional().describe('Pagination cursor for next page of results'),
    },
    async ({ limit, cursor }, _extra) => {
      try {
        const response = await slackClient.getUsers(limit, cursor)

        if (!response.ok) {
          return {
            content: [{ type: 'text', text: `Error retrieving users: ${response.error}` }],
            isError: true,
          }
        }

        let responseText = 'Users in workspace:\n\n'

        if (response.members.length === 0) {
          responseText += 'No users found.'
        } else {
          response.members.forEach((user: any, index: number) => {
            if (user.is_bot && user.name !== 'slackbot') {
              responseText += `${index + 1}. 🤖 ${user.real_name || user.name} (ID: ${user.id}) [BOT]\n`
            } else {
              responseText += `${index + 1}. ${user.real_name || user.name} (ID: ${user.id})\n`
            }

            if (user.profile?.status_text) {
              responseText += `   Status: ${user.profile.status_emoji || ''} ${user.profile.status_text}\n`
            }

            responseText += '\n'
          })
        }

        if (response.response_metadata?.next_cursor) {
          responseText += `\nMore users available. Use cursor: ${response.response_metadata.next_cursor}`
        }

        return {
          content: [{ type: 'text', text: responseText }],
        }
      } catch (error) {
        console.error('Error in slack_get_users:', error)
        return {
          content: [
            {
              type: 'text',
              text: `Error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        }
      }
    },
  )

  server.tool(
    'slack_get_user_profile',
    'Get detailed profile information for a specific user',
    {
      user_id: z.string().describe('The ID of the user'),
    },
    async ({ user_id }, _extra) => {
      try {
        const response = await slackClient.getUserProfile(user_id)

        if (!response.ok) {
          return {
            content: [{ type: 'text', text: `Error retrieving user profile: ${response.error}` }],
            isError: true,
          }
        }

        const profile = response.profile

        let responseText = `Profile for <@${user_id}>:\n\n`

        responseText += `Name: ${profile.real_name || 'N/A'}\n`
        responseText += `Display Name: ${profile.display_name || 'N/A'}\n`
        responseText += `Email: ${profile.email || 'N/A'}\n`

        if (profile.phone) {
          responseText += `Phone: ${profile.phone}\n`
        }

        if (profile.title) {
          responseText += `Title: ${profile.title}\n`
        }

        if (profile.status_text) {
          responseText += `Status: ${profile.status_emoji || ''} ${profile.status_text}\n`
        }

        if (profile.fields) {
          const customFields = Object.values(profile.fields).filter(Boolean)
          if (customFields.length > 0) {
            responseText += '\nCustom Fields:\n'
            customFields.forEach((field: any) => {
              responseText += `- ${field.label}: ${field.value}\n`
            })
          }
        }

        return {
          content: [{ type: 'text', text: responseText }],
        }
      } catch (error) {
        console.error('Error in slack_get_user_profile:', error)
        return {
          content: [
            {
              type: 'text',
              text: `Error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        }
      }
    },
  )

  server.tool(
    'slack_get_unreplied_mentions',
    'Get unreplied mentions in a specific channel',
    {
      channel_id: z.string().describe('The ID of the channel to check'),
      user_id: z.string().describe('The ID of the user to check mentions for'),
      hours: z.number().default(24).describe('How many hours back to check (default: 24)'),
    },
    async ({ channel_id, user_id, hours }, _extra) => {
      try {
        const response = await slackClient.getUnrepliedMentions(channel_id, user_id, hours)

        if (!response.ok) {
          return {
            content: [
              { type: 'text', text: `Error retrieving unreplied mentions: ${response.error}` },
            ],
            isError: true,
          }
        }

        let responseText = `Unreplied mentions for <@${user_id}> in <#${channel_id}> (past ${hours} hours):\n\n`

        if (response.mentions.length === 0) {
          responseText += 'No unreplied mentions found.'
        } else {
          response.mentions.forEach((mention: any, index: number) => {
            const timestamp = new Date(
              Number(mention.timestamp.split('.')[0]) * 1000,
            ).toLocaleString()

            responseText += `${index + 1}. [${timestamp}] From <@${mention.user}>:\n`
            responseText += `   ${mention.text}\n`

            if (mention.permalink) {
              responseText += `   Link: ${mention.permalink}\n`
            }

            responseText += '\n'
          })
        }

        return {
          content: [{ type: 'text', text: responseText }],
        }
      } catch (error) {
        console.error('Error in slack_get_unreplied_mentions:', error)
        return {
          content: [
            {
              type: 'text',
              text: `Error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        }
      }
    },
  )

  server.tool(
    'slack_summarize_recent_activity',
    'Get messages from the last 24 hours in a channel, for summarization',
    {
      channel_id: z.string().describe('The ID of the channel to check'),
      hours: z.number().default(24).describe('How many hours back to retrieve (default: 24)'),
    },
    async ({ channel_id, hours }, _extra) => {
      try {
        const response = await slackClient.getRecentActivity(channel_id, hours)

        if (!response.ok) {
          return {
            content: [
              { type: 'text', text: `Error retrieving recent activity: ${response.error}` },
            ],
            isError: true,
          }
        }

        const channelInfo = response.channel_info || {}
        const channelName = channelInfo.name ? `#${channelInfo.name}` : channel_id

        let responseText = `Recent activity in ${channelName} (past ${hours} hours):\n\n`

        if (response.messages.length === 0) {
          responseText += 'No messages found in this time period.'
        } else {
          const uniqueUsers = new Set(response.messages.map((msg: any) => msg.user))
          const threadCount = response.messages.filter(
            (msg: any) => msg.thread_ts && msg.thread_ts === msg.ts,
          ).length

          responseText += 'Summary Statistics:\n'
          responseText += `- Total Messages: ${response.messages.length}\n`
          responseText += `- Unique Participants: ${uniqueUsers.size}\n`
          responseText += `- Conversation Threads: ${threadCount}\n\n`

          responseText += 'Message Timeline:\n\n'

          response.messages.forEach((msg: any, index: number) => {
            const timestamp = new Date(Number(msg.ts.split('.')[0]) * 1000).toLocaleString()

            if (!msg.thread_ts || msg.thread_ts === msg.ts) {
              responseText += `[${timestamp}] <@${msg.user}>: ${msg.text}\n`

              if (msg.replies && msg.replies.length > 0) {
                responseText += `   Thread with ${msg.replies.length} ${msg.replies.length === 1 ? 'reply' : 'replies'}:\n`

                // 長いスレッドは最初と最後の返信だけ表示。トークン節約用。
                if (msg.replies.length <= 3) {
                  msg.replies.forEach((reply: any) => {
                    responseText += `   - <@${reply.user}>: ${reply.text}\n`
                  })
                } else {
                  responseText += `   - <@${msg.replies[0].user}>: ${msg.replies[0].text}\n`
                  responseText += `   - ... ${msg.replies.length - 2} more messages ...\n`
                  responseText += `   - <@${msg.replies[msg.replies.length - 1].user}>: ${msg.replies[msg.replies.length - 1].text}\n`
                }
              }

              if (msg.permalink) {
                responseText += `   Link: ${msg.permalink}\n`
              }

              responseText += '\n'
            }
          })
        }

        return {
          content: [{ type: 'text', text: responseText }],
        }
      } catch (error) {
        console.error('Error in slack_summarize_recent_activity:', error)
        return {
          content: [
            {
              type: 'text',
              text: `Error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        }
      }
    },
  )
}
