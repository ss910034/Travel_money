import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { handleCommand } from '@/lib/commands'

export async function POST(req: NextRequest) {
  const body = await req.text()

  // Verify LINE webhook signature
  const signature = req.headers.get('x-line-signature') ?? ''
  const channelSecret = process.env.LINE_CHANNEL_SECRET!
  const digest = crypto.createHmac('sha256', channelSecret).update(body).digest('base64')

  if (digest !== signature) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  const payload = JSON.parse(body)
  const events = payload.events ?? []

  for (const event of events) {
    if (event.type !== 'message' || event.message?.type !== 'text') continue
    if (event.source?.type !== 'group') continue

    const groupId: string = event.source.groupId
    const userId: string = event.source.userId
    const text: string = event.message.text
    // LINE webhook does not provide display name directly; use userId as fallback
    const displayName: string = userId

    const reply = await handleCommand({ groupId, userId, displayName, text })
    if (reply) {
      await replyMessage(event.replyToken, reply)
    }
  }

  return NextResponse.json({ ok: true })
}

async function replyMessage(replyToken: string, text: string) {
  await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: 'text', text }],
    }),
  })
}
