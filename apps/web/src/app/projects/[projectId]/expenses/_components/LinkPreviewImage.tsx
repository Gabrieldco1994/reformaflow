'use client';

import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { ShoppingCart } from 'lucide-react';
import type { LinkPreview } from '../_types';

/**
 * Imagem do item de despesa com fallback automático para link-preview (ogImage).
 * Usa o mesmo cache do LinkPreviewCard (queryKey ['link-preview', link]).
 */
export function LinkPreviewImage({
  imageUrl,
  link,
  alt,
  className,
}: {
  imageUrl?: string | null;
  link?: string | null;
  alt: string;
  className?: string;
}) {
  const [imgError, setImgError] = useState(false);

  const { data: preview } = useQuery<LinkPreview>({
    queryKey: ['link-preview', link],
    queryFn: () => api.get(`/link-preview?url=${encodeURIComponent(link!)}`),
    staleTime: 1000 * 60 * 60 * 24,
    retry: 1,
    enabled: !!link && !imageUrl,
  });

  const src = imageUrl || (preview?.ogImage && !imgError ? preview.ogImage : null);
  if (src) {
    return <img src={src} alt={alt} className={className} onError={() => setImgError(true)} />;
  }
  return (
    <div className="flex items-center justify-center w-full h-full bg-gray-50">
      <ShoppingCart className="w-4 h-4 text-gray-300" />
    </div>
  );
}
