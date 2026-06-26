import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { calculateSettlement } from '@/lib/settlement'
import type { Expense } from '@/types'

export async function GET(
  _req: NextRequest,
  { params }: { params: { tripId: string } }
) {
  const { data: rows, error } = await supabase
    .from('expenses')
    .select('*, expense_splits(*)')
    .eq('trip_id', params.tripId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const expenses: Expense[] = (rows ?? []).map(e => ({
    id: e.id,
    tripId: e.trip_id,
    payerLineId: e.payer_line_id,
    payerName: e.payer_name,
    amount: Number(e.amount),
    description: e.description,
    splitType: e.split_type,
    createdAt: e.created_at,
    splits: (e.expense_splits ?? []).map((s: {
      id: string
      expense_id: string
      user_line_id: string
      user_name: string
      amount: string
    }) => ({
      id: s.id,
      expenseId: s.expense_id,
      userLineId: s.user_line_id,
      userName: s.user_name,
      amount: Number(s.amount),
    })),
  }))

  return NextResponse.json(calculateSettlement(expenses))
}
