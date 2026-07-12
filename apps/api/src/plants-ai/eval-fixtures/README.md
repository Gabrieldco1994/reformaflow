# Eval fixtures — PLANTAS AI

Datasets de referência para montar `cases.json` com casos reais (não inventados):

1. **PlantVillage** — https://www.kaggle.com/datasets/abdallahalidev/plantvillage-dataset
   38 classes `Cultura___condicao` (ex.: `Tomato___Late_blight`, `Apple___healthy`), ~54k imagens.
   Cobre a dimensão **saúde/doença** do diagnóstico. Baixe o zip do Kaggle (requer login),
   descompacte em qualquer pasta local e rode:
   ```bash
   cd apps/api
   npx ts-node src/plants-ai/build-eval-cases.ts /caminho/para/PlantVillage/color 3
   ```
   Isso copia até 3 imagens por classe para `images/plantvillage/` e mescla os casos
   em `cases.json` (via `plantVillageLabelToEvalCase` em `eval-lib.ts`).
   Observação: são espécies agrícolas (tomate, maçã, milho...), não plantas de casa —
   útil para calibrar a detecção de "está doente", não a identificação de espécie de
   planta ornamental.

2. **Indoor Plant Disease Detection Dataset** — https://www.kaggle.com/datasets/abdulahad0296/indoor-plant-disease-detection-dataset
   16 classes `Especie_Condicao` (ex.: `Aloe_Rust`, `Snake_Plant_Anthracnose`) de **plantas de
   interior reais** (babosa, cacto, jiboia/pothos, espada-de-são-jorge, clorofito) —
   muito mais próximo do nosso caso de uso do que o PlantVillage (que é agrícola).
   Já baixado: 32 imagens (2 por classe) em `images/indoor-disease/`, mapeadas manualmente
   em `cases.json` (não há um `labelToEvalCase` automático aqui pois os nomes de espécie e
   condição vêm concatenados sem separador fixo — ver `CLASS_MAP` usado ao gerar o dataset).
   Atenção: "Money Plant" nesse dataset é sinônimo indiano de pothos/jiboia (Epipremnum aureum),
   não jade (Crassula) — confirmado pelas fotos (folha em coração variegada).

3. **House Plant Species** — https://www.kaggle.com/datasets/kacpergregorowicz/house-plant-species
   47 classes de plantas de interior saudáveis (só identificação de espécie, sem doença).
   Já baixado: 16 imagens (2 cada) de 8 espécies novas em `images/house-plant-species/`
   (violeta-africana, babosa, antúrio, palmeira-areca, aspargo-samambaia, begônia,
   ave-do-paraíso, samambaia-ninho-de-pássaro). **Importante**: o dataset só tem fotos por
   pasta-espécie, sem nenhum rótulo de toxicidade a pet apesar da descrição do autor citar
   esse objetivo — o `riscoPet` desses casos foi anotado manualmente com base em conhecimento
   botânico geral (mesma referência ASPCA já citada no prompt), não é um dado do dataset.

4. **Indoor Plant Health and Growth Factors** (CSV, `souvikrana17/indoor-plant-health-and-growth-dataset`)
   e **House Plants Care Instructions** (`prakash27x/indoor-house-plants-dataset-with-care-instructions`,
   209 espécies com rega/luz/temperatura/pragas por espécie, ver `eval-fixtures/care-reference.json`
   e `findCareReference()` em `eval-lib.ts`) — nenhum dos dois tem imagens, não entram no
   `cases.json`. O segundo é usado para comparação manual (não métrica automática) do campo
   `cuidados` durante o eval — ver comentário `ponytail:` em `eval-lib.ts`.

5. **ASPCA Plant Toxicity Info** — https://www.kaggle.com/datasets/pelinkeskin/aspca-plant-toxicity-info
   1896 espécies com toxicidade real para cão/gato/cavalo (`eval-fixtures/aspca-toxicity.json`,
   `findToxicityReference()` em `eval-lib.ts`). 12 fotos reais em `images/aspca-photos/`, com
   `riscoPet` em `cases.json` vindo do CSV (coluna `Toxicity_Cat`) quando há match exato de
   nome científico — 4 das 12 espécies não têm match e foram marcadas `DESCONHECIDO`
   honestamente (não inventamos toxicidade sem fonte). O eval.ts também compara, para
   qualquer espécie que o Gemini identifique, o `riscoPet` retornado com esse CSV real.

6. **OpenPlant** (artigo PMC12986848, revista *Plants*) — https://pmc.ncbi.nlm.nih.gov/articles/PMC12986848/
   635k imagens / 1167 espécies agregadas de 41 repositórios, sem download único público.
   Usado aqui só como **referência de leitura**: metodologia de benchmark de espécies com
   VLMs e amplitude taxonômica esperada — não há automação de download no repo.

7. **Houseplants Healthy/Wilted** — https://huggingface.co/datasets/bhargob11/houseplants
   971 imagens de plantas domésticas (490 saudáveis, 481 murchas), licença MIT.
   Foi salva uma amostra balanceada de 10 imagens em `images/hf-houseplants-health/`
   e seus rótulos em `health-cases.json`. Esse lote fica separado de `cases.json`
   porque só possui ground truth de saúde (`SAUDAVEL`/`ATENCAO`), sem espécie,
   toxicidade ou causa específica; misturá-lo ao eval principal distorceria essas
   métricas.

8. **Plant Dataset** — https://www.kaggle.com/datasets/yousra15b/plant-dataset
   28 classes ornamentais (~2,8 mil imagens, 518 MB), licença Apache 2.0. Foi salva
   uma amostra de 1 imagem por classe (4,3 MB) em `images/kaggle-plant-dataset/`,
   com ground truth de espécie em `species-cases.json`. O lote é separado porque
   não possui rótulos de saúde ou toxicidade. A pasta inválida `error_borrados`
   encontrada no arquivo original foi descartada.

9. **Fotos reais suas** (jiboia, samambaia etc.) — coloque em `images/upload-aqui/` e
   adicione manualmente ao `cases.json` (ver `PlantEvalCase` em `eval-lib.ts`).

10. **ISpeakPlantish common houseplants** —
    https://github.com/anjelicasilva/ispeakplantish/blob/master/seed_data/common-houseplants-data.csv
    93 plantas com nome científico/popular, descrição, nível de luz e URL de imagem.
    Não foi copiado: o repositório não declara licença (GitHub License API retorna
    404) e cerca de 37 entradas já se sobrepõem ao `care-reference.json`. Mantido
    apenas como referência externa até o autor esclarecer uma licença de reuso.

Depois de montar `cases.json`, rode o eval:
```bash
cd apps/api
GEMINI_API_KEY=... npx ts-node src/plants-ai/eval.ts
```


11. **JBRJ — Acervo da Coleção Viva** — https://ckan.jbrj.gov.br/dataset/acervo-colecao-viva
    Licença **CC-BY**. Autor/fonte institucional: **Coordenação de Coleções Vivas/DICAT — Jardim Botânico do Rio de Janeiro**.
    O fixture compacto `jbrj-common-names.json` foi gerado localmente via
    `npx ts-node src/plants-ai/build-jbrj-reference.ts /caminho/para/colecao_viva_2020.csv`
    e guarda **somente** nome científico identificado de táxons vivos, família e nome popular brasileiro.
    O ETL descarta o CSV bruto, GPS, IDs operacionais, notas internas, desaparecidos/mortos, `INDETERMINADA`
    e registros só de família/gênero antes de deduplicar por `normalizeLabel`.
