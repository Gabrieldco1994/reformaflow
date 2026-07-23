import type { Metadata, Viewport } from 'next';
import { Cormorant_Garamond, Inter, Jost } from 'next/font/google';
import { GeistSans } from 'geist/font/sans';
import { SpeedInsights } from '@vercel/speed-insights/next';
import './globals.css';
import { Providers } from '@/lib/providers';
import { Toaster } from 'sonner';
import { ClarityInit } from './_components/ClarityInit';

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
    icon: '/lifeone-mark.svg',
    shortcut: '/lifeone-mark.svg',
    apple: '/lifeone-mark.svg',
  },
  manifest: '/manifest.json',
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
      <head>
        {/* Material Symbols (ícones) via Google Fonts. O Geist agora vem do
            pacote `geist` (next/font/local) para eliminar o CLS de troca de fonte. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Material+Symbols+Rounded:opsz,wght,FILL,GRAD@20..48,300,0,0&display=swap"
        />
      </head>
      <body className={jost.className}>
        <ClarityInit />
        <Providers>
          <Toaster richColors position="top-right" />
          {children}
        </Providers>
        <SpeedInsights />
      </body>
    </html>
  );
}
