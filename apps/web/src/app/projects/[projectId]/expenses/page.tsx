'use client';

import Link from 'next/link';
import { useEffect } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { hasNavRoute, type ProjectType } from '@reformaflow/domain';
import { useProject } from '@/contexts/project-context';
import { useAuth } from '@/contexts/auth-context';
import { ExpensesView } from './ExpensesView';
import { MobileExpensesScreen } from './_components/MobileExpensesScreen';

/**
 * Desktop mantém a view analítica existente. No mobile (<lg) renderizamos a
 * superfície "app" simplificada.
 *
 * Issue #369 — superfície única de despesas: quando o tipo de projeto perdeu
 * `expenses` como rota de nav (`PROJECT_NAV`, via `hasNavRoute`) E ganhou
 * `bills` como a superfície equivalente (aba Avulsas), `/expenses`
 * redireciona para lá. Hoje isso cobre só CASA/CARRO — a checagem exige as
 * DUAS condições (não só "sumiu de expenses") porque PLANTAS também não tem
 * `expenses` na nav mas não tem `bills` como destino válido; sem a segunda
 * checagem, PLANTAS seria redirecionado para uma rota que ele não expõe. O
 * módulo `expenses` (feature) continua existindo como âncora de
 * vínculo/rateio (feito a partir do PESSOAL) e fonte das despesas de
 * combustível (#289) — só a rota de produto some, a capacidade permanece.
 */
export default function ExpensesPage() {
  const { projectType, projectId } = useProject();
  const { hasModule } = useAuth();
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const routeProjectId = String(params?.projectId ?? projectId);
  const type = projectType as ProjectType;
  const shouldRedirectToAvulsas = !hasNavRoute(type, 'expenses') && hasNavRoute(type, 'bills');
  const navCollapsed = !hasNavRoute(type, 'expenses') && hasNavRoute(type, 'conta');
  const noPermission = navCollapsed && !hasModule('expenses');
  // #529: o redirect ao hub é INCONDICIONAL para quem tem o módulo. NÃO
  // acrescente `&& hasModule('monthlyOverview')` aqui: o antigo "caso 3"
  // (módulo sem o hub → renderizava a página legada) deixou de ser estado
  // suportado no PESSOAL. As QUATRO rotas colapsadas usam a mesma condição —
  // divergir uma delas já foi defeito antes. Travado por u4-nav-redirect (U4-10c/d).
  const shouldRedirectToHub = navCollapsed && hasModule('expenses');

  useEffect(() => {
    if (shouldRedirectToAvulsas) {
      router.replace(`/projects/${routeProjectId}/bills?tab=avulsas`);
    } else if (noPermission) {
      router.replace('/no-permission');
    } else if (shouldRedirectToHub) {
      const query = searchParams.toString();
      router.replace(`/projects/${routeProjectId}/conta${query ? `?${query}` : ''}`);
    }
  }, [shouldRedirectToAvulsas, noPermission, shouldRedirectToHub, routeProjectId, router, searchParams]);

  if (shouldRedirectToAvulsas || noPermission || shouldRedirectToHub) {
    return null;
  }

  if (projectType !== 'PESSOAL') {
    return <ExpensesView lockedEixo="competencia" />;
  }

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-lifeone-hairline bg-lifeone-card px-3 py-2.5">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-lifeone-ink-3">
            Visão por competência
          </p>
          <Link
            href={`/projects/${projectId}/conta`}
            className="text-[12px] font-semibold text-lifeone-blue hover:underline"
          >
            Voltar para Conta
          </Link>
        </div>
      </div>
      <div className="lg:hidden">
        <MobileExpensesScreen />
      </div>
      <div className="hidden lg:block">
        <ExpensesView lockedEixo="competencia" />
      </div>
    </div>
  );
}
