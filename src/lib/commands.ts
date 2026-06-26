import { supabase } from './supabase'
import { calculateSettlement } from './settlement'
import { getGroupMemberIds, getGroupMemberProfile, getBotId } from './line'
import type { Expense } from '@/types'

interface CommandContext {
  groupId: string
  userId: string
  displayName: string
  text: string
}

export interface QuickReplyItem {
  label: string
  text: string
}

export interface BotReply {
  text: string
  quickReply?: QuickReplyItem[]
}

const QR_MAIN: QuickReplyItem[] = [
  { label: '📋 查帳', text: '查帳' },
  { label: '👤 我的帳', text: '我的帳' },
  { label: '🏦 結算', text: '結算' },
  { label: '🗑 刪除最後一筆', text: '刪除最後一筆' },
  { label: '🏁 結束旅程', text: '結束旅程' },
  { label: '📖 幫助', text: '幫助' },
]

const QR_NEW_TRIP: QuickReplyItem[] = [
  { label: '📋 查帳', text: '查帳' },
  { label: '📖 幫助', text: '幫助' },
]

const QR_AFTER_SETTLE: QuickReplyItem[] = [
  { label: '📋 查帳', text: '查帳' },
  { label: '🏁 結束旅程', text: '結束旅程' },
]

const QR_NEW_AFTER_END: QuickReplyItem[] = [
  { label: '🆕 新增旅程', text: '新增旅程 ' },
  { label: '📖 幫助', text: '幫助' },
]

export async function handleCommand(ctx: CommandContext): Promise<BotReply | null> {
  const { groupId, userId, displayName, text } = ctx
  const trimmed = text.trim()

  if (trimmed.startsWith('新增旅程') || trimmed.startsWith('開始分帳')) {
    return handleNewTrip(groupId, userId, displayName, trimmed)
  }
  if (trimmed.startsWith('記帳') || trimmed.startsWith('新增消費')) {
    return handleAddExpense(groupId, userId, displayName, trimmed)
  }
  if (trimmed === '查帳' || trimmed === '消費清單') {
    return handleListExpenses(groupId)
  }
  if (trimmed === '我的帳' || trimmed === '我的餘額') {
    return handleMyBalance(groupId, userId, displayName)
  }
  if (trimmed === '結算') {
    return handleSettle(groupId)
  }
  if (trimmed === '結束旅程' || trimmed === '重置') {
    return handleEndTrip(groupId)
  }
  if (trimmed === '刪除最後一筆' || trimmed === '刲除') {
    return handleDeleteLast(groupId)
  }
  if (trimmed === '幫助' || trimmed === 'help' || trimmed === '說明') {
    return { text: HELP_TEXT, quickReply: QR_MAIN }
  }
  return null
}

async function getActiveTrip(groupId: string) {
  const { data } = await supabase
    .from('trips')
    .select('*')
    .eq('line_group_id', groupId)
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1)
    .single()
  return data
}

async function handleNewTrip(
  groupId: string,
  userId: string,
  displayName: string,
  text: string
): Promise<BotReply> {
  const name = text.replace(/^(新增旅程|開始分帳)\s*/, '').trim()
  if (!name) return { text: '請輸入旅程名稱，例如：新增旅程 沖繩五天' }

  const { data, error } = await supabase
    .from('trips')
    .insert({ name, line_group_id: groupId, status: 'active', created_by: userId })
    .select()
    .single()

  if (error || !data) return { text: '建立旅程失敗，請稍後再試' }

  // Sync all group members in background (don't await, avoid timeout)
  syncGroupMembers(groupId, data.id).catch(() => null)

  return {
    text: `✅ 已建立旅程：${data.name}\n👥 正在同步群組成員...\n\n輸入「記帳 金額 說明」來新增消費`,
    quickReply: QR_NEW_TRIP,
  }
}

async function syncGroupMembers(groupId: string, tripId: string) {
  const botId = await getBotId()
  const memberIds = await getGroupMemberIds(groupId)

  for (const memberId of memberIds) {
    if (memberId === botId) continue // skip the bot itself
    const profile = await getGroupMemberProfile(groupId, memberId)
    if (!profile) continue
    await supabase.from('trip_members').upsert(
      { trip_id: tripId, user_line_id: memberId, user_name: profile.displayName },
      { onConflict: 'trip_id,user_line_id' }
    )
  }
}

async function handleAddExpense(
  groupId: string,
  userId: string,
  displayName: string,
  text: string
): Promise<BotReply> {
  const trip = await getActiveTrip(groupId)
  if (!trip) return { text: '目前沒有進行中的旅程，請先輸入「新增旅程 旅程名稱」' }

  const raw = text.replace(/^(記帳|新增消費)\s*/, '').trim()
  const parts = raw.split(/\s+/)
  if (parts.length < 2) return { text: FORMAT_ERROR }

  const amount = parseFloat(parts[0])
  if (isNaN(amount) || amount <= 0) return { text: '金額格式錯誤，請輸入正確數字' }

  const description = parts[1]
  const rest = parts.slice(2)
  const isCustomSplit = rest.some(p => p.includes(':'))
  const isMentionSplit = rest.some(p => p.startsWith('@'))

  await ensureMember(trip.id, userId, displayName)

  let splits: { userLineId: string; userName: string; amount: number }[] = []

  if (isCustomSplit) {
    let total = 0
    for (const p of rest) {
      const colonIdx = p.lastIndexOf(':')
      if (colonIdx === -1) continue
      const name = p.slice(0, colonIdx)
      const amt = parseFloat(p.slice(colonIdx + 1))
      if (!name || isNaN(amt)) continue
      splits.push({ userLineId: name, userName: name, amount: amt })
      total += amt
    }
    if (splits.length === 0) return { text: FORMAT_ERROR }
    if (Math.abs(total - amount) > 0.5) {
      return { text: `分攤金額加總 $${total} 與消費金額 $${amount} 不符，請確認` }
    }
  } else if (isMentionSplit) {
    const names = rest.filter(p => p.startsWith('@')).map(p => p.slice(1))
    if (names.length === 0) return { text: FORMAT_ERROR }
    const share = Math.round(amount / names.length)
    splits = names.map(name => ({ userLineId: name, userName: name, amount: share }))
  } else {
    const { data: members } = await supabase
      .from('trip_members')
      .select('user_line_id, user_name')
      .eq('trip_id', trip.id)

    const memberList = members?.length ? members : [{ user_line_id: userId, user_name: displayName }]
    const share = Math.round(amount / memberList.length)
    splits = memberList.map(m => ({
      userLineId: m.user_line_id,
      userName: m.user_name,
      amount: share,
    }))
  }

  const { data: expense, error } = await supabase
    .from('expenses')
    .insert({
      trip_id: trip.id,
      payer_line_id: userId,
      payer_name: displayName,
      amount,
      description,
      split_type: isCustomSplit ? 'custom' : 'equal',
    })
    .select()
    .single()

  if (error || !expense) return { text: '記帳失敗，請稍後再試' }

  await supabase.from('expense_splits').insert(
    splits.map(s => ({
      expense_id: expense.id,
      user_line_id: s.userLineId,
      user_name: s.userName,
      amount: s.amount,
    }))
  )

  const splitSummary = splits.map(s => `  ${s.userName} $${s.amount}`).join('\n')
  return {
    text: `✅ 已記錄消費\n💰 ${displayName} 付了 $${amount}（${description}）\n\n分攤：\n${splitSummary}`,
    quickReply: QR_MAIN,
  }
}

async function handleListExpenses(groupId: string): Promise<BotReply> {
  const trip = await getActiveTrip(groupId)
  if (!trip) return { text: '目前沒有進行中的旅程' }

  const { data: expenses } = await supabase
    .from('expenses')
    .select('*')
    .eq('trip_id', trip.id)
    .order('created_at', { ascending: true })

  if (!expenses || expenses.length === 0) {
    return { text: `旅程「${trip.name}」尚無消費紀錄`, quickReply: QR_MAIN }
  }

  const total = expenses.reduce((sum, e) => sum + Number(e.amount), 0)
  const list = expenses
    .map((e, i) => `${i + 1}. ${e.payer_name} 付 $${e.amount}（${e.description}）`)
    .join('\n')

  return {
    text: `📋 旅程：${trip.name}\n\n${list}\n\n合計：$${total}`,
    quickReply: QR_MAIN,
  }
}

async function handleMyBalance(
  groupId: string,
  userId: string,
  displayName: string
): Promise<BotReply> {
  const trip = await getActiveTrip(groupId)
  if (!trip) return { text: '目前沒有進行中的旅程' }

  await ensureMember(trip.id, userId, displayName)

  const { data: expenses } = await supabase
    .from('expenses')
    .select('*, expense_splits(*)')
    .eq('trip_id', trip.id)

  if (!expenses || expenses.length === 0) {
    return { text: '尚無消費紀錄', quickReply: QR_MAIN }
  }

  let paid = 0
  let shouldPay = 0

  for (const expense of expenses) {
    if (expense.payer_line_id === userId) paid += Number(expense.amount)
    const mySplit = expense.expense_splits?.find(
      (s: { user_line_id: string; amount: string }) => s.user_line_id === userId
    )
    if (mySplit) shouldPay += Number(mySplit.amount)
  }

  const balance = paid - shouldPay
  const status =
    balance > 0.5
      ? `別人欠你 $${Math.round(balance)}`
      : balance < -0.5
      ? `你欠別人 $${Math.round(Math.abs(balance))}`
      : '剛好平衡 👍'

  return {
    text: `👤 ${displayName} 的帳\n\n已付：$${paid}\n應付：$${shouldPay}\n餘額：${status}`,
    quickReply: QR_MAIN,
  }
}

async function handleSettle(groupId: string): Promise<BotReply> {
  const trip = await getActiveTrip(groupId)
  if (!trip) return { text: '目前沒有進行中的旅程' }

  const { data: expenses } = await supabase
    .from('expenses')
    .select('*, expense_splits(*)')
    .eq('trip_id', trip.id)

  if (!expenses || expenses.length === 0) {
    return { text: '尚無消費紀錄', quickReply: QR_MAIN }
  }

  const formatted: Expense[] = expenses.map(e => ({
    id: e.id,
    tripId: e.trip_id,
    payerLineId: e.payer_line_id,
    payerName: e.payer_name,
    amount: Number(e.amount),
    description: e.description,
    splitType: e.split_type,
    createdAt: e.created_at,
    splits: (e.expense_splits ?? []).map((s: {
      id: string; expense_id: string; user_line_id: string; user_name: string; amount: string
    }) => ({
      id: s.id,
      expenseId: s.expense_id,
      userLineId: s.user_line_id,
      userName: s.user_name,
      amount: Number(s.amount),
    })),
  }))

  const settlements = calculateSettlement(formatted)
  const liffId = process.env.LIFF_ID
  const liffLink = liffId
    ? `\n\n📊 查看完整明細\nhttps://liff.line.me/${liffId}/expense/${trip.id}`
    : ''

  if (settlements.length === 0) {
    return {
      text: `✅ 大家都平衡了，不需要轉帳！${liffLink}`,
      quickReply: QR_AFTER_SETTLE,
    }
  }

  const list = settlements.map(s => `💸 ${s.fromName} → ${s.toName} $${s.amount}`).join('\n')
  return {
    text: `💰 結算結果\n旅程：${trip.name}\n\n${list}${liffLink}`,
    quickReply: QR_AFTER_SETTLE,
  }
}

async function handleEndTrip(groupId: string): Promise<BotReply> {
  const trip = await getActiveTrip(groupId)
  if (!trip) return { text: '目前沒有進行中的旅程' }

  const { error } = await supabase
    .from('trips')
    .update({ status: 'settled' })
    .eq('id', trip.id)

  if (error) return { text: '結束旅程失敗，請稍後再試' }

  return {
    text: `🏁 旅程「${trip.name}」已結束\n\n輸入「新增旅程 名稱」可以開始新的分帳`,
    quickReply: QR_NEW_AFTER_END,
  }
}

async function handleDeleteLast(groupId: string): Promise<BotReply> {
  const trip = await getActiveTrip(groupId)
  if (!trip) return { text: '目前沒有進行中的旅程' }

  const { data: last, error: fetchError } = await supabase
    .from('expenses')
    .select('*')
    .eq('trip_id', trip.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .single()

  if (fetchError || !last) return { text: '目前沒有可删除的消費紀錄' }

  const { error } = await supabase.from('expenses').delete().eq('id', last.id)

  if (error) return { text: '删除失敗，請稍後再試' }

  return {
    text: `🗑 已删除最後一筆\n${last.payer_name} 付 $${last.amount}（${last.description}）`,
    quickReply: QR_MAIN,
  }
}

async function ensureMember(tripId: string, userId: string, userName: string) {
  await supabase
    .from('trip_members')
    .upsert(
      { trip_id: tripId, user_line_id: userId, user_name: userName },
      { onConflict: 'trip_id,user_line_id' }
    )
}

const FORMAT_ERROR = `格式錯誤，請參考：
• 記帳 500 晚餐（均分所有成員）
• 記帳 600 計程車 @小明 @小花（指定均分）
• 記帳 900 午餐 小明:400 小花:500（自訂金額）`

const HELP_TEXT = `📖 分帳機器人指令

🆕 新增旅程 [名稱]
💰 記帳 [金額] [說明]
   指定則：記帳 600 計程車 @A @B
   自訂：記帳 900 午餐 A:400 B:500
📋 查帳
👤 我的帳
🏦 結算
🏁 結束旅程
🗑 刪除最後一筆`
