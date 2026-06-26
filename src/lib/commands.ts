import { supabase } from './supabase'
import { calculateSettlement } from './settlement'
import { getGroupMemberIds, getGroupMemberProfile, getBotId } from './line'
import { isCurrency, currencySymbol, convertToTWD } from './currency'
import type { Expense } from '@/types'

interface CommandContext {
  groupId: string
  userId: string
  displayName: string
  text: string
  mentionees: string[]
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
  const { groupId, userId, displayName, text, mentionees } = ctx
  const trimmed = text.trim()

  const proxyMatch =
    trimmed.match(/^幫(.+?)記帳\s+(.+)$/) ||
    trimmed.match(/^(.+?)付了\s+(.+)$/)

  if (proxyMatch) {
    const rawPayerName = proxyMatch[1].trim()
    const payerName = rawPayerName.replace(/^@/, '')
    const payerUserId = rawPayerName.startsWith('@') && mentionees.length > 0
      ? mentionees[0]
      : undefined
    return handleAddExpense({
      groupId, userId,
      payerName,
      raw: proxyMatch[2].trim(),
      isProxy: true,
      mentionees: [],
      payerUserId,
    })
  }
  if (trimmed.startsWith('新增旅程') || trimmed.startsWith('開始分帳')) {
    return handleNewTrip(groupId, userId, displayName, trimmed)
  }
  if (trimmed.startsWith('記帳') || trimmed.startsWith('新增消費')) {
    return handleAddExpense({ groupId, userId, payerName: displayName, raw: trimmed.replace(/^(記帳|新增消費)\s*/, ''), isProxy: false, mentionees })
  }
  if (trimmed.startsWith('設定貨幣')) return handleSetCurrency(groupId, trimmed)
  if (trimmed === '查帳' || trimmed === '消費清單') return handleListExpenses(groupId)
  if (trimmed === '我的帳' || trimmed === '我的餘額') return handleMyBalance(groupId, userId, displayName)
  if (trimmed === '結算') return handleSettle(groupId)
  if (trimmed === '結束旅程' || trimmed === '重置') return handleEndTrip(groupId)
  if (trimmed === '刪除最後一筆' || trimmed === '刲除') return handleDeleteLast(groupId)
  if (trimmed === '幫助' || trimmed === 'help' || trimmed === '說明') return { text: HELP_TEXT, quickReply: QR_MAIN }
  return null
}

async function getActiveTrip(groupId: string) {
  const { data } = await supabase
    .from('trips').select('*').eq('line_group_id', groupId).eq('status', 'active')
    .order('created_at', { ascending: false }).limit(1).single()
  return data
}

async function resolveNameToId(
  tripId: string,
  name: string
): Promise<{ userId: string; userName: string }> {
  const { data } = await supabase
    .from('trip_members')
    .select('user_line_id, user_name')
    .eq('trip_id', tripId)
    .eq('user_name', name)

  if (data && data.length === 1) {
    return { userId: data[0].user_line_id, userName: data[0].user_name }
  }
  return { userId: `name:${name}`, userName: name }
}

async function resolveIdToName(tripId: string, userId: string, groupId?: string): Promise<string> {
  const { data } = await supabase
    .from('trip_members')
    .select('user_name')
    .eq('trip_id', tripId)
    .eq('user_line_id', userId)
    .single()
  if (data?.user_name) return data.user_name

  if (groupId) {
    const profile = await getGroupMemberProfile(groupId, userId)
    if (profile?.displayName) {
      await ensureMember(tripId, userId, profile.displayName)
      return profile.displayName
    }
  }
  return userId
}

function buildDupeSet(pairs: Array<{ id: string; name: string }>): Set<string> {
  const nameIds: Record<string, string[]> = {}
  pairs.forEach(function({ id, name }) {
    if (!nameIds[name]) nameIds[name] = []
    if (nameIds[name].indexOf(id) === -1) nameIds[name].push(id)
  })
  const dupes = new Set<string>()
  Object.keys(nameIds).forEach(function(name) {
    if (nameIds[name].length > 1) dupes.add(name)
  })
  return dupes
}

function tagName(id: string, name: string, dupes: Set<string>): string {
  return dupes.has(name) ? `${name}(…${id.slice(-4)})` : name
}

async function handleNewTrip(groupId: string, userId: string, displayName: string, text: string): Promise<BotReply> {
  const raw = text.replace(/^(新增旅程|開始分帳)\s*/, '').trim()
  if (!raw) return { text: '請輸入旅程名稱，例如：新增旅程 沖繩五天' }

  const parts = raw.split(/\s+/)
  const lastPart = parts[parts.length - 1].toUpperCase()
  let currency = 'TWD', name = raw
  if (isCurrency(lastPart) && parts.length > 1) {
    currency = lastPart
    name = parts.slice(0, -1).join(' ')
  }

  const { data, error } = await supabase
    .from('trips')
    .insert({ name, line_group_id: groupId, status: 'active', created_by: userId, currency })
    .select().single()

  if (error || !data) return { text: '建立旅程失敗，請稍後再試' }

  // Run sync in background so trip creation response is fast
  syncGroupMembers(groupId, data.id).catch(() => null)

  const currencyNote = currency !== 'TWD' ? `\n💱 預設貨幣：${currency}（結算自動換算為 TWD）` : ''
  return {
    text: `✅ 已建立旅程：${data.name}${currencyNote}\n👥 正在同步群組成員...`,
    quickReply: QR_NEW_TRIP,
  }
}

async function handleSetCurrency(groupId: string, text: string): Promise<BotReply> {
  const currency = text.replace(/^設定貨幣\s*/, '').trim().toUpperCase()
  if (!isCurrency(currency)) return { text: `不支援的貨幣，可用：TWD JPY USD EUR KRW HKD SGD GBP AUD THB` }
  const trip = await getActiveTrip(groupId)
  if (!trip) return { text: '目前沒有進行中的旅程' }
  await supabase.from('trips').update({ currency }).eq('id', trip.id)
  return { text: `✅ 旅程「${trip.name}」預設貨幣已設為 ${currency}`, quickReply: QR_MAIN }
}

async function syncGroupMembers(groupId: string, tripId: string) {
  const botId = await getBotId()
  const memberIds = await getGroupMemberIds(groupId)
  for (const memberId of memberIds) {
    if (memberId === botId) continue
    const profile = await getGroupMemberProfile(groupId, memberId)
    if (!profile) continue
    await supabase.from('trip_members').upsert(
      { trip_id: tripId, user_line_id: memberId, user_name: profile.displayName },
      { onConflict: 'trip_id,user_line_id' }
    )
  }
}

interface AddExpenseParams {
  groupId: string
  userId: string
  payerName: string
  raw: string
  isProxy: boolean
  mentionees: string[]
  payerUserId?: string
}

async function getTripMembers(tripId: string, groupId: string) {
  const { data } = await supabase
    .from('trip_members').select('user_line_id, user_name').eq('trip_id', tripId)
  if (data && data.length > 0) return data
  // Background sync hasn't finished yet — run inline now
  await syncGroupMembers(groupId, tripId)
  const fresh = await supabase
    .from('trip_members').select('user_line_id, user_name').eq('trip_id', tripId)
  return fresh.data ?? []
}

async function handleAddExpense(p: AddExpenseParams): Promise<BotReply> {
  const { groupId, userId, payerName, raw, isProxy, mentionees, payerUserId } = p
  const trip = await getActiveTrip(groupId)
  if (!trip) return { text: '目前沒有進行中的旅程，請先輸入「新增旅程 旅程名稱」' }

  const parts = raw.trim().split(/\s+/)
  if (parts.length < 2) return { text: FORMAT_ERROR }

  const amount = parseFloat(parts[0])
  if (isNaN(amount) || amount <= 0) return { text: '金額格式錯誤，請輸入正確數字' }

  let inputCurrency = trip.currency ?? 'TWD'
  let descStart = 1
  if (parts.length > 2 && isCurrency(parts[1].toUpperCase())) {
    inputCurrency = parts[1].toUpperCase()
    descStart = 2
  }
  if (parts.length <= descStart) return { text: FORMAT_ERROR }

  const description = parts[descStart]
  const rest = parts.slice(descStart + 1)
  const isCustomSplit = rest.some(p => p.includes(':'))
  const isMentionSplit = rest.some(p => p.startsWith('@')) || mentionees.length > 0

  const { twd, rate } = await convertToTWD(amount, inputCurrency)
  const conversionNote = inputCurrency !== 'TWD'
    ? `\n   ${currencySymbol(inputCurrency)}${amount} ≈ $${twd} TWD（匯率 ${rate}）`
    : ''

  let payerLineId: string
  let resolvedPayerName = payerName
  if (isProxy) {
    if (payerUserId) {
      payerLineId = payerUserId
      const nameFromDb = await resolveIdToName(trip.id, payerUserId, groupId)
      resolvedPayerName = nameFromDb !== payerUserId ? nameFromDb : payerName
      await ensureMember(trip.id, payerUserId, resolvedPayerName)
    } else {
      const resolved = await resolveNameToId(trip.id, payerName)
      payerLineId = resolved.userId
      resolvedPayerName = resolved.userName
    }
  } else {
    payerLineId = userId
    await ensureMember(trip.id, userId, payerName)
  }

  let splits: { userLineId: string; userName: string; amount: number }[] = []

  if (isCustomSplit) {
    let total = 0
    for (const part of rest) {
      const colonIdx = part.lastIndexOf(':')
      if (colonIdx === -1) continue
      const name = part.slice(0, colonIdx)
      const amt = parseFloat(part.slice(colonIdx + 1))
      if (!name || isNaN(amt)) continue
      const resolved = await resolveNameToId(trip.id, name)
      splits.push({ userLineId: resolved.userId, userName: resolved.userName, amount: amt })
      total += amt
    }
    if (splits.length === 0) return { text: FORMAT_ERROR }
    if (Math.abs(total - twd) > 1) {
      return { text: `分攤金額加總 $${total} 與消費 $${twd} TWD 不符，請確認` }
    }
  } else if (isMentionSplit) {
    if (mentionees.length > 0) {
      const share = Math.round(twd / mentionees.length)
      splits = await Promise.all(
        mentionees.map(async uid => ({
          userLineId: uid,
          userName: await resolveIdToName(trip.id, uid, groupId),
          amount: share,
        }))
      )
    } else {
      const names = rest.filter(p => p.startsWith('@')).map(p => p.slice(1))
      const share = Math.round(twd / names.length)
      splits = await Promise.all(
        names.map(async name => {
          const resolved = await resolveNameToId(trip.id, name)
          return { userLineId: resolved.userId, userName: resolved.userName, amount: share }
        })
      )
    }
  } else {
    // Equal split among all members; sync inline if DB is still empty
    const members = await getTripMembers(trip.id, groupId)
    const memberList = members.length > 0
      ? members
      : [{ user_line_id: payerLineId, user_name: resolvedPayerName }]
    const share = Math.round(twd / memberList.length)
    splits = memberList.map(m => ({ userLineId: m.user_line_id, userName: m.user_name, amount: share }))
  }

  const { data: expense, error } = await supabase
    .from('expenses')
    .insert({
      trip_id: trip.id,
      payer_line_id: payerLineId,
      payer_name: resolvedPayerName,
      amount: twd,
      description,
      split_type: isCustomSplit ? 'custom' : 'equal',
      original_amount: inputCurrency !== 'TWD' ? amount : null,
      original_currency: inputCurrency !== 'TWD' ? inputCurrency : null,
    })
    .select().single()

  if (error || !expense) return { text: '記帳失敗，請稍後再試' }

  await supabase.from('expense_splits').insert(
    splits.map(s => ({
      expense_id: expense.id,
      user_line_id: s.userLineId,
      user_name: s.userName,
      amount: s.amount,
    }))
  )

  const dupeNames = buildDupeSet(splits.map(s => ({ id: s.userLineId, name: s.userName })))
  const splitSummary = splits.map(s => `  ${tagName(s.userLineId, s.userName, dupeNames)} $${s.amount}`).join('\n')

  const payerLabel = isProxy ? `代為 ${resolvedPayerName} 記帳` : `${resolvedPayerName} 付了`
  return {
    text: `✅ 已記錄消費\n💰 ${payerLabel} ${currencySymbol(inputCurrency)}${amount}（${description}）${conversionNote}\n\n分攤（TWD）：\n${splitSummary}`,
    quickReply: QR_MAIN,
  }
}

async function handleListExpenses(groupId: string): Promise<BotReply> {
  const trip = await getActiveTrip(groupId)
  if (!trip) return { text: '目前沒有進行中的旅程' }

  const { data: expenses } = await supabase
    .from('expenses').select('*').eq('trip_id', trip.id).order('created_at', { ascending: true })

  if (!expenses || expenses.length === 0) return { text: `旅程「${trip.name}」尚無消費紀錄`, quickReply: QR_MAIN }

  const total = expenses.reduce((sum, e) => sum + Number(e.amount), 0)
  const list = expenses.map((e, i) => {
    const orig = e.original_currency ? ` (${currencySymbol(e.original_currency)}${e.original_amount})` : ''
    return `${i + 1}. ${e.payer_name} 付 $${e.amount}${orig}（${e.description}）`
  }).join('\n')

  return {
    text: `📋 旅程：${trip.name}\n💱 貨幣：${trip.currency ?? 'TWD'}\n\n${list}\n\n合計：$${total} TWD`,
    quickReply: QR_MAIN,
  }
}

async function handleMyBalance(groupId: string, userId: string, displayName: string): Promise<BotReply> {
  const trip = await getActiveTrip(groupId)
  if (!trip) return { text: '目前沒有進行中的旅程' }

  await ensureMember(trip.id, userId, displayName)

  const { data: expenses } = await supabase
    .from('expenses').select('*, expense_splits(*)').eq('trip_id', trip.id)

  if (!expenses || expenses.length === 0) return { text: '尚無消費紀錄', quickReply: QR_MAIN }

  let paid = 0, shouldPay = 0
  for (const expense of expenses) {
    if (expense.payer_line_id === userId) paid += Number(expense.amount)
    const mySplit = expense.expense_splits?.find(
      (s: { user_line_id: string; amount: string }) => s.user_line_id === userId
    )
    if (mySplit) shouldPay += Number(mySplit.amount)
  }

  const balance = paid - shouldPay
  const status = balance > 0.5 ? `別人欠你 $${Math.round(balance)}`
    : balance < -0.5 ? `你欠別人 $${Math.round(Math.abs(balance))}`
    : '剛好平衡 👍'

  return {
    text: `👤 ${displayName} 的帳（TWD）\n\n已付：$${paid}\n應付：$${shouldPay}\n餘額：${status}`,
    quickReply: QR_MAIN,
  }
}

async function handleSettle(groupId: string): Promise<BotReply> {
  const trip = await getActiveTrip(groupId)
  if (!trip) return { text: '目前沒有進行中的旅程' }

  const { data: expenses } = await supabase
    .from('expenses').select('*, expense_splits(*)').eq('trip_id', trip.id)

  if (!expenses || expenses.length === 0) return { text: '尚無消費紀錄', quickReply: QR_MAIN }

  const formatted: Expense[] = expenses.map(e => ({
    id: e.id, tripId: e.trip_id, payerLineId: e.payer_line_id, payerName: e.payer_name,
    amount: Number(e.amount), description: e.description, splitType: e.split_type,
    createdAt: e.created_at,
    splits: (e.expense_splits ?? []).map((s: { id: string; expense_id: string; user_line_id: string; user_name: string; amount: string }) => ({
      id: s.id, expenseId: s.expense_id, userLineId: s.user_line_id,
      userName: s.user_name, amount: Number(s.amount),
    })),
  }))

  const settlements = calculateSettlement(formatted)
  const liffId = process.env.LIFF_ID
  const liffLink = liffId ? `\n\n📊 查看完整明細\nhttps://liff.line.me/${liffId}/expense/${trip.id}` : ''

  if (settlements.length === 0) {
    return { text: `✅ 大家都平衡了，不需要轉帳！${liffLink}`, quickReply: QR_AFTER_SETTLE }
  }

  const settlePairs = settlements.reduce<Array<{ id: string; name: string }>>((acc, s) => {
    acc.push({ id: s.from, name: s.fromName })
    acc.push({ id: s.to, name: s.toName })
    return acc
  }, [])
  const dupeNames = buildDupeSet(settlePairs)

  const list = settlements.map(s =>
    `💸 ${tagName(s.from, s.fromName, dupeNames)} → ${tagName(s.to, s.toName, dupeNames)} $${s.amount} TWD`
  ).join('\n')

  return {
    text: `💰 結算結果\n旅程：${trip.name}\n\n${list}${liffLink}`,
    quickReply: QR_AFTER_SETTLE,
  }
}

async function handleEndTrip(groupId: string): Promise<BotReply> {
  const trip = await getActiveTrip(groupId)
  if (!trip) return { text: '目前沒有進行中的旅程' }
  const { error } = await supabase.from('trips').update({ status: 'settled' }).eq('id', trip.id)
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
    .from('expenses').select('*').eq('trip_id', trip.id)
    .order('created_at', { ascending: false }).limit(1).single()
  if (fetchError || !last) return { text: '目前沒有可删除的消費紀錄' }
  const { error } = await supabase.from('expenses').delete().eq('id', last.id)
  if (error) return { text: '删除失敗，請稍後再試' }
  return {
    text: `🗑 已删除最後一筆\n${last.payer_name} 付 $${last.amount}（${last.description}）`,
    quickReply: QR_MAIN,
  }
}

async function ensureMember(tripId: string, userId: string, userName: string) {
  await supabase.from('trip_members').upsert(
    { trip_id: tripId, user_line_id: userId, user_name: userName },
    { onConflict: 'trip_id,user_line_id' }
  )
}

const FORMAT_ERROR = `格式錯誤，請參考：
• 記帳 500 晚餐
• 記帳 5000 JPY 晚餐
• 幫爬爾記帳 800 交通
• 爬爾付了 1200 晚餐`

const HELP_TEXT = `📖 分帳機器人指令

🆕 新增旅程 [名稱] [貨幣]
   例：新增旅程 沖繩 JPY

💰 記帳 [金額] [貨幣] [說明]
   例：記帳 5000 JPY 晚餐

👨 幫[NAME]記帳 [金額] [說明]
   [NAME]付了 [金額] [說明]

💱 設定貨幣 JPY
📋 查帳 | 👤 我的帳 | 🏦 結算
🏁 結束旅程 | 🗑 刪除最後一筆`
