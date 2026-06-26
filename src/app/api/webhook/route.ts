import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { handleCommand } from '@/lib/commands'
import { getGroupMemberProfile } from '@/lib/line'
import type { QuickReplyItem } from '@/lib/commands'

export async function POST(req: NextRequest) {
  const body = await req.text()

  const signature = req.headers.get('x-line-signature') ?? ''
  const channelSecret = process.env.LINE_CHANNEL_SECRET!
  const digest = crypto.createHmac('sha256', channelSecret).update(body).digest('base64')

  if (digest !== signature) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  const events = JSON.parse(body).events ?? []

  for (const event of events) {
    if (event.type !== 'message' || event.message?.type !== 'text') continue
    if (event.source?.type !== 'group') continue

    const groupId: string = event.source.groupId
    const userId: string = event.source.userId
    const text: string = event.message.text

    // Extract ordered mentionee user IDs from the message
    const mentionees: string[] = (event.message.mention?.mentionees ?? [])
      .filter((m: { type: string }) => m.type === 'user')
      .sort((a: { index: number }, b: { index: number }) => a.index - b.index)
      .map((m: { userId: string }) => m.userId)

    const profile = await getGroupMemberProfile(groupId, userId)
    const displayName: string = profile?.displayName ?? userId

    const reply = await handleCommand({ groupId, userId, displayName, text, mentionees })
    if (reply) {
      await replyMessage(event.replyToken, reply.text, reply.quickReply)
    }
  }

  return NextResponse.json({ ok: true })
}

async function replyMessage(
  replyToken: string,
  text: string,
  quickReplyItems?: QuickReplyItem[]
) {
  const message: Record<string, unknown> = { type: 'text', text }

  if (quickReplyItems && quickReplyItems.length > 0) {
    message.quickReply = {
      items: quickReplyItems.map(item => ({
        type: 'action',
        action: { type: 'message', label: item.label, text: item.text },
      })),
    }
  }

  await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ replyToken, messages: [message] }),
  })
}
