# Sandbox local de PDF raster (fundação inerte)

## Estado

Esta entrega é somente a fundação local de admissão e rasterização de PDF
escaneado/misto do #719. Ela **não está registrada no Nest, não chama provedor,
não habilita OCR e não altera a capability pública**. PDFs com raster continuam
seguindo o comportamento público atual até as entregas futuras de
contrato/provedor, consentimento e integração.

## Contrato operacional

- Imagem de produção: Debian bookworm com `bubblewrap`, `poppler-utils`, `qpdf`,
  `pngcrush`, `pngcheck` e `util-linux`. Nenhuma dependência npm foi adicionada.
- Entrada inicial: somente `application/pdf`, magic `%PDF-` no byte zero, até
  10 MiB e de 1 a 10 páginas.
- Rejeições fechadas: PDF malformado, criptografado, com arquivo embutido,
  polyglot com bytes após `%%EOF`, página com dimensão anormal e estouro dos
  limites de decode/raster.
- Raster: PNG determinístico, no máximo 4096 por dimensão, 8 milhões de pixels
  por página, 32 milhões de pixels e 128 MiB raw no total, e 32 MiB codificados
  no total. Chunks auxiliares de metadata são removidos.
- Processo: grupo próprio com deadline de 45 s, limites de CPU/address
  space/arquivo/FD/PID, namespace sem rede, capabilities removidas, ambiente
  reconstruído por allow-list e somente o diretório daquela execução gravável.
- Saída: erros tipados e fixos; nunca incluem conteúdo, diagnóstico de
  ferramenta ou caminho do documento.
- Cleanup: o diretório aleatório `0700` de cada execução é removido depois de
  sucesso, erro, abort ou término forçado. Entrada, manifest e rasters usam
  criação exclusiva e leitura sem seguir symlink.

## Qualificação da imagem real

O job obrigatório de PR
`OCR PDF Sandbox (production image, 512 MiB)` constrói exatamente
`apps/api/Dockerfile` e executa:

```bash
docker run --rm \
  --memory=512m --memory-swap=512m --pids-limit=128 --network=bridge \
  reformaflow-api:ocr-sandbox \
  node /app/apps/api/dist/imports/import-session/ocr/pdf-raster-sandbox.qualify.mjs
```

O qualificador usa somente documentos sintéticos. Ele falha se não comprovar:

1. raster de duas páginas e bytes determinísticos sem metadata;
2. rejeição de 11 páginas, malformed, encrypted, embedded-file e polyglot;
3. namespace sem acesso nem ao servidor loopback do container;
4. ausência de secrets, `/app`, `/data` e descritores herdados no payload;
5. morte do grupo (inclusive filho que ignora `SIGTERM`) e cleanup no abort;
6. pico agregado de RSS abaixo de 512 MiB.

Uma imagem/kernel que impeça `bubblewrap --unshare-all` falha fechada como
`SANDBOX_UNAVAILABLE`; não existe fallback sem isolamento.

## Operação e diagnóstico

Os códigos permitidos são `INVALID_DOCUMENT`, `MALFORMED_PDF`,
`ENCRYPTED_PDF`, `EMBEDDED_FILE`, `PAGE_LIMIT_EXCEEDED`,
`DECOMPRESSION_LIMIT`, `RASTER_LIMIT_EXCEEDED`,
`INVALID_SANDBOX_OUTPUT`, `SANDBOX_UNAVAILABLE`, `SANDBOX_TIMEOUT`, `ABORTED`
e `SANDBOX_FAILED`. Não registrar stderr/stdout dos binários nem anexar
documentos ou rasters a issues.

Antes de qualquer registro da capability, a entrega futura deve integrar o
contrato/provedor e consentimento aprovados, ownership de tenant, vault,
atestação humana e quotas do #719. Este runbook não é evidência de OCR pronto
para uso.
