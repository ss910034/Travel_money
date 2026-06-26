import type { Metadata } from 'next'
export const metadata: Metadata = { title: 'Travel Money', description: 'LINE group expense splitter' }
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-TW">
      <body>{children}</body>
    </html>
  )
}
