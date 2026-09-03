import type { Metadata } from 'next'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import localFont from 'next/font/local'
import appContent from '../content/app.json'
import './globals.css'

const dz23Sans = localFont({
  src: '../node_modules/geist/dist/fonts/geist-sans/Geist-Variable.woff2',
  variable: '--font-dz23-sans',
  weight: '100 900',
  display: 'swap',
})
const dz23Serif = localFont({
  src: '../node_modules/@fontsource-variable/source-serif-4/files/source-serif-4-latin-wght-normal.woff2',
  variable: '--font-dz23-serif',
  weight: '200 900',
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'Aplicativo criado no DZ23 STUDIO',
  description: 'Protótipo verificável criado pelo DZ23 STUDIO.',
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const hasBrandLogo = existsSync(resolve(process.cwd(), 'public', 'brand', 'logo.png'))
  return <html lang="pt-BR"><body className={`${dz23Sans.variable} ${dz23Serif.variable}`}>
    {hasBrandLogo ? <header aria-label="Marca do aplicativo"><img src="/brand/logo.png" alt={`Logotipo de ${appContent.title}`} /></header> : null}
    {children}
  </body></html>
}
