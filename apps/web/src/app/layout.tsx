import type { Metadata, Viewport } from 'next';
import { Cormorant_Garamond, Inter, Jost } from 'next/font/google';
import { GeistSans } from 'geist/font/sans';
import { SpeedInsights } from '@vercel/speed-insights/next';
import './globals.css';
import { Providers } from '@/lib/providers';
import { Toaster } from 'sonner';
import { ClarityInit } from './_components/ClarityInit';
import { ServiceWorkerInit } from './_components/ServiceWorkerInit';

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-minimal",
  display: "swap",
});

const jost = Jost({
  subsets: ['latin'],
  weight: ['300', '400', '500', '600'],
  variable: '--font-sans',
  display: 'swap',
});

const cormorant = Cormorant_Garamond({
  subsets: ['latin'],
  weight: ['300', '400', '500'],
  style: ['italic', 'normal'],
  variable: '--font-display',
  display: 'swap',
});

// Geist via pacote oficial `geist` (next/font/local): fontes bundladas +
// fallback com métricas ajustadas -> elimina o layout shift (CLS) que o
// <link> do Google Fonts causava ao trocar Jost -> Geist. Expõe --font-geist-sans.

export const metadata: Metadata = {
  title: 'LifeOne — SaaS de gestão Financeira e Vida',
  description: 'Gestão financeira e de vida: controle seus projetos, contas, metas e o dia a dia em um só lugar',
  icons: {
    // SVG primeiro (nítido em qualquer densidade) com PNGs de fallback: o
    // Safari não usa SVG como ícone de tela inicial.
    icon: [
      { url: '/lifeone-mark.svg', type: 'image/svg+xml' },
      { url: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    shortcut: '/icon-192.png',
    // O iOS ignora SVG aqui e cai num screenshot borrado da página. Precisa
    // ser PNG opaco e sangrando até a borda — o próprio iOS arredonda.
    apple: '/apple-touch-icon.png',
  },
  manifest: '/manifest.json',
  // Instalado na tela inicial: abre sem a barra do Safari e usa este nome
  // embaixo do ícone (sem isso, vira o <title> inteiro, que é comprido).
  appleWebApp: {
    capable: true,
    title: 'LifeOne',
    statusBarStyle: 'default',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
  viewportFit: 'cover',
  themeColor: '#eef0f3',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="pt-BR" className={`${jost.variable} ${cormorant.variable} ${inter.variable} ${GeistSans.variable}`}>
      <body className={jost.className}>
        <ClarityInit />
        <ServiceWorkerInit />
        <Providers>
          <Toaster richColors position="top-right" />
          {children}
        </Providers>
        <SpeedInsights />
      </body>
    </html>
  );
}
