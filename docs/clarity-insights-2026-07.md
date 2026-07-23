# Insights do Microsoft Clarity — LifeOne (julho/2026)

> **Para quem é este doc:** design e produto. É um documento de **descoberta** —
> o que os dados de comportamento real mostraram, com evidência e implicação de
> UX. Não é plano de implementação (esse virou os PRs #245–#283).
>
> **Fonte:** Microsoft Clarity, projeto `xp2t8pv3uc`. Janela de 30 dias até
> 2026-07-22: **228 sessões, 182 usuários únicos** (87% novos), heatmaps de
> tap/dead-tap e gravações de sessão assistidas frame a frame.
>
> ⚠️ **Todos os números abaixo são do baseline de 22/07.** Vários problemas já
> foram corrigidos (ver §6). O baseline serve de "antes" para medir o "depois" —
> a leitura pós-correções sai a partir de ~24/07, quando o funil corrigido
> acumular massa.

---

## 1. Quem é o usuário (e por que isso muda tudo)

| Dimensão | Dado | Implicação de design |
|---|---|---|
| Origem | `l.threads.com` — **168 sessões (74%)** | O tráfego vem de UM link no Threads. É público frio, curioso, não veio buscar "app financeiro". |
| Dispositivo | ChromeMobile 55% + MobileSafari 38% = **93% mobile** | Desktop é 7%. Qualquer decisão se valida a 375/390px primeiro. |
| Novos | 87% dos usuários são novos | Quase ninguém tem conta. A primeira tela é a que importa. |
| Performance | 89/100, **LCP 0,92s ("good")** | **Velocidade não é o problema.** Não perseguir performance — perseguir clareza. |

**Leitura de design:** o produto é julgado por um público que chegou de rede
social, no celular, sem intenção prévia, e decide ficar ou sair em segundos.
A boca do funil (`/register`) é onde se ganha ou perde a maioria.

---

## 2. O funil de cadastro — onde as pessoas somem

Baseline de 22/07, do register ao Cockpit:

```
187 viram /register
 └─ 78 (42%) rolaram a página inteira
     └─ 27 (14%) tocaram em algum campo   ← o gargalo real
         └─ 22 tocaram no botão
             └─ 19 sign ups
                 └─ ~28 chegaram ao Cockpit (inclui retornos)
```

**O achado central:** 42% leem a página toda e vão embora — só **14% tocam num
campo**. Não é falta de rolagem (metade rola). É falta de **motivo para
começar**: a página original mostrava um formulário sem dizer o que o produto
faz.

**Implicação de design:** o trabalho de conversão está em dar prova de valor
*antes* do formulário, não em mexer no formulário. Foi a origem do redesign do
hero (telas do produto + card da Maria + benefícios).

---

## 3. Dead taps no Cockpit — a affordance que mentia

`/monthly` (Cockpit): 48 pageviews, 224 taps, **49 dead taps (22%)** — quase 1 em
cada 4 toques não fazia nada.

**Ranking real dos elementos mortos:**

| Elemento tocado | Dead taps |
|---|---|
| `Entrou R$ …` | 10 |
| `R$ …` (valores) | 8 |
| bloco do card "Caixa hoje" | 6 |
| "Se nada mudar, o mês fecha em R$ …" | 2 |
| `Projeção`, `fim do mês R$`, `Mês protegido` | resto |

**Por que acontecia:** as linhas Entrou/Saiu/Projeção eram visualmente idênticas
ao `MovimentacaoRow` — o layout de linha financeira que é clicável em todo o
resto do app. O usuário aprendeu a affordance e ela **quebrava justo no card mais
importante**.

**Implicação de design:** consistência de affordance não é estética, é contrato.
Se parece linha clicável, tem que ser clicável — senão vira frustração medível.

---

## 4. Erros de JS e tela branca

- **15,7% das sessões** registraram erro de JS.
- **97% desses erros** são `window.webkit.messageHandlers` — ou seja, do
  **navegador in-app** (Instagram/Threads embutido), **não do nosso código**.
- Os 3% restantes eram nossos — e um deles era grave.

**A gravação que doeu (`uo3war`):** usuário cadastrou, no passo de conta bancária
tomou erro de validação, tentou pular, levou um **modal de advertência**, e a
sessão terminou em **tela branca → spinner infinito → erro de JS**. Foi a última
coisa que essa pessoa viu do produto.

**Implicação de design:** um erro não tratado numa SPA vira tela branca — sem
saída, sem mensagem. O custo não é técnico, é de confiança: a pessoa não volta.

---

## 5. Três gravações que valem mais que os agregados

| Sessão | O que aconteceu | Lição |
|---|---|---|
| `uo3war` | Cadastro → erro de validação → modal ao pular → **tela branca → spinner infinito** | Onboarding com fricção + sem error boundary = perda no primeiro contato |
| `158new6` | **Rage clicks** repetidos sobre a linha "Projeção". Voltou 2× no dia seguinte, ficou **2 segundos**, saiu na `/conta` | A affordance morta gera raiva medível; a pessoa desiste rápido |
| `1frxkkn` | Tentou importar fatura em Cartões → "Nenhum cartão cadastrado" + dead clicks → **terminou de volta em `/register`** | Beco sem saída (texto morto onde devia ter CTA) expulsa o usuário |

**Outros sinais do baseline:**
- **Quick backs: 7,46%** das sessões (entrou e voltou rápido) — bounce disfarçado.
- **CLS 0,18** — layout shift no hero (a fonte trocava depois do render e empurrava o texto).

---

## 6. O que já mudou (correções entregues 22–23/07)

Estes achados viraram os PRs #245–#283. **O baseline acima é o "antes";
os alvos são o que esperamos medir no "depois".**

| Achado | Correção | PR |
|---|---|---|
| 22% dead taps no Cockpit | Linhas Entrou/Saiu/Projeção navegáveis | #246 |
| Modal de culpa ao pular conta | Pular em 1 toque, sem modal | #247 |
| Beco "Nenhum cartão cadastrado" | Vira CTA para cadastrar | #248 |
| Tela branca | Error boundaries + loading states | #249 |
| 14% tocam no 1º campo | Cadastro 3 campos + hero com prova de valor | #253, #260 |
| Origem do erro JS desconhecida | Tag `jsErrorSource` no Clarity (diagnóstico) | #245 |
| CLS 0,18 | Geist via `next/font` (elimina troca de fonte) | #277 |
| Jornada errada no onboarding | Escolha de objetivo antes do setup | #258 |

**Alvos declarados** (a validar no funil corrigido): dead taps `/monthly` < 5%,
toque no 1º campo do register ≥ 30%, conversão register→cockpit ≥ 20%.

---

## 7. Como a medição funciona agora

Foi montado um **funil no Clarity** (`Ativacao Threads ate o Cockpit`) com smart
events:

```
F1 Viu register → F2 Submit cadastro → Sign up → F3 Entrou no onboarding → F4 Chegou ao Cockpit
```

**Ressalvas que o design precisa saber ao ler os números:**
- O funil só mede a partir de 22/07 — **não retroage**. Os primeiros dias são o
  novo baseline.
- O degrau `F3 Entrou no onboarding` passou a disparar **mais cedo** (na nova
  tela de objetivos), então a contagem de `/onboarding` sobe por definição — não
  é melhora orgânica.
- Heatmap é indexado por URL. O baseline de dead taps está sob o domínio antigo
  (`reformaflow.vercel.app`); a produção agora é `lifeoneapp.vercel.app`. A
  comparação é de **taxa**, não de série contínua.
- O `F2 Submit cadastro` esteve cego por um tempo (o texto do botão mudou 3× num
  dia). Está corrigido, mas números de F2 antes de ~23/07 são subcontados.

---

## 8. O que ainda não sabemos (perguntas abertas para o design)

1. **O gargalo pós-correção é o register ou o onboarding?** O baseline não
   distinguia (F2 estava cego). A leitura de ~24/07 responde.
2. **A vitrine de telas no hero move o toque no 1º campo?** É a primeira mudança
   de conversão que teremos como medir de verdade.
3. **O onboarding do PESSOAL (5 passos) é longo demais?** Decisão de produto
   manteve os 5; se a queda F3→F4 persistir, reabrir.
4. **Combustível no CARRO** — o mockup pede "gasto com combustível", mas o tipo
   COMBUSTÍVEL não existe na taxonomia. Decisão de design/produto pendente.

---

*Documento gerado a partir do briefing de descoberta do Clarity (30 dias até
2026-07-22). Mantido por: QA/PO. Última atualização: 2026-07-23.*
