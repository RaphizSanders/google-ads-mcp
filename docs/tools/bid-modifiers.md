# Lote bid-modifiers — ajustes de lance, programação e demografia

Módulo: `src/tools/bid-modifiers.ts` · catálogo: `src/tools/bid-modifiers.catalog.ts` ·
testes: `tests/bid-modifiers.test.ts`.

As seis tools que já existiam em `src/tools.ts` (`set_location_bid_adjustment`,
`set_device_bid_adjustment`, `set_age_bid_adjustment`, `set_gender_bid_adjustment`,
`set_ad_schedule`, `get_device_breakdown`) foram **reescritas neste módulo** e removidas de
`src/tools.ts` (ficou um comentário no lugar de cada uma). Os nomes e a classificação
(read/write em `src/read-only.ts`) não mudaram. As nove tools novas estão no catálogo do lote.

## Regras comuns

- **Ler antes de gravar.** Toda escrita confere o que existe na conta, envia só o que muda e
  devolve antes/depois. Valor igual ao atual → nenhuma escrita (mensagem "nada a mudar").
- **Upsert de ajuste de lance.** Critério existente → `update` com `updateMask: bid_modifier`;
  inexistente → `create`. Era o bug do item 4: as tools só criavam, então repetir um ajuste
  falhava (`BID_MODIFIER_ALREADY_EXISTS` / `CANNOT_ADD_EXISTING_FIELD`).
- **Faixa do bid_modifier** (protos v25): 0.1–10.0 (1.0 = sem ajuste, 1.3 = +30%). `0` só vale
  para dispositivo (−100%, exclusão). Idade/gênero com 0 era aceito pela tool e recusado pela API.
- **Exclusão é critério negativo.** `negative` é IMMUTABLE: trocar um ajuste positivo por
  exclusão é `remove` + `create negative`. Critérios de dispositivo e demográficos têm
  `criterion_id` fixo (AGE_RANGE_18_24 = 503001, MOBILE = 30001...), então o remove e o create
  atingem o **mesmo recurso** (`{pai}~{id}`) — e a API recusa mutar o mesmo recurso duas vezes numa
  requisição (`errors/mutate_error.proto`: `ID_EXISTS_IN_MULTIPLE_MUTATES`, "Cannot mutate the same
  resource twice in one request"). Por isso essas trocas vão em **duas requisições ordenadas**:
  1) só as remoções dos critérios que serão recriados; 2) o resto (creates, updates e demais
  remoções). Se a 1 falhar, nada foi gravado. Se a 2 falhar depois da 1 gravada, a resposta diz
  **"GRAVAÇÃO PARCIAL"** e o estado exato de cada item (ex.: "o ajuste positivo foi removido e a
  exclusão não foi criada — voltou ao padrão"); repetir a mesma chamada conclui, porque a tool relê
  a conta. Em validateOnly a remoção é validada e o create dependente **não é enviado** (em
  validate_only nada é removido, então ele seria recusado por um motivo falso) — a resposta diz que
  ele não foi validado (`not_validated`). Isto foi deduzido do proto + payload; não houve teste ao
  vivo (sem credenciais aqui).
- **Smart Bidding** (TARGET_CPA, TARGET_ROAS, MAXIMIZE_CONVERSIONS, MAXIMIZE_CONVERSION_VALUE)
  não usa ajustes manuais, exceto −100% em dispositivo — a tool grava e avisa. A programação e as
  exclusões continuam valendo (Google Ads Help, "About bid adjustments").
- **Atomicidade.** Operações dependentes vão numa única requisição sem `partialFailure` (ou
  tudo, ou nada) — exceto a troca positivo ↔ negativo acima, que a API obriga a separar.
  Atualizações independentes em lote usam `partialFailure` com relatório por item.
- **confirm: true** em tudo que amplia alcance ou apaga configuração: local fora da segmentação,
  `set_ad_schedule` com `replace` que remove horários, `remove_ad_schedule`, remover todos os
  limites de frequência. Em validateOnly/dry-run o confirm não é exigido (nada é gravado).
- **validateOnly** vale para todas as escritas (nenhuma usa um ID criado por outra) e a resposta
  diz "DRY-RUN (validateOnly): validado na API, nada foi gravado" — ou, na troca positivo ↔ negativo,
  que a etapa 1 foi validada e o create dependente não pôde ser.
- Erros da API voltam com o texto original + explicação em PT-BR dos códigos conhecidos
  (`BID_MODIFIER_ALREADY_EXISTS`, `CANNOT_EXCLUDE_ALL_TARGETS`, `CANNOT_TARGET_ONLY_UNDETERMINED`,
  `AD_SCHEDULE_*`, `CANNOT_BID_MODIFY_*`, `CANNOT_OVERRIDE_OPTED_OUT_CAMPAIGN_CRITERION_BID_MODIFIER`,
  `MAX_IMPRESSIONS_NOT_IN_RANGE`, `TIME_UNIT_NOT_SUPPORTED`, `ID_EXISTS_IN_MULTIPLE_MUTATES`...).

## Tools reescritas

### `set_location_bid_adjustment` (write)
Ajuste de lance por local. Parâmetros: `campaignId`, `locationId` (geo_target_constant),
`bidModifier` 0.1–10, `confirm?`.
- Local já segmentado → update do bid_modifier.
- Local novo **dentro** de um segmentado (ex.: campanha no Brasil, ajuste na cidade de SP) → cria o
  critério com o ajuste; alcance inalterado. A tool sobe a hierarquia por
  `geo_target_constant.parent_geo_target` para saber.
- Local novo **fora** da segmentação → amplia o alcance: só com `confirm: true`.
- Campanha sem segmentação geográfica positiva (veicula em todo lugar) → recusa: criar um local
  restringiria a campanha a ele. Local excluído, ou dentro de área excluída → recusa.
- Performance Max → recusa (não usa ajuste por local). 0 → recusa e aponta `set_campaign_locations`
  com `negative=true`.
- Limite: campanha com raio/grupo de locais não dá para comparar geograficamente — a tool trata o
  local novo como "fora" e pede confirm.

### `set_device_bid_adjustment` (write)
`campaignId`, `deviceType` (MOBILE, DESKTOP, TABLET, CONNECTED_TV), `bidModifier` (0 ou 0.1–10).
Upsert do critério DEVICE (o `create` não manda mais `criterionId`, que é OUTPUT_ONLY). Recusa
excluir o último entre computador/celular/tablet. PMax → aponta `set_device_targeting`.

### `set_age_bid_adjustment` / `set_gender_bid_adjustment` (write)
`adGroupId`, `ageRange`/`gender`, `bidModifier` 0.1–10. Upsert no grupo de anúncios; 0 é recusado
e aponta `set_demographic_targeting` com `action: EXCLUDE`; valor excluído → recusa (ajuste não se
aplica a exclusão). Critério com status REMOVED é tratado como inexistente (é como a API mostra o
padrão "todos segmentados").

### `set_ad_schedule` (write)
Programação por dia/horário. Aceita `slots[]` (`dayOfWeek`, `startHour`, `startMinute?`, `endHour`,
`endMinute?`, `bidModifier?`) ou os campos avulsos antigos (compatível). `dayOfWeek` aceita
atalhos `WEEKDAYS`, `WEEKEND`, `ALL_DAYS`.
- Validação antes da API: horas inteiras 0–23 / 0–24, minutos em passos de 15, `endHour 24` só com
  `ZERO`, fim depois do início (não atravessa meia-noite), sem sobreposição, no máximo 6 por dia
  (`common/criteria.proto`), mesmo horário repetido só com o mesmo ajuste.
- `replace=false` (padrão): adiciona. Horário idêntico a um existente só atualiza o ajuste;
  sobreposto a um existente é recusado (aponta `replace=true` / `remove_ad_schedule`).
- `replace=true`: a programação vira exatamente `slots[]` — mantém os idênticos (atualiza o ajuste;
  sem `bidModifier` = 1.0), remove os demais e cria os novos numa requisição atômica, remoções
  primeiro. Se remover algum, exige `confirm: true`.
- Os campos de `AdScheduleInfo` são proibidos em UPDATE: mudar o horário é sempre remove + create.
- Avisa quando a campanha era 24/7 e passa a ter horários. Horas no fuso da conta.
- A descrição antiga mandava apagar "via run_gaql" (que é só leitura) — corrigida.

### `get_device_breakdown` (read)
Mesmos campos de antes (`device, impressions, clicks, spend, conversions, revenue, ctr, roas`) mais
`cpc, cpa, conv_rate_pct, spend_share_pct`. Novo `campaignId?` (usa `FROM campaign` — `campaign.id`
não filtra em `FROM customer`) que acrescenta `bid_adjustment` com o ajuste/exclusão atual de cada
dispositivo. `format` json/table/csv.

## Tools novas

### `list_ad_schedules` (read)
`campaignId?`, `withMetrics?`, `dateRange/days`, `format`. Lista os horários (dia, janela, ajuste,
criterionId). Com `withMetrics`, junta impressões, cliques, gasto, conversões, CPA e ROAS de cada
horário (`ad_schedule_view`). Sem horários = 24/7.

### `update_ad_schedule_bid` (write)
Muda só o ajuste de horários existentes: `updates [{criterionId, bidModifier}]` ou
`criterionIds + bidModifier`. `partialFailure` com relatório por item; iguais são pulados;
IDs inexistentes voltam em `not_found`.

### `remove_ad_schedule` (write)
`criterionIds` ou `all: true`, sempre com `confirm: true`. Avisa quando a campanha volta a 24/7.
`partialFailure` com relatório por item.

### `get_time_performance` (read)
Dayparting. `campaignId?` (sem ele, a conta), `dimension` HOUR | DAY_OF_WEEK | HOUR_X_DAY (padrão),
`metric` da grade (CPA padrão, ROAS, CONVERSIONS, COST, CLICKS, IMPRESSIONS, CTR, CONV_RATE,
IMPRESSION_SHARE), `dateRange/days`, `format`.
- Cada célula: impressões, cliques, gasto, conversões, valor, CTR, CPC, CPA, ROAS, taxa de conversão
  e parcela de impressões de Pesquisa (`metrics.search_impression_share`, compatível com
  `segments.hour` e `segments.day_of_week` segundo a field reference v25).
- Marca **fracos** (gastou ≥ 1 CPA médio sem converter; CPA ≥ 1,5× a média; ROAS ≤ metade da média,
  com gasto ≥ 0,5 CPA médio) e **fortes** (≥ 2 conversões e CPA ≤ 0,7× ou ROAS ≥ 1,5× a média).
- Em json, HOUR_X_DAY devolve a grade 7×24 da métrica + os marcados; table/csv trazem todas as células.

### `list_bid_modifiers` (read)
`campaignId`, `includeAdGroups?` (padrão true), `format`. Estado atual numa visão só: dispositivo,
locais, raio, programação e demografia da campanha; e por grupo, demografia (idade, gênero, status
parental, renda — positivos com ajuste e exclusões) e dispositivo (`ad_group_bid_modifier`).

### `set_demographic_targeting` (write)
`adGroupId` **ou** `campaignId`, `dimension` AGE_RANGE | GENDER | PARENTAL_STATUS | INCOME_RANGE,
`values[]` (aceita "18-24", "65+", "undetermined"), `action` EXCLUDE | INCLUDE | BID_ADJUST,
`bidModifier?` (só BID_ADJUST).
- EXCLUDE → critério negativo. Positivo existente (ex.: ajuste de lance) vira remove (requisição 1)
  + create negative (requisição 2) — ver "Exclusão é critério negativo" acima.
- INCLUDE → remove a exclusão (volta ao padrão). Em campanha com critérios positivos (restritiva),
  também cria o positivo; se o valor estava excluído, é remove (requisição 1) + create positivo
  (requisição 2).
- Campanha restritiva: excluir o único valor positivo é recusado (`CANNOT_EXCLUDE_ALL_TARGETS`) —
  o estado "restritiva" é lido antes da mudança.
- BID_ADJUST → upsert do ajuste (só em grupo de anúncios; em campanha é recusado).
- Pré-checa as recusas da API: excluir todos os valores (`CANNOT_EXCLUDE_ALL_TARGETS`, v24.1) e
  deixar só o "desconhecido" (`CANNOT_TARGET_ONLY_UNDETERMINED`).
- Performance Max (campanha): só AGE_RANGE e GENDER (exclusões de gênero em PMax desde a v24).
  Status parental na campanha é só exclusão (tabela de critérios da documentação).
- Renda familiar só existe em alguns países — aviso na resposta; a API decide.
- Nível de campanha fora de PMax: a tabela de critérios da API lista idade/gênero/renda/status
  parental também na campanha, mas o suporte depende do tipo de campanha — a API valida
  (use validateOnly para conferir).

### `set_device_targeting` (write)
`campaignId` **ou** `adGroupId`, `device`, `action` EXCLUDE | INCLUDE | BID_ADJUST, `bidModifier?`.
Rota por tipo:
- PMax (campanha): critério DEVICE positivo/negativo; BID_ADJUST recusado. Com algum positivo, a
  campanha é tratada como restrita (só veicula nos positivos) — estado lido **antes** da mudança:
  - EXCLUDE do **único** dispositivo positivo é recusado: sem positivo, a campanha passaria a
    veicular em todos os outros (ex.: campanha só-celular iria para DESKTOP, TABLET e CONNECTED_TV),
    o contrário do pedido. Para trocar de dispositivo: INCLUDE do novo, depois EXCLUDE do antigo.
  - EXCLUDE de um positivo quando há outros: remove (requisição 1) + create negativo (requisição 2).
  - INCLUDE em campanha restrita: cria o positivo; se o dispositivo estava excluído, remove
    (requisição 1) + create positivo (requisição 2).
  - A resposta traz `targeted_before` e `targeted_after`.
- Demais campanhas: ajuste de lance da campanha (EXCLUDE = 0, INCLUDE = 1.0 só se estava em 0,
  BID_ADJUST = 0.1–10).
- Grupo de anúncios: `AdGroupBidModifierService` (`adGroupBidModifiers:mutate`), que sobrepõe o
  da campanha. INCLUDE remove o −100% do grupo (volta a valer o da campanha). Se a campanha exclui o
  dispositivo, o grupo não pode sobrepor (`CANNOT_OVERRIDE_OPTED_OUT_CAMPAIGN_CRITERION_BID_MODIFIER`)
  — recusa antes da API.
- Nunca deixa computador, celular e tablet todos excluídos.

### `set_frequency_cap` (write) — **só Display**
`campaignId`, `caps [{timeUnit DAY|WEEK|MONTH, cap, level? CAMPAIGN|AD_GROUP|AD_GROUP_AD,
timeLength?, eventType? IMPRESSION}]`, `mode` MERGE (padrão) | REPLACE, `confirm?`.
- Lê `campaign.frequency_caps` antes. MERGE troca/adiciona pela chave (level + eventType + timeUnit +
  timeLength) e `cap: 0` remove aquela chave; REPLACE define a lista inteira. Igual ao atual → nada.
- `updateMask: frequency_caps` (campo repetido: a lista inteira é substituída).
- Remover todos os limites exige `confirm: true`.
- Canal: **só Display**. `eventType` só aceita IMPRESSION (padrão). `cap` inteiro ≥ 1, `timeLength`
  ≥ 1 (padrão 1).
- **Vídeo é recusado antes de qualquer escrita** (inclusive em validateOnly): a documentação oficial
  diz "You cannot create new Video campaigns or update existing Video campaigns using the Google
  Ads API" (developers.google.com/google-ads/api/docs/video/overview, atualizada em 2026-09-10).
  `VIDEO_VIEW` saiu do schema de escrita (só existe em Vídeo) e, se vier mesmo assim, é recusado
  com esse motivo antes de qualquer chamada. O limite de Vídeo só muda na interface do Google Ads;
  a leitura continua em `get_frequency_report`.
- Demand Gen, Pesquisa, Shopping e PMax: recusado (não têm limite de frequência gravável aqui).

### `get_frequency_report` (read)
`campaignId?`, `dateRange/days`, `format`. Limites atuais + alcance real das campanhas Display,
Vídeo e Demand Gen: `unique_users` e `average_impression_frequency_per_user` (janela ≤ 92 dias) e
`unique_users_two_plus` … `ten_plus` (janela ≤ 31 dias), conforme os limites do `metrics.proto`.
Fora da janela, a métrica é omitida com nota (em vez do erro da API). Campanhas de Vídeo aparecem
com seus limites atuais e uma nota de que são só leitura (a API não altera Vídeo).

## Fluxos típicos

1. **Dayparting:** `get_time_performance` → `set_ad_schedule` (replace com os horários bons e
   ajustes) → `list_ad_schedules withMetrics` depois de alguns dias → `update_ad_schedule_bid`.
2. **Ajuste regional:** `list_bid_modifiers` → `set_location_bid_adjustment` na sub-região.
3. **Demografia:** `list_bid_modifiers` → `set_demographic_targeting` EXCLUDE/BID_ADJUST (validateOnly
   antes, se quiser) → `list_bid_modifiers` para conferir.
4. **Dispositivo:** `get_device_breakdown campaignId` → `set_device_targeting` (PMax: EXCLUDE;
   demais: BID_ADJUST na campanha ou no grupo).
5. **Frequência (Display):** `get_frequency_report` → `set_frequency_cap` → `get_frequency_report`.
   Vídeo: só `get_frequency_report`; a mudança é na interface do Google Ads.
6. **PMax só-celular → só-computador:** `set_device_targeting` INCLUDE DESKTOP → EXCLUDE MOBILE
   (a ordem inversa é recusada, porque ampliaria o alcance).

## O que ficou de fora / parcial

- **Item 75 (limite de frequência) — parcial: só Display.** A primeira versão do lote dizia que
  `set_frequency_cap` funcionava em "Display e Vídeo"; a parte de Vídeo nunca poderia gravar, porque
  a API do Google Ads não altera campanhas de Vídeo (ver `set_frequency_cap`). Vídeo agora é
  recusado com esse motivo, `VIDEO_VIEW` saiu do schema de escrita e a leitura dos limites de Vídeo
  ficou em `get_frequency_report`. Não há como gravar limite de Vídeo por este servidor.
- **Troca positivo ↔ negativo em duas requisições**: não é atômica por limitação da API (mesmo
  recurso duas vezes numa requisição é `ID_EXISTS_IN_MULTIPLE_MUTATES`). A janela de estado parcial
  é reportada com precisão e resolvida repetindo a chamada. Nenhuma das duas formas (uma ou duas
  requisições) foi testada ao vivo — não há credenciais aqui; a decisão vem do proto.

- **Métricas de frequência em `get_video_performance`**: essa tool não existe nesta base e não é
  deste lote; as métricas (`unique_users*`, frequência média) ficaram em `get_frequency_report`. Se o
  lote de vídeo criar `get_video_performance`, pode reaproveitar a mesma query.
- **Critérios de sistema operacional e modelo de aparelho** (`operating_system_version`,
  `mobile_device`): citados na análise, fora da proposta do item; não implementados.
- **Ajuste de lance demográfico no nível de campanha**: não oferecido (só exclusão/inclusão), por
  falta de documentação de que a campanha aceite bid_modifier para essas dimensões.
- **Janela de 37 meses de dados por hora**: não é validada na tool; a API recusa período mais antigo.
- O código exato da API ao criar um critério DEVICE que já existe não foi confirmado ao vivo (não há
  credenciais aqui); o upsert evita o caso de qualquer forma.
