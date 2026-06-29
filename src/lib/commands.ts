import { supabase } from './supabase'
import { calculateSettlement } from './settlement'
import { getGroupMemberIds, getGroupMemberProfile, getBotId } from './line'
import { isCurrency, currencySymbol, convertToTWD } from './currency'
import type { Expense, Payment } from '@/types'

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
  { label: '👥 成員', text: '成員 ' },
  { label: '📋 查帳', text: '查帳' },
  { label: '📖 幫助', text: '幫助' },
]
const QR_AFTER_SETTLE: QuickReplyItem[] = [
  { label: '📋 查帳', text: '查帳' },
  { label: '💸 還款紀錄', text: '還款紀錄' },
  { label: '🏁 結束旅程', text: '結束旅程' },
]
const QR_NEW_AFTER_END: QuickReplyItem[] = [
  { label: '🆕 新增旅程', text: '新增旅程 ' },
  { label: '📖 幫助', text: '幫助' },
]

export async function handleCommand(ctx: CommandContext): Promise<BotReply | null> {
  const { groupId, userId, displayName, text, mentionees } = ctx
  const trimmed = text.trim()

  // Repayment — check before proxy so it isn't parsed as an expense
  if (trimmed.startsWith('還款') || trimmed.startsWith('付清')) {
    return handlePayment(groupId, userId, displayName, trimmed, mentionees)
  }
  if (trimmed === '付款紀錄' || trimmed === '還款紀錄') return handleListPayments(groupId)

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
    return handleNewTrip(groupId, userId, displayName, trimmed, mentionees)
  }
  if (trimmed.startsWith('成員') || trimmed.startsWith('新增成員')) {
    return handleAddMembers(groupId, mentionees)
  }
  if (trimmed.startsWith('記帳') || trimmed.startsWith('新增消費')) {
    return handleAddExpense({ groupId, userId, payerName: displayName, raw: trimmed.replace(/^(記帳|新增消費)\s*/, ''), isProxy: false, mentionees })
  }
  if (trimmed.startsWith('設定貨幣')) return handleSetCurrency(groupId, trimmed)
  if (trimmed === '查帳' || trimmed === '消費清單') return handleListExpenses(groupId)
  if (trimmed === '我的帳' || trimmed === '我的餘額') return handleMyBalance(groupId, userId, displayName)
  if (trimmed === '結算') return handleSettle(groupId)
  if (trimmed === '結束旅程' || trimmed === '重置') return handleEndTrip(groupId)
  const delMatch = trimmed.match(/^刪除\s+(\d+)$/)
  if (delMatch) return handleDeleteByIndex(groupId, parseInt(delMatch[1], 10))
  if (trimmed === '刪除最後一筆' || trimmed === '刪除') return handleDeleteLast(groupId)
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

// Split an integer total into n shares that sum exactly to total.
// The remainder is handed out one unit at a time to the first members.
function splitEvenly(total: number, n: number): number[] {
  if (n <= 0) return []
  const base = Math.floor(total / n)
  let remainder = total - base * n
  const result: number[] = []
  for (let k = 0; k < n; k++) {
    result.push(base + (remainder > 0 ? 1 : 0))
    if (remainder > 0) remainder--
  }
  return result
}

// Distribute an integer total proportionally by shares, summing exactly to
// total (largest-fraction method for the leftover units).
function distributeByShares(total: number, shares: number[]): number[] {
  const totalShares = shares.reduce((a, b) => a + b, 0)
  if (totalShares <= 0) return shares.map(() => 0)
  const raw = shares.map(s => (total * s) / totalShares)
  const floored = raw.map(r => Math.floor(r))
  let remainder = total - floored.reduce((a, b) => a + b, 0)
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac)
  let k = 0
  while (remainder > 0 && k < order.length) {
    floored[order[k].i]++
    remainder--
    k++
  }
  return floored
}

// Register all @mentioned users (real LINE userIds) as members of a trip.
async function registerMentionees(
  tripId: string, groupId: string, mentionees: string[], alreadySeen: Set<string>
): Promise<Array<{ id: string; name: string }>> {
  const added: Array<{ id: string; name: string }> = []
  for (const uid of mentionees) {
    if (alreadySeen.has(uid)) continue
    alreadySeen.add(uid)
    const prof = await getGroupMemberProfile(groupId, uid)
    const memberName = prof?.displayName ?? uid
    await ensureMember(tripId, uid, memberName)
    added.push({ id: uid, name: memberName })
  }
  return added
}

async function getPayments(tripId: string): Promise<Payment[]> {
  const { data } = await supabase.from('payments').select('*').eq('trip_id', tripId)
  return (data ?? []).map(p => ({
    id: p.id, tripId: p.trip_id, fromLineId: p.from_line_id, fromName: p.from_name,
    toLineId: p.to_line_id, toName: p.to_name, amount: Number(p.amount), createdAt: p.created_at,
  }))
}

async function getFormattedExpenses(tripId: string): Promise<Expense[]> {
  const { data } = await supabase
    .from('expenses').select('*, expense_splits(*)').eq('trip_id', tripId)
  return (data ?? []).map(e => ({
    id: e.id, tripId: e.trip_id, payerLineId: e.payer_line_id, payerName: e.payer_name,
    amount: Number(e.amount), description: e.description, splitType: e.split_type,
    createdAt: e.created_at,
    splits: (e.expense_splits ?? []).map((s: { id: string; expense_id: string; user_line_id: string; user_name: string; amount: string }) => ({
      id: s.id, expenseId: s.expense_id, userLineId: s.user_line_id,
      userName: s.user_name, amount: Number(s.amount),
    })),
  }))
}

async function buildSettlementReply(trip: { id: string; name: string }): Promise<BotReply> {
  const expenses = await getFormattedExpenses(trip.id)
  if (expenses.length === 0) return { text: '尚無消費紀錄', quickReply: QR_MAIN }

  const payments = await getPayments(trip.id)
  const settlements = calculateSettlement(expenses, payments)
  const liffId = process.env.LIFF_ID
  const liffLink = liffId ? `\n\n📊 查看完整明細\nhttps://liff.line.me/${liffId}/expense/${trip.id}` : ''
  const paidNote = payments.length > 0 ? `（已含 ${payments.length} 筆還款）\n` : ''

  if (settlements.length === 0) {
    return { text: `✅ 大家都平衡了，不需要轉帳！\n${paidNote}${liffLink}`, quickReply: QR_AFTER_SETTLE }
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
    text: `💰 結算結果\n旅程：${trip.name}\n${paidNote}\n${list}\n\n💡 還款後輸入「還款 @對方」可更新結算${liffLink}`,
    quickReply: QR_AFTER_SETTLE,
  }
}

async function handleNewTrip(
  groupId: string, userId: string, displayName: string,
  text: string, mentionees: string[]
): Promise<BotReply> {
  const raw = text.replace(/^(新增旅程|開始分帳)\s*/, '').trim()
  if (!raw) return { text: '請輸入旅程名稱，例如：新增旅程 沖繩 @小明 @阿華' }

  const beforeMentions = raw.split('@')[0].trim()
  const nameParts = beforeMentions.split(/\s+/).filter(Boolean)
  let currency = 'TWD'
  let name = beforeMentions
  if (nameParts.length > 1 && isCurrency(nameParts[nameParts.length - 1].toUpperCase())) {
    currency = nameParts[nameParts.length - 1].toUpperCase()
    name = nameParts.slice(0, -1).join(' ')
  }
  if (!name) name = '旅程'

  const { data, error } = await supabase
    .from('trips')
    .insert({ name, line_group_id: groupId, status: 'active', created_by: userId, currency })
    .select().single()

  if (error || !data) return { text: '建立旅程失敗，請稍後再試' }

  const seen = new Set<string>([userId])
  await ensureMember(data.id, userId, displayName)
  const roster: Array<{ id: string; name: string }> = [{ id: userId, name: displayName }]
  const added = await registerMentionees(data.id, groupId, mentionees, seen)
  roster.push(...added)

  if (mentionees.length === 0) {
    syncGroupMembers(groupId, data.id).catch(() => null)
  }

  const dupes = buildDupeSet(roster)
  const rosterText = roster.map(m => tagName(m.id, m.name, dupes)).join('、')
  const currencyNote = currency !== 'TWD' ? `\n💱 預設貨幣：${currency}（結算自動換算為 TWD）` : ''
  const memberNote = mentionees.length > 0
    ? `\n👥 成員（${roster.length}）：${rosterText}`
    : `\n👥 尚未設定其他成員\n請用「成員 @A @B」加入一起分帳的人`

  return {
    text: `✅ 已建立旅程：${data.name}${currencyNote}${memberNote}`,
    quickReply: QR_NEW_TRIP,
  }
}

async function handleAddMembers(groupId: string, mentionees: string[]): Promise<BotReply> {
  const trip = await getActiveTrip(groupId)
  if (!trip) return { text: '目前沒有進行中的旅程，請先「新增旅程」' }
  if (mentionees.length === 0) return { text: '請 @ 要加入的成員，例如：成員 @小明 @阿華' }

  await registerMentionees(trip.id, groupId, mentionees, new Set<string>())

  const { data: members } = await supabase
    .from('trip_members').select('user_line_id, user_name').eq('trip_id', trip.id)
  const roster = (members ?? []).map(m => ({ id: m.user_line_id, name: m.user_name }))
  const dupes = buildDupeSet(roster)
  const rosterText = roster.map(m => tagName(m.id, m.name, dupes)).join('、')

  return {
    text: `✅ 已更新成員\n👥 目前成員（${roster.length}）：${rosterText}`,
    quickReply: QR_MAIN,
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
  let rest = parts.slice(descStart + 1)

  // Exclude-payer keyword
  let excludePayer = false
  rest = rest.filter(t => {
    if (t === '不含我' || t === '-我' || t === '不含付款人') { excludePayer = true; return false }
    return true
  })

  const shareRe = /^(.+)\*([0-9]+(?:\.[0-9]+)?)$/
  const isShareSplit = rest.some(t => shareRe.test(t))
  const isCustomSplit = !isShareSplit && rest.some(t => t.includes(':'))
  const isMentionSplit = !isShareSplit && !isCustomSplit && (rest.some(t => t.startsWith('@')) || mentionees.length > 0)

  const { twd, rate } = await convertToTWD(amount, inputCurrency)
  const totalTwd = Math.round(twd)
  const conversionNote = inputCurrency !== 'TWD'
    ? `\n   ${currencySymbol(inputCurrency)}${amount} ≈ $${totalTwd} TWD（匯率 ${rate}）`
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

  if (isShareSplit) {
    // 廷瑞*2 小明*1 — proportional by shares
    const entries: { userLineId: string; userName: string; share: number }[] = []
    for (const t of rest) {
      const m = t.match(shareRe)
      if (!m) continue
      const name = m[1]
      const share = parseFloat(m[2])
      if (!name || isNaN(share) || share <= 0) continue
      const resolved = await resolveNameToId(trip.id, name)
      entries.push({ userLineId: resolved.userId, userName: resolved.userName, share })
    }
    if (entries.length === 0) return { text: FORMAT_ERROR }
    const amounts = distributeByShares(totalTwd, entries.map(e => e.share))
    splits = entries.map((e, idx) => ({ userLineId: e.userLineId, userName: e.userName, amount: amounts[idx] }))
  } else if (isCustomSplit) {
    // 小明:400 小花:500 — absolute amounts
    let total = 0
    for (const part of rest) {
      const colonIdx = part.lastIndexOf(':')
      if (colonIdx === -1) continue
      const name = part.slice(0, colonIdx)
      const amt = Math.round(parseFloat(part.slice(colonIdx + 1)))
      if (!name || isNaN(amt)) continue
      const resolved = await resolveNameToId(trip.id, name)
      splits.push({ userLineId: resolved.userId, userName: resolved.userName, amount: amt })
      total += amt
    }
    if (splits.length === 0) return { text: FORMAT_ERROR }
    if (Math.abs(total - totalTwd) > 1) {
      return { text: `分攤金額加總 $${total} 與消費 $${totalTwd} TWD 不符，請確認` }
    }
  } else if (isMentionSplit) {
    let targets: { userLineId: string; userName: string }[] = []
    if (mentionees.length > 0) {
      targets = await Promise.all(
        mentionees.map(async uid => ({
          userLineId: uid,
          userName: await resolveIdToName(trip.id, uid, groupId),
        }))
      )
    } else {
      const names = rest.filter(t => t.startsWith('@')).map(t => t.slice(1))
      targets = await Promise.all(
        names.map(async name => {
          const resolved = await resolveNameToId(trip.id, name)
          return { userLineId: resolved.userId, userName: resolved.userName }
        })
      )
    }
    const amounts = splitEvenly(totalTwd, targets.length)
    splits = targets.map((t, idx) => ({ userLineId: t.userLineId, userName: t.userName, amount: amounts[idx] }))
  } else {
    // Equal split among all members (optionally excluding the payer)
    const members = await getTripMembers(trip.id, groupId)
    let memberList = members.length > 0
      ? members.map(m => ({ user_line_id: m.user_line_id, user_name: m.user_name }))
      : [{ user_line_id: payerLineId, user_name: resolvedPayerName }]
    if (excludePayer) {
      const filtered = memberList.filter(m => m.user_line_id !== payerLineId)
      if (filtered.length > 0) memberList = filtered
    }
    const amounts = splitEvenly(totalTwd, memberList.length)
    splits = memberList.map((m, idx) => ({ userLineId: m.user_line_id, userName: m.user_name, amount: amounts[idx] }))
  }

  const { data: expense, error } = await supabase
    .from('expenses')
    .insert({
      trip_id: trip.id,
      payer_line_id: payerLineId,
      payer_name: resolvedPayerName,
      amount: totalTwd,
      description,
      split_type: (isCustomSplit || isShareSplit) ? 'custom' : 'equal',
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
  const excludeNote = excludePayer ? '（不含付款人）' : ''
  const payerLabel = isProxy ? `代為 ${resolvedPayerName} 記帳` : `${resolvedPayerName} 付了`
  return {
    text: `✅ 已記錄消費\n💰 ${payerLabel} ${currencySymbol(inputCurrency)}${amount}（${description}）${conversionNote}\n\n分攤（TWD）${excludeNote}：\n${splitSummary}`,
    quickReply: QR_MAIN,
  }
}

async function handlePayment(
  groupId: string, userId: string, displayName: string,
  text: string, mentionees: string[]
): Promise<BotReply> {
  const trip = await getActiveTrip(groupId)
  if (!trip) return { text: '目前沒有進行中的旅程' }
  if (mentionees.length === 0) {
    return { text: '請 @ 你要還款的對象，例如：還款 @小明 500（不填金額則還清應付）' }
  }

  const payeeId = mentionees[0]
  await ensureMember(trip.id, userId, displayName)
  const payeeName = await resolveIdToName(trip.id, payeeId, groupId)

  const tokens = text.replace(/^(還款|付清)\s*/, '').trim().split(/\s+/)
  const amtTok = tokens.find(t => /^\d+(\.\d+)?$/.test(t))
  let amount = amtTok ? Math.round(parseFloat(amtTok)) : 0

  if (!amtTok) {
    const expenses = await getFormattedExpenses(trip.id)
    const payments = await getPayments(trip.id)
    const settlements = calculateSettlement(expenses, payments)
    const owed = settlements.find(s => s.from === userId && s.to === payeeId)
    if (!owed) return { text: `你目前不需要還款給 ${payeeName} 👍`, quickReply: QR_AFTER_SETTLE }
    amount = owed.amount
  }
  if (amount <= 0) return { text: '還款金額需大於 0' }

  const { error } = await supabase.from('payments').insert({
    trip_id: trip.id,
    from_line_id: userId, from_name: displayName,
    to_line_id: payeeId, to_name: payeeName,
    amount,
  })
  if (error) {
    return { text: '記錄還款失敗，可能是 payments 資料表尚未建立。請先在 Supabase SQL Editor 執行更新後的 schema。' }
  }

  const reply = await buildSettlementReply(trip)
  return {
    text: `✅ 已記錄還款\n💸 ${displayName} → ${payeeName} $${amount} TWD\n\n${reply.text}`,
    quickReply: QR_AFTER_SETTLE,
  }
}

async function handleListPayments(groupId: string): Promise<BotReply> {
  const trip = await getActiveTrip(groupId)
  if (!trip) return { text: '目前沒有進行中的旅程' }
  const payments = await getPayments(trip.id)
  if (payments.length === 0) return { text: '目前沒有還款紀錄', quickReply: QR_MAIN }

  const pairs = payments.reduce<Array<{ id: string; name: string }>>((acc, p) => {
    acc.push({ id: p.fromLineId, name: p.fromName })
    acc.push({ id: p.toLineId, name: p.toName })
    return acc
  }, [])
  const dupes = buildDupeSet(pairs)
  const list = payments.map((p, i) =>
    `${i + 1}. ${tagName(p.fromLineId, p.fromName, dupes)} → ${tagName(p.toLineId, p.toName, dupes)} $${p.amount} TWD`
  ).join('\n')

  return { text: `💸 還款紀錄（${payments.length}）\n\n${list}`, quickReply: QR_MAIN }
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
    text: `📋 旅程：${trip.name}\n💱 貨幣：${trip.currency ?? 'TWD'}\n\n${list}\n\n合計：$${total} TWD\n\n🗑 刪除某筆：輸入「刪除 編號」`,
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

  const payments = await getPayments(trip.id)
  let balance = paid - shouldPay
  for (const p of payments) {
    if (p.fromLineId === userId) balance += p.amount
    if (p.toLineId === userId) balance -= p.amount
  }

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
  return buildSettlementReply(trip)
}

async function handleEndTrip(groupId: string): Promise<BotReply> {
  const trip = await getActiveTrip(groupId)
  if (!trip) return { text: '目前沒有進行中的旅程' }
  const { error } = await supabase.from('trips').update({ status: 'settled' }).eq('id', trip.id)
  if (error) return { text: '結束旅程失敗，請稍後再試' }
  return {
    text: `🏁 旅程「${trip.name}」已結束\n\n輸入「新增旅程 名稱 @成員」可以開始新的分帳`,
    quickReply: QR_NEW_AFTER_END,
  }
}

async function handleDeleteLast(groupId: string): Promise<BotReply> {
  const trip = await getActiveTrip(groupId)
  if (!trip) return { text: '目前沒有進行中的旅程' }
  const { data: last, error: fetchError } = await supabase
    .from('expenses').select('*').eq('trip_id', trip.id)
    .order('created_at', { ascending: false }).limit(1).single()
  if (fetchError || !last) return { text: '目前沒有可刪除的消費紀錄' }
  await supabase.from('expense_splits').delete().eq('expense_id', last.id)
  const { error } = await supabase.from('expenses').delete().eq('id', last.id)
  if (error) return { text: '刪除失敗，請稍後再試' }
  return {
    text: `🗑 已刪除最後一筆\n${last.payer_name} 付 $${last.amount}（${last.description}）`,
    quickReply: QR_MAIN,
  }
}

async function handleDeleteByIndex(groupId: string, index: number): Promise<BotReply> {
  const trip = await getActiveTrip(groupId)
  if (!trip) return { text: '目前沒有進行中的旅程' }
  const { data: expenses } = await supabase
    .from('expenses').select('*').eq('trip_id', trip.id).order('created_at', { ascending: true })
  if (!expenses || expenses.length === 0) return { text: '目前沒有可刪除的消費紀錄' }
  if (index < 1 || index > expenses.length) {
    return { text: `找不到第 ${index} 筆，目前共 ${expenses.length} 筆，可先「查帳」確認編號` }
  }
  const target = expenses[index - 1]
  await supabase.from('expense_splits').delete().eq('expense_id', target.id)
  const { error } = await supabase.from('expenses').delete().eq('id', target.id)
  if (error) return { text: '刪除失敗，請稍後再試' }
  return {
    text: `🗑 已刪除第 ${index} 筆\n${target.payer_name} 付 $${target.amount}（${target.description}）`,
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
• 記帳 1200 晚餐 不含我
• 記帳 1200 晚餐 廷瑞*2 小明*1
• 幫小明記帳 800 交通
• 小明付了 1200 晚餐`

const HELP_TEXT = `📖 分帳機器人指令

🆕 新增旅程 [名稱] [貨幣] @成員...
   例：新增旅程 沖繩 JPY @小明 @阿華
   （建立時 @ 到所有一起分帳的人）

👥 成員 @A @B
   中途補加成員

💰 記帳 [金額] [貨幣] [說明]
   例：記帳 5000 JPY 晚餐（預設全員均分）

進階分攤：
   • 記帳 1200 晚餐 不含我（付款人不分攤）
   • 記帳 1200 晚餐 廷瑞*2 小明*1（按份數）
   • 記帳 1200 晚餐 廷瑞:800 小明:400（指定金額）
   • 記帳 1200 晚餐 @小明 @阿華（只分給被 @ 的人）

👨 幫[NAME]記帳 [金額] [說明]
   [NAME]付了 [金額] [說明]

💸 還款 @對方 [金額]
   記錄還款（不填金額＝還清應付）
💸 還款紀錄

💱 設定貨幣 JPY
📋 查帳 | 👤 我的帳 | 🏦 結算
🗑 刪除 [編號] | 刪除最後一筆
🏁 結束旅程`
