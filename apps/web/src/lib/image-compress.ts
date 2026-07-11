/**
 * Comprime uma imagem no client antes do upload.
 * Se a imagem é menor que `skipIfUnder`, devolve o arquivo original.
 * Caso contrário, redimensiona para no máximo `maxDimension` (lado maior)
 * e re-encoda como JPEG com a qualidade especificada.
 *
 * Útil pra evitar upload de fotos de 8MB+ tiradas no celular, que travam
 * em redes 3G/4G e estouram limites do servidor.
 */
export async function compressImage(
  file: File,
  opts: {
    maxDimension?: number;
    quality?: number;
    skipIfUnderBytes?: number;
  } = {},
): Promise<File> {
  const maxDimension = opts.maxDimension ?? 1800;
  const quality = opts.quality ?? 0.82;
  const skipIfUnder = opts.skipIfUnderBytes ?? 800 * 1024; // 800kB

  if (!file.type.startsWith('image/')) return file;
  if (file.type === 'image/gif' || file.type === 'image/svg+xml') return file;
  if (file.size <= skipIfUnder) return file;

  try {
    const bitmap = await loadBitmap(file);
    const { width, height } = scaleSize(bitmap.width, bitmap.height, maxDimension);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, width, height);

    const blob: Blob | null = await new Promise((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', quality),
    );
    if (!blob) return file;
    if (blob.size >= file.size) return file;

    const newName = file.name.replace(/\.[^.]+$/, '') + '.jpg';
    return new File([blob], newName, { type: 'image/jpeg', lastModified: Date.now() });
  } catch (err) {
    console.warn('compressImage failed, sending original:', err);
    return file;
  }
}

export interface ImageQualityCheck {
  ok: boolean;
  reason?: string;
  width: number;
  height: number;
}

/**
 * Checagem client-side rápida antes de gastar uma chamada de IA: resolução
 * mínima e tamanho de arquivo mínimo (fotos muito pequenas tendem a vir
 * borradas/sem detalhe suficiente pra diagnóstico de espécie/saúde).
 *
 * ponytail: heurística simples (dimensão + bytes), não é blur-detection de
 * verdade — o Gemini já reporta `qualidadeImagem` no resultado; isso aqui só
 * evita a chamada quando dá pra saber de antemão que a foto é fraca.
 */
export async function checkImageQuality(file: File): Promise<ImageQualityCheck> {
  const MIN_DIMENSION = 400;
  const MIN_BYTES = 15 * 1024; // 15kB

  if (!file.type.startsWith('image/')) {
    return { ok: false, reason: 'Arquivo não é uma imagem', width: 0, height: 0 };
  }
  if (file.size < MIN_BYTES) {
    return { ok: false, reason: 'Arquivo muito pequeno — a foto pode estar com baixa qualidade', width: 0, height: 0 };
  }

  try {
    const bitmap = await loadBitmap(file);
    const width = 'width' in bitmap ? bitmap.width : 0;
    const height = 'height' in bitmap ? bitmap.height : 0;
    if (width < MIN_DIMENSION || height < MIN_DIMENSION) {
      return {
        ok: false,
        reason: `Resolução baixa (${width}x${height}px) — tente uma foto mais nítida e próxima da planta`,
        width,
        height,
      };
    }
    return { ok: true, width, height };
  } catch {
    // se não conseguir ler dimensões, não bloqueia o envio
    return { ok: true, width: 0, height: 0 };
  }
}

async function loadBitmap(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file);
    } catch {
      /* fallback abaixo */
    }
  }
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = (e) => {
      URL.revokeObjectURL(url);
      reject(e);
    };
    img.src = url;
  });
}

function scaleSize(width: number, height: number, maxDim: number) {
  if (width <= maxDim && height <= maxDim) return { width, height };
  const ratio = width >= height ? maxDim / width : maxDim / height;
  return {
    width: Math.round(width * ratio),
    height: Math.round(height * ratio),
  };
}
