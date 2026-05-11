import { Injectable, Logger } from '@nestjs/common';

export interface LinkPreviewResult {
  url: string;
  ogImage: string | null;
  ogTitle: string | null;
  ogDescription: string | null;
  favicon: string | null;
}

@Injectable()
export class LinkPreviewService {
  private readonly logger = new Logger(LinkPreviewService.name);
  private readonly cache = new Map<string, { data: LinkPreviewResult; ts: number }>();
  private readonly CACHE_TTL = 1000 * 60 * 60 * 24; // 24h

  async getPreview(url: string): Promise<LinkPreviewResult> {
    const cached = this.cache.get(url);
    if (cached && Date.now() - cached.ts < this.CACHE_TTL) {
      return cached.data;
    }

    const result = await this.fetchPreview(url);
    this.cache.set(url, { data: result, ts: Date.now() });
    return result;
  }

  private async fetchPreview(url: string): Promise<LinkPreviewResult> {
    const empty: LinkPreviewResult = { url, ogImage: null, ogTitle: null, ogDescription: null, favicon: null };

    // Always get favicon from Google's API (works for any site)
    let favicon: string | null = null;
    try {
      const u = new URL(url);
      favicon = `https://www.google.com/s2/favicons?domain=${u.hostname}&sz=64`;
    } catch {}

    // Known sites with predictable image CDN URLs
    const knownImage = await this.tryKnownSiteImage(url);
    if (knownImage) {
      return { url, ogImage: knownImage, ogTitle: null, ogDescription: null, favicon };
    }

    // Determine if site needs Googlebot UA (sites that block normal UA or return placeholders)
    const needsGooglebot = this.needsGooglebotUA(url);

    const html = await this.fetchHtml(url, needsGooglebot);
    if (!html) {
      const screenshotUrl = `https://image.thum.io/get/width/600/crop/400/${encodeURI(url)}`;
      return { url, ogImage: screenshotUrl, ogTitle: null, ogDescription: null, favicon };
    }

    // Detect error/block pages (WAF, CAPTCHA) — only if page is small and has no OG tags
    const hasOgTags = html.includes('og:image') || html.includes('og:title');
    const isBlocked = !hasOgTags && (
      html.includes('page-not-found') ||
      html.includes('Access Denied') ||
      html.includes('<body class="captcha') ||
      html.includes('captcha-delivery.com') ||
      html.length < 2000
    );

    if (isBlocked) {
      // If we haven't tried Googlebot yet, retry with it
      if (!needsGooglebot) {
        this.logger.warn(`Site blocked normal UA for ${url}, retrying with Googlebot`);
        const retryHtml = await this.fetchHtml(url, true);
        if (retryHtml && retryHtml.includes('og:image')) {
          return this.extractFromHtml(retryHtml, url, favicon);
        }
      }
      this.logger.warn(`Site blocked all fetch for ${url}, using screenshot fallback`);
      const screenshotUrl = `https://image.thum.io/get/width/600/crop/400/${encodeURI(url)}`;
      return { url, ogImage: screenshotUrl, ogTitle: null, ogDescription: null, favicon };
    }

    const result = this.extractFromHtml(html, url, favicon);

    // Detect placeholder images (1px transparent gif) and retry with Googlebot
    if (result.ogImage && this.isPlaceholderImage(result.ogImage) && !needsGooglebot) {
      this.logger.warn(`Placeholder image detected for ${url}, retrying with Googlebot`);
      const retryHtml = await this.fetchHtml(url, true);
      if (retryHtml) {
        const retryResult = this.extractFromHtml(retryHtml, url, favicon);
        if (retryResult.ogImage && !this.isPlaceholderImage(retryResult.ogImage)) {
          return retryResult;
        }
      }
    }

    // Final fallback: screenshot if no image or still placeholder
    if (!result.ogImage || this.isPlaceholderImage(result.ogImage)) {
      result.ogImage = `https://image.thum.io/get/width/600/crop/400/${encodeURI(url)}`;
    }

    return result;
  }

  /** Extract all metadata from HTML */
  private extractFromHtml(html: string, url: string, defaultFavicon: string | null): LinkPreviewResult {
    const ogImage =
      this.extractMeta(html, 'og:image') ||
      this.extractMeta(html, 'twitter:image') ||
      this.extractMeta(html, 'image') ||
      this.extractJsonLdImage(html);

    const ogTitle =
      this.extractMeta(html, 'og:title') ||
      this.extractMeta(html, 'twitter:title') ||
      this.extractTitle(html);

    const ogDescription =
      this.extractMeta(html, 'og:description') ||
      this.extractMeta(html, 'twitter:description') ||
      this.extractMeta(html, 'description');

    const pageFavicon = this.extractFavicon(html, url);
    let resolvedImage = ogImage ? this.resolveUrl(ogImage, url) : null;

    // Clean Amazon image URLs — remove rating/review overlay params
    if (resolvedImage && resolvedImage.includes('m.media-amazon.com')) {
      const cleanMatch = resolvedImage.match(/(https:\/\/m\.media-amazon\.com\/images\/I\/[^.]+)\./);
      if (cleanMatch) {
        resolvedImage = `${cleanMatch[1]}._AC_SX679_.jpg`;
      }
    }

    return {
      url,
      ogImage: resolvedImage,
      ogTitle,
      ogDescription,
      favicon: pageFavicon || defaultFavicon,
    };
  }

  /** Sites known to block normal UA but serve content to Googlebot */
  private needsGooglebotUA(url: string): boolean {
    try {
      const host = new URL(url).hostname.replace(/^www\./, '');
      return ['mercadolivre.com.br', 'amazon.com.br', 'magazineluiza.com.br'].includes(host);
    } catch { return false; }
  }

  /** Detect 1px transparent placeholder images */
  private isPlaceholderImage(img: string): boolean {
    return img.startsWith('data:image/gif;base64,R0lGODlhAQAB') ||
      img.includes('placeholder') ||
      img.includes('1x1') ||
      img.length < 30;
  }

  /** Construct direct CDN image URLs for known e-commerce sites that block server-side HTML fetch */
  private async tryKnownSiteImage(url: string): Promise<string | null> {
    try {
      const u = new URL(url);
      const host = u.hostname.replace(/^www\./, '').replace(/^m\./, '');

      // Casas Bahia, Ponto, Extra (Via Varejo) — pattern: /p/{productId}
      if (['casasbahia.com.br', 'pontofrio.com.br', 'extra.com.br'].includes(host)) {
        const match = u.pathname.match(/\/p\/(\d+)/);
        if (match) {
          const id = match[1];
          // Try both image formats (varies by product)
          const candidates = [
            `https://imgs.casasbahia.com.br/${id}/1g.png?imwidth=500`,
            `https://imgs.casasbahia.com.br/${id}/1xg.jpg?imwidth=500`,
          ];
          for (const candidate of candidates) {
            const ok = await this.probeUrl(candidate);
            if (ok) return candidate;
          }
          return candidates[0]; // fallback to first
        }
      }

      // Amazon BR — let Googlebot fetch handle it
      if (host === 'amazon.com.br') {
        return null;
      }

      // Leroy Merlin — CDN slug is unpredictable, use screenshot fallback
      if (host === 'leroymerlin.com.br') {
        return `https://image.thum.io/get/width/600/crop/400/${encodeURI(url)}`;
      }
    } catch {}
    return null;
  }

  /** Quick HEAD request to check if a URL exists */
  private async probeUrl(imageUrl: string): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      const res = await fetch(imageUrl, {
        method: 'HEAD',
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
      });
      clearTimeout(timeout);
      return res.ok;
    } catch {
      return false;
    }
  }

  private async fetchHtml(url: string, useGooglebot = false): Promise<string | null> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);

      const headers: Record<string, string> = useGooglebot
        ? {
            'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
            Accept: 'text/html',
            'Accept-Encoding': 'identity',
          }
        : {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
            'Accept-Encoding': 'identity',
            'Cache-Control': 'no-cache',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-User': '?1',
            'Upgrade-Insecure-Requests': '1',
          };

      const res = await fetch(url, {
        signal: controller.signal,
        headers,
        redirect: 'follow',
      });
      clearTimeout(timeout);

      const reader = res.body?.getReader();
      if (!reader) return res.ok ? null : 'BLOCKED';

      let html = '';
      const decoder = new TextDecoder();
      while (html.length < 200000) {
        const { done, value } = await reader.read();
        if (done) break;
        html += decoder.decode(value, { stream: true });
      }
      reader.cancel().catch(() => {});
      return html;
    } catch (err: any) {
      this.logger.warn(`Failed to fetch ${url}: ${err.message}`);
      return null;
    }
  }

  private extractMeta(html: string, property: string): string | null {
    // Match both property="og:..." and name="og:..."
    const regex = new RegExp(
      `<meta[^>]*(?:property|name)=["']${property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*content=["']([^"']*)["']|<meta[^>]*content=["']([^"']*)["'][^>]*(?:property|name)=["']${property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`,
      'i',
    );
    const match = html.match(regex);
    return match ? (match[1] || match[2] || null) : null;
  }

  private extractTitle(html: string): string | null {
    const match = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    return match ? match[1].trim() : null;
  }

  private extractJsonLdImage(html: string): string | null {
    try {
      const matches = html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
      for (const m of matches) {
        const data = JSON.parse(m[1]);
        const img = data?.image;
        if (typeof img === 'string') return img;
        if (Array.isArray(img) && typeof img[0] === 'string') return img[0];
        if (img?.url) return img.url;
      }
    } catch { /* ignore parse errors */ }
    return null;
  }

  private extractFavicon(html: string, baseUrl: string): string | null {
    const match = html.match(/<link[^>]*rel=["'](?:shortcut )?icon["'][^>]*href=["']([^"']*)["']/i)
      || html.match(/<link[^>]*href=["']([^"']*)["'][^>]*rel=["'](?:shortcut )?icon["']/i);
    if (match?.[1]) return this.resolveUrl(match[1], baseUrl);
    try {
      const u = new URL(baseUrl);
      return `${u.origin}/favicon.ico`;
    } catch {
      return null;
    }
  }

  private resolveUrl(href: string, base: string): string {
    try {
      return new URL(href, base).href;
    } catch {
      return href;
    }
  }
}
