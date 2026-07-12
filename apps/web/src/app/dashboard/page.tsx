import { redirect } from 'next/navigation';

type SearchParams = Record<string, string | string[] | undefined>;

export default function Page({ searchParams }: { searchParams?: SearchParams }) {
  const query = new URLSearchParams();

  for (const [key, value] of Object.entries(searchParams ?? {})) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      value.forEach((item) => query.append(key, item));
    } else {
      query.append(key, value);
    }
  }

  const serialized = query.toString();
  redirect(serialized ? `/financeiro?${serialized}` : '/financeiro');
}
