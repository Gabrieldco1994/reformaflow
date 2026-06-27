export function isPdfBuffer(buf: Buffer): boolean {
  return buf.length >= 5 && buf.slice(0, 5).toString('ascii') === '%PDF-';
}

export async function parseBuffersAndMerge<T>(
  buffers: Buffer[],
  parse: (buffer: Buffer) => Promise<T>,
  merge: (results: T[]) => T,
): Promise<T> {
  const results = await Promise.all(buffers.map((buffer) => parse(buffer)));
  return merge(results);
}
