import type { Metadata, Viewport } from 'next';
import { Cormorant_Garamond, Jost } from 'next/font/google';
import { SpeedInsights } from '@vercel/speed-insights/next';
import './globals.css';
import { Providers } from '@/lib/providers';
import { Toaster } from 'sonner';

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

export const metadata: Metadata = {
  title: 'LifeOne — SaaS de gestão Financeira e Vida',
  description: 'Gestão financeira e de vida: controle seus projetos, contas, metas e o dia a dia em um só lugar',
  icons: {
    icon: '/lifeone-mark.svg',
    shortcut: '/lifeone-mark.svg',
    apple: '/lifeone-mark.svg',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
  viewportFit: 'cover',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="pt-BR" className={`${jost.variable} ${cormorant.variable}`}>
      <head>
        {/* LifeOne design system — Geist + Material Symbols (loaded via Google Fonts,
            per design handoff). Exposed as the `font-geist` Tailwind family; opted
            into by re-skinned hi-fi screens during the LifeOne migration. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700;800&display=swap"
        />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Material+Symbols+Rounded:opsz,wght,FILL,GRAD@20..48,300,0,0&display=swap"
        />
      </head>
      <body className={jost.className}>
        <Providers>
          <Toaster richColors position="top-right" />
          {children}
        </Providers>
        <SpeedInsights />
      </body>
    </html>
  );
}
