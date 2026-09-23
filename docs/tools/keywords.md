# Lote keywords — Palavras-chave, termos de pesquisa e DSA

Módulo: `src/tools/keywords.ts` (catálogo em `src/tools/keywords.catalog.ts`). Tools do núcleo
alteradas em `src/tools.ts`: `get_search_terms`, `get_keyword_performance`, `create_keyword`,
`remove_keyword`, `update_keyword` (só descrição) e `create_ad_group`.

Testes: `tests/keywords.test.ts` (44 testes; toda query passa pelo validador de GAQL com os
metadados reais da v25, toda escrita é registrada). As guardas principais passaram por teste de
mutação: cada uma foi quebrada de propósito e o teste falhou.

## Tools novas

### `list_keywords` — leitura

Lista palavras-chave a partir de `ad_group_criterion`, portanto **inclusive as sem impressão**,
com tudo o que as outras tools precisam para encadear:

- IDs: `criterion_id`, `ad_group_id`, `campaign_id` (entrada de `update_keyword`,
  `remove_keyword` e `bulk_update_keyword_status`);
- status, `primary_status` e `primary_status_reasons` (ex.: `AD_GROUP_CRITERION_BELOW_FIRST_PAGE_BID`,
  `AD_GROUP_CRITERION_RARELY_SERVED`, `AD_GROUP_CRITERION_PAUSED_DUE_TO_LOW_ACTIVITY`),
  `approval_status`, `system_serving_status`;
- Índice de Qualidade e componentes: `ad_relevance` (creative_quality_score),
  `landing_page_experience` (post_click_quality_score), `expected_ctr` (search_predicted_ctr);
- lance, lance efetivo e estimativas de 1ª página, topo e 1ª posição (`position_estimates`);
- URL final e a estratégia de lance da campanha;
- coluna `fix` com o que corrigir: `LP` (página de destino), `AD` (relevância do anúncio),
  `CTR` (CTR esperada), `BID` (abaixo da 1ª página — pelo motivo da API ou, em CPC manual, lance
  efetivo menor que a estimativa), `VOLUME` (raramente veiculada / pausada por baixa atividade),
  `POLICY` (reprovada/restrita), `NEGATIVE` (bloqueada por negativa da campanha), `QS` (baixo sem
  componente abaixo da média), mais a explicação em `diagnosis`.

Parâmetros: `campaignId`, `adGroupId`, `status` (ALL/ENABLED/PAUSED; removidas nunca), `onlyIssues`,
`includeNegatives`, `includeMetrics` + `dateRange`/`days` (segunda consulta em `keyword_view`,
zeros para quem não teve tráfego), `limit` (default 500, teto 10.000), `format` json/table/csv.
Resumo por `primary_status` e por código de `fix` no topo.

**`onlyIssues` em conta grande.** O `fix` é calculado depois que as linhas chegam, então a busca
precisa ver todas as palavras-chave do filtro:

1. uma varredura com teto de 10.000 linhas; se vier abaixo do teto, ela viu tudo
   (`summary.scan.mode = "full"`, cabeçalho "varredura completa de N palavra(s)-chave");
2. se bater no teto, a tool faz **uma consulta por condição de problema** (GAQL não tem `OR`), cada
   uma com os mesmos filtros da chamada e o próprio teto de 10.000 — assim o teto vale para as
   candidatas, não para a conta: `post_click_quality_score`, `creative_quality_score` ou
   `search_predicted_ctr` = `BELOW_AVERAGE`; `primary_status_reasons CONTAINS ANY (...)` com os 7
   motivos que o diagnóstico usa; `system_serving_status = RARELY_SERVED`; `approval_status =
   DISAPPROVED`; e estratégia manual com `first_page_cpc_micros > 0` (heurística de lance). Juntas
   cobrem todos os ramos do diagnóstico (há teste que confere cada ramo e a lista de motivos contra
   o enum v25). União por `ad_group_id~criterion_id`, ordenada por campanha, grupo e texto
   (`summary.scan.mode = "targeted"`);
3. se alguma consulta dirigida também bater no teto, a resposta **começa com "ATENÇÃO — busca
   INCOMPLETA"**, nomeia as condições cortadas (`summary.scan.truncated_checks`,
   `summary.scan.complete = false`) e pede filtro por `campaignId`/`adGroupId` ou percorrer campanha
   a campanha. "0 palavra(s)-chave com problema" só aparece quando a busca foi completa.

Quando há mais palavras-chave com problema que `limit`, o cabeçalho diz quantas foram achadas e que
está mostrando só `limit`.

### `add_keywords` — escrita

Várias palavras-chave num grupo, numa única mutação `adGroupCriteria:mutate` com
`partialFailure` (as válidas entram, cada recusada volta com o motivo e o código de erro).

- Valida tudo **antes** da API e recusa a chamada inteira se algum item for inválido: texto até
  80 caracteres e 10 palavras (limites do `KeywordInfo` no proto v25), sem colchetes/aspas (a
  correspondência vai em `matchType`), sem `+modificador` (`BROAD_MATCH_MODIFIER_KEYWORD_NOT_ALLOWED`),
  sem `-` inicial (negativa), `matchType` EXACT/PHRASE/BROAD, lance inteiro positivo em micros,
  URL http(s). Até 1.000 por chamada (a API aceita 10.000 operações por request).
- Lê antes de gravar: o grupo precisa existir, não estar removido e ser `SEARCH_STANDARD` ou
  `DISPLAY_STANDARD` (DSA não aceita palavra-chave positiva; Shopping etc. não usam).
- Pula o que já existe no grupo (mesmo texto normalizado e correspondência), **inclusive pausada —
  nunca reativa**; pula repetidas no próprio pedido. Tudo existente → nenhuma escrita.
- Avisos: lance ignorado por estratégia automática, lance muito baixo, texto que também é
  negativa no grupo, grupo/campanha pausado.
- Parâmetros: `adGroupId`, `keywords[{text, matchType, cpcBidMicros?, finalUrl?}]`, `status`
  (default ENABLED). Dry-run/validateOnly relatam `validated`, nunca `created`.

### `bulk_update_keyword_status` — escrita

Pausa ou ativa várias palavras-chave (`"adGroupId~criterionId"` ou o resource name). Confere cada
uma na conta (`ad_group_criterion.resource_name IN (...)`), pula as que já estão no status pedido,
as removidas, as negativas e o que não é palavra-chave; relata as não encontradas. Uma mutação com
`updateMask: status` e `partialFailure`. **Mais de 20 mudanças exigem `confirm: true`**; ao ativar,
avisa quando o grupo/campanha está pausado. Referência inválida ou de outra conta é recusada antes
de qualquer chamada.

### `get_search_term_insights` — leitura

Search term insights: categorias e subcategorias de pesquisa com volume (faixa `min–max` de
`metrics.search_volume`), impressões, cliques, CTR, conversões, taxa de conversão e valor, ordenadas
por conversão. Cobre Pesquisa e Performance Max. Dados desde março de 2023.

- `level: "account"` (default) → `customer_search_term_insight`, o nível que o Google recomenda
  consultar primeiro; com `campaignId`, filtra pelo segmento `segments.campaign` (selecionado junto,
  como o GAQL exige).
- `level: "campaign"` → `campaign_search_term_insight`, sempre com `campaign_search_term_insight.campaign_id`.
  Se a API responder `RESOURCE_EXHAUSTED` mesmo depois das novas tentativas do client, a tool volta
  para o nível de conta filtrado pela campanha e avisa.
- Abrir uma categoria: `categoryId` (o `category_id` de uma linha) + `includeSubcategories` e/ou
  `includeTerms` — filtro por campanha + id da categoria, como o suporte do Google indica.
  Com `includeTerms` a query não pede `search_volume` (a métrica não é selecionável com
  `segments.search_term`, segundo a field reference). No nível de conta, `segments.campaign` não
  combina com subcategoria/termo — a tool recusa e indica `level: "campaign"`.

### `audit_dsa_and_legacy` — leitura

Inventário para a migração de DSA e das estruturas legadas para AI Max:

- campanhas de Pesquisa com `dynamic_search_ads_setting` (domínio, idioma, só URLs fornecidas),
  AI Max ligado ou não, estratégia;
- **page feeds do DSA** (`page_feeds` em cada campanha): no DSA o page feed é baseado em assets —
  assets `PageFeedAsset` agrupados num `AssetSet` do tipo `PAGE_FEED` e vinculados à campanha por
  `CampaignAssetSet` (guia oficial "Dynamic Search Ads Page Feeds"; `AssetSetType.PAGE_FEED = 2`).
  A tool lê `campaign_asset_set` com `asset_set.type = 'PAGE_FEED'` e vínculo não removido (só
  quando há DSA) e lista id, nome e status do asset set e do vínculo; `summary.dsa_page_feeds` conta;
- grupos `SEARCH_DYNAMIC_ADS`, alvos de página (`ad_group_criterion.webpage`: condições, cobertura
  em %, exemplos de URL) e critérios de página na campanha: exclusões `WEBPAGE` e listas
  `WEBPAGE_LIST` (campo `webpage_list_shared_set`). `WEBPAGE_LIST` **não é o page feed do DSA** —
  é uma lista de páginas em shared set que o proto v25 marca como "not publicly available";
- principais termos do DSA (`dsa_top_search_terms`): os **1.000 de maior custo** do período
  (`dynamic_search_ads_search_term_view`, só consultado se houver DSA);
- páginas de destino do DSA (`dsa_top_landing_pages`): consulta própria na mesma view, só com a
  página e as métricas, que soma **todas** as linhas termo × página do período (teto de 50.000
  linhas). `term_rows` = quantas linhas termo × página somaram na página;
- `data_notes`: diz de onde vieram os números e avisa quando algo foi limitado (termos acima de
  1.000; linhas de página acima de 50.000) — nesse caso o cabeçalho também avisa;
- correspondência ampla no nível da campanha (`campaign.keyword_match_type = BROAD`) e campanhas
  já migradas pelo Google (`aca_migration_date_time`, `broad_match_migration_date_time`);
- recomendações: DSA sem AI Max, só URLs fornecidas (`use_supplied_urls_only`) sem page feed ativo
  vinculado, alvos com cobertura < 10%, termos de DSA que convertem sem palavra-chave (candidatos a
  `add_keywords`; quando os termos passam de 1.000, a frase diz "entre os 1.000 de maior custo") e
  páginas com gasto e sem conversão (candidatas a exclusão de URL) — **só emitida quando a soma por
  página está completa**: com a soma no teto, a cauda longa pode ter as conversões da página, então a
  recomendação não sai e `data_notes` explica.

Cronograma usado (Google Ads Developer Blog, 11/06/2026 e 12/08/2026): criação de DSA restaurada em
15/06/2026 e encerrada em janeiro de 2027; automigração dos DSA em fevereiro de 2027; ampla no nível
da campanha e ACA migradas automaticamente em setembro de 2026 (criação bloqueada desde 03/08/2026).

## Tools existentes alteradas

### `get_search_terms` — leitura

`search_term_view` não tem dados de Performance Max. Agora há duas visões, e a resposta diz qual
foi usada:

- `view: "ad_group"` → `search_term_view` (por grupo), com `campaign_id`, `ad_group_id` e, com
  `includeKeyword`, a palavra-chave que acionou (`segments.keyword.info.*`);
- `view: "campaign"` → `campaign_search_term_view` (Pesquisa + PMax, por campanha), com
  `segments.search_term_targeting_status` no lugar do status. Sem `ad_group.*` (recurso de
  segmentação desta view; PMax não tem grupo) e sem segmentos de palavra-chave (tiram o PMax do
  resultado, segundo o proto e o guia de PMax).
- `view: "auto"` (default): `campaign` quando a campanha é `PERFORMANCE_MAX` (uma consulta ao canal
  quando há `campaignId`) ou quando `matchSources` pede `PERFORMANCE_MAX`; senão `ad_group` — e o
  cabeçalho avisa que o PMax ficou de fora e como incluir.
- Combinações que nunca devolveriam PMax são recusadas: `view ad_group` + `PERFORMANCE_MAX`,
  `view ad_group` em campanha PMax, `includeKeyword` na visão de campanha.
- `limit` validado; `format` json/table/csv. O formato JSON padrão continua um array após o
  cabeçalho (compatível com o teste de AI Max).

### `get_keyword_performance` — leitura

Passa a devolver `criterion_id`, `ad_group_id` e `campaign_id`; novo filtro `adGroupId`; novo
`diagnostics: true` com os mesmos campos e a coluna `fix` de `list_keywords`; `format`
json/table/csv. `campaignId`/`adGroupId` agora são validados como numéricos (antes o `campaignId`
entrava cru na GAQL) e `limit` como inteiro positivo. Continua só com palavras-chave com impressão
no período — a descrição aponta `list_keywords` para as demais.

### `create_keyword` — escrita

Delegada ao mesmo núcleo do `add_keywords` (import dinâmico de `src/tools/keywords.ts` dentro do
handler, para não mexer no bloco de imports de `tools.ts`): mesma validação, checagem do grupo,
sem duplicar (existente/pausada → nenhuma escrita) e relatório com `criterion_id`. Novo parâmetro
opcional `finalUrl`.

### `remove_keyword` — escrita

Remoção é irreversível: agora valida IDs, lê a palavra-chave antes (texto, grupo, campanha), recusa
critério que não seja `KEYWORD`, trata já removida como no-op e **exige `confirm: true`** — sem ele,
mostra o que seria removido e não grava. Dry-run relata validação.

### `create_ad_group` — escrita

- `SEARCH_DYNAMIC_ADS` só é aceito em campanha SEARCH com `dynamic_search_ads_setting.domain_name`
  (a API recusa com `CANNOT_ADD_ADGROUP_OF_TYPE_DSA_TO_CAMPAIGN_WITHOUT_DSA_SETTING`); sem domínio, a
  tool recusa antes e aponta AI Max. Com domínio, cria e avisa que o grupo não aceita palavra-chave
  positiva, que anúncios DSA e alvos de página não são criados por este servidor e o cronograma de
  descontinuação.
- `type` explícito de outro canal (ex.: `SEARCH_STANDARD` em campanha DISPLAY) é recusado antes.
- Em dry-run a mensagem diz "validado, nada foi gravado" em vez de "created".

### `update_keyword` — escrita

Só a descrição de `criterionId` passou a apontar `list_keywords`.

## Fluxos

- **Minerar negativas com PMax junto:** `get_search_terms { view: "campaign", days: 30 }` →
  `add_negative_keyword`. Para o detalhe por grupo/palavra-chave em Pesquisa:
  `get_search_terms { view: "ad_group", includeKeyword: true }`.
- **O que o PMax / a ampla estão comprando:** `get_search_term_insights {}` (conta) →
  `{ campaignId }` → `{ level: "campaign", campaignId, categoryId, includeTerms: true }`.
- **Limpar palavras-chave:** `list_keywords { onlyIssues: true, includeMetrics: true }` →
  `update_keyword` (lance/URL) ou `bulk_update_keyword_status { status: "PAUSED" }`; remover de vez
  com `remove_keyword { confirm: true }`. Se a resposta começar com "ATENÇÃO — busca INCOMPLETA",
  repita por `campaignId` (IDs em `get_campaign_performance`) até cada chamada vir completa.
- **Expandir:** termos que convertem (`get_search_terms`, `audit_dsa_and_legacy`) →
  `add_keywords` (pula o que já existe).
- **Migração DSA → AI Max:** `audit_dsa_and_legacy` → `set_ai_max_settings` / experimento →
  `add_keywords` com os termos vencedores.

## Correções da revisão (branch `batch/keywords-fix`)

- `list_keywords { onlyIssues }` parava em 10.000 palavras-chave varridas sem avisar e podia
  responder "0 palavra(s)-chave." numa conta grande. Agora: varredura → consultas dirigidas por
  problema → aviso explícito de busca incompleta (detalhes em `list_keywords`).
- `audit_dsa_and_legacy` chamava `WEBPAGE_LIST` de page feed e não lia os page feeds reais do DSA.
  Agora lê `campaign_asset_set` com asset sets `PAGE_FEED` (`page_feeds` por campanha) e o campo
  de `WEBPAGE_LIST` virou `webpage_list_shared_set`.
- Os totais de `dsa_top_landing_pages` vinham só dos 1.000 termos de maior custo, e a recomendação
  de exclusão de URL saía dessa amostra. Agora a soma vem de consulta própria com todas as linhas
  termo × página (até 50.000), a exclusão só é recomendada com a soma completa e `data_notes`
  avisa de qualquer corte.
- Testes novos para as guardas que não tinham: `adGroupId` não numérico em
  `get_keyword_performance` (nenhuma GAQL sai) e critério que não é `KEYWORD` (ex.: `WEBPAGE`) em
  `bulk_update_keyword_status` (pulado, nenhuma escrita). Todas as correções passaram por teste de
  mutação (11 mutações, todas derrubaram ao menos um teste).

## Parcial / fora do escopo

- **Pausar palavras-chave pelo `bulk_update_status`** (proposta original: aceitar `adGroupCriteria`
  lá): a tool não é deste lote. O caso foi coberto pela tool nova `bulk_update_keyword_status`, que
  além disso confere cada palavra-chave antes. Na integração, a descrição do `bulk_update_status` passou a apontar para ela.
- **Criação de DSA (anúncios `ExpandedDynamicSearchAdInfo`, alvos `webpage`)**: não implementada de
  propósito — a criação acaba em janeiro de 2027. O caminho suportado é auditar e migrar para AI Max.
- **Soma por página do DSA acima de 50.000 linhas termo × página**: fica limitada às de maior custo
  e a resposta avisa (`data_notes` e cabeçalho); não há view por URL só de DSA com a mesma
  garantia — `expanded_landing_page_view` agrega por URL final, mas a documentação não diz se as
  páginas dinâmicas do DSA entram nela, então não foi usada. Reduzir o período dá totais completos.
- **`list_keywords { onlyIssues }` acima de 10.000 candidatas numa mesma condição**: a resposta
  avisa que a busca ficou incompleta e pede filtro por campanha/grupo; não pagina sozinha.
- **Métricas históricas de QS** (`metrics.historical_*` em `keyword_view`): não usadas; o diagnóstico
  usa o QS atual (`quality_info`), que é o acionável.
- A descrição do `run_gaql` e o `src/resources.ts` ainda citam só `search_term_view` para termos de
  pesquisa; convém citar `campaign_search_term_view` (PMax) — arquivos de outros lotes.
