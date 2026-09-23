# Lote video-display — Vídeo, YouTube e anúncios de Display

Módulo: `src/tools/video-display.ts` (`registerVideoDisplayTools`), catálogo
`src/tools/video-display.catalog.ts`, testes `tests/video-display.test.ts`.
Tools existentes alteradas em `src/tools.ts`: `create_responsive_display_ad`,
`create_video_campaign`, `create_video_ad`. Método novo no client (fim da classe, bloco
`// ── lote video-display ──`): upload resumável.

Fontes conferidas: protos v25 (`common/ad_type_infos.proto`, `common/ad_asset.proto`,
`common/metrics.proto`, `common/segments.proto`, `resources/youtube_video_upload.proto`,
`services/youtube_video_upload_service.proto`, `resources/data_link.proto`,
`services/data_link_service.proto`, `enums/*`, `errors/video_campaign_error.proto`,
`errors/data_link_error.proto`), guias `responsive-display-ads/create-responsive-display-ads`,
`assets/upload-videos`, `video/overview`, `demand-gen/reporting`,
`account-management/linking-youtube`, `display-upload-ads/*` e a página de especificações de
anúncios de display enviados da Central de Ajuda (tamanhos e 150 KB). Toda query GAQL passa
pelo validador com os metadados reais da v25.

## Tools novas

### get_video_performance (leitura)
Relatório de vídeo para campanhas de Vídeo e Demand Gen.
- `level`: `CAMPAIGN` (default) | `AD_GROUP` | `AD` | `VIDEO` (FROM `video`, por vídeo do YouTube
  × campanha) | `VIDEO_ENHANCEMENT` (FROM `video_enhancement`, versões geradas pelo Google).
- `breakdown`: `NONE` | `NETWORK` (`segments.ad_network_type`) | `SUB_NETWORK`
  (`ad_network_type` + `ad_sub_network_type` — Demand Gen: YOUTUBE_INSTREAM, INFEED, SHORTS) |
  `FORMAT` (`ad_format_type` + `ad_sub_format_type`). Com quebra, o resumo traz `split` (fatia de
  impressões e de custo por segmento).
- `channel`: `VIDEO_AND_DEMAND_GEN` (default) | `VIDEO` | `DEMAND_GEN` | `ALL`. `ALL` não filtra tipo
  de campanha, então acrescenta `metrics.video_trueview_views > 0` ao WHERE: sem isso Pesquisa,
  Shopping e Display sem vídeo ocupariam o `LIMIT` (ordenado por impressões) e entrariam no relatório.
  Consequência: em `ALL`, linhas de bumper/in-stream não pulável sem views ficam de fora (use `VIDEO`).
- `campaignId`, `dateRange`/`days`, `limit` (default 200, máx. 5000), `format` json/table/csv.
- `includeReach`: `metrics.unique_users` e `average_impression_frequency_per_user` — só
  `level CAMPAIGN`, sem quebra e janela de até 92 dias (limite da API; recusado antes da chamada).
- Métricas (nomes v22+): impressões, `video_trueview_views`, `video_trueview_view_rate`
  (+ `_in_feed`, `_in_stream`, `_shorts`), `trueview_average_cpv`, quartis p25–p100, tempo
  assistido total/médio, engajamentos, `youtube_likes/comments/shares` (não existem em
  `video_enhancement`), cliques, custo, conversões e view-through.
- Compara view rate e CPV com os benchmarks de Brand/Awareness de `src/resources.ts`
  (view rate > 30% bom, 15–30% médio; CPV < R$ 0,10 bom, até R$ 0,25 médio). Menos de 1.000
  impressões de vídeo = "amostra pequena"; conta fora de BRL não recebe benchmark de CPV.
- **Linha sem views TrueView** (campanha sem vídeo, Demand Gen só de imagem, bumper/in-stream não
  pulável — formatos que não geram view): `benchmark_view_rate` e `benchmark_cpv` saem
  `"sem views TrueView"`, nunca "ruim". O 0% dela não é taxa de visualização a julgar.
- **Resumo (`totals`)**: impressões, custo, cliques e conversões somam todas as linhas; já o view
  rate e os quartis usam só as linhas com views, ponderados pelas impressões de vídeo de cada uma
  — `views ÷ video_trueview_view_rate` da própria API (o proto v25 define a taxa como views ÷
  impressões *do anúncio de vídeo*; numa campanha mista de Demand Gen isso é uma parte das
  impressões da linha). `totals.view_rate_basis` mostra `video_impressions`, `rows_with_views` e
  `rows_without_views`; o cabeçalho diz quantas linhas ficaram fora. Sem nenhuma linha com views,
  `view_rate_pct`, `cpv` e quartis do resumo são `null` e o veredito é "sem views TrueView".
- Convenções: taxas da API em fração → exibidas em %; `trueview_average_cpv` tratado em micros
  (mesma convenção de `average_cpc` no resto do MCP); CPM calculado (custo/impressões × 1000).
  Quartis e CPV do resumo são médias ponderadas (aproximação, sinalizada nas notas).

### upload_youtube_video (escrita)
Sobe um arquivo para o YouTube pelo `YouTubeVideoUploadService` (REST, protocolo resumável:
`POST https://googleads.googleapis.com/resumable/upload/v25/customers/{cid}/youTubeVideoUploads:create`
com `X-Goog-Upload-Protocol: resumable`, depois `PUT` dos pedaços com `X-Goog-Upload-Offset` e
`upload` / `upload, finalize`).
- Fonte (exatamente uma): `filePath` (absoluto, só no modo local/stdio — recusado no servidor
  hospedado), `httpsUrl` (download em streaming: só https, sem credenciais na URL, porta 443,
  host que resolve para rede interna/loopback/link-local é recusado, até 3 redirecionamentos
  revalidados, conteúdo `video/*` ou octet-stream) ou `videoBase64` (até 20 MB). Limite geral 2 GiB.
- `title` (até 100, sem `<>`; imutável depois), `description` (até 5000 bytes, sem `<>`), `privacy`
  (`UNLISTED` default; `PUBLIC` só com `channelId`), `channelId` (canal da marca, `UC…` — exige
  OAuth de usuário, que é o deste servidor; sem ele o vídeo vai para o canal gerenciado pelo Google).
- Pedaços de ~8 MiB (múltiplos da granularidade informada pela API). Falha transitória →
  consulta `X-Goog-Upload-Size-Received` e retoma dali (até 3 vezes); 4xx (exceto 408/429) é
  definitivo e a sessão é cancelada. Ao final lê o estado em `you_tube_video_upload`.
- Dry-run/validateOnly: valida tudo localmente e não abre sessão (o endpoint não tem
  `validate_only`); o client também recusa o upload em dry-run (fail-closed).

### get_youtube_video_uploads (leitura)
Lista `you_tube_video_upload` (estado PENDING/UPLOADED/PROCESSED/FAILED/REJECTED/UNAVAILABLE,
`video_id`, canal, privacidade), filtra por `state`/`videoUploadId`, cruza com assets
`YOUTUBE_VIDEO` da conta e diz o próximo passo (ex.: "PROCESSED → registre com upload_video_asset").

### remove_youtube_video_upload (escrita, destrutiva)
`youTubeVideoUploads:remove` — apaga o vídeo do YouTube e da biblioteca. Confere que cada upload
existe na conta, mostra a prévia e só remove com `confirm: true`. Dry-run: só prévia (sem
`validate_only` no endpoint). Máx. 50 por chamada.

### create_image_ad (escrita)
Anúncio de imagem enviado (`Ad.image_ad.image_asset`, tipo IMAGE_AD), criado PAUSADO.
Confere: grupo existe, não removido, campanha DISPLAY e tipo DISPLAY_STANDARD; asset IMAGE,
GIF/JPG/PNG, até 150 KB e num dos 20 tamanhos padrão (200x200 … 320x100). Mesmo banner + mesma
URL já no grupo = no-op. Erro da API vem com mensagem clara.

### list_youtube_video_links (leitura)
`data_link` com `type = 'VIDEO'`, filtro opcional de status, com URL do vídeo e próximo passo.
(`youtube_link_metadata.brand_channel_id`, citado no guia, não está na field reference da v25
usada pelo validador — não é selecionado.)

### request_youtube_video_link (escrita)
`dataLinks:create` com `youtubeVideo { videoId, channelId? }` e `youtubeLinkMetadata { brandChannelId? }`.
Aceita ID ou URL (watch, youtu.be, shorts, embed). Vínculo REQUESTED/PENDING_APPROVAL/ENABLED já
existente = no-op. Exige `confirm: true` (o nome e o ID da conta são compartilhados com o criador).
Dry-run: só prévia. Erros DataLinkError (PERMISSION_DENIED, YOUTUBE_VIDEO_ID_INVALID…) explicados.

### respond_youtube_video_link (escrita)
`action`: `ACCEPT` (PENDING_APPROVAL → ENABLED), `REJECT` (PENDING_APPROVAL → REJECTED),
`REVOKE` (REQUESTED → REVOKED) via `dataLinks:update`; `REMOVE` (ENABLED → removido) via
`dataLinks:remove`. Lê o status atual antes: ação incompatível é recusada, status já no alvo não
gera escrita. REJECT/REVOKE/REMOVE exigem `confirm: true`. Dry-run: só prévia.

## Tools existentes alteradas

### create_responsive_display_ad
- Logo deixou de ser obrigatório (a API não exige). `landscapeLogoAssets` → `logo_images` (4:1,
  mín. 512x128) e `squareLogoAssets` → `square_logo_images` (1:1, mín. 128x128). O `logoAssets`
  legado é roteado pela proporção real de cada imagem (o 1200x1200 que `upload_image_asset`
  recomenda agora vai para `square_logo_images` em vez de quebrar o anúncio).
- Confere grupo (existe, campanha DISPLAY) e cada imagem (IMAGE, proporção ±1% e mínimo do campo)
  antes de gravar; limites 15 imagens de marketing e 5 logos.
- Novos opcionais: `youtubeVideoIds` (até 5, precisam já ser asset — `upload_video_asset`),
  `callToAction`, `mainColor` + `accentColor` (#RRGGBB, juntos), `allowFlexibleColor` (false exige
  cores), `formatSetting` (NATIVE recusa cor não flexível), `promoText`, `pricePrefix`,
  `enableAssetEnhancements`, `enableAutogenVideo`.
- Dry-run relatado como validação; erro da API vira mensagem clara; aceita IDs ou resource names.

### create_video_campaign
Descrição reescrita: diz que a tool NÃO cria (Vídeo é só leitura na API — MUTATE_REQUIRES_RESERVATION)
e aponta `create_demand_gen_campaign`, `get_video_performance` e `upload_youtube_video`. Código
morto de criação de orçamento/campanha removido; parâmetros antigos são ignorados (o SDK descarta
chaves desconhecidas).

### create_video_ad
Lê antes de escrever: grupo existe, é VIDEO_RESPONSIVE em campanha VIDEO (grupo de Demand Gen é
recusado com orientação — lá o anúncio é DEMAND_GEN_VIDEO_RESPONSIVE_AD); logo é IMAGE 1:1 mín.
128x128 — tudo isso ANTES de criar o asset do vídeo. `MUTATE_REQUIRES_RESERVATION` /
`MUTATE_NOT_ALLOWED` viram explicação com a alternativa Demand Gen (e avisam se o asset do vídeo
ficou criado). Dry-run relatado corretamente.

## Fluxos

1. **Vídeo do cliente (MP4) → Demand Gen**: `upload_youtube_video` → `get_youtube_video_uploads`
   até PROCESSED → `upload_video_asset` (video_id) → campanha/anúncio de Demand Gen.
2. **Display responsivo**: `upload_image_asset` (paisagem 1200x628, quadrada 1200x1200, logo
   1200x1200 ou 1200x300) → `create_responsive_display_ad`.
3. **Banner fixo**: `upload_image_asset` (ex.: 300x250 ≤ 150 KB) → `create_image_ad`.
4. **Vídeo de criador**: `request_youtube_video_link` (confirm) → criador aceita →
   `list_youtube_video_links` (ENABLED); ou pedido do criador: `list_youtube_video_links
   status=PENDING_APPROVAL` → `respond_youtube_video_link ACCEPT`.
5. **Medição**: `get_video_performance` (ex.: `breakdown SUB_NETWORK` para Shorts × in-feed ×
   in-stream em Demand Gen; `includeReach` para alcance/frequência).

## Correções da revisão (branch `batch/video-display-fix`)

- **`get_video_performance` julgava linha sem vídeo e diluía o resumo** (ex.: `channel ALL` com
  uma campanha de Vídeo a 31% e uma de Pesquisa com 90 mil impressões dava "3,1% — ruim" no
  resumo e "ruim" na linha da Pesquisa). Corrigido como descrito acima: rótulo
  "sem views TrueView", resumo só sobre linhas com views na base de impressões de vídeo da API, e
  `metrics.video_trueview_views > 0` no WHERE de `ALL`.
- **Testes novos** (`tests/video-display.test.ts`), cada guarda conferida por mutação (a condição
  trocada por `false`, ou `>` por `>=` nos limites, faz o teste falhar):
  - relatório: `ALL` com Pesquisa + Vídeo, Demand Gen só de imagem no filtro padrão, campanha mista
    (imagem + vídeo) e relatório sem nenhuma view;
  - `respond_youtube_video_link`: REJECT (PENDING_APPROVAL) e REVOKE (REQUESTED) sem `confirm` e com
    `confirm: false` só dão prévia, sem escrita; com `confirm: true` mandam
    `dataLinks:update {resourceName, dataLinkStatus: REJECTED/REVOKED}`;
  - upload: `Content-Length` acima de 2 GiB e `content-type` `text/html` recusados sem abrir sessão
    (download cancelado; 2 GiB exatos passam); corte do fluxo acima de `maxBytes` (tudo num pedaço e
    no meio do fluxo) cancela a sessão; `X-Goog-Upload-Size-Received` abaixo do offset, além do
    pedaço ou não numérico — e sessão não mais `active` — não é retomado (nada reenviado, sessão
    cancelada); `description` medida em bytes UTF-8 (5001 bytes ou 2501 × "é" recusados; 5000
    bytes passam);
  - `create_image_ad`: grupo REMOVED e grupo de tipo diferente de DISPLAY_STANDARD recusados antes
    de ler a imagem;
  - `create_responsive_display_ad`: 16 imagens de marketing, 6 logos (inclusive via `logoAssets`
    legado) e 6 `youtubeVideoIds` recusados (os limites exatos 15/5/5 passam); asset
    YOUTUBE_VIDEO em campo de imagem recusado;
  - `create_video_ad`: logo que não é IMAGE recusado antes de procurar/criar o asset do vídeo.
- Todo `assert.ok` do arquivo tem mensagem explícita: sem ela o Node 24 tenta reconstruir a
  mensagem a partir do fonte e, num dos casos, travava o processo em vez de falhar o teste.

## Parcial / fora do escopo do lote

- **Item 26 — `create_ad_group`** ainda lista `VIDEO_*` no enum `type`, e **`src/resources.ts`**
  (linha "VIDEO: YouTube ads (in-stream, bumper, discovery)") segue desatualizado: nenhum dos dois
  é deste lote (ownership). Resolvido na integração: `VIDEO_*` saiu do enum de `create_ad_group`. Sugestão original: tirar `VIDEO_*` do enum de `create_ad_group`
  (o lote dono) e trocar a linha do resources por "VIDEO: só leitura/relatório na API; criar vídeo
  via Demand Gen".
- **Item 12 — `upload_image_asset`**: a orientação de tamanhos da descrição ("1200x1200 (logo)")
  não é deste lote. Deixou de ser nociva (o RDA agora roteia o logo quadrado para
  `square_logo_images`), mas vale acrescentar "logo 4:1 1200x300; retrato 4:5 e 9:16".
- **Upload do YouTube**: não há credenciais aqui — o protocolo foi implementado conforme o guia
  REST oficial e testado com fetch interceptado, mas não contra a API real. `UpdateYouTubeVideoUpload`
  não foi exposto: o proto v25 marca título e descrição como imutáveis e a privacidade só muda em
  canal da marca. Resíduo de SSRF: a checagem de DNS acontece antes do `fetch` (sem pinning de IP,
  já que o `undici` não é dependência direta); redirecionamentos são revalidados.
- **HTML5/AMPHTML (display upload com media bundle)**: não coberto — exige conta habilitada
  (allowlist) pelo Google.
- **Unidades**: `trueview_average_cpv` tratado como micros e taxas como fração, pela convenção da
  API já usada no MCP (`average_cpc`, `ctr`); o proto não documenta a unidade.
