import type { Metadata, Viewport } from 'next';
import { Cormorant_Garamond, Jost } from 'next/font/google';
import './globals.css';
import { Providers } from '@/lib/providers';

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
  title: "D'arc Studio — Gestão de Projetos de Vida",
  description: 'Controle financeiro, manutenções e lembretes para seus projetos de vida',
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
      <body className={jost.className}>
        <Providers>
          {children}
        </Providers>
      </body>
    </html>
  );
}
