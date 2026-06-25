import { supabase } from './supabase'
import { calculateSettlement } from './settlement'
import type { Expense } from '@/types'

interface CommandContext {
  groupId: string
  userId: string
  displayName: string
  text: string
}

export async function handleCommand(ctx: CommandContext): Promise<string> {
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
  if (trimmed === '幫助' || trimmed === 'help' || trimmed === '說明') {
    return HELP_TEXT
  }
  return ''
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
): Promise<string> {
  const name = text.replace(/^(新增旅程|開始分帳)\s*/, '').trim()
  if (!name) return '請輸入旅程名稱，例如：新增旅程 沖繩五天'

  const { data, error } = await supabase
    .from('trips')
    .insert({ name, line_group_id: groupId, status: 'active', created_by: userId })
    .select()
    .single()

  if (error || !data) return '建立旅程失敗，請稍後再試'

  await ensureMember(data.id, userId, displayName)
  return `✅ 已建立旅程：${data.name}\n\n輸入「記帳 金額 說明」來新增消費\n輸入「幫助」查看所有指令`
}

async function handleAddExpense(
  groupId: string,
  userId: string,
  displayName: string,
  text: string
): Promise<string> {
  const trip = await getActiveTrip(groupId)
  if (!trip) return '目前沒有進行中的旅程，請先輸入「新增旅程 旅程名稱」'

  const raw = text.replace(/^(記帳|新增消費)\s*/, '').trim()
  const parts = raw.split(/\s+/)
  if (parts.length < 2) return FORMAT_ERROR

  const amount = parseFloat(parts[0])
  if (isNaN(amount) || amount <= 0) return '金額格式錯誤，請輸入正確數字'

  const description = parts[1]
  const rest = parts.slice(2)
  const isCustomSplit = rest.some(p => p.includes(':'))
  const isMentionSplit = rest.some(p => p.startsWith('@'))

  await ensureMember(trip.id, userId, displayName)

  let splits: { userLineId: string; userName: string; amount: number }[] = []

  if (isCustomSplit) {
    // 小明:200 小花:300
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
    if (splits.length === 0) return FORMAT_ERROR
    if (Math.abs(total - amount) > 0.5) {
      return `分攤金額加總 $${total} 與消費金額 $${amount} 不符，請確認`
    }
  } else if (isMentionSplit) {
    // @小明 @小花 — equal split among mentioned only
    const names = rest.filter(p => p.startsWith('@')).map(p => p.slice(1))
    if (names.length === 0) return FORMAT_ERROR
    const share = Math.round(amount / names.length)
    splits = names.map(name => ({ userLineId: name, userName: name, amount: share }))
  } else {
    // Equal split among all current trip members
    const { data: members } = await supabase
      .from('trip_members')
      .select('user_line_id, user_name')
      .eq('trip_id', trip.id)

    const memberList = members ?? [{ user_line_id: userId, user_name: displayName }]
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

  if (error || !expense) return '記帳失敗，請稍後再試'

  await supabase.from('expense_splits').insert(
    splits.map(s => ({
      expense_id: expense.id,
      user_line_id: s.userLineId,
      user_name: s.userName,
      amount: s.amount,
    }))
  )

  const splitSummary = splits.map(s => `  ${s.userName} $${s.amount}`).join('\n')
  return `✅ 已記錄消費\n💰 ${displayName} 付了 $${amount}（${description}）\n\n分攤：\n${splitSummary}`
}

async function handleListExpenses(groupId: string): Promise<string> {
  const trip = await getActiveTrip(groupId)
  if (!trip) return '目前沒有進行中的旅程'

  const { data: expenses } = await supabase
    .from('expenses')
    .select('*')
    .eq('trip_id', trip.id)
    .order('created_at', { ascending: true })

  if (!expenses || expenses.length === 0) return `旅程「${trip.name}」尚無消費紀錄`

  const total = expenses.reduce((sum, e) => sum + Number(e.amount), 0)
  const list = expenses
    .map((e, i) => `${i + 1}. ${e.payer_name} 付 $${e.amount}（${e.description}）`)
    .join('\n')

  return `📋 旅程：${trip.name}\n\n${list}\n\n合計：$${total}`
}

async function handleMyBalance(
  groupId: string,
  userId: string,
  displayName: string
): Promise<string> {
  const trip = await getActiveTrip(groupId)
  if (!trip) return '目前沒有進行中的旅程'

  await ensureMember(trip.id, userId, displayName)

  const { data: expenses } = await supabase
    .from('expenses')
    .select('*, expense_splits(*)')
    .eq('trip_id', trip.id)

  if (!expenses || expenses.length === 0) return '尚無消費紀錄'

  let paid = 0
  let shouldPay = 0

  for (const expense of expenses) {
    if (expense.payer_line_id === userId) paid += Number(expense.amount)
    const mySplit = expense.expense_splits?.find((s: { user_line_id: string; amount: string }) => s.user_line_id === userId)
    if (mySplit) shouldPay += Number(mySplit.amount)
  }

  const balance = paid - shouldPay
  const status =
    balance > 0.5
      ? `別人欠你 $${Math.round(balance)}`
      : balance < -0.5
      ? `你欠別人 $${Math.round(Math.abs(balance))}`
      : '剛好平衡 👍'

  return `👤 ${displayName} 的帳\n\n已付：$${paid}\n應付：$${shouldPay}\n餘額：${status}`
}

async function handleSettle(groupId: string): Promise<string> {
  const trip = await getActiveTrip(groupId)
  if (!trip) return '目前沒有進行中的旅程'

  const { data: expenses } = await supabase
    .from('expenses')
    .select('*, expense_splits(*)')
    .eq('trip_id', trip.id)

  if (!expenses || expenses.length === 0) return '尚無消費紀錄'

  const formatted: Expense[] = expenses.map(e => ({
    id: e.id,
    tripId: e.trip_id,
    payerLineId: e.payer_line_id,
    payerName: e.payer_name,
    amount: Number(e.amount),
    description: e.description,
    splitType: e.split_type,
    createdAt: e.created_at,
    splits: (e.expense_splits ?? []).map((s: { id: string; expense_id: string; user_line_id: string; user_name: string; amount: string }) => ({
      id: s.id,
      expenseId: s.expense_id,
      userLineId: s.user_line_id,
      userName: s.user_name,
      amount: Number(s.amount),
    })),
  }))

  const settlements = calculateSettlement(formatted)

  if (settlements.length === 0) return '✅ 大家都平衡了，不需要轉帳！'

  const list = settlements
    .map(s => `💸 ${s.fromName} → ${s.toName} $${s.amount}`)
    .join('\n')

  return `💰 結算結果\n旅程：${trip.name}\n\n${list}`
}

async function ensureMember(tripId: string, userId: string, userName: string) {
  await supabase
    .from('trip_members')
    .upsert({ trip_id: tripId, user_line_id: userId, user_name: userName }, { onConflict: 'trip_id,user_line_id' })
}

const FORMAT_ERROR = `格式錯誤，請參考：
• 記帳 500 晚餐（均分所有成員）
• 記帳 600 計程車 @小明 @小花（指定均分）
• 記帳 900 午餐 小明:400 小花:500（自訂金額）`

const HELP_TEXT = `📖 分帳機器人指令

🆕 新增旅程 [名稱]
   例：新增旅程 沖繩五天

💰 記帳 [金額] [說明]
   例：記帳 1200 晚餐

   指定分攤人（均分）：
   記帳 600 計程車 @小明 @小花

   自訂金額（不均分）：
   記帳 900 午餐 小明:400 小花:500

📋 查帳 — 查看所有消費
👤 我的帳 — 查看個人餘額
🏦 結算 — 計算最少轉帳方案`
