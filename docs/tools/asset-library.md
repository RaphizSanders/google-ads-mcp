# Lote asset-library — Biblioteca de assets e locais do Perfil da Empresa

Módulo: `src/tools/asset-library.ts` (catálogo em `src/tools/asset-library.catalog.ts`).
Testes: `tests/asset-library.test.ts` (35 testes; toda query passa por `assertGaqlRules` com os
metadados reais da v25, e três testes usam o `GoogleAdsClient` real com `fetch` interceptado para
provar a rota REST e o corpo enviado).

As quatro tools antigas da biblioteca (`get_image_assets`, `get_video_assets`, `upload_image_asset`,
`upload_video_asset`) **saíram de `src/tools.ts` e passaram a ser registradas pelo módulo** — no
`tools.ts` ficou só um comentário apontando para cá. A classificação delas continua no núcleo
(`src/read-only.ts`); o catálogo do módulo lista só as tools novas.

Fontes conferidas (v25): `resources/asset.proto` (`orientation` = 54, `synthetic_content_info` = 55,
`source`, `policy_summary`, `field_type_policy_summaries`), `common/synthetic_content_info.proto`,
`enums/synthetic_content_attestation_status.proto` (`IS_SYNTHETIC`, `NOT_SYNTHETIC`),
`enums/synthetic_content_source.proto` (`ADVERTISER_ATTESTED`), `resources/asset_set.proto`,
`common/asset_set_types.proto`, `services/{asset_set,customer_asset_set,campaign_asset_set,ad_group_asset_set,asset_set_asset}_service.proto`,
`services/google_ads_service.proto` (o `MutateOperation` aceita `asset_set_operation`,
`asset_set_asset_operation` e `campaign_asset_set_operation`, **mas não** `customer_asset_set_operation`
nem `ad_group_asset_set_operation`), `errors/asset_set_error.proto`, `errors/asset_set_link_error.proto`,
`errors/asset_set_asset_error.proto`, release notes (Asset.orientation na v23; synthetic_content_info
totalmente mutável na v25), guia "Location assets" e a referência de `metrics.linked_entities_count`.

## Biblioteca de assets

### `get_image_assets` (leitura, alterada)
Lista as imagens com URL, `width`/`height`/`dimensions`, `aspect_ratio` (1:1, 1.91:1, 4:5, 9:16, 16:9,
4:1 com ±1%), `orientation` (do Google; se ausente, calculada pelas dimensões), `mime_type`,
`file_size_kb`, `source` (ADVERTISER / AUTOMATICALLY_CREATED), política (`approval_status`,
`review_status`, `policy_topics`, `policy_by_field_type`) e a declaração de IA (`ai_generated`:
IS_SYNTHETIC / NOT_SYNTHETIC / NAO_DECLARADO, `ai_attestation_source`, `google_ai_detection`).
- Filtros no GAQL: `assetIds`, `nameContains` (REGEXP_MATCH `(?i)`, com escape RE2 + literal GAQL),
  `orientation`, `minWidth`, `minHeight`, `mimeType`, `approvalStatus`, `source`,
  `aiGenerated` (IS_SYNTHETIC / NOT_SYNTHETIC).
- Filtros locais (o GAQL não expressa): `aspectRatio` e `aiGenerated=NAO_DECLARADO` — varrem até
  5000 assets por chamada; se a varredura bater no teto sem completar a página, `next_cursor` continua
  de onde parou.
- Paginação por cursor: `ORDER BY asset.id`, `afterAssetId` = `next_cursor` (GAQL não tem OFFSET).
  `limit` 1–1000 (default 50).
- `includeUsage=true`: `linked_entities`, `linked_by_channel` e `in_use` por imagem, via
  `channel_aggregate_asset_view` (`metrics.linked_entities_count`, sem data).
- `format`: json / table / csv (em table/csv o cursor vai num segundo bloco de texto).

### `get_video_assets` (leitura, alterada)
Mesmo desenho para vídeos do YouTube: `youtube_video_id`, `youtube_url`, `title`, `orientation`,
`source`, política e declaração de IA. Filtros extras: `youtubeVideoIds` (ID ou URL), `titleContains`.
`limit` default 20.

### `get_asset_usage` (leitura, nova)
Onde um asset está em uso (`assetId` = ID ou resource name da própria conta):
- vínculos em `customer_asset`, `campaign_asset`, `ad_group_asset`, `asset_group_asset`,
  `asset_set_asset` e anúncios (`ad_group_ad_asset_view`: RSA, Demand Gen, App) — com status, tipo de
  campo, origem e `primary_status`; REMOVED fica de fora salvo `includeRemoved=true`;
- `aggregate_by_campaign` (`campaign_aggregate_asset_view`, sem data): `linked_entities` por campanha e
  tipo de campo — cobre também anúncios responsivos de Display e de vídeo;
- `performance` (default ligado; `dateRange`/`days`): impressões, cliques, custo, conversões e valor por
  campanha e tipo de campo;
- `summary`: `in_use`, `verdict`, `active_links`/`paused_links` e a contagem por nível
  (`active_by_level`, `paused_by_level`). Cada vínculo é classificado **uma vez só** (ativo, pausado ou
  inativo), então as contagens nunca se sobrepõem:
  - conta, campanha, grupo, asset group e asset set: status do vínculo (ENABLED = ativo, PAUSED = pausado);
  - anúncios: só vale o vínculo na versão atual do anúncio (`enabled = true`); anúncio ENABLED = ativo,
    anúncio PAUSED = pausado; vínculo fora da versão atual ou anúncio REMOVED = inativo.
- Vereditos: `in_use = true` → "em uso" (há vínculo ativo ou entidade na visão agregada);
  `in_use = false` → "sem vínculo ativo — só vínculos pausados" ou "sem uso: nenhum vínculo ativo
  encontrado"; `in_use = null` → "indeterminado: seções com erro (…)".
- Seções com erro: as outras voltam e o erro fica em `section_errors`. Se falhou alguma seção de vínculo
  (conta, campanha, grupo, asset group, anúncios, asset set ou a visão agregada) e nenhuma das que
  responderam tem vínculo ativo, a resposta **não** diz "sem uso": `in_use = null`, `failed_sections`
  lista as seções, o veredito é "indeterminado" e a resposta volta como erro (`isError`), com o payload
  parcial — o vínculo pode estar justamente na seção que falhou. Se alguma seção achou vínculo ativo, o
  veredito "em uso" vale mesmo com falhas (as contagens podem estar subestimadas). Falha só no
  desempenho (`performance`) não afeta o veredito.

### `upload_image_asset` (escrita, alterada)
- Aceita data URL (`data:image/png;base64,...`), quebras de linha e base64 URL-safe; base64 inválido é
  recusado antes da API.
- Lê formato e dimensões do cabeçalho (PNG, JPEG, GIF) e devolve `detected` (proporção, orientação,
  tamanho); avisa (sem bloquear) WEBP, formato desconhecido e arquivo acima de 5120 KB.
- `aiGenerated` (opcional): `true` → `syntheticContentInfo.advertiserAttestation = {status: IS_SYNTHETIC,
  source: ADVERTISER_ATTESTED}`; `false` → NOT_SYNTHETIC; omitido → nada é declarado (comportamento antigo).
- Dry-run/validateOnly: relata "validado, nada gravado" (antes dizia "created" mesmo em dry-run).

### `upload_video_asset` (escrita, alterada)
- Aceita ID de 11 caracteres ou URL (watch, youtu.be, shorts, embed, live); inválido é recusado antes da API.
- Lê antes: se o vídeo já é asset da conta, devolve o existente e **não grava** (evita duplicata); se a
  declaração pedida difere da atual, aponta `update_asset_synthetic_attestation`.
- `name` (opcional) e `aiGenerated` (como no upload de imagem).

### `update_asset_synthetic_attestation` (escrita, nova)
Declara `IS_SYNTHETIC` (`aiGenerated=true`) ou `NOT_SYNTHETIC` em até 100 assets (IDs ou resource names).
- Lê cada asset: inexistente ou tipo fora de IMAGE / MEDIA_BUNDLE / YOUTUBE_VIDEO → nada é gravado.
- No-op: asset já com o valor pedido (e origem ADVERTISER_ATTESTED) é pulado; sem mudança → nenhuma escrita.
- `confirm: true` obrigatório — sem ele mostra o plano antes/depois. Motivo: a declaração é do
  anunciante e, depois de feita, só alterna entre IS_SYNTHETIC e NOT_SYNTHETIC.
- `assets:mutate` com `partialFailure` e resultado por item; `updateMask` só com as folhas que mudam
  (`synthetic_content_info.advertiser_attestation.status` e/ou `.source`).

## Locais (Perfil da Empresa, redes e Maps)

Fluxo documentado pelo Google: **LOCATION_SYNC** (asset set) → vínculo com a conta
(`CustomerAssetSet`) → o Google gera os location assets de forma assíncrona → (opcional) **grupo de
locais** (dinâmico ou estático) vinculado a campanha (`CampaignAssetSet`) ou grupo de anúncios
(`AdGroupAssetSet`). É pré-requisito para extensões de local, ações locais/Maps e a segmentação por
grupos de locais (item 84, lote de segmentação).

### `list_location_asset_sets` (leitura, nova)
LOCATION_SYNC e grupos (BUSINESS_PROFILE_DYNAMIC / CHAIN_DYNAMIC / STATIC_LOCATION_GROUP): filtros,
dono (`ownership`), origem da sincronização (`sync_source`), pai, quantidade de locais ativos e
vínculos (conta, campanhas, grupos). `warnings`: sem LOCATION_SYNC ativo, LOCATION_SYNC sem vínculo com
a conta ou sem locais, grupo sem vínculo. `format` json/table/csv.
Limite: a v25 não expõe no GAQL os campos de `maps_location_set`, e um LOCATION_SYNC do Perfil da
Empresa sem filtros pode não trazer o sub-objeto — nesses casos `sync_source` sai como
`NAO_IDENTIFICADA (...)` em vez de chutar.

### `list_location_assets` (leitura, nova)
Location assets com `place_id`, `ownership`, e (Perfil da Empresa) `store_codes`, `listing_ids`,
`labels`, `approval_status`. `assetSetId` restringe aos locais ativos de um asset set; `label` filtra
por rótulo (local, sem diferenciar maiúsculas); cursor `afterAssetId`.

### `create_location_sync_asset_set` (escrita encadeada, nova)
Cria o asset set LOCATION_SYNC (`assetSets:mutate`) e o vincula à conta (`customerAssetSets:mutate`).
- `source=BUSINESS_PROFILE`: `businessProfileEmail` + `businessProfileAccessToken` (access token OAuth
  2.0 com escopo `https://www.googleapis.com/auth/business.manage`, gerado para o MESMO e-mail; expira
  em ~1 h). Opcionais: `businessAccountId`, `businessNameFilter`, `labelFilters`, `listingIds`
  (IDs ≥ 2^63 convertidos para int64 em complemento de dois, como o guia manda).
  O token só vai no corpo para o Google Ads; **nunca aparece na resposta** (inclusive em mensagens de
  erro que o ecoem — é substituído por `[token omitido]`).
- `source=CHAIN`: `chainRelationshipType` (AUTO_DEALERS / GENERAL_RETAILERS) + `chains`
  [{chainId, locationAttributes?}].
- `source=MAPS`: `placeIds`.
- `ownershipType` obrigatório: BUSINESS_OWNER (extensão de local) ou AFFILIATE (local afiliado).
- Recusa antes de gravar: campos de outra origem misturados, e-mail/token/IDs inválidos, LOCATION_SYNC
  ativo já existente (o Google aceita um só — mostra o atual), nome repetido entre asset sets ativos.
- É **encadeada** (o vínculo usa o resource name criado; o `googleAds:mutate` não aceita
  `CustomerAssetSetOperation`): `validateOnly` por chamada é recusado; com `GOOGLE_ADS_DRY_RUN` só o
  passo 1 é validado e o passo 2 não é enviado. Se o passo 2 falhar, a resposta diz que o asset set foi
  criado e manda repetir só o vínculo com `link_location_asset_set`.
- Erros da API mapeados em PT-BR: OAUTH_INFO_INVALID/MISSING, NOT_UNIQUE_ENABLED_LOCATION_SYNC…,
  INVALID_CHAIN_IDS, INVALID_PLACE_IDS, DUPLICATE_ASSET_SET_NAME etc.

### `link_location_asset_set` (escrita, nova)
Vincula um asset set existente: LOCATION_SYNC → conta (`level=CUSTOMER`); grupo → campanhas
(`CAMPAIGN`, `campaignIds`) ou grupos de anúncios (`AD_GROUP`, `adGroupIds`), até 50 por chamada.
Confere tipo × nível, existência e status dos alvos; vínculo ativo é pulado; `partialFailure` com
resultado por item e dicas (canal incompatível, vínculo duplicado).

### `create_location_group_asset_set` (escrita atômica, nova)
Um único `googleAds:mutate` com ID temporário (`assetSets/-1`): cria o grupo (+ os
`AssetSetAsset` do estático) e, opcionalmente, os `CampaignAssetSet` de `campaignIds` — grava tudo ou nada.
- `BUSINESS_PROFILE_DYNAMIC`: `labelFilters`, `listingIds` e/ou `businessName` (EXACT).
- `CHAIN_DYNAMIC`: `chains`.
- `STATIC`: `locationAssetIds` (até 1000), conferidos como ATIVOS no LOCATION_SYNC pai antes de gravar
  (senão a API recusaria com PARENT_LINKAGE_DOES_NOT_EXIST).
- Pai: `parentAssetSetId` ou o LOCATION_SYNC ativo; pai de redes não aceita grupo do Perfil da Empresa
  e vice-versa (recusado antes; quando a origem não é identificável, a API decide e o erro é explicado).
- Grupos de anúncios: depois, com `link_location_asset_set` (o batch não aceita `AdGroupAssetSetOperation`).
- `validateOnly` funciona (atômica).

### `unlink_location_asset_set` (escrita, nova)
Remove vínculos (conta, campanhas ou grupos) lidos da conta — só os ativos; alvo sem vínculo é pulado.
`confirm: true` obrigatório (desvincular o LOCATION_SYNC da conta tira os locais de toda a conta).
Mapeia ASSET_SET_LINK_CANNOT_BE_REMOVED.

### `remove_location_asset_set` (escrita, nova)
Remove um asset set de locais. `confirm: true` obrigatório. Antes, recusa se houver vínculos ativos
ou grupos filhos ativos (o Google recusaria com CANNOT_DELETE_AS_ENABLED_LINKAGES_EXIST) e lista o
que desfazer. Já removido → no-op. Serve para trocar a origem do LOCATION_SYNC.

## Fluxos

- Achar "a imagem 4:5" ou "o logo quadrado": `get_image_assets aspectRatio=4:5` (ou `1:1`,
  `nameContains=logo`), `includeUsage=true` para ver se está em uso.
- Imagens reprovadas: `get_image_assets approvalStatus=DISAPPROVED` → `policy_topics` /
  `policy_by_field_type` → `get_asset_usage` para ver onde afeta.
- Criativo feito com IA: `upload_image_asset aiGenerated=true`; para o acervo antigo,
  `get_image_assets aiGenerated=NAO_DECLARADO` → `update_asset_synthetic_attestation` (plano → `confirm: true`).
- Locais do Perfil da Empresa: `create_location_sync_asset_set source=BUSINESS_PROFILE` →
  `list_location_assets` → (opcional) `create_location_group_asset_set` com `campaignIds` →
  `list_location_asset_sets` para conferir.
- Trocar a origem dos locais: `unlink_location_asset_set level=CUSTOMER confirm=true` → remover os grupos
  filhos → `remove_location_asset_set confirm=true` → `create_location_sync_asset_set`.

## Limites e o que depende de fora

- **Token do Perfil da Empresa**: o Google exige, no `BusinessProfileLocationSet`, um access token OAuth
  com escopo `business.manage` do dono/gestor do Perfil. Este servidor só tem o escopo `adwords`, então
  o token precisa ser gerado fora (ex.: OAuth Playground ou o app da agência) e passado na chamada; ele
  expira em ~1 h. Redes (CHAIN) e Place IDs (MAPS) não precisam de token.
- **synthetic_content_info**: só gravável a partir da v25 (em versões antigas a API responde
  "immutable"/"cannot be set" — a mensagem de erro explica e cita `GOOGLE_ADS_API_VERSION`). O payload
  usa `status` + `source: ADVERTISER_ATTESTED` (os dois campos que o release note da v25 declara
  mutáveis); não foi exercitado contra a API real (sem credenciais aqui).
- **Uso agregado sem data**: `linked_entities_count` é lido sem `segments.date` (sem segmento de data no
  SELECT o GAQL não exige janela). Se o Google omitir da visão agregada assets sem atividade, o
  `in_use` do `includeUsage` pode sair falso para asset vinculado mas sem veiculação — para certeza, use
  `get_asset_usage`, que lê os vínculos diretos.
- `ad_group_ad_asset_view` cobre só RSA, Demand Gen e App (documentação do Google); anúncios
  responsivos de Display e de vídeo aparecem só na visão agregada por campanha.
- Declaração de IA em anúncios (`Ad.synthetic_content_info`) não faz parte deste lote.
