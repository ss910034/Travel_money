import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

export async function GET(
  _req: NextRequest,
  { params }: { params: { tripId: string } }
) {
  const { data, error } = await supabase
    .from('expenses')
    .select('*, expense_splits(*)')
    .eq('trip_id', params.tripId)
    .order('created_at', { ascending: true })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}
