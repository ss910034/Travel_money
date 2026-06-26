const CURRENCIES = ['TWD', 'JPY', 'USD', 'EUR', 'KRW', 'HKD', 'SGD', 'GBP', 'AUD', 'THB', 'CNY', 'MYR', 'VND']

const SYMBOLS: Record<string, string> = {
  TWD: '$', JPY: '¥', USD: 'US$', EUR: '€', KRW: '₩',
  HKD: 'HK$', SGD: 'S$', GBP: '£', AUD: 'A$', THB: '฿', CNY: '¥', MYR: 'RM', VND: '₫',
}

export function isCurrency(str: string): boolean {
  return CURRENCIES.includes(str.toUpperCase())
}

export function currencySymbol(code: string): string {
  return SYMBOLS[code.toUpperCase()] ?? code
}

export async function convertToTWD(amount: number, from: string): Promise<{ twd: number; rate: number }> {
  if (from === 'TWD') return { twd: amount, rate: 1 }

  try {
    const res = await fetch(
      `https://api.frankfurter.app/latest?amount=${amount}&from=${from.toUpperCase()}&to=TWD`
    )
    const data = await res.json()
    const twd = Math.round(data.rates?.TWD ?? amount)
    const rate = Math.round((twd / amount) * 1000) / 1000
    return { twd, rate }
  } catch {
    return { twd: amount, rate: 1 }
  }
}
