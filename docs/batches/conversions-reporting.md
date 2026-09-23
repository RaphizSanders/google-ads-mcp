# Lote conversions-reporting — regras de valor, detalhamento de conversões, lift e leads

Módulo: `src/tools/conversions-reporting.ts` (`registerConversionsReportingTools`), catálogo em
`src/tools/conversions-reporting.catalog.ts`, testes em `tests/conversions-reporting.test.ts`.
Tool existente revista: `get_purchase_conversions` (em `src/tools.ts`).

Tudo foi conferido na API v25: GAQL contra `tests/fixtures/google-ads-v25-fields.json` e, além
disso, contra a coluna **"Selectable with"** da referência de campos
(`developers.google.com/google-ads/api/fields/v25/segments` e `/metrics`) — o validador
compartilhado não confere se um segmento combina com uma métrica, e várias combinações óbvias
são recusadas pela API (ver "Armadilhas" abaixo). Payloads e enums vêm dos protos v25
(`resources/conversion_value_rule(_set).proto`, `services/*_service.proto`,
`errors/conversion_value_rule(_set)_error.proto`, `resources/lift_measurement_*.proto`,
`common/asset_types.proto` (LeadFormAsset), `resources/lead_form_submission_data.proto`,
`resources/customer.proto` (CustomerAgreementSetting), `enums/lead_form_*`, `enums/value_rule_*`,
`enums/conversion_lag_bucket.proto`).

## Tools novas

| Tool | Tipo | O que faz |
|---|---|---|
| `get_conversions_by_action` | leitura | Conversões por ação de conversão (e por campanha × ação): coluna Conversões (primárias) × Todas as conversões (secundárias), valor e view-through. |
| `get_conversion_lag` | leitura | Distribuição do atraso impressão → conversão, limites de 50/90/95% e comparação dia a dia por data da interação × data da conversão. |
| `list_conversion_value_rules` | leitura | Conjuntos de regras (escopo, dimensões, categorias) com as regras na ordem de avaliação; regras fora de conjunto; herança da MCC. |
| `create_conversion_value_rule` | escrita | Cria a regra e a põe no conjunto do escopo (ou cria o conjunto) numa operação atômica. |
| `update_conversion_value_rule` | escrita | Muda ação, condições ou status; remove (com `confirm`) tirando do conjunto na mesma operação. |
| `get_value_rule_impact` | leitura | Valor original × ajustado por campanha e quebra por `segments.conversion_value_rule_primary_dimension`. |
| `get_lift_results` | leitura | Estudos de Conversion Lift e Brand Lift: voos, resultados com intervalo de 90%, p-valor e veredito em linguagem simples. |
| `list_lead_forms` | leitura | Formulários de lead, campanhas vinculadas e se os termos de formulário de lead foram aceitos. |
| `create_lead_form` | escrita | Cria o LeadFormAsset e o vincula às campanhas numa operação atômica. |
| `link_lead_form_to_campaigns` | escrita | Vincula (LINK) ou desvincula (UNLINK, com `confirm`) um formulário existente, com relatório por campanha. |
| `get_lead_form_submissions` | leitura | Leads recebidos (campos, perguntas personalizadas, GCLID, campanha, formulário), com opção de mascarar dados pessoais. |

Nenhuma escrita é encadeada (catálogo `chained` vazio): regra + conjunto e formulário + vínculos
saem num único `googleAds:mutate` com IDs temporários, então `validateOnly` funciona em todas.

## Detalhe por tool

### get_conversions_by_action (leitura)
- `FROM campaign` com `segments.conversion_action`, `conversion_action_name`, `conversion_action_category` e
  `metrics.conversions`, `conversions_value`, `all_conversions`, `all_conversions_value`, `view_through_conversions`.
  Uma segunda consulta a `conversion_action` traz `primary_for_goal` e `include_in_conversions_metric` (chave pelo ID,
  para funcionar com ações da MCC).
- Parâmetros: `dateRange`/`days`, `campaignId`, `category` (aceita os apelidos `LEAD`→`SUBMIT_LEAD_FORM`, `SIGN_UP`→`SIGNUP`),
  `includeSecondary` (padrão true), `breakdown` (`action` | `campaign`), `format` (json/table/csv).
- `in_conversions_column`: o observado manda — conversões em Todas e zero na coluna Conversões = ação fora das metas
  (secundária ou meta da campanha). Só sem nenhuma conversão vale a configuração da ação.
- Limite: não traz custo/cliques — `segments.conversion_action` não é selecionável com `metrics.cost_micros`, `clicks`,
  `impressions` (API recusa). CPA por ação exige cruzar com `get_campaign_performance`.

### get_conversion_lag (leitura)
- Consulta 1: `segments.conversion_lag_bucket` (dias entre impressão e conversão) com `metrics.conversions`,
  `conversions_value`, `all_conversions`. Consulta 2: por `segments.date`, `metrics.conversions` ×
  `metrics.conversions_by_conversion_date` (e valor/Todas).
- `FROM customer`; com `campaignId` vira `FROM campaign` (FROM customer não aceita `campaign.id`). Com `conversionActionId`
  a ação é conferida antes e `segments.conversion_action` entra no SELECT e no WHERE (regra de segmento no WHERE).
- Saída: distribuição com % e % acumulado, `threshold_days` (p50/p90/p95 pelo limite superior do bucket),
  `incomplete_recent_days` (= p90) e `recent_7_days`: os últimos 7 dias do CALENDÁRIO da janela (`from`/`to`,
  `calendar_days`, `days_with_data`) pelas duas datas. O trecho é filtrado por data (fim da janela − 6 dias, sem passar
  do início do período), não pelas 7 últimas linhas: o GAQL omite dias sem conversão, e numa conta de lead gen as 7
  últimas linhas podem cobrir meses. O fim da janela sai da própria cláusula (`BETWEEN ... AND 'fim'`, ou ontem para
  `DURING LAST_N_DAYS`). Buckets UNKNOWN ficam fora da distribuição.
- Ação secundária (sem `metrics.conversions`) usa Todas as conversões como base. Período padrão: 90 dias.
- Limite: `conversion_lag_bucket` não combina com `view_through_conversions` nem com `segments.device`.

### list_conversion_value_rules (leitura)
- `conversion_value_rule` (ação, condições de local/dispositivo/público, itinerário, status, dono) e
  `conversion_value_rule_set` (dimensões, escopo CUSTOMER/CAMPAIGN, campanha, categorias, lista ordenada de regras).
- Nomes resolvidos: `geo_target_constant.canonical_name`, `user_list.name`, `user_interest.name`, `campaign.name`
  (só resource names bem formados entram no `IN (...)`).
- Mostra a precedência documentada: conjunto da campanha substitui o da conta; dentro do conjunto vale a primeira regra
  que casa (locais: o mais específico). Regra fora de conjunto não é aplicada (nem aparece na interface).
- `includeRemoved` mostra regras removidas. format json/table/csv.

### create_conversion_value_rule (escrita)
- Condição: `geoTargetConstantIds`/`excludedGeoTargetConstantIds` (+ `geoMatchType`/`excludedGeoMatchType`, padrão `ANY`),
  `deviceTypes` (MOBILE/DESKTOP/TABLET), `userListIds`/`userInterestIds`. De 1 a 2 tipos de condição por regra.
- Ação: `ADD` (> 0), `MULTIPLY` (0,5 a 10), `SET` (> 0; a API só aceita SET em contas na allowlist — avisado na resposta).
- Escopo: sem `campaignId` = conjunto da conta; com `campaignId` = conjunto da campanha, só Pesquisa/Display
  (`VALUE_RULES_NOT_SUPPORTED_FOR_CAMPAIGN_TYPE`) — recusado antes de gravar para outros tipos.
- **Precedência** (guia "Conversion value rules", "Precedence of rules and rule sets"): se existe conjunto `CAMPAIGN`
  para a campanha, só os conjuntos da campanha valem para ela; senão valem os da conta. Com `campaignId`, quando a
  campanha ainda não tem conjunto próprio **ativo** (não existe, ou só existe pausado), a regra nova liga essa precedência
  e as regras da conta deixam de valer para a campanha. A tool lê os conjuntos `CUSTOMER` (todas as categorias, inclusive
  herdados da MCC) e, se algum tem regra ENABLED, **recusa sem `confirm: true`** listando cada regra que deixaria de valer
  (condições com nomes resolvidos e ação). A resposta sempre diz o efeito: "passa a ignorar os conjuntos da conta — N
  regra(s) deixam de valer" / "(hoje sem regras ativas)" / "já tem conjunto próprio ativo — nada muda"; sem `campaignId`,
  lista as campanhas com conjunto próprio ativo, que não recebem a regra da conta. Em dry-run/validateOnly o texto sai no
  condicional ("passaria", "deixariam").
- Antes de gravar: campanha existe e não está removida; locais, listas e interesses existem; conjunto do escopo (geral,
  sem categorias) é desta conta (herdado da MCC → recusa e manda criar na MCC); regra com as mesmas condições no conjunto
  (mesmos locais incluídos/excluídos, dispositivos, listas e interesses): só é no-op se também a ação, o status (ENABLED)
  **e o tipo de correspondência dos locais** (`geoMatchType`/`excludedGeoMatchType`, padrão ANY) forem iguais. Qualquer
  diferença vira conflito que lista o que difere (ação, status, correspondência dos incluídos/excluídos) e a chamada
  exata de `update_conversion_value_rule` que aplica o pedido (ex.: `geoMatchType: "LOCATION_OF_PRESENCE"`); pausada nunca
  é reativada sozinha. A correspondência fica fora da assinatura de conflito: mesmos locais com outra correspondência
  ainda são a mesma regra no conjunto.
- Dimensões: conjunto existente recebe a regra no FIM de `conversion_value_rules` e, se preciso, a dimensão nova é
  acrescentada (`DIMENSIONS_UPDATE_ONLY_ALLOW_APPEND`, máximo 2). Conjunto novo: dimensões da regra, `primaryDimension`
  escolhe a primeira (é a dimensão primária do relatório).
- Escrita: `googleAds:mutate` com `conversionValueRuleOperation.create` (`customers/{cid}/conversionValueRules/-1`) e
  `conversionValueRuleSetOperation.update` (updateMask `conversion_value_rules[,dimensions]`) ou `.create`
  (`.../conversionValueRuleSets/-2`, `attachmentType`, `campaign`). Erros conhecidos da API ganham explicação em PT-BR
  (ver "Dicas de erro" abaixo).
- Parâmetro novo: `confirm` (só exigido no caso de precedência acima).

### update_conversion_value_rule (escrita)
- `operation`/`value` (faixa checada com a operação resultante), `status` ENABLED/PAUSED, listas de condição (substituem;
  `[]` limpa aquele tipo desde que sobre uma condição). updateMask só com folhas que mudam (`action.value`,
  `device_condition.device_types`, `geo_location_condition.geo_target_constants`...), nunca a mensagem inteira.
- A condição resultante precisa caber nas dimensões do conjunto; não pode duplicar a condição de outra regra do conjunto.
- `status: REMOVED` exige `confirm: true`, não se combina com outras mudanças e é atômico: a regra sai da lista do conjunto
  (a API recusa remover regra ainda referenciada — `CANNOT_REMOVE_IF_INCLUDED_IN_VALUE_RULE_SET`) e é removida. Se era a
  única do conjunto, exige `removeRuleSetIfEmpty: true` e remove o conjunto junto (conjunto precisa de ao menos uma regra).
  Se o conjunto removido era o único conjunto ativo de uma campanha, a resposta avisa que ela volta a usar os da conta.
- Regra ou conjunto herdado da MCC é recusado. Nada muda = nenhuma escrita.

### get_value_rule_impact (leitura)
- Por campanha: `metrics.conversions_value` (depois dos ajustes) × `metrics.original_conversion_value` (antes), diferença e %.
- Quebra por `segments.conversion_value_rule_primary_dimension` com `conversions_value` e `all_conversions_value`.
  Significado (guia "Conversion value rules", seção Metrics): NO_RULE_APPLIED = valor das conversões sem regra;
  ORIGINAL = valor original (antes da regra) das conversões com regra; GEO_LOCATION, DEVICE, AUDIENCE, NO_CONDITION (e
  demais valores do enum) = **valor depois da regra** (conversões com regra, agrupadas pela dimensão primária do
  conjunto) — não é o ajuste.
- `rule_effect` (JSON) e uma linha no cabeçalho trazem o ajuste explícito das regras: `value_after_rules` (soma das
  linhas de dimensão) − `original_value` (linha ORIGINAL) = `adjustment`, para `conversions_value` e
  `all_conversions_value`.
- Limites: o segmento de dimensão primária NÃO combina com `original_conversion_value` (por isso duas consultas);
  `original_conversion_value` também exclui ajustes de metas de ciclo de vida, então a diferença não é só de regras de valor.

### get_lift_results (leitura, v25.1)
- `lift_measurement_config` (estudos: campanhas, ações, holdback, perguntas) e `lift_measurement_flight` (voos: tipo
  CONVERSION/SEARCH/SURVEY, status, datas, % de respostas coletadas).
- Conversion Lift: sempre segmentado por `conversion_lift_start_date/end_date/conversion_category/included_conversion_action_types`
  (resultados por período não podem ser somados) + quebra opcional `CONVERSION_ACTION`, `AGE_RANGE`, `GENDER`, `DEVICE`,
  `COUNTRY`, `EXPERIMENT_ARM`. 24 métricas (incrementais, bounds p90, p-valor, lift relativo, custo por incremental, iROAS,
  baseline × exposto) + winner scores só em NONE/EXPERIMENT_ARM (não combinam com as outras quebras).
- Brand Lift: `lift_measurement_config` (NONE) ou `lift_measurement_campaign/age_range/gender/device/video` com
  `segments.brand_lift_measurement_type`; lift absoluto/relativo/headroom com bounds e p-valor, respostas, custo por
  usuário impactado.
- Veredito: intervalo de 90% inteiro acima de zero = positivo e significativo; abaixo = negativo; cruzando zero =
  inconclusivo (p ≤ 0,10 ⇔ 90% de confiança, pela descrição oficial do p-valor).
- `liftType` AUTO segue o tipo dos voos. Quebra incompatível com o tipo é recusada (ou omitida em AUTO, com aviso).
- Limites: somente leitura (estudos são montados com o Google); lift relativo, taxas e custos saem como a API devolve —
  a referência não documenta a unidade (fração × percentual; micros ou moeda); Search Lift não tem métricas próprias
  nestes recursos.

### list_lead_forms (leitura)
- `customer.customer_agreement_setting.accepted_lead_form_terms`, assets `LEAD_FORM` (textos, CTA, campos, perguntas,
  pós-envio, intenção, imagem de fundo, webhook) e vínculos `campaign_asset` `LEAD_FORM` não removidos.
- O `google_secret` do webhook nunca é exibido. `campaignId` filtra os formulários vinculados à campanha.

### create_lead_form (escrita)
- Obrigatórios: `campaignIds`, `businessName`, `headline`, `description`, `callToActionType`, `callToActionDescription`,
  `privacyPolicyUrl`, `finalUrl` (o exemplo oficial `add-lead-form-asset` preenche `final_urls`), `fields`.
- Regras aplicadas antes de chamar a API (proto/enum v25): FULL_NAME não combina com FIRST_NAME/LAST_NAME; `answers`
  (2 a 12) só em perguntas pré-aprovadas; no máximo 5 pré-aprovadas; até 5 `customQuestions` (texto ≤ 300); pré-aprovadas
  e personalizadas não se misturam (`LEAD_FORM_LEGACY_QUALIFYING_QUESTIONS_DISALLOWED`); campos repetidos; URLs http(s);
  webhook com `url` e `googleSecret` (`payloadSchemaVersion` padrão 3, como no exemplo oficial).
- Leitura antes de gravar: termos aceitos (senão recusa — o campo é somente leitura, só a interface aceita os termos);
  campanhas existem e não estão removidas; nome único entre os LEAD_FORM (`DUPLICATE_ASSET_NAME`); imagem de fundo é
  IMAGE 1200x628; aviso se a campanha já tinha formulário ou não é Pesquisa/PMax.
- Escrita: `googleAds:mutate` com `assetOperation.create` (`customers/{cid}/assets/-1`) + um `campaignAssetOperation.create`
  (`fieldType: LEAD_FORM`) por campanha. O segredo do webhook não aparece na resposta.

### link_lead_form_to_campaigns (escrita)
- Confere que o asset é LEAD_FORM desta conta e lê os vínculos atuais. LINK: vínculo ativo é pulado, pausado não é
  reativado (fica para decisão explícita), campanha removida é ignorada. UNLINK exige `confirm: true` e remove pelo
  resource name lido. `mutate campaignAssets` com `partialFailure` e relatório por campanha.

### get_lead_form_submissions (leitura)
- `lead_form_submission_data` com campos (`lead_form_submission_fields`), perguntas personalizadas, GCLID, campanha, grupo e
  formulário; filtro por `submission_date_time` (`days` 1–60, padrão 30, ou `dateRange`), `campaignId`, `assetId`;
  `ORDER BY submission_date_time DESC LIMIT` (padrão 1000, máx. 10000).
- `redact: true` mascara e-mail (m***@dominio), telefone (***últimos 2), demais respostas e GCLID.
- Limite: o Google Ads guarda os leads por 60 dias (Central de Ajuda "About lead form assets").

## Dicas de erro (regras de valor e formulários de lead)

- O `GoogleAdsClient` monta a mensagem de erro só com `errors[].message` (descarta o `errorCode`), e essa mensagem é o
  texto em inglês do comentário do enum no proto v25. Por isso cada dica em PT-BR casa com esse texto
  (`errors/conversion_value_rule_error.proto`, `conversion_value_rule_set_error.proto`, `database_error.proto`,
  `asset_error.proto`, `policy_finding_error.proto`, `policy_violation_error.proto`); o nome do enum fica só como reserva.
- Os testes jogam o texto real (nunca o nome do enum) para cada dica e há um teste com o `GoogleAdsClient` real e um
  HTTP 400 no formato REST (`details[].errors[]` com `errorCode` + `message`).

## Tool existente alterada

### get_purchase_conversions (leitura)
- Agora agrupa por `campaign.id` (nome de campanha não é único), traz `all_purchase_conversions`/`all_purchase_revenue`
  (`metrics.all_conversions*`) além da coluna Conversões e avisa quando há compras de ações secundárias.
- Novos parâmetros opcionais: `campaignId`, `format` (json/table/csv). Campos antigos (`campaign_name`,
  `purchase_conversions`, `purchase_revenue`) e a linha "Total: ..." continuam iguais; totais arredondados.

## Fluxos

- **"Os números de conversão fazem sentido?"** → `get_conversions_by_action` (o que alimenta a coluna Conversões) →
  `get_conversion_lag` (quantos dias recentes ainda estão incompletos) → só então comparar CPA/ROAS.
- **Regra de valor por região/dispositivo/público** → `list_geo_targets` / `list_remarketing_lists` para os IDs →
  `create_conversion_value_rule` (com `validateOnly: true` primeiro) → `list_conversion_value_rules` para conferir a ordem →
  `get_value_rule_impact` depois de alguns dias.
- **Incrementalidade** → `get_lift_results` (sem ID lista os estudos; com ID e `breakdown` detalha).
- **Lead gen** → `list_lead_forms` (termos aceitos?) → `create_lead_form` (com webhook para o CRM) →
  `get_lead_form_submissions` (exportar antes de 60 dias) → `link_lead_form_to_campaigns` para reutilizar o formulário.

## Armadilhas da API cobertas pelos testes

- `segments.conversion_action` / `_category` / `_name` não combinam com `metrics.cost_micros`, `clicks`, `impressions`.
- `segments.conversion_lag_bucket` não combina com `metrics.view_through_conversions` nem com `segments.device`.
- `segments.conversion_value_rule_primary_dimension` só combina com `conversions_value`/`all_conversions_value`
  (não com `original_conversion_value`), só em `campaign`/`customer`/`location_interest_view`.
- Métricas de Conversion Lift só saem de `lift_measurement_config`; os recursos por dimensão só têm Brand Lift.
  Winner scores só com os segmentos `conversion_lift_*` e `experiment_arm`.
- O teste `tests/conversions-reporting.test.ts` embute a tabela "Selectable with" destes campos e o client falso a aplica
  em toda query, além do `assertGaqlRules`.

## O que ficou parcial (e por quê)

- **Condição de itinerário** (regras de viagem): recurso só para contas na allowlist, não é criado nem editado aqui
  (a listagem mostra que existe). **SET** é aceito pela tool, mas a API só o grava em contas na allowlist.
- **Conjuntos de Store Visits/Store Sales** (dimensão `NO_CONDITION` + categoria única): não são criados por
  `create_conversion_value_rule` (que só usa o conjunto geral do escopo); aparecem na listagem.
- **Reordenar regras** dentro do conjunto: não há tool; a regra nova entra no fim da lista (a ordem é mostrada).
- **ID temporário dentro de lista repetida** (`conversion_value_rules: [".../-1"]`): a documentação de IDs temporários diz
  que qualquer referência posterior é resolvida, mas não há exemplo oficial com esse campo. Se a API recusar, nada é gravado
  (operação atômica) — vale validar na primeira conta com `validateOnly: true`.
- **Aceitar os termos de formulário de lead**: impossível pela API (`accepted_lead_form_terms` é OUTPUT_ONLY); a tool detecta
  e explica. **Editar** um formulário existente não foi feito: a API só permite reordenar campos, não adicionar/remover.
  `custom_disclosure` é só para contas liberadas.
- **Unidades no lift**: lift relativo, taxas e custos por incremental saem crus porque a referência não documenta a unidade.
- **Dicas de erro por texto**: casar pelo `errorCode` seria mais estável, mas o código não chega à tool — o
  `GoogleAdsClient` (fora deste lote) o descarta ao montar a exceção. Se o Google mudar a redação de uma mensagem, a dica
  deixa de aparecer; a mensagem crua da API continua na resposta e nada é mascarado.
- **Precedência com conjunto de campanha pausado**: o guia não diz se um conjunto `CAMPAIGN` com todas as regras
  pausadas já tira a campanha dos conjuntos da conta. A tool trata como "sem conjunto ativo" (o lado seguro): exige
  `confirm` se a regra nova o reativaria com regras ativas na conta.
