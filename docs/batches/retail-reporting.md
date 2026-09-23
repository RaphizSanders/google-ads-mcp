# Lote retail-reporting — relatórios de varejo, status de produtos, canais do PMax e listas de marcas

Módulo: `src/tools/retail-reporting.ts` (`registerRetailReportingTools`), catálogo em
`src/tools/retail-reporting.catalog.ts`, testes em `tests/retail-reporting.test.ts`.

Todas as queries foram validadas contra os metadados reais da v25
(`tests/fixtures/google-ads-v25-fields.json`) e todos os payloads conferidos nos protos oficiais da
v25 (`resources/shopping_product`, `shared_set`, `shared_criterion`, `campaign_criterion`,
`ad_group_criterion`, `campaign`, `common/criteria`, `services/brand_suggestion_service`,
`services/google_ads_service`, `errors/criterion_error`, `errors/campaign_criterion_error`).

## Resumo

| Tool | Tipo | Item |
|---|---|---|
| `get_pmax_channel_performance` | leitura | #32 PMax por canal |
| `get_product_status` | leitura | #33 status e problemas de produtos |
| `get_shopping_products` (alterada, movida para o módulo) | leitura | #71 |
| `get_listing_group_performance` | leitura | #71 |
| `get_cart_data_sales` | leitura | #71 |
| `suggest_brands` | leitura | #51 |
| `list_brand_lists` | leitura | #51 |
| `create_brand_list` | escrita | #51 |
| `update_brand_list` | escrita | #51 |
| `attach_brand_list` | escrita | #51 |
| `detach_brand_list` | escrita | #51 |

Nenhuma escrita é encadeada: `create_brand_list` e `attach_brand_list` usam uma única chamada
atômica (`googleAds:mutate` com ID temporário), então `validateOnly: true` funciona em todas.

---

## #32 — `get_pmax_channel_performance` (leitura)

Onde o Performance Max gasta e converte, por canal (`segments.ad_network_type`, API v23+):
Pesquisa Google, Parceiros de pesquisa, Display (`CONTENT`), YouTube, Gmail, Discover, Maps, Google
TV, `MIXED` (cross-network, sem canal atribuído) e `GOOGLE_OWNED_CHANNELS` (agrupamento histórico).

Parâmetros principais:
- `level`: `campaign` (default, `FROM campaign`), `asset_group` (`FROM asset_group`) ou `asset`
  (`FROM asset_group_asset`; exige `campaignId` ou `assetGroupId`).
- `campaignId`, `assetGroupId`, `dateRange`/`days`, `format` (json/table/csv).
- `splitByProductData` / `splitByVideo`: separam anúncios que usaram dados do feed e/ou vídeo
  (`segments.ad_using_product_data` / `ad_using_video`, v22+). **Só em `level=campaign`** — os
  metadados da v25 só expõem esses segmentos em `FROM campaign`; nos outros níveis a tool recusa.

Saída: total, resumo por canal (gasto, impressões, cliques, CTR, conversões, valor, ROAS, CPA e
`share_of_spend_pct`) e, por campanha/grupo/asset, a mesma divisão com o % do gasto daquele item.
Avisa quando parte do gasto veio como `MIXED`.

**`level=asset` — as métricas por asset não somam.** O Google conta a métrica de asset uma vez para
cada asset exibido no anúncio: uma impressão que mostrou título + descrição registra a impressão (e o
custo) nos dois, então a soma dos assets passa do total do grupo de recursos
(support.google.com/google-ads/answer/16259414). Por isso, nesse nível:
- as linhas de asset (`itens`, e as linhas de `table`/`csv`) trazem só os números de cada asset e a
  divisão por canal dentro daquele asset;
- o **total** (cabeçalho "gasto total …" e `total`) e o **resumo por canal** (`por_canal`,
  `share_of_spend_pct`, "Canal com mais gasto") vêm de uma segunda consulta, `FROM asset_group`
  segmentada por `segments.ad_network_type`, com os mesmos filtros (PMax, `campaignId`,
  `assetGroupId`, período) — nunca da soma dos assets. O JSON traz `origem_do_total` e uma nota
  explicando isso.
Nos níveis `campaign` e `asset_group` as linhas não se sobrepõem e o total é a soma delas (uma consulta).

Não feito: o `segmentBy=channel` opcional em `get_campaign_performance` e
`get_asset_group_performance` — essas tools não pertencem a este lote (ficam em `src/tools.ts`);
`get_pmax_channel_performance` cobre o mesmo dado nos níveis campanha e grupo de recursos.

## #33 — `get_product_status` (leitura)

"Por que meu produto não aparece?" a partir de `shopping_product` (estado **atual** do produto,
tenha ou não veiculado — diferente de `shopping_performance_view`, que só tem histórico).

Parâmetros: `campaignId`, `adGroupId` (exige `campaignId`), `status`
(`ELIGIBLE`/`ELIGIBLE_LIMITED`/`NOT_ELIGIBLE`, filtrado no GAQL), `severity` (`ERROR`/`WARNING`,
filtrado aqui — `issues` não é filtrável), `itemIds` (até 500, escapados), `dateRange`/`days`
(janela das impressões), `limit` (amostras, 1–200), `format`.

Escopos (doc do recurso na v25):
- conta (sem filtro): todos os produtos dos Merchant Centers vinculados; métricas somam Shopping + PMax;
- campanha: `shopping_product.campaign = 'customers/{cid}/campaigns/{id}'` — Shopping, PMax,
  Demand Gen, Vídeo, App; a tool lê a campanha antes e recusa outros tipos;
- grupo de anúncios: `campaign` + `ad_group` — Shopping, Demand Gen, Vídeo, App (PMax recusado).

Saída: total e contagem por status, fora de estoque, principais problemas agrupados por
`error_code` + severidade (descrição, atributo, link de ajuda, nº de produtos afetados, regiões,
exemplos), amostra de produtos com problema (NOT_ELIGIBLE primeiro) e **elegíveis sem impressão**
no período.

Limites e cuidados:
- data só no `WHERE` (selecionar `segments.date` dá `UNSUPPORTED_DATE_SEGMENTATION`);
- `effective_max_cpc_micros` e `shopping_product.campaign` só são pedidos no escopo de campanha;
- Demand Gen, Vídeo e App: no escopo de campanha/grupo a API só aceita impressões e cliques — a
  tool não pede custo/conversões nesses casos;
- App: sem `status`/`issues` (notas da v24) — a tool não os seleciona e recusa `status`/`severity`;
- status e problemas podem levar até 24h para atualizar; na conta inteira a consulta é pesada.

## #71 — relatórios de varejo

### `get_shopping_products` (leitura, alterada)

**Movida** de `src/tools.ts` para o módulo (o bloco antigo virou um comentário apontando para cá) e
continua classificada como leitura em `src/read-only.ts`. Sem opções, a saída é a mesma de antes
(`title, item_id, clicks, impressions, spend, conversions, revenue, roas`; `revenue` = valor de
conversão). Única diferença visível: `conversions` sai arredondado em 2 casas.

Novos parâmetros:
- `campaignId`; `channelType` (`SHOPPING`, `PERFORMANCE_MAX`, `DEMAND_GEN`, `VIDEO`, `DISPLAY`,
  `MULTI_CHANNEL`) — `campaign` é recurso de segmentação da view, então o campo filtrado vai no
  `SELECT`;
- `groupBy`: `item` | `brand` | `category_l1..l5` | `type_l1..l5` | `custom_label0..4` | `channel` |
  `feed_label` (categorias viram nome pt-BR via `product_category_constant`);
- `includeProfit`: receita, lucro bruto, COGS, unidades e pedidos (conversões com dados do carrinho)
  + `margin_pct`, `poas` (lucro bruto ÷ gasto) e `profit_after_ads` (lucro bruto − gasto);
  `orderBy: "profit"` liga o lucro sozinho. Sem dado de carrinho, avisa;
- `includeImpressionShare`: IS, perda por orçamento e por classificação, click share (rede de Pesquisa);
- `format`.

Agregação: com `channelType` sem `campaignId`, cada linha vem por campanha — a tool agrega por
grupo antes de ordenar/cortar (consulta com teto de 50.000 linhas; avisa se bater). IS agregado de
várias linhas vira média ponderada por impressões (marcado como aproximação).

### `get_listing_group_performance` (leitura, nova)

Métricas por grupo de produtos: PMax via `asset_group_product_group_view`, Shopping padrão via
`product_group_view`. Informe `campaignId` (o tipo da campanha escolhe a view), `assetGroupId` (PMax)
ou `adGroupId` (Shopping). Cada nó sai com o caminho legível do `path` (ex.: `Marca: Nike > Tipo L1:
Tênis`, `(outros)` para o "everything else", categorias com nome pt-BR), tipo (`SUBDIVISION`,
`UNIT_INCLUDED/EXCLUDED`, `UNIT`/`UNIT (excluído)`), lance (Shopping) e métricas; `includeProfit`,
`onlyUnits`, `limit`, `format`. Nós `SUBDIVISION` agregam os filhos — não somar.

### `get_cart_data_sales` (leitura, nova)

`cart_data_sales_view` (v24+): vendas por produto **vendido** (`perspective: "sold"`, default,
`product_sold_*`) ou pelo produto do anúncio **clicado** (`"clicked"`). `groupBy` como acima
(`channel`/`feed_label` só no clicado — não existe `product_sold_channel`). Métricas: receita, lucro
bruto, COGS, margem, unidades, `lead_*` (mesmo produto) e `cross_sell_*` (outro produto na mesma
compra). A view não tem custo nem cliques — para ROAS/POAS use `get_shopping_products` com
`includeProfit`. View vazia → aviso de que a conta não envia conversões com dados do carrinho.

## #51 — listas de marcas (shared set `BRANDS`)

### `suggest_brands` (leitura)
`POST /v25/customers/{cid}:suggestBrands` (`BrandSuggestionService`, via `customerAction`, que não
grava). `prefix` (obrigatório) e `excludeBrandIds` (`selectedBrands`). Devolve `id` (MID do
Knowledge Graph — é ele que vai nas listas), nome, URLs e estado (`ENABLED`, `UNVERIFIED`, ...).

### `list_brand_lists` (leitura)
Listas `BRANDS` (ativas por padrão; `includeRemoved`), marcas de cada uma
(`shared_criterion.brand`: entity_id, nome, URL, estado, motivo de rejeição) e onde estão anexadas:
campanhas (`campaign_criterion.brand_list`, modo INCLUDE/EXCLUDE, override de Shopping do PMax ou do
Shopping) e grupos de anúncios (`ad_group_criterion.brand_list`). Avisa marcas `DEPRECATED`,
`CANCELLED` ou `REJECTED` (sem efeito).

### `create_brand_list` (escrita)
Uma chamada atômica: `sharedSetOperation.create` (`type: BRANDS`, `resourceName` temporário
`.../sharedSets/-1`) + um `sharedCriterionOperation.create` (`brand.entityId`) por marca. Recusa antes
de gravar: nome vazio/ > 255 bytes, lista ativa com o mesmo nome, `brandIds` vazio ou inválido
(ids repetidos são unidos). Erros da API traduzidos (ex.: `CANNOT_RECOGNIZE_BRAND` → "use o id de
suggest_brands"). Em dry-run/validateOnly responde "validado, nada foi gravado".

### `update_brand_list` (escrita)
`add`, `remove` (id da marca ou `criterion_id`) e/ou `name`. Lê a lista antes (existe, é `BRANDS`,
está ativa) e as marcas: não readiciona presentes, não remove ausentes; sem mudança não grava.
**Remover exige `confirm: true`** (sem ele mostra o plano e não grava). Marcas via
`sharedCriteria:mutate` com `partialFailure` e relatório por item; renomear via
`sharedSets:mutate` com `updateMask: "name"` (checa nome duplicado antes).
Em dry-run/validateOnly as mesmas operações vão com `validate_only`, a resposta diz "DRY-RUN
(validateOnly): validado, nada foi gravado" e o resultado usa `adicionariam` / `removeriam` /
`renomearia` (nunca "atualizada", "adicionadas", "removidas" ou "renomeada").

### `attach_brand_list` (escrita)
Anexa a lista a uma campanha (`campaign_criterion.brand_list`, `negative` = EXCLUDE) ou a um grupo
de anúncios (`ad_group_criterion.brand_list`). Lê lista, alvo e anexos atuais antes. Regras por
canal (dos enums de erro da v25 e dos guias), conferidas antes de gravar:
- Pesquisa: EXCLUDE sempre; INCLUDE só com AI Max ligado (ou broad match de campanha, legado) —
  `CANNOT_ATTACH_BRAND_LIST_TO_NON_QUALIFIED_SEARCH_CAMPAIGN`; com
  `ai_max_setting.bundling_required = REQUIRED` qualquer lista exige AI Max ligado;
- grupo de anúncios (Pesquisa): só INCLUDE (`ONLY_INCLUSION_BRAND_LIST_ALLOWED_FOR_AD_GROUPS`);
- Performance Max: só EXCLUDE (guia de critérios do PMax, `ONLY_EXCLUSION_BRAND_LIST_ALLOWED_FOR_CAMPAIGN_TYPE`);
- Shopping: só EXCLUDE (o campo `ignore_brand_exclusion_in_shopping_ads` existe para ela);
- outros tipos, campanha/grupo removido: recusado.

`ignoreExclusionsForShoppingAds` (só campanha PMax/Shopping) liga/desliga o override que ignora as
exclusões de marca nos anúncios de Shopping: PMax →
`pmax_campaign_settings.brand_targeting_overrides.ignore_exclusions_for_shopping_ads`; Shopping →
`shopping_setting.ignore_brand_exclusion_in_shopping_ads` (v24.2). updateMask só com a folha.
Critério + override vão numa única chamada atômica; o que já está igual é pulado (nada a fazer =
nada gravado). Lista já anexada no modo oposto → pede `detach_brand_list` (`negative` é imutável).

### `detach_brand_list` (escrita)
Remove o critério `BRAND_LIST` da campanha/grupo. **Exige `confirm: true`**; sem anexo = nada a
fazer. A lista continua existindo. Em dry-run/validateOnly o `remove` vai com `validate_only` e a
resposta diz "DRY-RUN (validateOnly): validado, nada foi gravado. A lista … sairia da …", com
`seriam_removidos` no lugar de `removidos` (nunca "desanexada").

## Fluxos

1. Excluir a própria marca de um PMax de prospecção:
   `suggest_brands(prefix)` → `create_brand_list(name, [id])` →
   `attach_brand_list(campaignId, sharedSetId, mode: "EXCLUDE")` (e, se quiser que o Shopping do
   PMax ignore a exclusão, `ignoreExclusionsForShoppingAds: true`).
2. Restringir uma campanha de Pesquisa com AI Max às buscas da marca: `set_ai_max_settings`
   (ligar) → `attach_brand_list(mode: "INCLUDE")`.
3. Diagnóstico de feed: `get_product_status(campaignId, severity: "ERROR")` → corrigir no Merchant
   Center conforme `documentacao` → depois `get_product_status` de novo (até 24h).
4. Varejo por lucro: `get_shopping_products(groupBy: "brand", includeProfit: true, orderBy: "profit")`
   → `get_listing_group_performance(campaignId)` para ver o grupo de produtos →
   `get_cart_data_sales(perspective: "sold")` para cross-sell.

## Parcial / limites conhecidos

- `segmentBy=channel` em `get_campaign_performance`/`get_asset_group_performance`: não feito (tools
  de outro dono); coberto por `get_pmax_channel_performance`.
- Regra "Shopping só EXCLUDE" em `attach_brand_list` e "grupo só em Pesquisa": derivadas da
  documentação (override existe só para exclusões; brand list em grupo é controle do AI Max em
  Pesquisa). Se a API liberar outros casos, é só afrouxar `brandListRuleError`.
- Nenhuma chamada real à API foi feita (sem credenciais): payloads, caminhos REST e enums vêm dos
  protos v25; queries dos metadados v25.
