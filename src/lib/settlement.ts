import type { Expense, Payment, Settlement } from '@/types'

export function calculateSettlement(expenses: Expense[], payments: Payment[] = []): Settlement[] {
  const balances: Record<string, { name: string; amount: number }> = {}

  for (const expense of expenses) {
    if (!balances[expense.payerLineId]) {
      balances[expense.payerLineId] = { name: expense.payerName, amount: 0 }
    }
    balances[expense.payerLineId].amount += expense.amount

    for (const split of expense.splits) {
      if (!balances[split.userLineId]) {
        balances[split.userLineId] = { name: split.userName, amount: 0 }
      }
      balances[split.userLineId].amount -= split.amount
    }
  }

  // A repayment from A to B reduces A's debt: A's balance rises, B's falls.
  for (const p of payments) {
    if (!balances[p.fromLineId]) balances[p.fromLineId] = { name: p.fromName, amount: 0 }
    if (!balances[p.toLineId]) balances[p.toLineId] = { name: p.toName, amount: 0 }
    balances[p.fromLineId].amount += p.amount
    balances[p.toLineId].amount -= p.amount
  }

  const creditors = Object.entries(balances)
    .filter(([, v]) => v.amount > 0.01)
    .map(([id, v]) => ({ id, name: v.name, amount: v.amount }))
    .sort((a, b) => b.amount - a.amount)

  const debtors = Object.entries(balances)
    .filter(([, v]) => v.amount < -0.01)
    .map(([id, v]) => ({ id, name: v.name, amount: v.amount }))
    .sort((a, b) => a.amount - b.amount)

  const transactions: Settlement[] = []
  let i = 0
  let j = 0

  while (i < creditors.length && j < debtors.length) {
    const creditor = creditors[i]
    const debtor = debtors[j]
    const amount = Math.min(creditor.amount, Math.abs(debtor.amount))

    transactions.push({
      from: debtor.id,
      fromName: debtor.name,
      to: creditor.id,
      toName: creditor.name,
      amount: Math.round(amount),
    })

    creditors[i].amount -= amount
    debtors[j].amount += amount

    if (creditors[i].amount < 0.01) i++
    if (Math.abs(debtors[j].amount) < 0.01) j++
  }

  return transactions.filter(t => t.amount > 0)
}
