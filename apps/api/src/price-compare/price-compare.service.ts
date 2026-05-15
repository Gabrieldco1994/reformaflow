import { Injectable, Logger } from '@nestjs/common';

export interface PriceResult {
  title: string;
  price: number | null;
  currency: string;
  store: string;
  link: string;
  image?: string;
}

@Injectable()
export class PriceCompareService {
  private readonly logger = new Logger(PriceCompareService.name);
  private cache = new Map<string, { results: PriceResult[]; timestamp: number }>();
  private readonly CACHE_TTL = 24 * 60 * 60 * 1000; // 24h

  async searchPrices(query: string): Promise<PriceResult[]> {
    const cacheKey = query.toLowerCase().trim();
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      return cached.results;
    }

    try {
      const results = await this.searchBuscape(query);
      this.cache.set(cacheKey, { results, timestamp: Date.now() });
      return results;
    } catch (error) {
      this.logger.error(`Price search failed: ${error}`);
      return [];
    }
  }

  private async searchBuscape(query: string): Promise<PriceResult[]> {
    const cleanedQuery = this.cleanQuery(query);
    const url = `https://www.buscape.com.br/search?q=${encodeURIComponent(cleanedQuery)}`;

    const response = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'pt-BR,pt;q=0.9',
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      this.logger.warn(`Buscapé returned ${response.status}`);
      return [];
    }

    const html = await response.text();
    return this.parseBuscapeHtml(html);
  }

  private parseBuscapeHtml(html: string): PriceResult[] {
    // Buscapé uses Next.js — product data lives in __NEXT_DATA__ JSON
    const nextDataMatch = html.match(
      /id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/,
    );
    if (!nextDataMatch) {
      this.logger.warn('Could not find __NEXT_DATA__ in Buscapé response');
      return this.parseBuscapeHtmlFallback(html);
    }

    try {
      const data = JSON.parse(nextDataMatch[1]);
      const hits =
        data?.props?.initialReduxState?.hits?.hits as BuscapeHit[] | undefined;
      if (!hits || !Array.isArray(hits)) {
        this.logger.warn('No hits found in Buscapé __NEXT_DATA__');
        return this.parseBuscapeHtmlFallback(html);
      }

      const products: PriceResult[] = [];
      const seen = new Set<string>();

      for (const hit of hits) {
        const title = hit.name;
        if (!title || seen.has(title)) continue;
        seen.add(title);

        const price =
          typeof hit.price === 'number'
            ? hit.price
            : this.parsePrice(`${hit.price}`);

        const link = hit.url
          ? hit.url.startsWith('http')
            ? hit.url
            : `https://www.buscape.com.br${hit.url}`
          : '';

        products.push({
          title: title.slice(0, 120),
          price,
          currency: 'BRL',
          store: hit.merchantName || '',
          link,
          image: hit.image || undefined,
        });

        if (products.length >= 20) break;
      }

      return products;
    } catch (error) {
      this.logger.error(`Failed to parse Buscapé JSON: ${error}`);
      return this.parseBuscapeHtmlFallback(html);
    }
  }

  /** Regex fallback if __NEXT_DATA__ structure changes */
  private parseBuscapeHtmlFallback(html: string): PriceResult[] {
    const priceMatches = [...html.matchAll(/R\$\s*[\d.,]+/g)];
    const products: PriceResult[] = [];
    const seen = new Set<string>();

    for (const pm of priceMatches) {
      const pos = pm.index!;
      const priceStr = pm[0];
      const chunkBefore = html.slice(Math.max(0, pos - 800), pos);

      const titles = [...chunkBefore.matchAll(/title="([^"]{10,150})"/g)];
      const title =
        titles.length > 0 ? this.decodeHtml(titles[titles.length - 1][1]) : null;
      if (!title || seen.has(title)) continue;
      seen.add(title);

      const links = [...chunkBefore.matchAll(/href="(https?:\/\/[^"]+)"/g)];
      const link = links.length > 0 ? links[links.length - 1][1] : '';
      const price = this.parsePrice(priceStr);

      products.push({
        title: title.slice(0, 120),
        price,
        currency: 'BRL',
        store: this.extractStoreFromLink(link),
        link,
      });

      if (products.length >= 20) break;
    }

    return products;
  }

  private cleanQuery(query: string): string {
    return query
      .replace(/comprar|promoção|oferta|barato|melhor preço|frete grátis/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private parsePrice(priceStr: string): number | null {
    const cleaned = priceStr
      .replace(/R\$\s*/, '')
      .replace(/\./g, '')
      .replace(',', '.');
    const num = parseFloat(cleaned);
    return isNaN(num) ? null : num;
  }

  private decodeHtml(str: string): string {
    return str
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/&#x27;/g, "'")
      .replace(/&#x2F;/g, '/')
      .replace(/&hellip;/g, '…');
  }

  private extractStoreFromLink(link: string): string {
    try {
      const host = new URL(link).hostname.replace(/^www\./, '');
      const storeMap: Record<string, string> = {
        'casasbahia.com.br': 'Casas Bahia',
        'amazon.com.br': 'Amazon',
        'mercadolivre.com.br': 'Mercado Livre',
        'magazineluiza.com.br': 'Magazine Luiza',
        'leroymerlin.com.br': 'Leroy Merlin',
        'telhanorte.com.br': 'Telhanorte',
        'pontofrio.com.br': 'Ponto Frio',
        'extra.com.br': 'Extra',
        'americanas.com.br': 'Americanas',
        'shopee.com.br': 'Shopee',
        'kabum.com.br': 'KaBuM!',
        'madeiramadeira.com.br': 'MadeiraMadeira',
      };
      return storeMap[host] || host;
    } catch {
      return '';
    }
  }
}

interface BuscapeHit {
  name?: string;
  price?: number;
  url?: string;
  merchantName?: string;
  image?: string;
}

