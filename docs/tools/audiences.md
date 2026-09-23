# Lote audiences — Públicos, remarketing e Customer Match

Módulo: `src/tools/audiences.ts` (tools novas + implementação das antigas corrigidas).
Catálogo: `src/tools/audiences.catalog.ts`. Testes: `tests/audiences.test.ts`.

As tools antigas do núcleo que este lote corrige continuam registradas em `src/tools.ts`
(com o mesmo nome e classificação): lá elas conferem a conta (`checkCustomerAccess`) e
delegam, via `import()` dinâmico, para as funções exportadas do módulo.

Fonte de verdade usada (v25): `resources/custom_audience.proto`, `resources/user_list.proto`,
`common/user_lists.proto`, `common/criteria.proto`, `resources/{campaign,ad_group}_criterion.proto`,
`common/targeting_setting.proto`, `resources/ad_group.proto`, `errors/criterion_error.proto`,
`errors/user_list_error.proto`, `errors/custom_audience_error.proto`,
`services/offline_user_data_job_service.proto`, `common/offline_user_data.proto`; guias
"Targeting settings", "Audiences", "Custom audiences", "Visited specific pages", "Customer Match —
get started", "Deprecations"; Ajuda do Google Ads 10537509 (segmentação otimizada); Data Manager API
(`audienceMembers:ingest`, regras de formatação). Toda query foi validada contra
`tests/fixtures/google-ads-v25-fields.json`.

## Item 6 — Segmentos personalizados (custom audiences)

### `create_audience_segment` (write, corrigida)
- Antes: mandava `keywordInfo`/`urlInfo` (campos que não existem em `CustomAudienceMember`; o REST recusa
  com "Unknown name") e `status` (OUTPUT_ONLY). Nenhuma outra tool conseguia usar o público criado.
- Agora: `members: [{memberType: KEYWORD, keyword} | {memberType: URL, url} | {memberType: APP, app}]`,
  sem `status`; `type` AUTO (default) ou SEARCH — INTEREST/PURCHASE_INTENT são recusados em público novo
  (o proto diz que só existem em públicos antigos); `description`; devolve o resource name e o ID.
- Validação antes da API: keyword ≤ 10 palavras e ≤ 80 caracteres; URL com `http(s)://` e ≤ 2048
  caracteres; app = pacote Android; membros repetidos são deduplicados; ao menos um membro.
- Lê os segmentos da conta e recusa nome repetido sem diferenciar maiúsculas (`NAME_ALREADY_USED`).
- PLACE_CATEGORY existe no proto, mas não há como descobrir os IDs pela API: não é oferecido.

### `update_custom_audience` (write, nova)
- Parâmetros: `customAudienceId`, `name?`, `description?`, `membersMode` add (default) | remove | replace,
  `keywords/urls/apps`.
- Lê o segmento, monta a lista final (o UPDATE com `members` substitui a lista inteira), preserva
  membros PLACE_CATEGORY, mostra antes/depois, não grava se nada muda, recusa deixar sem membros.
- Renomear para um nome já usado por outro segmento ativo (sem diferenciar maiúsculas) é recusado;
  nome de segmento removido fica livre.
- `updateMask`: só `name`, `description`, `members` que mudaram. O tipo não é editável
  (`CustomAudienceError.INVALID_TYPE_CHANGE`).

## Item 7 — Segmentação por público, Observação × Segmentação

### `search_audience_segments` (read, nova) e `list_audience_segments` (read, corrigida)
- `type`: AUDIENCE, USER_LIST, AFFINITY, IN_MARKET (user_interest por taxonomy_type), LIFE_EVENT,
  DETAILED_DEMOGRAPHIC, CUSTOM, COMBINED; `query` por trecho do nome (LIKE com `% _ [ ]` escapados
  entre colchetes, como manda a gramática GAQL); `limit` 1–1000; `format` json/table/csv.
- Devolve `targeting_type` + `id` prontos para `add_audience_segment_targeting` (DETAILED_DEMOGRAPHIC
  não tem alvo direto nesta tool: vai dentro de um Audience).
- `list_audience_segments` sem `type` continua listando Audiences (compatível); com `type` é o mesmo
  que `search_audience_segments`. A descrição antiga prometia "custom, in-market, affinity" mas só lia
  `FROM audience`.

### `add_audience_segment_targeting` (write, nova)
- `level` campaign | adGroup, `campaignId`/`adGroupId`, `segments[]` (até 50) com `type`
  (USER_LIST, USER_INTEREST, CUSTOM_AUDIENCE, COMBINED_AUDIENCE, LIFE_EVENT, AUDIENCE), `id` ou
  `resourceName`, `negative?`, `bidModifier?` (0.1–10, só em alvo), `targetingMode?`
  (OBSERVATION | TARGETING | KEEP).
- Critério gerado (oneof do proto): `userList.userList`, `userInterest.userInterestCategory`,
  `customAudience.customAudience`, `combinedAudience.combinedAudience`, `lifeEvent.lifeEventId`
  (ID, não resource name), `audience.audience`.
- Regras conferidas antes de gravar (fontes: criterion_error.proto e guias):
  - PMax não aceita segmento como critério → aponta `add_audience_signal`.
  - AUDIENCE só como critério de grupo (CampaignCriterion não tem AudienceInfo), só em Demand Gen/App
    (MULTI_CHANNEL) e só em grupo com `audience_setting.use_audience_grouped = true` (imutável);
    um Audience por grupo (`ONE_AUDIENCE_ALLOWED_PER_AD_GROUP`).
  - Grupo com `use_audience_grouped = true` não aceita segmentos avulsos
    (`CANNOT_ADD_AUDIENCE_SEGMENT_CRITERION_WHEN_AUDIENCE_GROUPED_IS_SET`).
  - Lista positiva no nível da campanha só em Pesquisa; em Display, na campanha só exclusão (guia
    "visited specific pages").
  - Lista positiva não pode ficar na campanha e no grupo ao mesmo tempo.
  - Listas SIMILAR recusadas (alvo e exclusão); lista CLOSED não pode ser alvo positivo; segmento
    removido ou de outra conta recusado; Audience com escopo ASSET_GROUP recusado.
  - Segmento já existente: no-op, ou atualiza só o `bid_modifier` se vier um diferente; polaridade
    oposta (alvo × exclusão) é recusada com instrução para remover antes.
- Modo da dimensão AUDIENCE (TargetingSetting): sem restrição, a API aplica Segmentação
  (bid_only=false) e o segmento positivo passa a restringir o alcance. Por isso:
  - Pesquisa/Shopping, adicionando alvo positivo e sem restrição AUDIENCE explícita: vira Observação
    por padrão — **exceto** se já houver segmentos positivos operando em Segmentação implícita; aí a
    tool recusa e pede `targetingMode` explícito (trocar o modo mudaria o alcance atual).
  - Restrição já explícita é mantida; `targetingMode` explícito é aplicado no nível pedido.
  - **Pedido de grupo nunca troca o modo da campanha.** Com `level=adGroup`, se o targeting_setting mora
    na campanha (a API não aceita no grupo enquanto a campanha tiver, e ele vale para todos os grupos),
    qualquer troca de modo — `targetingMode` explícito diferente do atual ou o default de Observação em
    Pesquisa/Shopping — é recusada sem gravar nada, com a lista de grupos que mudariam de comportamento
    e duas saídas: `set_targeting_mode level=campaign` (decisão consciente para a campanha inteira) e
    depois repetir o pedido, ou `targetingMode KEEP`. Mesma regra do `set_targeting_mode`. Só
    `level=campaign` grava o targeting_setting da campanha.
  - A lista inteira de restrições é reenviada (a API apaga o que faltar), com updateMask
    `targeting_setting.target_restrictions`; campanha e grupos não podem ter setting ao mesmo tempo,
    então a tool recusa quando gravar exigiria isso.
- Tudo vai numa operação atômica `googleAds:mutate` (setting + critérios): ou grava tudo, ou nada.
- Dry-run/validateOnly: a mutação sai com validate_only e a resposta diz que nada foi gravado.

### `update_ad_group_targeting` (write, corrigida)
- Antes: sempre `AudienceInfo` com `bidModifier: 1.0` — falhava em Pesquisa, Display e Shopping.
- Agora: o tipo sai do resource name (`userLists`, `userInterests`, `customAudiences`,
  `combinedAudiences`, `lifeEvents`, `audiences`) ou de `segmentType`; delega para
  `add_audience_segment_targeting` (level=adGroup) com todas as validações; `bidModifier` só é enviado
  se informado; aceita `negative` e `targetingMode` (só do grupo: se o setting estiver na campanha, a
  troca de modo é recusada como em `add_audience_segment_targeting` level=adGroup).

### `remove_audience_segment_targeting` (write, nova)
- Remove alvos/exclusões por `criterionIds` ou `segments`; exige `confirm: true` (sem ele mostra o que
  sairia); `partialFailure` com relatório por item.

### `set_targeting_mode` (write, nova)
- `level`, `campaignId`/`adGroupId`, `dimension` (AUDIENCE default; AGE_RANGE, GENDER, PARENTAL_STATUS,
  INCOME_RANGE, TOPIC, PLACEMENT, KEYWORD), `mode` OBSERVATION | TARGETING.
- Lê as restrições, troca só a dimensão, reenvia a lista inteira; no-op quando já está no modo
  (ausente = Segmentação); recusa gravar no grupo se a campanha tem setting e na campanha se algum grupo
  tem o próprio.

### `set_optimized_targeting` — movida
- Na integração ficou só a versão do grupo `placements-brand-safety` (duas tools com o mesmo nome
  derrubavam o registro); a restrição "`exclude_demographic_expansion` só em Demand Gen" desta versão
  não vale pelo proto. Documentação: `docs/tools/placements-brand-safety.md`.

## Item 8 — Listas de remarketing

### `create_remarketing_list` (write, corrigida)
- Antes: todas as regras num único `ruleItemGroup` (itens de um grupo são E — o "OU" padrão virava E),
  exclusões idem, `membershipLifeSpan` enviado (ignorado em rule-based) e janela só na exclusão, lista
  sem pré-população, CUSTOM_EVENT gravando `ecomm_pagetype`.
- Agora: um `FlexibleRuleOperandInfo` por regra, com `lookbackWindowDays` = `lookbackDays` da regra ou
  `membershipLifeSpan`; `inclusiveRuleOperator` = `ruleOperator` (OR default); uma exclusão por operando
  (exclusivos são OU no proto), com janela `excludeLifeSpan` ou `membershipLifeSpan`;
  `prepopulationStatus: REQUESTED` por padrão (`prepopulate: false` desliga); `membership_life_span`
  não é enviado.
- ruleType: URL_CONTAINS, URL_EQUALS, URL_STARTS_WITH, URL_ENDS_WITH, REFERRER_URL_CONTAINS
  (`ref_url__`) e CUSTOM_PARAMETER `{parameterName, operator, value, valueType?}` (texto ou número).
  CUSTOM_EVENT continua no schema só para devolver o erro explicado.
- Validação: janelas 1–540; URL sem quebra de linha, aspas, tab ou parênteses (proto); nome de
  parâmetro nas regras do proto; nome de lista único (lido antes).
- A resposta traz a regra legível, ex.: `(url CONTAINS "/produto" [30d]) OU (url CONTAINS "/categoria" [30d]) E NÃO [(url CONTAINS "/obrigado" [7d])]`.

### `create_logical_user_list` (write, nova)
- `rules: [{operator ALL|ANY|NONE, userListIds}]`, combinadas em E (ex.: carrinho E NÃO compradores).
- Confere as listas: existem, não são LOGICAL (`CAN_NOT_ADD_LOGICAL_LIST_AS_LOGICAL_LIST_OPERAND`), não
  são SIMILAR, sem misturar CRM_BASED com outros tipos; avisa regra só com NONE e operandos CLOSED.

### `update_remarketing_list` (write, corrigida)
- Lê a lista antes; recusa lista somente leitura/SIMILAR/EXTERNAL; `membershipLifeSpan` em RULE_BASED
  ou LOGICAL é recusado com a explicação (a duração é a janela de cada regra — mostra as atuais) e a
  orientação de criar outra lista; fechar (CLOSED) exige `confirm: true`; `eligibleForSearch` novo;
  descrição vazia recusada (INVALID_DESCRIPTION); no-op não grava; updateMask só com o que muda.

### `list_remarketing_lists` (read, corrigida)
- Filtros `query` e `type`; `format`. Novos campos: faixas de tamanho, read_only, access_reason,
  closing_reason, match rate (CRM), pré-população e regra legível (rule-based), combinação (lógicas).
  `membership_days` é `null` em rule-based/lógicas (a API ignora esse campo nelas).

## Item 62 — Relatórios de público e demografia

### `get_audience_performance` (read, nova)
- `level` campaign (campaign_audience_view) | ad_group (ad_group_audience_view), `campaignId?`,
  `adGroupId?`, `dateRange`/`days`, `minClicks` (20), `threshold` (0.3), `limit` (200), `format`.
- Por segmento: nome, tipo, modo efetivo (Observação/Segmentação e de onde vem: grupo, campanha ou
  padrão da API), ajuste de lance, métricas, CTR/CPA/ROAS comparados à campanha no mesmo período e um
  sinal ("candidato a aumentar/reduzir lance", "gastou ≥ 1 CPA médio sem converter", "dados
  insuficientes").

### `get_demographic_performance` (read, nova)
- `dimension` AGE | GENDER | PARENTAL | INCOME (views separadas — a API não cruza idade × gênero),
  `level` campaign | ad_group, filtros, período, `minClicks`, `threshold`, `format`.
- Base de comparação = soma das faixas da campanha (toda impressão cai em uma faixa). Faixas excluídas
  (no grupo ou na campanha) aparecem mesmo sem métrica; `bid_down_candidate` marca CPA acima do limiar
  ou gasto ≥ 1 CPA médio sem conversão.

## Item 86 — Customer Match (parcial)

### `create_customer_match_list` (write, nova)
- `crm_based_user_list` com `upload_key_type` CONTACT_INFO (default), CRM_ID ou MOBILE_ADVERTISING_ID
  (+ `appId`, obrigatório só nesse caso); `membershipLifeSpan` 1–540 (default 540 — desde 07/04/2025 não
  existe mais duração infinita, então 10000 é recusado); nome único.

### `upload_customer_match_members` (write, encadeada)
- `userListId`, `members[{email, phone}]`, `emails[]`, `phones[]`, `mode` add | remove | replace,
  `consent {adUserData, adPersonalization}`, `defaultCountryCode` (55), `preview`, `confirm`.
- Normaliza no servidor (e-mail minúsculo e sem espaços; gmail.com/googlemail.com sem pontos e sem
  `+sufixo`; telefone E.164 — `+`/`00` = já tem DDI; sem DDI, com o padrão 55 aceita 10/11 dígitos ou
  12/13 começando com 55, o resto é recusado como ambíguo) e faz SHA-256 hex. Nada em claro volta na
  resposta: inválidos e recusados são citados pelo índice (`emails[3]`).
- Fluxo (OfflineUserDataJobService): `offlineUserDataJobs:create` (CUSTOMER_MATCH_USER_LIST, com
  consentimento) → `:addOperations` em lotes de até 10.000 identificadores, `enablePartialFailure`,
  `removeAll` primeiro no replace → `:run`. Relata por item o que a API recusou.
- Portões: consentimento GRANTED/GRANTED para incluir (com DENIED a API recusa); `confirm: true` para
  remove/replace (conferido antes de ler a lista — sem ele nada é lido nem enviado); `preview: true`
  valida sem enviar; lista precisa ser CRM_BASED/CONTACT_INFO e editável (read_only recusada em
  qualquer modo) e OPEN para incluir (CLOSED recusa add/replace; remover de lista CLOSED é permitido);
  até 10.000 contatos por chamada.
- `validateOnly` é recusado (tool encadeada — o job criado em validate_only não tem ID); em dry-run
  (GOOGLE_ADS_DRY_RUN) nada é enviado e a resposta diz isso.

### `get_customer_match_status` (read, nova)
- Listas CRM_BASED: match rate, tamanhos e faixas (Pesquisa/Display), elegibilidade, duração, status e
  os últimos jobs de upload (status, motivo de falha, faixa de match); se a leitura dos jobs falhar, a
  tool devolve as listas e avisa.

### Por que é parcial
- Desde **01/04/2026** o Google recusa `OfflineUserDataJobService`/`UserDataService` de Customer Match
  para projetos do Google Cloud sem uso prévio de Customer Match (erro
  `CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE`). Para esses projetos o caminho é a **Data Manager API**
  (`POST https://datamanager.googleapis.com/v1/audienceMembers:ingest`, até 10.000 membros por
  requisição, escopo OAuth `https://www.googleapis.com/auth/datamanager`).
- Este servidor só chama `googleads.googleapis.com` e o token OAuth só tem o escopo `adwords`; incluir
  o host e o escopo novos cabe ao lote account-auth (cliente, fluxo OAuth) — compartilhado com o upgrade
  de conversões offline. A tool de upload já entrega normalização + hash + consentimento; falta só o
  transporte para a Data Manager.
- Enquanto isso: projetos com histórico de Customer Match usam a tool normalmente; os demais recebem o
  erro explicado e sobem a lista pela interface do Google Ads ou pela Data Manager API.
- Store sales (allowlist) não foi construído, como pedido.

## Fluxos

- **RLSA em Pesquisa**: `list_remarketing_lists` → `add_audience_segment_targeting`
  (level campaign, USER_LIST, bidModifier 1.3) → fica em Observação → depois de alguns dias,
  `get_audience_performance` → ajustar `bidModifier` (mesma tool) ou `set_targeting_mode`.
- **Carrinho abandonado sem compra**: `create_remarketing_list` (URL /carrinho, excluir /obrigado 7d) ou
  `create_logical_user_list` (ANY carrinho, NONE compradores) → Display: `add_audience_segment_targeting`
  (level adGroup).
- **Prospecção por concorrentes**: `create_audience_segment` (URLs de concorrentes, type AUTO) →
  `add_audience_segment_targeting` (CUSTOM_AUDIENCE) em Display/Demand Gen/Vídeo.
- **Exclusões demográficas**: `get_demographic_performance` (AGE) → faixas candidatas → ajuste de lance
  (lote bid-modifiers).
- **Customer Match**: `create_customer_match_list` → `upload_customer_match_members` (preview, depois
  envio) → `get_customer_match_status`.

## Correções pós-revisão (branch batch/audiences-fix)

- `add_audience_segment_targeting` / `update_ad_group_targeting`: com `level=adGroup` e o
  targeting_setting na campanha, a tool trocava o modo AUDIENCE da campanha inteira (update em
  `customers/{cid}/campaigns/{id}` dentro da operação atômica) sem confirm — virar Observação →
  Segmentação passava a restringir o alcance de todos os grupos. Agora recusa, como o
  `set_targeting_mode`; só `level=campaign` grava o setting da campanha. Testado pelas duas tools, nos
  dois sentidos e no default de Pesquisa.
- Testes novos para portões que não tinham cobertura (cada um conferido quebrando a guarda de propósito):
  `confirm` do mode=remove no upload de Customer Match, lista CRM CLOSED e somente leitura, polaridade
  invertida (alvo × exclusão), nome repetido ao renomear segmento personalizado, Audience com escopo
  ASSET_GROUP, CUSTOM/COMBINED_AUDIENCE removido e limite de 50 segmentos.

## Pendências fora da posse deste lote (para o integrador)

- ~~`create_ad_group` ganhar `useAudienceGrouped`~~ — resolvido na integração: `create_ad_group` recusa DEMAND_GEN e
  aponta para `create_demand_gen_ad_group`, que envia `audience_setting.use_audience_grouped=true` sempre que o grupo
  nasce com público (ou quando pedido com `useAudienceGrouped`); `set_demand_gen_ad_group_targeting` recusa público em
  grupo criado sem ele (o ajuste é imutável).
- O compositor de Audience (`create_audience_from_lists`, item 49) aceitar CUSTOM_AUDIENCE: a tool não é
  deste lote. O critério direto por custom audience já existe em `add_audience_segment_targeting`.
- README principal: tabelas de públicos/remarketing ainda descrevem as versões antigas.
