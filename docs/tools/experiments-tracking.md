# Lote experiments-tracking — experimentos, rastreamento de URL, rótulos e aquisição de clientes

Módulo: `src/tools/experiments-tracking.ts` (catálogo em `experiments-tracking.catalog.ts`).
Tools do núcleo alteradas (em `src/tools.ts`): `create_label`, `assign_label`, `list_labels`.
Testes: `tests/experiments-tracking.test.ts` (54 testes; client falso que valida toda GAQL contra os
metadados reais da v25 e todo updateMask contra a regra de folhas). Todo `assert.ok` do arquivo leva
mensagem: sem ela, uma falha fazia o Node reler o fonte (via tsx) para montar a mensagem e o teste
travava em loop em vez de falhar — foi o que escondeu a checagem de mutação do confirm de anúncio/palavra-chave.

Fontes conferidas (v25): protos `resources/{goal,campaign_goal_config,user_list_customer_type,experiment,
experiment_arm,campaign_draft,label,customer_label,ad_group_criterion_label,customer,campaign,ad_group,ad,
ad_group_criterion}.proto`, `services/{goal,campaign_goal_config,user_list_customer_type,experiment,
experiment_arm,campaign_draft,label,customer_label,customer,google_ads}_service.proto`,
`common/{goal_setting,goal_common,campaign_goal_settings,text_label,custom_parameter,metrics,
experiment_types,metric_goal,segments}.proto`, enums e errors correspondentes; guias
`conversions/goals/lifecycle-goals`, `experiments/{overview,system-managed,intra-campaign,
asset-optimization,campaign-mix,reporting}`, `reporting/labels`, `ads/upgraded-urls/{supported-entities,
fields}`; exemplos oficiais do google-ads-python (`examples/experiments/*.py`); field reference de
`segments.new_versus_returning_customers` (combina só com métricas de conversão).

## 1. Aquisição de clientes (metas de ciclo de vida, v25)

A v25 removeu CustomerLifecycleGoal/CampaignLifecycleGoal. O modelo novo é `Goal` (meta da conta, no
máximo uma por tipo) + `CampaignGoalConfig` (vínculo por campanha) + `UserListCustomerType` (quem é
cliente existente).

| Tool | Tipo | O que faz |
|---|---|---|
| `get_lifecycle_goals` | leitura | Metas da conta (clientes novos, retenção, fidelidade) com valores; configuração por campanha (`mode` BID_HIGHER/NEW_ONLY, valores próprios); conta de conversão (acompanhamento entre contas); listas marcadas com tipo de cliente. `format` table/csv = configs por campanha. |
| `set_new_customer_acquisition` | escrita | Sem `campaignId`: cria/atualiza a meta `NEW_CUSTOMER_ACQUISITION` da conta (`additionalValue`, `highLifetimeValue` > `additionalValue`). Com `campaignId` + `mode`: `BID_HIGHER` (TARGET_ALL, aceita valores próprios), `NEW_ONLY` (TARGET_SPECIFIC, limpa valores próprios), `OFF` (remove o vínculo, `confirm: true`). |
| `tag_user_list_customer_type` | escrita | Marca/desmarca categorias (PURCHASERS, HIGH_VALUE_CUSTOMERS, CART_ABANDONERS, LOYALTY_TIER_n...) numa lista. Recusa antes de enviar os pares conflitantes documentados; `remove` pede `confirm`. |
| `get_new_vs_returning_performance` | leitura | Conversões/valor por campanha segmentados em NEW, NEW_AND_HIGH_LTV, RETURNING; % de clientes novos; custo por conversão de cliente novo (aproximado — o custo vem de outra query, porque o segmento não combina com custo). |

Detalhes:
- REST: `customers/{id}/Goals:mutate` e `customers/{id}/CampaignGoalConfigs:mutate` (com maiúscula,
  como está no `google.api.http` do proto). Goal não tem remove; a meta da conta só é criada/atualizada.
- Acompanhamento entre contas: `customer.conversion_tracking_setting.google_ads_conversion_customer`
  diferente da conta → a meta da conta é lida/gravada na conta de conversão (que também passa pela
  allowlist); a configuração da campanha fica na conta da campanha (guia lifecycle-goals: "configure
  customer-level lifecycle goals in the Google Ads conversion account"). A meta da conta de conversão vale
  para todas as contas que a usam — a resposta diz isso.
  - A escrita na meta da conta só usa meta lida NA conta de conversão, e o `Goals:mutate` vai para a conta
    dona do resource name (se a meta lida viesse com resource name de outra conta, a tool recusa sem gravar).
  - Se a conta de conversão não tem meta mas a conta cliente tem uma própria (`customers/{cliente}/goals/…`),
    essa meta NÃO é atualizada pela conta de conversão (URL e resource name de contas diferentes — era o bug
    da revisão). A tool mostra a meta da conta cliente e pede `confirm: true` para criar a meta na conta de
    conversão; a da conta cliente não é alterada.
  - No vínculo de campanha, a meta da conta cliente ainda é usada quando é a única visível (o
    CampaignGoalConfig fica na própria conta cliente), com aviso de que o guia manda a meta ficar na conta
    de conversão.
- Com `campaignId`, se a conta ainda não tem meta e vier `mode: BID_HIGHER` + `additionalValue`, a tool cria
  a meta (valores na conta) e depois o vínculo. Em validateOnly/dry-run só a criação da meta é validada — o
  vínculo depende do ID dela e a tool diz isso explicitamente.
- Avisos: estratégia de lance que não é por conversão/valor; tipo de campanha fora de PMax/Pesquisa/Shopping.
- Erros traduzidos: `CANNOT_USE_INCOMPATIBLE_CLO_GOALS`, `CAMPAIGN_OVERRIDE_VALUES_SET_FOR_..._TARGET_SPECIFIC_OPTION`,
  `HIGH_LIFETIME_VALUE_*`, `CONFLICTING_CUSTOMER_TYPES`, `USERLIST_NOT_ELIGIBLE` etc.
- Não implementado: escrita de metas de retenção e fidelidade (a proposta era aquisição; as duas aparecem
  na leitura). `value_multiplier` de clientes novos não é oferecido (o guia diz "not supported yet").

## 2. Experimentos e rascunhos

| Tool | Tipo | O que faz |
|---|---|---|
| `create_experiment` | escrita | Cria experimento + braços num `googleAds:mutate` atômico (ID temporário `experiments/-1`). Tipos: SEARCH_CUSTOM, DISPLAY_CUSTOM, HOTEL_CUSTOM, PMAX_REPLACEMENT_SHOPPING, ADOPT_AI_MAX, ADOPT_BROAD_MATCH_KEYWORDS, COMPARE_CAMPAIGNS, OPTIMIZE_ASSETS. Devolve as campanhas em rascunho (`in_design_campaigns`). |
| `list_experiments` | leitura | Experimentos com status, datas, promote_status, braços (controle/tratamento, %, campanhas e rascunhos) e erros assíncronos (`GET experiments/{id}:listExperimentAsyncErrors`). |
| `get_experiment_results` | leitura | Tratamento × controle por métrica (cliques, impressões, custo, conversões, CPA, valor, valor/custo): lift, intervalo (estimativa ± margem), p-valor, veredito (AUMENTO/QUEDA_SIGNIFICATIVA, INCONCLUSIVO, SEM_DADOS) e se é favorável (CPA menor = favorável; custo é neutro). |
| `schedule_experiment` | escrita | `experiments/{id}:scheduleExperiment` (assíncrono). Só em SETUP; confere se há rascunho no tratamento. |
| `end_experiment` | escrita | `:endExperiment`, `confirm: true`. |
| `promote_experiment` | escrita | `:promoteExperiment` (assíncrono, permanente), `confirm: true`. Recusado para PMAX_REPLACEMENT_SHOPPING, COMPARE_CAMPAIGNS e OPTIMIZE_ASSETS. |
| `graduate_experiment` | escrita | `:graduateExperiment` com `campaignBudgetMappings` (campanha de tratamento → orçamento), `confirm: true`. Orçamento existente (`campaignBudgetId`) ou novo (`dailyBudgetMicros`). Recusado para ADOPT_*. Em COMPARE_CAMPAIGNS a prévia e o resultado listam as campanhas que o Google PAUSA (controle e demais braços). |
| `update_experiment_campaign` | escrita | Altera a campanha em RASCUNHO (tratamento de experimento ou rascunho de campanha): nome, estratégia (MAXIMIZE_CONVERSIONS / MAXIMIZE_CONVERSION_VALUE / TARGET_SPEND) e alvos (tCPA, tROAS, teto de CPC). Só mexe em campanha `experiment_type = DRAFT`. |
| `create_campaign_draft` | escrita | `campaignDrafts:mutate` create; devolve o ID da campanha em rascunho. |
| `list_campaign_drafts` | leitura | Rascunhos com status e, em PROMOTE_FAILED, os erros (`GET campaignDrafts/{base~draft}:listAsyncErrors`). |
| `promote_campaign_draft` | escrita | `campaignDrafts/{base~draft}:promote` (assíncrono), `confirm: true`, só PROPOSED. |

Fluxo A/B de Pesquisa (ex.: testar tCPA):
1. `create_experiment` type SEARCH_CUSTOM, controlCampaignId, suffix, trafficSplit, datas.
2. `update_experiment_campaign` experimentId + targetCpaMicros (o Google exige ao menos uma mudança no rascunho).
3. `schedule_experiment` → `list_experiments` até ENABLED (erros em async_errors).
4. `get_experiment_results` → `promote_experiment` / `graduate_experiment` / `end_experiment`.

Fluxo DSA → AI Max (automigração de fev/2027): `create_experiment` type ADOPT_AI_MAX na campanha de Pesquisa;
a mesma operação liga `ai_max_setting.enable_ai_max` e, como no exemplo oficial, personalização de texto e
expansão de URL final (desligáveis com `aiMaxTextCustomization`/`aiMaxFinalUrlExpansion: false`). Os tipos de
automação que já existiam na campanha são reenviados como estavam (campo repetido). Divisão 50/50 fixa.

Detalhes e decisões:
- Criação atômica: braços de experimento não aceitam partial failure e têm de ir juntos (guia system-managed);
  o `googleAds:mutate` com ID temporário (usado pelos exemplos oficiais de intra-campaign e asset optimization)
  permite validateOnly de ponta a ponta. Por isso nenhuma tool do lote é "chained".
- As tools comuns não enxergam rascunhos: o GAQL só devolve campanha de rascunho com
  `PARAMETERS include_drafts=true`. Por isso existe `update_experiment_campaign`; `set_tracking`
  (campanha/grupo) também lê com include_drafts. Grupos, anúncios e palavras-chave DENTRO do rascunho
  continuam sem tool própria (ver "parcial").
- Validação local antes da API: nome único (lê experimentos), canal da campanha de controle por tipo,
  campanha BASE e não removida, orçamento compartilhado (recusado pela API em experimentos), AI Max já ligado,
  datas (início não no passado, fim depois do início), `syncEnabled` só SEARCH/DISPLAY_CUSTOM, braços de
  COMPARE_CAMPAIGNS (2–5, soma 100, mínimo 1%, sem braços idênticos), textos de OPTIMIZE_ASSETS (30/90/90).
- validateOnly nos endpoints de ação: `customerWriteAction` recusa dry-run fora de upload de conversões
  (fail-closed). Os endpoints de experimento/rascunho/`customers:mutate` TÊM `validate_only` no proto; o módulo
  usa um helper (`validatableAction`) que, em dry-run, chama `customerAction` com `validateOnly: true` e,
  fora do dry-run, passa por `customerWriteAction` (guard de read-only). Nada mudou no client para escrita.
- `graduate_experiment` com `dailyBudgetMicros` cria o orçamento e depois gradua; em validateOnly isso é
  recusado sem enviar nada (o ID do orçamento só existe depois de gravar) — use `campaignBudgetId` para validar.
  Se a graduação falhar depois do orçamento criado, a resposta diz qual orçamento ficou órfão.
- O que a graduação faz com as outras campanhas depende do tipo:
  - SEARCH/DISPLAY/HOTEL_CUSTOM e PMAX_REPLACEMENT_SHOPPING (guia system-managed): "The control campaign is
    not modified" — o tratamento vira campanha independente;
  - COMPARE_CAMPAIGNS (guia campaign-mix, "Graduate or end"): as campanhas dos outros braços, INCLUSIVE o
    controle, são pausadas. A prévia (sem `confirm`) traz `campaigns_to_pause` (ID, nome, status, braço e se é
    o controle) e um aviso; o resultado traz `paused_campaigns` (ou `campaigns_to_pause` em dry-run, que não
    afirma pausa). A tool não reativa nada — reativar é manual;
  - OPTIMIZE_ASSETS: a campanha base é pausada e o tratamento vira campanha nova (aviso na prévia).

## 3. Rastreamento de URL

| Tool | Tipo | O que faz |
|---|---|---|
| `get_tracking_settings` | leitura | Modelo de acompanhamento, sufixo e parâmetros personalizados em conta, campanhas, grupos, anúncios e palavras-chave; efetivo por grupo (grupo > campanha > conta, com a origem); anúncios/palavras-chave que sobrepõem; problemas: `SOBREPOSICAO`, `PARAMETRO_NAO_DEFINIDO` ({_chave} sem parâmetro), `MODELO_SEM_LPURL`, `SUFIXO_INVALIDO`. |
| `set_tracking` | escrita | Define/limpa `trackingUrlTemplate`, `finalUrlSuffix` e parâmetros (mescla por chave; `removeCustomParameterKeys`; `clear`) em `account`, `campaign`, `adGroup`, `ad` (adGroupId~adId ou adId) e `keyword` (adGroupId~criterionId). Várias entidades por chamada com partial failure e relatório por item. |

- Prioridade (Google): palavra-chave > anúncio > grupo > campanha > conta.
- Impacto: campanha/grupo/conta não interrompem a veiculação; anúncio e palavra-chave vão para revisão e
  PARAM de veicular até aprovar → `confirm: true` obrigatório nesses níveis. Conta também pede `confirm`
  (vale para todas as campanhas sem valor próprio).
- Validações locais (erros de `UrlFieldError`): modelo começa com http(s):// ou `{lpurl...}`; sufixo sem `?`/`&`
  no começo e sem `{lpurl}`/`{ignore}`; parâmetro com chave alfanumérica de até 16 caracteres, valor até 200
  bytes, sem repetição (sem diferenciar maiúsculas) e no máximo 8 por entidade depois da mescla.
- Limpar = caminho no updateMask sem valor. Conta não tem parâmetros personalizados (não existe no proto).
- Conta: `POST customers/{id}:mutate` com `operation.update` (CustomerService).
- Anúncio: `ads:mutate` (`customers/{id}/ads/{adId}`), como o `update_ad` do núcleo.

## 4. Rótulos

| Tool | Tipo | O que faz |
|---|---|---|
| `create_label` (alterada) | escrita | Agora aceita `backgroundColor` (hex) e `description` (≤200); nome 1–80; se já existe rótulo ativo com o nome, devolve o existente sem criar. |
| `assign_label` (alterada) | escrita | `resourceType` campaign, adGroup, adGroupAd (adGroupId~adId), **adGroupCriterion** (adGroupId~criterionId) e **customer** (contas clientes; `customerId` = MCC dono do rótulo; uma requisição por conta, como a API exige). `resourceIds[]` (mantém `resourceId` por compatibilidade), `action` assign/unassign (`confirm` no unassign), partial failure, pula o que já está no estado pedido, recusa negativa e item removido. |
| `list_labels` (alterada) | leitura | Cor, descrição e contagem de uso por rótulo (campanhas, grupos, anúncios, palavras-chave, contas); `includeRemoved`; json/table/csv. `accounts` vem de `customer_client.applied_labels` consultado no MCC. |
| `update_label` | escrita | Nome, cor, descrição (só as folhas que mudam; `""` limpa cor/descrição); recusa nome repetido. |
| `remove_label` | escrita | Remove o rótulo (irreversível), `confirm: true`; sem confirm mostra quantos itens usam (contas clientes via `customer_client.applied_labels CONTAINS ANY`). |
| `get_label_performance` | leitura | Métricas só dos itens com os rótulos (campaign/adGroup/ad/keyword), `match` ANY/ALL (`<recurso>.labels CONTAINS ANY/ALL (...)`), total do conjunto + detalhe. |
| `update_status_by_label` | escrita | Pausa/ativa tudo com os rótulos (campaign/adGroup/ad/keyword); `confirm: true` (sem ele devolve a prévia); só envia quem muda; partial failure. |

- Filtro por rótulo é por ID/resource name (a API não filtra por nome — guia de labels).
- Contas rotuladas: o vínculo `CustomerLabel` mora na conta ROTULADA (`customers/{cliente}/customerLabels/{id}`,
  proto `customer_label.proto`), e é lá que o `assign_label` grava e lê. Consultar `customer_label` no MCC só
  traz rótulos aplicados ao próprio MCC — por isso `list_labels` e a prévia do `remove_label` mostravam
  `accounts: 0` para rótulos em uso. Agora a contagem vem de `customer_client.applied_labels` (no MCC: "labels
  owned by the requesting customer that are applied to the client customer"), cada conta contada uma vez e só
  com rótulos da própria conta consultada. Em conta de anunciante o número é 0 (rótulo de anunciante não vai
  em conta). Se a consulta falhar, a prévia do `remove_label` diz "indisponível" em vez de 0.
- O pedido original era um parâmetro `labelIds` nos relatórios de desempenho e no `bulk_update_status`
  existentes; essas tools não são deste lote (regra de ownership), então o filtro por rótulo veio como
  `get_label_performance` e `update_status_by_label`. Ligar `labelIds` nas tools existentes é uma linha de
  WHERE (`campaign.labels CONTAINS ANY (...)`) — fica para quem for dono delas.

## Parcial / fora do alcance (com motivo)

- `create_experiment` não cria YOUTUBE_CUSTOM (exige `video_experiment` subtype e teste criativo por braço —
  `ExperimentError.MISSING_VIDEO_EXPERIMENT_SUBTYPE`) nem PMAX_TEXT_CUSTOMIZATION_FINAL_URL_EXPANSION (o guia
  manda ligar o recurso por atualização da campanha sem dizer quais campos). Experimentos desses tipos criados
  na interface aparecem em `list_experiments`/`get_experiment_results` e podem ser encerrados/promovidos.
- OPTIMIZE_ASSETS só com textos novos (HEADLINE, LONG_HEADLINE, DESCRIPTION) — imagem exigiria upload binário
  na mesma operação. A ordem das operações segue o exemplo oficial em Python (assets → experimento → braços →
  vínculos), que diverge da ordem do texto do guia.
- Graduar OPTIMIZE_ASSETS: o braço de tratamento aponta para a mesma campanha do controle; a tool usa essa
  campanha no `campaignBudgetMappings` e avisa — o guia não detalha o campo nesse tipo.
- Dentro de campanhas em rascunho só há edição de nome, estratégia/alvos (update_experiment_campaign) e
  rastreamento (set_tracking); grupos/anúncios/palavras-chave do rascunho não são alcançados pelas tools
  comuns (o GAQL delas não usa include_drafts).
- `read-only.ts` e o allowlist de dry-run do client não foram tocados (não pertencem ao lote): a classificação
  vem do catálogo do módulo e o validateOnly dos endpoints de ação vem do helper `validatableAction`.

## Mudança no client (para o integrador)

`src/google-ads-client.ts` ganhou, no FIM da classe, sob `// ── lote experiments-tracking ──`, o método
`customerGet(customerId, path, params)` — GET de leitura sob `customers/{id}`. É o único jeito de chamar
`experiments/{id}:listExperimentAsyncErrors` e `campaignDrafts/{base~draft}:listAsyncErrors` (métodos GET que
não são GAQL) com o mesmo tratamento de erro/retry do `request` privado. Não grava nada.
