import type { Metadata } from 'next'
import { GeistSans } from 'geist/font/sans'
import './globals.css'

export const metadata: Metadata = {
  title: 'Aplicativo criado no DZ23 STUDIO',
  description: 'Protótipo verificável criado pelo DZ23 STUDIO.',
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="pt-BR"><body className={GeistSans.className}>{children}</body></html>
}
