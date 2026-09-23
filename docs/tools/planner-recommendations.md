# Lote planner-recommendations — Planejador de palavras-chave e recomendações

Módulo: `src/tools/planner-recommendations.ts` (catálogo em `planner-recommendations.catalog.ts`).
Testes: `tests/planner-recommendations.test.ts` (35 testes; client falso que valida todo GAQL contra os
metadados reais da v25 e registra o corpo de cada chamada; `apply_recommendation` também é testada pelo servidor
MCP de verdade — `createMcpServer` + `InMemoryTransport` — para cobrir o que o schema zod faz com o input).

As cinco tools existentes do lote (`generate_keyword_ideas`, `list_recommendations`, `apply_recommendation`,
`dismiss_recommendation`, `get_change_history`) **saíram de `src/tools.ts` e passaram a ser registradas pelo
módulo**, com o mesmo nome. A classificação delas continua no núcleo (`src/read-only.ts`); no lugar de cada
bloco ficou um comentário apontando para o módulo.

Fontes conferidas: protos oficiais v25 (`services/keyword_plan_idea_service`, `services/recommendation_service`,
`services/recommendation_subscription_service`, `resources/recommendation`, `resources/recommendation_subscription`,
`resources/change_event`, `common/keyword_plan_common`, `common/dates` e enums `recommendation_type`,
`change_client_type`, `change_event_resource_type`, `resource_change_operation`, `month_of_year`,
`bidding_strategy_type`, `conversion_tracking_status_enum`, `ad_group_type`, `target_impression_share_location`);
docs `recommendations`, `change-event`, `keyword-planning/*`; post "Simplifying Keyword Forecast Metrics in
Google Ads API v24" (abr/2026).

## Tools

| Tool | Tipo | Situação |
|---|---|---|
| `generate_keyword_ideas` | leitura | alterada |
| `get_keyword_historical_metrics` | leitura | nova |
| `forecast_search_campaign` | leitura | nova |
| `suggest_ad_group_themes` | leitura | nova |
| `list_recommendations` | leitura | alterada |
| `apply_recommendation` | escrita | alterada |
| `dismiss_recommendation` | escrita | alterada |
| `generate_recommendations` | leitura | nova |
| `list_recommendation_subscriptions` | leitura | nova |
| `set_recommendation_subscription` | escrita | nova |
| `get_change_history` | leitura | alterada |

### generate_keyword_ideas (leitura, alterada)
Ideias do Keyword Planner (`:generateKeywordIdeas`).
- Novos parâmetros: `siteSeed` (domínio inteiro; não combina com `keywords`/`pageUrl` — a semente é `oneof`),
  `includeMonthly` (volume mês a mês), `monthRange {start,end}` em `YYYY-MM` (`year_month_range`, até 4 anos
  atrás), `pageToken` (a resposta mostra `nextPageToken` e o total disponível).
- Validação antes da API: até 20 keywords semente, até 10 localizações, `pageUrl` com host de verdade (com ou
  sem `http(s)://` — o próprio proto dá o exemplo `www.example.com/cars`; sem espaço e sem outro esquema; vai para
  a API como veio, igual à versão anterior), domínio válido, meses válidos e em ordem. `limit` acima de 1000 continua virando 1000 (como antes); para mais, paginar.
- Saída ganhou `close_variants` e, com `includeMonthly`, `monthly_searches` (table/csv: um mês por coluna).
- Erro da API volta em PT-BR com dica (ex.: URL que o Google não conseguiu ler).

### get_keyword_historical_metrics (leitura, nova)
Volume, sazonalidade, concorrência e faixa de lance de **uma lista sua** (`:generateKeywordHistoricalMetrics`).
- Parâmetros: `keywords` (1–10.000), `languageCode` (default `pt`), `geoTargetIds` (default `2076`, até 10),
  `network`, `monthRange`, `includeMonthly` (default true), `includeDeviceBreakdown` (agregado por dispositivo).
- A API junta variantes próximas ("carro"/"carros"): cada linha traz `close_variants` e a resposta lista em
  `not_returned` as keywords pedidas que não voltaram com linha própria. Métrica ausente é `null`, não 0.

### forecast_search_campaign (leitura, nova)
Previsão de uma campanha de Pesquisa proposta (`:generateKeywordForecastMetrics`), **só no schema v24+**.
- Parâmetros: `keywords` (atalho de um grupo) ou `adGroups[].keywords` (texto ou `{text, matchType}`,
  `defaultMatchType` = BROAD), `languageCode`, `geoTargetIds`, `bidding` (MAXIMIZE_CLICKS default, MANUAL_CPC,
  MAXIMIZE_CONVERSIONS), `dailyBudgetMicros`, `maxCpcBidMicros`, `period {since, until}`, `scenarios[]` (até 5,
  cada um herda o que não informar — uma chamada por cenário).
- Regras do proto: MANUAL_CPC exige `maxCpcBidMicros`; MAXIMIZE_CLICKS e MAXIMIZE_CONVERSIONS exigem orçamento;
  MAXIMIZE_CONVERSIONS não aceita CPC. Keyword até 80 caracteres e 10 palavras. Período com início futuro e fim
  em até 1 ano; sem período a tool envia o default documentado (próximo domingo ao sábado seguinte, 7 dias) —
  a v25 recusa o pedido sem `forecastPeriod` ("The string date's format should be yyyy-mm-dd"), apesar da doc.
- Saída por cenário: cliques, custo, CPC médio (cliques/manual) ou conversões, CPA médio (Max. conversões), e
  médias por dia. Um cenário com erro não derruba os outros.
- Guardas de unidade: orçamento < 1.000.000 micros e CPC < 100.000 micros são recusados (valor em reais por engano).

### suggest_ad_group_themes (leitura, nova)
`:generateAdGroupThemes`: para cada keyword, o grupo de anúncios existente e o match type sugeridos.
- Parâmetros: `keywords`, `adGroupIds` (a API exige grupos existentes — são conferidos na conta antes; ID de
  outra conta ou removido é recusado sem chamar a API). Saída com nomes do grupo/campanha e os grupos que a
  API não pôde usar.

### list_recommendations (leitura, alterada) — item 22
- Com `campaignId`, faz duas consultas e junta sem duplicar: `recommendation.campaign = ...` e
  `recommendation.campaigns CONTAINS ANY (...)` — as de orçamento (CAMPAIGN_BUDGET, FORECASTING_CAMPAIGN_BUDGET,
  MARGINAL_ROI_CAMPAIGN_BUDGET, MOVE_UNUSED_BUDGET) só preenchem `campaigns`/`campaign_budget`.
- Seleciona as mensagens de detalhe de cada tipo e devolve em `details` o valor proposto: orçamento atual vs.
  recomendado e a tabela de opções com impacto; CPA/ROAS sugerido e orçamento exigido; keyword e lance;
  multiplicadores; contagem de sitelinks/callouts etc.
- Linhas de orçamento são rotuladas "orçamento X — campanhas: A, B" (nomes lidos numa consulta a `campaign`).
- `types` validado contra o enum da v25; `campaignId` numérico. Mostra `dismissed`.

### apply_recommendation (escrita, alterada) — item 80
- Novo `applications: [{ resourceName, overrides }]` (mantém `resourceNames` para aplicar com os valores do
  Google). `overrides` tem **um** parâmetro de `ApplyRecommendationOperation.apply_parameters`, conferido
  contra o tipo da recomendação lida na conta:
  `campaignBudget` (CAMPAIGN_BUDGET), `keyword` (KEYWORD: `adGroupId` + `matchType` obrigatórios,
  `cpcBidMicros` opcional), `targetCpaOptIn`, `targetRoasOptIn`, `moveUnusedBudget`, `useBroadMatchKeyword`,
  `raiseTargetCpaBidTooLow` (> 1.0), `raiseTargetCpa`, `lowerTargetRoas`, `setTargetCpa`, `setTargetRoas`,
  `forecastingSetTargetCpa`, `forecastingSetTargetRoas`. Micros como no resto do servidor; ROAS 0.01–1000.
- Fluxo: confirm → validação local (formato, conta, até 100, override) → dry-run recusado → leitura das
  recomendações (repete só as faltantes com `dismissed = TRUE`, já que dispensadas também podem ser aplicadas)
  → confere tipo x override e o grupo do override de keyword → aplica com `partialFailure` → relatório por
  item com `google_recommended` (o que o Google propunha) e `applied_with`.
- Continua exigindo `confirm: true` e continua **recusado em dry-run/validateOnly** (o endpoint não tem
  `validate_only`), sem ler nem gravar nada — a recusa mostra as operações que seriam enviadas.
- **Chave desconhecida recusa a chamada inteira, nunca vira "valores do Google"**. O `z.object` padrão descarta
  em silêncio o que não conhece: `overrides: { campaign_budget: {...} }` (snake_case do proto), `textAd`,
  `override` no singular ou `cpc_bid_micros` dentro de `keyword` chegavam vazios ao handler e a recomendação era
  aplicada com o valor do Google. Agora:
  - o item de `applications`, o `overrides` e cada parâmetro dele são objetos *strict* no schema (mensagem em
    PT-BR com os campos aceitos);
  - o handler confere de novo (item só com `resourceName`/`overrides`, um parâmetro conhecido, só campos
    conhecidos) — necessário porque `applications` enviado como **texto JSON** (`flexArray`) não passa os itens
    pelo schema;
  - `overrides: {}` é recusado (para os valores do Google, omita `overrides` ou use `resourceNames`);
  - `overrides` no nível de cima (fora de `applications`) é recusado com a forma certa — sem isso o SDK o
    descartaria e aplicaria o valor do Google.

### dismiss_recommendation (escrita, alterada)
Lê antes: recusa as que não existem na conta, pula as já dispensadas (no-op sem escrita), dispensa o resto com
`partialFailure` e relata por item. Formato/conta dos resource names e o limite de 100 conferidos antes. Recusado
em dry-run (sem `validate_only` no endpoint).

### generate_recommendations (leitura, nova) — item extra
`seedUrl` (`SeedInfo.url_seed`) aceita URL sem esquema como no exemplo do proto (`www.example.com/cars`);
`finalUrl` (URL final do grupo de recursos) continua exigindo `http(s)://`.

`recommendations:generate` para campanha de SEARCH ou PERFORMANCE_MAX **ainda não criada**: CAMPAIGN_BUDGET,
KEYWORD, MAXIMIZE_CLICKS/CONVERSIONS/CONVERSION_VALUE_OPT_IN, SET_TARGET_CPA/ROAS, SITELINK_ASSET,
TARGET_CPA/ROAS_OPT_IN.
- Como o Google não avisa quando faltam dados (só não devolve a recomendação), a tool confere os campos exigidos
  por tipo antes (tabela da doc "Recommendations in campaign construction"): CAMPAIGN_BUDGET pede
  `biddingStrategyType` e `finalUrl`, e em SEARCH também países, idiomas, localizações, keywords do grupo e
  `targetImpressionShare` com TARGET_IMPRESSION_SHARE; KEYWORD pede sementes; os de lance pedem
  `biddingStrategyType` + status de conversão (lido de `customer.conversion_tracking_setting` se não vier);
  SITELINK_ASSET pede `sitelinkCount`. `merchantCenterAccountId` só em PMax; alvo (CPA/ROAS/IS) é `oneof` e
  precisa combinar com a estratégia.
- Saída: recomendações com o mesmo `details` de `list_recommendations` e a lista de tipos que voltaram vazios.
- Não altera `create_campaign`/`create_pmax_campaign` (outros lotes): o fluxo é chamar esta tool antes.

### list_recommendation_subscriptions (leitura, nova) — item 68
Lê `recommendation_subscription` (tipo, status, criação, modificação) de uma conta (`customerId`) ou de todas
as contas acessíveis (`allAccounts: true`, via `listChildAccounts`, filtradas pela allowlist, até 100). Filtro
opcional por `status`.

### set_recommendation_subscription (escrita, nova) — item 68
`recommendationSubscriptions:mutateRecommendationSubscription` para os 15 tipos que aceitam auto-aplicação.
- `types[]`, `status` ENABLED|PAUSED; **ligar exige `confirm: true`** (o Google passa a alterar a conta
  sozinho); pausar não exige.
- Lê as assinaturas antes: status igual → pulado; existente → `update` com o resource name devolvido pela API e
  `updateMask: "status"`; inexistente → `create` só para ligar (pausar o que não existe é no-op).
- `partialFailure` com relatório por tipo. validateOnly funciona de verdade: o endpoint tem `validate_only`,
  então em dry-run a chamada vai com `validateOnly: true` (por `customerAction`, já que `customerWriteAction`
  recusa ações sem suporte em dry-run) — a API valida e nada é gravado.

### get_change_history (leitura, alterada) — item 68
- Filtros novos: `clientTypes` (enum `ChangeClientType` completo da v25, valores 2–14, incluindo
  `SEARCH_ADS_360_SYNC` e `SEARCH_ADS_360_POST`), `autoAppliedOnly` (= `GOOGLE_ADS_RECOMMENDATIONS_SUBSCRIPTION`),
  `resourceTypes`, `operations` (CREATE/UPDATE/REMOVE), `userEmail` (exato), `campaignId`, `adGroupId`.
- Diff por campo: `changed_fields` × `old_resource`/`new_resource` do recurso certo → `changes: [{field, old, new}]`
  (campos `*_micros` mostram também o valor em moeda). table/csv: uma linha por campo alterado.
  `includeRawResources` devolve os payloads completos; `summaryOnly` só as contagens por origem, recurso,
  operação e usuário.
- Paginação além de 10.000 (máximo da API por consulta): reconsulta com `change_date_time <` segundo seguinte
  ao da última linha e descarta as repetidas pelo `resource_name`; `limit` até 50.000. As alterações já lidas
  no segundo da fronteira voltam no topo da página seguinte, então o `LIMIT` dela é "o que falta + essas
  repetidas" (teto 10.000) — uma edição em massa na fronteira não consome mais a página nem para a paginação
  antes do limite. O aviso "Paginação interrompida" só aparece quando uma página inteira de 10.000 cai no mesmo
  segundo (não há como avançar pelo horário), quando o horário da última linha vem num formato inesperado ou
  após 10 consultas — e a mensagem diz qual dos três motivos foi.
- Janela de datas continua a do helper `buildChangeEventDateClause` (29 dias; do lote diagnostics).

## Fluxos

1. **"Devo aumentar o orçamento desta campanha?"** → `list_recommendations {campaignId, types:[CAMPAIGN_BUDGET]}`
   mostra atual vs. recomendado e as opções → `apply_recommendation {applications:[{resourceName, overrides:
   {campaignBudget:{newBudgetAmountMicros}}}], confirm:true}` com o valor escolhido.
2. **"O que o Google mudou sozinho este mês?"** → `list_recommendation_subscriptions {allAccounts:true, status:ENABLED}`
   → `get_change_history {autoAppliedOnly:true, days:29}` → `set_recommendation_subscription {types:[...],
   status:PAUSED}` para desligar.
3. **Plano de mídia / pitch** → `generate_keyword_ideas` (ou `siteSeed` do cliente) → `get_keyword_historical_metrics`
   (sazonalidade da lista final) → `suggest_ad_group_themes` (conta existente) → `forecast_search_campaign` com
   cenários de orçamento.
4. **Construção de campanha** → `generate_recommendations` (orçamento/lance/keywords sugeridos) → `create_campaign`
   / `create_pmax_campaign`.

## O que ficou parcial e por quê

- **Overrides de recomendações de ativos/anúncios** (`callout_asset`, `sitelink_asset`, `call_asset`,
  `lead_form_asset`, `text_ad`, `responsive_search_ad*`, `callout/call/sitelink_extension`): exigem objetos
  `Asset`/`Ad` completos; não foram expostos. Essas recomendações continuam aplicáveis com os valores do Google.
- **Override de orçamento em FORECASTING_CAMPAIGN_BUDGET e MARGINAL_ROI_CAMPAIGN_BUDGET**: o proto só documenta
  `campaign_budget` para "campaign budget recommendation" e a doc diz que parâmetros que não se aplicam ao tipo
  são ignorados — ou seja, a API aplicaria o valor do Google em silêncio. Por segurança a tool recusa; para
  esses tipos, dispense e use `update_budget` com o seu valor.
- **apply/dismiss em validateOnly**: os endpoints não têm `validate_only`; a chamada é recusada (fail-closed),
  com a prévia das operações.
- **Previsão**: a v24+ removeu impressões, CTR, valor de conversão, negativas, rede e lance por grupo
  (`CriterionBidModifier`, `keyword_plan_network`, `negative_keywords`, `ForecastAdGroup.max_cpc_bid_micros`);
  não há como pedi-los.
- **change_event**: só os últimos 29 dias, nem toda mudança gera evento e mudanças do Google Ads Editor não
  aparecem (a tool avisa quando `GOOGLE_ADS_EDITOR` é filtrado); para isso a API indica `change_status`.
- **Dispensadas em list_recommendations**: a tool não filtra por `dismissed`; o campo aparece em cada linha.
