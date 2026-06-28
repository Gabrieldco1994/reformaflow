# VibeVoice no Modal (GPU serverless, escala a zero)

Tira o servidor de voz do notebook e o coloca numa GPU sob demanda do
[Modal](https://modal.com). A URL é **estável** (sem túnel Cloudflare que muda)
e só consome créditos quando há uso real (~$30/mês grátis cobrem uso pessoal).

## Passo a passo

```bash
# 1. CLI do Modal
pip install modal

# 2. Conta + login (abre o navegador; cria a conta com GitHub se ainda não tiver)
modal setup

# 3. Deploy (build remoto: clona o VibeVoice, baixa modelo + vozes PT)
modal deploy deploy/modal/vibevoice_modal.py
```

O deploy imprime uma URL como:

```
https://<workspace>--vibevoice-realtime-serve.modal.run
```

O endpoint de streaming (websocket) usado pela API é essa URL com `/stream`:

```
wss://<workspace>--vibevoice-realtime-serve.modal.run/stream
```

## Apontar a API (Fly) para o Modal

```bash
flyctl secrets set \
  VIBEVOICE_WS_URL="wss://<workspace>--vibevoice-realtime-serve.modal.run/stream" \
  VIBEVOICE_DEFAULT_VOICE="pt-Spk1_man" \
  -a reformaflow-api
```

(O `flyctl secrets set` já redeploya a API.)

## Notas

- **Cold start**: o primeiro pedido após ficar ocioso carrega o modelo (~1–2 min).
  `scaledown_window=240` mantém o container quente por 4 min entre as falas, então
  numa conversa só a primeira fala é lenta.
- **GPU**: T4 (mais barata; a doc do VibeVoice diz que atinge tempo real nela).
- **Custo**: escala a zero quando ocioso. `max_containers=1` evita subir várias GPUs.
- **Logs/observabilidade**: `modal app logs vibevoice-realtime`.
- **Atualizar**: editar `vibevoice_modal.py` e rodar `modal deploy` de novo.
- **Derrubar**: `modal app stop vibevoice-realtime`.
