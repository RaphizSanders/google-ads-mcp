# Lote diagnostics — veiculação, parcela de impressões e reprovações

Módulo: `src/tools/diagnostics.ts` (catálogo em `diagnostics.catalog.ts`). Alterações em
`src/tools.ts` só nas tools deste lote (`get_daily_trend`, `compare_periods`,
`get_performance_alerts`, `get_campaign_performance`, `get_ad_group_performance`) e em
`buildDateClause` (`src/tool-kit.ts`, que este lote é dono). Testes: `tests/diagnostics.test.ts`.

Fontes conferidas: protos oficiais da v25 (`resources/campaign.proto`, enums
`campaign_primary_status_reason`, `bidding_strategy_system_status`, `ad_group_*_primary_status_reason`,
`asset_group_primary_status_reason`, `policy_*`, `common/policy.proto`, `errors/errors.proto`,
`services/ad_group_ad_service.proto`, `ad_group_criterion_service.proto`, `ad_service.proto`), a field
reference v25 (campos e "Selectable with" das métricas de parcela) e o fixture
`tests/fixtures/google-ads-v25-fields.json` (toda query passa por `validateGaql`).

## Tools novas

### `diagnose_campaigns` — leitura
"Por que a campanha não está gastando?" Lista **todas** as campanhas não removidas — inclusive as que
pararam de veicular e por isso somem de `get_campaign_performance` (que filtra `impressions > 0`).

- Por campanha: `status`, `primary_status`, `primary_status_reasons` (cada motivo com explicação em PT-BR
  e a tool que resolve — ex.: `BUDGET_CONSTRAINED` → `get_impression_share` + `update_budget`,
  `HAS_ADS_DISAPPROVED` → `list_policy_issues`, `NO_KEYWORDS` → `create_keyword`,
  `MISSING_LOCATION_TARGETING` → `set_campaign_locations`), `serving_status`,
  `bidding_strategy_system_status` explicado (aprendizado, `LIMITED_BY_*`, `MISCONFIGURED_*`), orçamento
  (e o recomendado, quando há), datas e **entrega recente** (impressões/custo em `days`, padrão 7).
- Status vem de uma query **sem métricas** (campanha parada não some); a entrega vem de outra.
- `gravidade`: ok / info / atencao / problema. Os motivos mandam na gravidade — grupo `NOT_ELIGIBLE`
  só porque a campanha está pausada (`CAMPAIGN_PAUSED`, herdado) é `info`; grupo pausado pelo Google
  por baixa atividade é `atencao`. Campanha ativa sem nenhuma impressão na janela ganha `alerta`.
- Parâmetros: `campaignId?`, `onlyProblems` (padrão `true`: só atenção/problema; informa quantas
  ficaram ocultas), `drillDown` `none|ad_groups|ads|keywords|asset_groups` (status primário e motivos
  do nível de baixo; em palavras-chave também `system_serving_status` — `RARELY_SERVED` —,
  aprovação e Índice de Qualidade; em anúncios, aprovação/revisão), `limit` (drill-down, padrão 200,
  máx. 1000), `format` json/table/csv.
- Com `onlyProblems`, o drill-down filtra **no GAQL** (antes do `LIMIT`) pela mesma regra da
  gravidade — os **motivos** mandam, não só o status primário. Pelos protos v25, o status sozinho
  engana: `AD_GROUP_PAUSED_DUE_TO_LOW_ACTIVITY` (e o equivalente de palavra-chave) deixa a entidade
  `PAUSED`; `HAS_ADS_DISAPPROVED` pode vir num grupo `ELIGIBLE`; QS baixo/lance abaixo da 1ª página
  deixam a palavra-chave `ELIGIBLE`; e todo grupo de campanha encerrada mas ainda `ENABLED` fica
  `NOT_ELIGIBLE` por `CAMPAIGN_ENDED` (herdado). Como GAQL não tem `OR`, são três consultas, cada uma
  com o próprio `LIMIT`, juntas sem repetir e ordenadas por gravidade:
  1. `primary_status_reasons CONTAINS ANY` (motivos "problema" do nível);
  2. `primary_status_reasons CONTAINS ANY` (motivos "atenção") — separada para milhares de palavras-chave
     com QS baixo não tirarem a vaga das reprovadas;
  3. `primary_status IN (NOT_ELIGIBLE, LIMITED, PENDING)` (palavra-chave: só `NOT_ELIGIBLE/PENDING`, o enum
     não tem `LIMITED`) com `primary_status_reasons CONTAINS NONE` (todos os motivos do enum) — status
     ruim sem motivo.
  Escopo: `campaign.status = ENABLED`, `campaign.primary_status != ENDED` e, em anúncios/palavras-chave,
  `ad_group.status = ENABLED` (pendência embaixo de algo pausado/encerrado não é urgente; grupo pausado
  pelo Google aparece no nível `ad_groups`). Campanha que ainda vai começar (`PENDING`) entra: o grupo sem
  anúncio dela é problema a resolver antes do início. Linha só com motivo herdado (`CAMPAIGN_*`,
  `AD_GROUP_PAUSED`) não entra — era o que enchia o `LIMIT`. Avisa (JSON, cabeçalho e csv) quando alguma
  consulta atinge o limite ou a junção passa dele.
- As tabelas de motivos batem exatamente com os enums v25 de cada nível (teste compara), porque os
  códigos vão para o GAQL: `CAMPAIGN_DRAFT` só existe no de grupo; `AD_GROUP_PAUSED/REMOVED` não existem
  no de grupo de recursos.
- `format`: `table` traz as campanhas e, com drill-down, uma segunda tabela (`Detalhe (nível)`); `csv`
  traz tudo num CSV só, com a coluna `nivel` (`campanha`, `grupo`, `anuncio`, `palavra-chave`,
  `grupo de recursos`) e `motivos` em códigos. Antes, table/csv descartavam o drill-down.

### `get_account_health` — leitura
Saúde da conta numa chamada: status da conta, índice de otimização (e peso), auto-tagging,
`conversion_tracking_status` (e a conta dona das conversões), aceite dos termos de dados do cliente,
enhanced conversions para leads, tráfego e **cliques inválidos** (`metrics.invalid_clicks`,
`invalid_click_rate`) no período (`dateRange`/`days`), campanhas por `primary_status` com os motivos
mais comuns nas ativas e anúncios reprovados em campanhas/grupos ativos. Gera alertas ordenados por
gravidade, cada um com a ação. Conta gerenciadora (MCC) responde só os dados da conta e orienta rodar
por conta cliente.
Limiares heurísticos (não são regra do Google): índice de otimização < 70%, cliques inválidos ≥ 10%.

### `get_impression_share` — leitura
O diagnóstico "orçamento ou lance?".
- `level`: `account | campaign | ad_group | keyword | product` (Shopping por `segments.product_item_id`,
  FROM `shopping_performance_view`).
- `network`: `SEARCH` (padrão; `search_*_impression_share`, topo/topo absoluto, perdas por orçamento e
  por ranking, correspondência exata, % no topo) ou `DISPLAY` (`content_*`; só account/campaign/ad_group).
- `segmentBy`: `none | date | week | month | device | day_of_week | hour`.
- Filtros `campaignId`, `adGroupId` (ad_group/keyword); `limit` (padrão 100, máx. 5000); `format`.
- `LIMIT` escolhe as linhas de **maior custo** (conta sem segmento é uma linha só, sem `LIMIT`). Quando a
  consulta enche o limite, o cabeçalho (e o csv, em linha `# ...`) avisa; com segmento de tempo avisa
  também que a série está incompleta (faltam períodos/entidades de menor custo).
- Com segmento de tempo (`date`, `week`, `month`, `hour`, `day_of_week`) a saída vem em ordem do período
  (dentro do mesmo período, por custo).
- Na visão `SEARCH` (níveis campaign, ad_group, keyword) o GAQL exclui
  `campaign.advertising_channel_type` `DISPLAY`, `VIDEO` e `DEMAND_GEN` — não veiculam na rede de
  Pesquisa, viriam sem parcela e tomariam vagas do `LIMIT` antes de serem descartadas.
- Métricas escolhidas pela compatibilidade da field reference: sem topo/perdas de topo/% no topo/exata
  em `product`; sem correspondência exata nem perdas de Display com `hour`; `hour` recusado em
  keyword/product (o recurso não aceita o segmento).
- Valores truncados pela API aparecem como `"<10%"` (parcela 0.0999) e `">90%"` (perda 0.9001).
- `diagnostico` por linha: limitada por orçamento / por ranking (lance/qualidade) / parcela alta / sem
  gargalo (limiar de 10 p.p., heurística). Com segmento `hour` na Display: "perdas não disponíveis".
- Campanha `TARGET_IMPRESSION_SHARE`: compara com a meta (local + fração), inclusive de estratégia de
  portfólio da própria conta (lida em `FROM bidding_strategy`).
- Linhas sem parcela (tipo de campanha/rede sem a métrica) são omitidas e contadas no cabeçalho.
- Segmento diário/semanal/por hora respeita a retenção de 37 meses (ver abaixo).

### `list_policy_issues` — leitura
Reprovações e limitações de política com o que a API sabe:
- Anúncios: `ad_group_ad.policy_summary` (aprovação, revisão, `policy_topic_entries`).
- Assets vinculados à campanha, ao grupo e à conta (`asset.policy_summary` pelo recurso atribuído,
  mais `primary_status`/motivos do vínculo) e a grupos de recursos PMax
  (`asset_group_asset.policy_summary`).
- Palavras-chave: `approval_status = DISAPPROVED` com `disapproval_reasons`.
- Cada tópico vem com efeito (`PROHIBITED` → não veicula etc.), evidências legíveis (texto que violou,
  sites, idioma, texto na página de destino, URLs divergentes, **destino fora do ar com código HTTP ou
  erro de DNS, dispositivo e data da checagem**), restrições por país/certificado/revenda e uma sugestão
  de correção (heurística por evidência/tópico).
- Parâmetros: `campaignId?`, `scope` `all|ads|assets|keywords`, `statuses` (padrão `DISAPPROVED`,
  `APPROVED_LIMITED`, `AREA_OF_INTEREST_ONLY`; palavras-chave só entram com `DISAPPROVED`), `limit`
  (por consulta, padrão 200), `format`.
- São até seis consultas (anúncios, assets de campanha, de grupo, da conta, de grupo de recursos e
  palavras-chave), cada uma com o próprio `LIMIT`. A que enche o limite é nomeada no cabeçalho, em
  `resumo.limite_atingido_em` (com `limite_por_consulta`) e, em csv, numa linha `# ...` antes do CSV.

### Formato csv (todas as tools de leitura do lote)
CSV sem nada a avisar sai puro. Aviso de corte entra antes, em linhas começando com `# `; resultado vazio
vira `# <cabeçalho>` em vez de texto vazio.

### `request_keyword_policy_exemption` — escrita
Cria uma palavra-chave pedindo exceção (`AdGroupCriterionOperation.exempt_policy_violation_keys`).
1. Confere o grupo (existe, não removido) e se a palavra-chave já existe (no-op, nada enviado).
2. Sem `confirm`: valida na API (`validate_only` + `partialFailure`, nada gravado) e devolve as violações
   — `policy_name`, nome/descrição da política, texto que violou e `is_exemptible`.
3. `confirm: true` + `exemptPolicies` com **todas** as políticas apontadas: cria com as chaves que a
   própria API devolveu (o agente não digita chave). Violação sem exceção possível é recusada.
- Parâmetros: `adGroupId`, `keyword` (≤ 80 caracteres e 10 palavras), `matchType`, `cpcBidMicros?`
  (≥ R$ 0,10), `status?` (padrão ENABLED, como `create_keyword`), `exemptPolicies`, `confirm`,
  `validateOnly`.
- A palavra-chave fica salva mas pode não veicular até a revisão. Sem violação: indica `create_keyword`.

### `request_ad_policy_exemption` — escrita
RSA com exceção (`policy_validation_parameter.ignorable_policy_topics`).
- Criação (`adGroupId` + `finalUrl` + `headlines` 3–15 ≤ 30 + `descriptions` 2–4 ≤ 90 + `path1/2` ≤ 15):
  `AdGroupAdOperation`, nasce PAUSED.
- Edição (`adId` + só os campos a mudar): lê o RSA, mostra antes, manda só as folhas alteradas no
  `updateMask` (`final_urls`, `responsive_search_ad.headlines/descriptions/path1/path2`), mantém o pin de
  títulos/descrições de texto igual, pula no-op; `AdOperation` em `ads:mutate`.
- Mesmo fluxo de duas etapas: validação (`validate_only`) lista tópicos (`PolicyFindingDetails`) com tipo,
  evidência, gatilho e campo; `confirm: true` + `ignorablePolicyTopics` com todos os tópicos envia.
  Erro que não é achado de política (ex.: texto longo) para o fluxo — só `PolicyFindingError` admite
  exceção (documentação de policy exemption para anúncios).

Nas duas tools de exceção, os detalhes estruturados vêm do `partialFailureError` do `:mutate` (a API
devolve o `GoogleAdsFailure` inteiro na resposta), sem mexer no client. Em `validateOnly`/dry-run tudo
roda em validate_only e a resposta diz que nada foi gravado.

## Tools alteradas

- **`get_daily_trend`** (#21): com `campaignId` a query sai de `FROM campaign` (o recurso `customer` não
  tem recursos atribuídos; `campaign.id` em `FROM customer` era recusado sempre). `campaignId` validado.
  Novo `granularity` `DAY|WEEK|MONTH|QUARTER|YEAR`. Sem linhas: diz se a campanha não existe ou só não
  veiculou (e aponta `diagnose_campaigns`). Saiu de `KNOWN_BROKEN` na varredura de GAQL.
- **`compare_periods`**: as datas iam cruas para o GAQL — agora passam por `buildDateClause` (formato,
  data real, ordem, retenção). Novo `campaignId?` (FROM campaign). Os dois períodos precisam de `since` e
  `until` preenchidos em `YYYY-MM-DD`: com um deles vazio, `buildDateClause` cairia em "últimos 30 dias" e
  a comparação sairia com o rótulo do período pedido — agora é recusado antes de qualquer consulta.
- **`get_campaign_performance`**: `includeImpressionShare` acrescenta parcela, perdas por
  orçamento/ranking, topo, topo absoluto e diagnóstico. Descrição avisa que campanha sem impressões não
  aparece (use `diagnose_campaigns`). Sem a flag, a query é a mesma de antes.
- **`get_ad_group_performance`**: `includeImpressionShare`; `campaignId` passa a ser validado (entrava
  cru no GAQL); saída ganha `campaign_id`.
- **`get_performance_alerts`**: alerta campanha ativa `NOT_ELIGIBLE/MISCONFIGURED` (com os motivos),
  campanha ativa sem gasto no período (exceto `ENDED/PENDING`) e campanha com ROAS ≥ média (e ≥ 1)
  perdendo ≥ 20% da parcela da Pesquisa por orçamento (heurística).
- **`buildDateClause`** (tool-kit): `dateRange` com só uma das pontas preenchida é erro ("dateRange
  incompleto") em vez de cair em `days` calado; as duas vazias continuam valendo como "sem dateRange".
  Valida data real e `since ≤ until`; aplica a retenção abaixo. Novo
  terceiro parâmetro opcional `{ granular: true }` para queries que selecionam `segments.date/week/hour`.
  Exporta `GRANULAR_RETENTION_MONTHS`, `granularRetentionStart()` e `retentionProblem()`.

## Retenção de 37 meses (desde 01/06/2026)

Fonte: deprecations da API e o Ads Developer Blog de 01/05/2026. Dado diário, semanal e por hora só
existe para os últimos 37 meses; mensal, trimestral e anual, por 11 anos. Query granular mais antiga
recebe `DateRangeError.INVALID_DATE`; query sem segmento de data para período histórico só passa
alinhada ao mês civil (dia 1 ao último dia).
- Granular (`{granular: true}`) começando antes do limite: recusado antes da API, orientando
  granularidade mensal (`get_daily_trend granularity MONTH`).
- Sem segmento de data e começando antes do limite: aceito só alinhado ao mês; a mensagem sugere o
  período alinhado (since dia 1, until fim do último mês completo coberto).
- A data-limite usa a data local do servidor; no dia exato do limite o fuso da conta pode deslocar 1 dia.

## Fluxos

- **"A campanha parou de gastar"**: `diagnose_campaigns {campaignId}` → motivo + tool; se
  `HAS_ADS_DISAPPROVED`: `list_policy_issues {campaignId, scope: ads}`; se `BUDGET_CONSTRAINED`:
  `get_impression_share {level: campaign}` para confirmar a perda por orçamento → `update_budget`.
- **"Escalar orçamento ou lance?"**: `get_impression_share` (campaign → keyword); perda por orçamento
  com bom ROAS → orçamento; perda por ranking → lance/Índice de Qualidade.
- **Revenda de marca / termos de saúde**: `request_keyword_policy_exemption` ou
  `request_ad_policy_exemption` sem `confirm` → mostrar políticas ao usuário → repetir com `confirm: true`
  e a lista confirmada.
- **Revisão semanal**: `get_account_health` → `get_performance_alerts` → `diagnose_campaigns`.

## Parcial / fora do alcance deste lote

- **Erros estruturados no `request()` do client** (errorCode, trigger, location, policy details): o
  arquivo `src/google-ads-client.ts` é do lote account-auth. Este lote obtém os mesmos dados pelo
  `partialFailureError` (helper `parseAdsFailure`, exportado do módulo). Recomendação ao account-auth:
  anexar `GoogleAdsFailure.errors` ao `Error` lançado, para que as demais tools de escrita também mostrem
  tópico/`is_exemptible`.
- **`exemptPolicyViolationKeys` em `create_keyword`/`add_keywords` e `ignorablePolicyTopics` em
  `create_ad`/`update_ad`**: essas tools não são deste lote. A capacidade foi entregue nas duas tools de
  exceção acima (com validação prévia e confirmação por política).
- **`includeImpressionShare` em `get_keyword_performance`**: tool de outro lote; o nível `keyword` de
  `get_impression_share` cobre o caso.
- **Recurso (appeal) de reprovação já decidida**: a API não oferece; exceção só vale ao criar/editar.
  Palavra-chave já salva e reprovada não tem pedido de exceção pela API (só recriando).
- **`validate_only` + `partial_failure` juntos**: a documentação não descreve a combinação
  explicitamente. Se a API lançar erro em vez de devolver `partialFailureError`, as tools de exceção
  param com a mensagem da API e dizem que os detalhes estruturados não vieram (nada é gravado).
- **Filtros do drill-down de `diagnose_campaigns`**: `primary_status_reasons` é filtrável e repetido na v25
  (fixture) e `CONTAINS ANY/NONE` são os operadores documentados da GAQL para campo repetido; os testes
  aplicam o `WHERE` e o `LIMIT` num client falso, mas não houve como rodar contra a API real (sem
  credenciais aqui). A consulta 3 assume que `CONTAINS NONE` é verdadeiro para lista vazia (entidade sem
  motivo), que é a semântica documentada.
- **Canais sem parcela da Pesquisa em `get_impression_share`**: só `DISPLAY`, `VIDEO` e `DEMAND_GEN` saem no
  GAQL (certamente não veiculam na Pesquisa). Outros tipos sem a métrica (se houver) ainda podem ocupar
  vagas do `LIMIT`; são descartados e contados no cabeçalho, e o aviso de limite aparece.
- **`tests/gaql-rules.ts`**: não é deste lote; o validador já recusa `campaign.*` em `FROM customer` (há
  teste provando).
- **Outras tools que selecionam `segments.date`** (de outros lotes) precisam passar
  `buildDateClause(dateRange, days, { granular: true })` para ganhar a recusa antecipada; sem isso recebem
  só a regra de alinhamento ao mês.
- **`src/resources.ts`/`src/prompts.ts`** ainda mandam "verificar o e-mail de reprovação" e usam impression
  share sem tool: vale apontar para `list_policy_issues`, `get_impression_share` e `diagnose_campaigns`
  (arquivos do lote account-auth).
