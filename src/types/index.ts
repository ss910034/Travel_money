export interface LineUser {
  lineUserId: string
  displayName: string
  pictureUrl?: string
}

export interface Trip {
  id: string
  name: string
  lineGroupId: string
  status: 'active' | 'settled'
  createdBy: string
  createdAt: string
}

export interface ExpenseSplit {
  id: string
  expenseId: string
  userLineId: string
  userName: string
  amount: number
}

export interface Expense {
  id: string
  tripId: string
  payerLineId: string
  payerName: string
  amount: number
  description: string
  splitType: 'equal' | 'custom'
  createdAt: string
  splits: ExpenseSplit[]
}

export interface Payment {
  id: string
  tripId: string
  fromLineId: string
  fromName: string
  toLineId: string
  toName: string
  amount: number
  createdAt: string
}

export interface Settlement {
  from: string
  fromName: string
  to: string
  toName: string
  amount: number
}
