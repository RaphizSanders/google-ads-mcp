# Lote demand-gen — Demand Gen e remarketing dinâmico de varejo em Display

Módulo: `src/tools/demand-gen.ts` · catálogo: `src/tools/demand-gen.catalog.ts` · testes: `tests/demand-gen.test.ts`.

## Como a API v25 modela Demand Gen

- Campanha `DEMAND_GEN` (sem subtipo) + grupo de anúncios **sem `type`** + `AdGroupAd` com um de
  `demand_gen_multi_asset_ad`, `demand_gen_carousel_ad`, `demand_gen_video_responsive_ad` ou `demand_gen_product_ad`.
- **Asset group é só Performance Max.** Em Demand Gen a API recusa com
  `AssetGroupError.CANNOT_ADD_ASSET_GROUP_FOR_CAMPAIGN_TYPE`. A descrição antiga de `create_demand_gen_campaign`
  ("Demand Gen uses asset groups") e o "Next: use create_asset_group" mandavam o agente para esse erro — corrigido.
- Canais por grupo (`demand_gen_ad_group_settings.channel_controls`): `channel_strategy` (ALL_CHANNELS, padrão, ou
  ALL_OWNED_AND_OPERATED_CHANNELS, sem Display de terceiros) **ou** `selected_channels` (YouTube in-stream, in-feed,
  Shorts, Discover, Gmail, Display e Maps — Maps entrou na v25.1).
- `campaign.demand_gen_campaign_settings.upgraded_targeting` (imutável, padrão `true`): localização e idioma ficam no
  **grupo** (`AdGroupCriterion.location/language`). Em Demand Gen é campanha **ou** grupo, nunca os dois.
- Orçamento exclusivo (sem compartilhado), diário ou total (`period = CUSTOM_PERIOD` + `total_amount_micros`, com
  `end_date_time` obrigatório) e mínimo de **5 USD/dia** ou equivalente (deprecations, 01/04/2026).
- Lances: Maximizar conversões, CPA desejado, Maximizar valor, ROAS desejado, Maximizar cliques (`target_spend`,
  sem teto de CPC) e CPC alvo (`target_cpc`, v22; o grupo pode sobrescrever com `target_cpc_micros`). CPC manual é
  recusado (`OPERATION_NOT_PERMITTED_FOR_CONTEXT`).

Fontes conferidas: protos v25 (`resources/campaign`, `ad_group`, `ad_group_ad`, `campaign_budget`, `user_list`,
`common/ad_type_infos`, `asset_types`, `ad_asset`, `user_lists`, `bidding`, `enums/asset_automation_type`,
`demand_gen_channel_strategy`, `errors/*`) e developers.google.com/google-ads/api/docs/demand-gen/{create-campaign,
channel-controls, audience-targeting, product-ads}, remarketing/audience-segments/lookalike-audiences,
dynamic-remarketing/merchant-center-example, assets/asset-automation-settings, campaigns/bidding/strategy-types,
deprecations e release notes (v22 TargetCpc, v24 VTC/DUPLICATE_LOOKALIKE, v25.1 Maps).

## Tools

Toda escrita do lote sai numa **única requisição atômica** (`googleAds:mutate` com IDs temporários, ou um
`:mutate` só do recurso, sem `partialFailure`): ou tudo é gravado, ou nada — sem orçamento/asset órfão. Em dry-run
(`GOOGLE_ADS_DRY_RUN`) ou `validateOnly` a API valida o pacote inteiro e a resposta diz "nada foi gravado".
Nenhuma tool do lote é encadeada (`chained` vazio).

### create_demand_gen_campaign — escrita (reescrita; registrada agora no módulo)

Cria orçamento + campanha (PAUSED) + opcionalmente o primeiro grupo e seus critérios, tudo num `googleAds:mutate`.

- Orçamento: `dailyBudgetMicros` **ou** `totalBudgetMicros` + `endDate` (CUSTOM_PERIOD); `startDate` opcional.
  Micros inteiros positivos e múltiplos de 10.000.
- Lances: `MAXIMIZE_CONVERSIONS`, `TARGET_CPA` (`targetCpaMicros` → `campaign.target_cpa`, como no exemplo oficial),
  `MAXIMIZE_CONVERSION_VALUE`, `TARGET_ROAS` (`targetRoas` → `maximize_conversion_value.target_roas`),
  `MAXIMIZE_CLICKS` (`target_spend {}`), `TARGET_CPC` (`targetCpcMicros` → `campaign.target_cpc`).
  Alvo com estratégia incompatível é recusado antes de qualquer chamada.
- `viewThroughConversionOptimization`, `merchantId` + `feedLabel` (produtos), `upgradedTargeting` (imutável).
- `adGroup`: nome, `channelStrategy` ou `selectedChannels`, `optimizedTargeting`, `excludeDemographicExpansion`,
  `audienceResourceName`. Nasce ENABLED dentro da campanha PAUSED (como no exemplo oficial).
- `locationIds`, `excludedLocationIds`, `languageIds`: no grupo (upgraded targeting) — exige `adGroup`; com
  `upgradedTargeting=false` vão para a campanha.
- Leituras antes de gravar: nome de campanha livre, moeda da conta (mínimo em USD), localizações/idiomas existentes,
  público existente, vínculo do Merchant Center (`product_link`, aviso) e nome do orçamento livre (se "Budget — nome"
  já existir — ex.: órfão da versão antiga — acrescenta data/hora).
- Avisos: orçamento < 15x o CPA desejado (recomendação da doc), sem localização/idioma, Merchant não vinculado.
- Próximo passo informado: `create_demand_gen_ad` (ou `create_demand_gen_ad_group`), nunca `create_asset_group`.

### create_display_campaign — escrita (reescrita; registrada agora no módulo)

Orçamento + campanha de Display (PAUSED) + localização/idioma da campanha + opcionalmente o primeiro grupo
(`DISPLAY_STANDARD`) com listas de remarketing — tudo num `googleAds:mutate`.

- Lances: `MAXIMIZE_CONVERSIONS`, `TARGET_CPA`, `MAXIMIZE_CONVERSION_VALUE`, `TARGET_ROAS` (novo), `MAXIMIZE_CLICKS`
  = `TARGET_SPEND` (novo, com `cpcBidCeilingMicros` opcional), `MANUAL_CPC`, `MANUAL_CPM` (novo, CPM visível).
  Com lance manual e `adGroup`, o lance do grupo (`cpcBidMicros`/`cpmBidMicros`) é obrigatório.
- Remarketing dinâmico de varejo (item extra): `merchantId`, `feedLabel`, `enableLocal`, `campaignPriority`
  (0–2, padrão 0 como no exemplo oficial) em `shopping_setting`; `adGroup.userListIds` vira critério `user_list`
  no grupo. As listas são conferidas antes (existem, elegíveis para Display; CLOSED gera aviso).
- Depois: `create_responsive_display_ad` no grupo — o anúncio responsivo puxa os produtos do feed.

### create_demand_gen_ad_group — escrita (nova)

Grupo Demand Gen (sem `type`, PAUSED por padrão) numa campanha DEMAND_GEN existente, com canais, segmentação
otimizada, lances do grupo (`targetCpcMicros`, `targetCpaMicros`, `targetRoas`), localização (incluir/excluir),
idioma e público — um `googleAds:mutate`. Recusa: campanha de outro canal, localização/idioma sem upgraded targeting
ou com critérios já na campanha, nome repetido na campanha, constantes inexistentes. Avisa quando o lance do grupo
não vale para a estratégia da campanha.

### update_demand_gen_ad_group — escrita (nova)

Lê o grupo, compara e envia só o que muda: canais (`channel_strategy` ou os 7 caminhos-folha
`selected_channels.*` — nunca a mensagem inteira, que a API recusa com FIELD_HAS_SUBFIELDS), `optimized_targeting_enabled`,
`exclude_demographic_expansion`, `target_cpc_micros`, `target_cpa_micros`, `target_roas`. Sem mudança → nenhuma
escrita. Grupo sem configuração de canais conta como ALL_CHANNELS (padrão). Mostra antes/depois e o updateMask.

### set_demand_gen_ad_group_targeting — escrita (nova)

Localização, exclusão de localização, idioma e público no nível do grupo, para `adGroupIds` ou todos os grupos de um
`campaignId`. Por padrão adiciona só o que falta (no-op quando já está tudo lá). `replace=true` substitui as
dimensões informadas e exige `confirm=true`; sem `confirm` devolve a prévia do que seria removido e não grava.
Remoções e criações vão numa única requisição `adGroupCriteria:mutate` (sem partialFailure). Um grupo aceita um
público: trocar exige `replace`. Lista vazia é ignorada (remover toda a localização não é feito aqui — evita entregar
no mundo inteiro por engano). Recusa campanha sem upgraded targeting (use `set_campaign_locations/languages`) e
campanha com localização/idioma no nível da campanha.

### create_demand_gen_ad — escrita (nova)

| adType | Obrigatórios | Limites conferidos antes |
| --- | --- | --- |
| MULTI_ASSET | 1–5 títulos, 1–5 descrições, 1–5 logos, businessName, imagem 1.91:1 ou 1:1 | títulos ≤ 40 (ao menos um ≤ 30), descrições ≤ 90, até 20 imagens somando 1.91:1, 1:1, 4:5 e 9:16 |
| CAROUSEL | 1 título, 1 descrição, 1 logo, businessName, 2–10 cards (título + imagem 1.91:1 e/ou 1:1) | idem |
| VIDEO_RESPONSIVE | vídeo(s) do YouTube (ID ou URL), logo(s), businessName | até 5 títulos (≤ 40), títulos longos (≤ 90) e descrições (≤ 90) |
| PRODUCT | campanha com Merchant Center, 1 título, 1 descrição, 1 logo, businessName | idem |

- Imagens: ID ou resource name de assets IMAGE da própria conta; uma única consulta confere existência, tipo,
  proporção (±1%) e tamanho mínimo (1.91:1 ≥ 600x314, 1:1 ≥ 300x300, 4:5 ≥ 480x600, 9:16 ≥ 600x1067, logo ≥ 128x128).
- Vídeos: reaproveita o asset YOUTUBE_VIDEO existente; os que faltam são criados com ID temporário na mesma
  requisição do anúncio. CTA de vídeo/produto (`callToAction`, enum CallToActionType) idem: reaproveita ou cria.
- Carrossel: cada card vira um asset `DEMAND_GEN_CAROUSEL_CARD` com ID temporário, na mesma requisição do anúncio;
  a URL do card vai em `Asset.final_urls` (padrão: a finalUrl do anúncio).
- A resposta lista os assets novos (vídeos, CTA, cards) como "Assets criados na mesma operação". Em dry-run ou
  `validateOnly` a linha vira "Assets que seriam criados na mesma operação (nada foi gravado)": os IDs temporários
  não existem na conta e não devem ser reaproveitados.
- `assetAutomation` por anúncio (tabela "Ad-level" da doc): MULTI_ASSET → GENERATE_ANIMATED_IMAGES_FROM_OTHER_ASSETS,
  GENERATE_DESIGN_VERSIONS_FOR_IMAGES, GENERATE_VIDEOS_FROM_OTHER_ASSETS; VIDEO_RESPONSIVE → GENERATE_LANDING_PAGE_PREVIEW,
  GENERATE_LANDING_PAGE_TEXT, GENERATE_SHORTER_YOUTUBE_VIDEOS, GENERATE_VERTICAL_YOUTUBE_VIDEOS. Ligar
  GENERATE_LANDING_PAGE_PREVIEW exige `confirm=true` (o proto declara que o anunciante tem direito sobre as imagens da página).
- Campo que não se aplica ao tipo é recusado (nunca ignorado em silêncio). Grupo de outro canal é recusado com a tool
  certa (create_ad, create_responsive_display_ad, create_video_ad, create_asset_group). Nasce PAUSED por padrão.

### create_lookalike_segment — escrita (nova)

`UserList.lookalike_user_list {seed_user_list_ids, expansion_level NARROW|BALANCED|BROAD, country_codes}` (imutável;
países padrão `["BR"]`). Antes de gravar: sementes existem na conta; soma do tamanho estimado (maior entre Display e
Pesquisa) ≥ 100 pessoas — se o Google ainda não calculou, só avisa; lookalike igual (mesmas sementes, nível e países)
já existente → devolve o resource existente sem gravar; nome livre. `DUPLICATE_LOOKALIKE` vindo da API vira "já
existe: <resource>". Lembra que só entrega em Demand Gen e que convém criar 2–3 dias antes. Uso: resource →
`create_audience_from_lists` → `set_demand_gen_ad_group_targeting` (público).

### list_demand_gen_ad_groups — leitura (nova)

Grupos de campanhas Demand Gen com canais (channel_config/strategy/selected_channels), segmentação otimizada, lances do
grupo, upgraded targeting e localização/exclusões/idiomas/público do grupo. `campaignId` opcional; json/table/csv.

### list_lookalike_segments — leitura (nova)

Lookalikes da conta com sementes, nível, países, faixa de tamanho e elegibilidade. json/table/csv.

## Fluxos

1. **Prospecção Demand Gen com lookalike**: `create_lookalike_segment` (2–3 dias antes) → `create_audience_from_lists`
   → `create_demand_gen_campaign` com `adGroup` (canais, locais, idioma, `audienceResourceName`) → `create_demand_gen_ad`
   → `update_ad_status`/`update_campaign` para ativar.
2. **Demand Gen com produtos**: `create_demand_gen_campaign` com `merchantId` → `create_demand_gen_ad` `PRODUCT`
   (ou MULTI_ASSET/VIDEO_RESPONSIVE, que também exibem produtos).
3. **Remarketing dinâmico de varejo em Display**: `list_remarketing_lists` → `create_display_campaign` com `merchantId` e
   `adGroup.userListIds` → `create_responsive_display_ad` no grupo criado.
4. **Só Shorts / sem Display de terceiros**: `update_demand_gen_ad_group` com `selectedChannels: ["YOUTUBE_SHORTS"]`
   ou `channelStrategy: "ALL_OWNED_AND_OPERATED_CHANNELS"`.

## Parcial / fora da posse deste lote (e por quê)

- **Mínimo de 5 USD/dia em outras moedas**: a API do Google Ads não expõe câmbio, então o pré-check local só é exato
  em conta USD. Nas demais a própria API confere na criação; como tudo vai numa operação atômica, nada fica órfão, e o
  erro `BUDGET_BELOW_PER_DAY_MINIMUM` é traduzido. O detalhe `budget_per_day_minimum_error_details` (mínimo na moeda da
  conta) se perde porque `GoogleAdsClient.request` só repassa as mensagens dos erros — `google-ads-client.ts` é do lote
  account-auth; com os detalhes repassados, a tool poderia citar o valor exato.
- **TARGET_CPM em Display**: não adicionado. A ajuda do Google para Display lista CPM visível (= `MANUAL_CPM`, adicionado),
  não CPM desejado; nenhuma fonte oficial encontrada mostra `target_cpm` aceito em campanha DISPLAY.
- **Fora da posse (notas para o integrador)**:
  - `create_asset_group`: a descrição ainda cita Demand Gen e não há trava de canal (deveria recusar campanha que não
    seja PERFORMANCE_MAX antes de criar os assets de texto).
  - `create_campaign` com `channelType=DEMAND_GEN` ainda aceita `MANUAL_CPC` (a API recusa) e não tem os lances de
    Demand Gen; o caminho certo é `create_demand_gen_campaign`.
  - `create_ad_group`/`update_ad_group` sem entradas de Demand Gen e `set_campaign_locations`/`set_campaign_languages`
    sem detectar upgraded targeting: cobertos por `create_demand_gen_ad_group`, `update_demand_gen_ad_group` e
    `set_demand_gen_ad_group_targeting`; as tools do núcleo poderiam recusar DEMAND_GEN com upgraded targeting e apontar
    para cá.
  - `src/resources.ts` (lote account-auth): a linha de DEMAND_GEN ainda diz "Discovery + Gmail + YouTube Shorts";
    hoje é YouTube (in-stream, in-feed, Shorts), Discover, Gmail, Display e Maps, sem asset groups.
  - `CHAINED_WRITE_TOOLS` (`src/tool-kit.ts`) ainda lista `create_display_campaign` e `create_demand_gen_campaign`, então
    o `validateOnly` por chamada é recusado nelas. Agora são atômicas: podem sair da lista (o dry-run por env já funciona).
- **Merchant Center em campanha Demand Gen já existente**: não há tool para ligar `shopping_setting.merchant_id` depois
  (seria `update_campaign`, do núcleo). Anúncio PRODUCT em campanha sem Merchant é recusado com orientação.
- **Listing groups em Demand Gen de produto**: a doc recomenda ao menos um listing group por grupo para relatório
  completo; não implementado aqui (sem exemplo oficial do payload para Demand Gen).
- **Decisões com fonte divergente**: títulos de multi-asset até 40 caracteres com ao menos um ≤ 30 (central de ajuda
  atual) — o comentário do proto ainda fala em largura 30; soma mínima das sementes do lookalike = 100 (seção
  "Requirements" da doc; o resumo da mesma página diz 1.000).
