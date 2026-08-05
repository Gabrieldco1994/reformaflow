# Agent landscape

## Matriz canônica de despacho

| ID                    | Owner primário            | Canais afetados                     | Consultas/lens por fontes vivas         | Impacto/guardiões plataforma  | Implementadores                       | Avaliadores/gates                  | Conclusão                      |
| --------------------- | ------------------------- | ----------------------------------- | --------------------------------------- | ----------------------------- | ------------------------------------- | ---------------------------------- | ------------------------------ |
| `web-desktop`         | `web-experience-owner`    | navegador desktop                   | lens Web em `docs/README.md`            | sem impacto na plataforma Web | `frontend-expert` para Web            | `qa-engineer` e gate Web           | harness Web aprovado           |
| `mobile-pwa`          | `mobile-experience-owner` | viewport mobile e PWA               | lens Mobile em `docs/README.md`         | guardião PWA quando aplicável | `frontend-expert` para Mobile         | `journey-qa` e gate Mobile         | harness Mobile aprovado        |
| `maria-cross-channel` | `maria-ai-owner`          | Maria em Web e Mobile               | fontes Maria em `docs/README.md`        | guardião da plataforma de IA  | `backend-expert` para Maria           | `ai-quality-engineer` e gate Maria | harness Maria aprovado         |
| `multi-channel`       | `maria-ai-owner`          | Web Mobile e Maria                  | lenses dos canais em `docs/README.md`   | guardiões Web Mobile e IA     | builders Web Mobile e Maria           | QA runtime e gates combinados      | QA runtime combinado aprovado  |
| `platform-only`       | `fleet-po`                | plataforma sem canal de experiência | fonte de plataforma em `docs/README.md` | `platform-sre` como guardião  | implementador de plataforma aplicável | testes e gate da plataforma        | testes da plataforma aprovados |
