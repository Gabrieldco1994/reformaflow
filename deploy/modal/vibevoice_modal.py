"""
VibeVoice-Realtime (0.5B) servido no Modal — GPU serverless que escala a zero.

Por que: tirar o servidor de voz do notebook. O Modal dá uma URL HTTPS/WSS
estável (sem túnel Cloudflare que muda de endereço) e só consome créditos
quando há uso real. Cold start (~1-2 min) acontece só no primeiro pedido após
ficar ocioso; `scaledown_window` mantém o container quente entre as falas.

Deploy:
    pip install modal
    modal setup                 # autentica (abre o navegador) — feito uma vez
    modal deploy deploy/modal/vibevoice_modal.py

Saída: uma URL tipo
    https://<workspace>--vibevoice-realtime-serve.modal.run
O endpoint de streaming usado pela API ReformaFlow é:
    wss://<workspace>--vibevoice-realtime-serve.modal.run/stream

Depois é só apontar o secret do Fly:
    flyctl secrets set VIBEVOICE_WS_URL="wss://.../stream" -a reformaflow-api
"""

import os
import subprocess

import modal

MODEL_ID = "microsoft/VibeVoice-Realtime-0.5B"
DEFAULT_VOICE = "pt-Spk1_man"  # voz PT mais próxima (single-speaker)
SERVER_PORT = 8000

# Imagem: clona o VibeVoice, instala o extra de streaming, baixa as vozes
# experimentais (inclui pt-*) e pré-baixa o modelo para dentro da imagem
# (assim o cold start não gasta tempo baixando pesos).
image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("git", "wget", "tar", "ffmpeg")
    .run_commands(
        "git clone --depth 1 https://github.com/microsoft/VibeVoice.git /vibevoice",
        "cd /vibevoice && pip install -e '.[streamingtts]'",
        # vozes experimentais multilíngues (de/fr/jp/kr/pl/pt/sp/en)
        "cd /vibevoice && bash demo/download_experimental_voices.sh",
        # PyTorch 2.6: torch.load passou a usar weights_only=True por padrão e
        # quebra o carregamento dos presets de voz. Forçamos False (idempotente).
        "sed -i 's/weights_only=True/weights_only=False/g' /vibevoice/demo/web/app.py",
        # pré-baixa os pesos para o cache da imagem
        f"python -c \"from huggingface_hub import snapshot_download; snapshot_download('{MODEL_ID}')\"",
    )
    .env({"HF_HUB_DISABLE_TELEMETRY": "1"})
)

app = modal.App("vibevoice-realtime")


@app.function(
    image=image,
    gpu="L4",  # Ampere+ (sm89): mais rápida que T4 e suporta flash-attn; atinge tempo real
    timeout=600,
    scaledown_window=240,  # mantém quente 4 min após o último pedido (turnos de conversa)
    max_containers=1,  # 1 usuário pessoal — evita subir várias GPUs
)
@modal.concurrent(max_inputs=100)  # 1 container atende todas as conexões ws
@modal.web_server(port=SERVER_PORT, startup_timeout=600)
def serve() -> None:
    env = {
        **os.environ,
        "MODEL_PATH": MODEL_ID,
        "MODEL_DEVICE": "cuda",
        "VOICE_PRESET": os.environ.get("VOICE_PRESET", DEFAULT_VOICE),
    }
    subprocess.Popen(
        [
            "uvicorn",
            "demo.web.app:app",
            "--host",
            "0.0.0.0",
            "--port",
            str(SERVER_PORT),
        ],
        cwd="/vibevoice",
        env=env,
    )
