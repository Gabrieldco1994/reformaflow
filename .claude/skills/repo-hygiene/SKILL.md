---
name: repo-hygiene
description: Audita e reduz branches/worktrees do ReformaFlow de forma conservadora, sem stash, force ou remoção de trabalho dirty/unmerged/detached.
allowed-tools: Read, Glob, Grep, Bash
---

# Higiene segura de branches e worktrees

## Proibições

- nunca `git stash`;
- nunca `git reset --hard`;
- nunca `git worktree remove --force`;
- nunca remover worktree dirty, detached, de sessão ativa ou branch não ancestral de `origin/main`;
- nunca inferir merge por nome.

## 1. Atualizar e inventariar

```bash
git fetch origin
git worktree list --porcelain
git branch --merged origin/main
```

Para cada worktree registre:

- caminho;
- branch/SHA;
- dirty/clean;
- attached/detached;
- tip é ancestral de `origin/main`?;
- sessão ativa/protegida?;
- decisão.

## 2. Candidato removível

Um worktree só é candidato se todos forem verdadeiros:

1. caminho existe;
2. `git -C <path> status --porcelain` é vazio;
3. tem branch attached;
4. `git merge-base --is-ancestor <branch> origin/main` retorna 0;
5. não é checkout principal;
6. não é worktree da sessão atual;
7. nenhum processo ativo conhecido depende dele.

## 3. Remover sem força

```bash
git worktree remove <path>
git branch -d <branch>
```

Se qualquer comando recusar, preserve e reporte. No final:

```bash
git worktree prune --expire now
```

## 4. Relatório

```text
before:
removed:
branches deleted:
preserved dirty:
preserved unmerged:
preserved detached:
after:
```

O objetivo é reduzir lixo comprovado, não atingir um número arbitrário.

