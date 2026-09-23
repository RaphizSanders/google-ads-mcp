# Lote bidding — estratégias de lance, simulações, sazonalidade e datas de campanha

Módulo `src/tools/bidding.ts` (catálogo em `src/tools/bidding.catalog.ts`) e as tools do núcleo
`create_campaign`, `update_campaign`, `update_ad_group`, `delete_campaign` e `delete_ad_group`
(`src/tools.ts`). Testes em `tests/bidding.test.ts` (49 casos, todo GAQL validado contra os
metadados reais da v25).

As duas tools do núcleo que usam as regras de data / orçamento total (`create_campaign` e
`update_campaign`) carregam os helpers do módulo com `await import("./tools/bidding.js")` dentro da
própria implementação — não há import no topo de `src/tools.ts` (só as implementações das tools
do lote foram alteradas ali).

## Status dos itens

| Item | Status | O que falta e por quê |
|------|--------|------------------------|
| 41 — simulações de lance | feito | — |
| 46 — sazonalidade e exclusão de dados | feito | A proposta pedia `confirm` acima de 14 dias; o proto limita a janela a (0, 14 dias], então acima disso a tool recusa (não há o que confirmar). |
| 47 — portfólios e estratégias de MCC | **parcial** | Feitos: `list_bidding_strategies`, `create_bidding_strategy`, `update_bidding_strategy`, `assign_bidding_strategy`, `remove_bidding_strategy`. **Não feito:** mostrar a estratégia efetiva e o status do lance de cada campanha em `diagnose_campaigns` — a tool é do lote diagnostics e este lote não pode alterá-la. Substituto disponível: `list_bidding_strategies` (`system_status` por campanha e `includeStandardCampaigns`). |
| 64 — overrides de alvo por grupo | **parcial** | Feitos: `targetRoas`, `clearTargetCpa`, `clearTargetRoas` e recusa sob portfólio em `update_ad_group`, mais `get_ad_group_bid_targets`. **Não feito:** alvos efetivos e origem em `get_ad_group_performance` — a tool é de outro lote. Substitutos: `get_ad_group_bid_targets` e `effective_targets_before` na resposta do `update_ad_group`. |
| 82 — orçamento total e datas de campanha | **parcial** | Feito em `create_campaign` e `update_campaign`. **Não feito:** `create_pmax_campaign`, `create_shopping_campaign` e `create_demand_gen_campaign` (outros lotes) — ver "Parcial / limites". |

Tudo conferido nos protos oficiais da v25 (`resources/*_simulation`, `common/simulation`,
`bidding_seasonality_adjustment`, `bidding_data_exclusion`, `bidding_strategy`,
`accessible_bidding_strategy`, `campaign_budget`, `campaign`, `ad_group`, `common/bidding`,
`errors/campaign_error`, `errors/bidding_strategy_error`) e nas páginas de docs:
bid-simulations (overview, prerequisites, retrieve), campaigns/bidding (seasonality-adjustments,
data-exclusions, assign-strategies, cross-account-strategies, override-strategies),
campaigns/budgets (overview, create-budgets), Ajuda do Google Ads 15137812 (duração do orçamento
total) e o blog de 16/06/2026 sobre a nomenclatura do Smart Bidding.

## Tools novas

### `get_bid_simulations` — leitura
Simulações de lance do Google (what-if) normalizadas.
- `level`: `CAMPAIGN` (`campaignId`), `AD_GROUP` (`adGroupId`), `KEYWORD` (`adGroupId` e, opcional,
  `criterionId` — sem ele traz todas as palavras do grupo), `PORTFOLIO` (`biddingStrategyId`).
- `type` (opcional) validado contra o nível: CAMPAIGN — CPC_BID, TARGET_CPA, TARGET_ROAS,
  TARGET_IMPRESSION_SHARE, BUDGET; AD_GROUP — CPC_BID, CPV_BID, TARGET_CPA, TARGET_ROAS;
  KEYWORD — CPC_BID, PERCENT_CPC_BID; PORTFOLIO — TARGET_CPA, TARGET_ROAS. `modificationMethod`
  opcional (UNIFORM, DEFAULT, SCALING).
- Cada ponto: valor de entrada já no parâmetro da tool de escrita (`targetCpaMicros`, `targetRoas`,
  `amountMicros`, `cpcBidMicros`, `locationFractionMicros`; `scaling_modifier` em SCALING), custo,
  cliques, impressões, conversões, valor, CPA e ROAS implícitos, orçamento / teto de CPC exigidos
  quando a API informa, e deltas contra o ponto atual (marcado `atual`, ou `mais próximo do atual`).
- Cada simulação traz período (`date_range`, sempre no passado), valor atual e `how_to_apply`
  (update_campaign / update_budget / update_ad_group / update_keyword / update_bidding_strategy).
- `how_to_apply` depende do método. Em **SCALING** (Pesquisa: CPC_BID e TARGET_CPA da campanha) o ponto
  não tem valor absoluto, só `scaling_modifier` (`target_cpa_scaling_modifier` /
  `cpc_bid_scaling_modifier` em `common/simulation.proto`), e o fator vale para o alvo da campanha **e**
  para os alvos próprios dos grupos (`SimulationModificationMethod.SCALING`). Com CPA alvo atual, cada
  ponto ganha `scaled_targetCpaMicros` = round(atual × fator), ao centavo, e o hint manda usar esse
  campo em `update_campaign` (ou multiplicar o alvo do portfólio em `update_bidding_strategy`) e
  multiplicar também os overrides dos grupos. Sem CPA alvo atual, o hint diz que não há valor absoluto
  para aplicar, em vez de citar um campo que o ponto não tem.
- `format`: json (agrupado por simulação), table ou csv (um ponto por linha).
- Limites: não existe em conta de teste nem para entidade sem histórico; em Pesquisa com expansão
  para Display cobre só a rede de Pesquisa. Sem simulação a tool explica os motivos (não é erro).

### `list_bidding_adjustments` — leitura
Ajustes de sazonalidade e exclusões de dados, com `timing` UPCOMING / ACTIVE / PAST pelo relógio da
conta (fuso de `customer.time_zone`), escopo, campanhas (com nome), canais, dispositivos e
modificador. Filtros `kind`, `timing`, `includeRemoved`; `format` json/table/csv.

### `create_seasonality_adjustment` — escrita
Avisa o Smart Bidding de uma mudança de taxa de conversão num evento futuro curto.
- `scope` CAMPAIGN (`campaignIds`, até 2000) ou CHANNEL (`channels`: SEARCH, SHOPPING, DISPLAY);
  nunca os dois. `devices` opcional (MOBILE, TABLET, DESKTOP; vazio = todos).
- `startDateTime` / `endDateTime` no fuso da conta; o fim é EXCLUSIVO na API — só a data inclui o
  dia inteiro (vira o dia seguinte 00:00:00).
- `conversionRateModifier` de 0.1 a 10.0 (1.0 é recusado: não ajusta nada).
- Recusa antes de gravar: janela > 14 dias (limite do proto), início no passado, conta MCC, nome
  repetido, campanha inexistente/removida. Avisa: janela > 7 dias (o Google recomenda 1–7),
  modificador agressivo (≥ 2 ou ≤ 0.5), sobreposição com outro ajuste, campanha sem Smart Bidding.

### `create_data_exclusion` — escrita
Faz o Smart Bidding ignorar as conversões de um período com problema (tag/GTM quebrado, pixel
duplicado). Mesmo escopo/dispositivos. Início precisa estar no passado; o fim pode estar no futuro
(avisa). Janela até 14 dias; até 500 exclusões ativas por conta (recusa antes de enviar); não existe
em MCC.

### `update_bidding_adjustment` — escrita
Altera nome, descrição, datas, modificador (só SEASONALITY), dispositivos (`[]` = todos), campanhas
(só escopo CAMPAIGN) ou canais (só escopo CHANNEL). updateMask só com o que muda; no-op sem
escrita. O escopo não muda (remova e crie outro). Sazonalidade que já terminou não é alterada;
ajuste removido não é alterado; renomear para um nome já usado por outro ajuste ativo do mesmo tipo
é recusado; mover o início para o passado ou passar de 14 dias é recusado.

### `remove_bidding_adjustments` — escrita (exige `confirm: true`)
Remove por IDs com partialFailure e relatório por item (removidos, não encontrados, já removidos,
erros).

### `list_bidding_strategies` — leitura
Portfólios da conta (`bidding_strategy`) e, com `includeManagerOwned` (default true), os de MCC
compartilhados (`accessible_bidding_strategy` com `owner_customer_id != conta`). Para cada um:
tipo, alvos, teto/piso, parcela de impressões, moeda, orçamento alinhado, campanhas que o usam com
`bidding_strategy_system_status` (LEARNING_*, LIMITED_*...). `includeStandardCampaigns` lista também
as campanhas com estratégia padrão e seus alvos. Quando há MAXIMIZE_* com alvo embutido, anexa a
orientação do Google de jun/2026 (Target CPA / Target ROAS standalone em Pesquisa).

### `create_bidding_strategy` — escrita
Cria portfólio TARGET_SPEND, MAXIMIZE_CONVERSIONS, MAXIMIZE_CONVERSION_VALUE, TARGET_CPA, TARGET_ROAS
ou TARGET_IMPRESSION_SHARE, com os parâmetros de cada esquema (`targetCpaMicros`, `targetRoas`
0.01–1000, `cpcBidCeilingMicros`, `cpcBidFloorMicros`, `targetImpressionShareLocation`,
`locationFractionMicros`). Recusa parâmetro de outro tipo, obrigatório ausente, piso > teto e nome
repetido. `currencyCode` só em MCC (estratégia de MCC; imutável depois). Não mexe em campanha.

### `update_bidding_strategy` — escrita
Altera nome e parâmetros com updateMask por folha (ex.: `target_roas.target_roas`); o tipo é
imutável. `clearTarget` remove o alvo opcional de MAXIMIZE_*. Portfólio com mais de uma campanha
ativa exige `confirm: true` (sem ele devolve a prévia e não grava). Estratégia de MCC: chamar com o
customerId do MCC dono.

### `assign_bidding_strategy` — escrita
Vincula campanhas (até 100) a um portfólio da conta ou de MCC (dono descoberto pelo
`accessible_bidding_strategy`). Sem `confirm: true` mostra a prévia antes → depois; com confirm
envia `campaign.bidding_strategy` (updateMask `bidding_strategy`) com partialFailure. Pula as que já
usam o portfólio; recusa campanha inexistente/removida e campanha fora do orçamento alinhado ao
portfólio. Para voltar a estratégia padrão: `update_campaign` com `biddingStrategy`.

### `remove_bidding_strategy` — escrita (exige `confirm: true`)
Remove portfólio sem campanhas ativas (com campanhas a API recusa com
CANNOT_REMOVE_ASSOCIATED_STRATEGY — a tool recusa antes).

### `get_ad_group_bid_targets` — leitura
Por grupo: CPC e CPC efetivo, CPA alvo e ROAS alvo do grupo (override) ao lado do efetivo e da
origem (`effective_target_*_source`), e a estratégia da campanha. Filtros `campaignId`,
`adGroupIds`, `onlyOverrides`, `limit`; `format` json/table/csv.

## Tools existentes alteradas

- **`create_campaign`**: `budgetType` DAILY (padrão) | TOTAL, `totalAmountMicros`,
  `startDateTime`, `endDateTime` (`dailyBudgetMicros` passou a opcional, obrigatório com DAILY).
  TOTAL cria `period: CUSTOM_PERIOD` + `totalAmountMicros` (não compartilhado) e exige início e fim;
  valida canal (SEARCH, PERFORMANCE_MAX, DEMAND_GEN — DISPLAY não tem), estratégia permitida por
  canal e duração (Pesquisa/PMax até 90 dias, Demand Gen até 1 ano; abaixo do mínimo só avisa)
  ANTES de criar qualquer coisa. Datas em qualquer tipo de orçamento. **No passado = dia anterior a
  hoje** no fuso da conta: `startDateTime` só com a data de hoje vira `hoje 00:00:00`, que o proto
  define como granularidade diária ("Set the time component to 00:00:00 for daily granularity") —
  é o jeito de dizer "começa hoje" e é aceito mesmo depois da meia-noite, o que permite flight com
  orçamento total começando no mesmo dia. Horário explícito no próprio dia vai para a API (que tem o
  relógio de referência e sabe se o tipo de campanha aceita horário). Com orçamento total a mensagem
  de data passada não sugere omitir o início (é obrigatório). Sem datas, nada muda no fluxo antigo
  (não lê a conta).
- **`update_campaign`**: `startDateTime`, `endDateTime`, `clearEndDateTime`. Recusa mudar o início de
  campanha que já começou, data de dia anterior a hoje (a data de hoje vale — mesma regra do
  `create_campaign`), fim antes do início efetivo (o novo ou o atual), remover o fim com orçamento
  total e duração acima do limite do orçamento total. Limpar o fim = `end_date_time` no updateMask
  sem valor.
- **`update_ad_group`**: `targetRoas` (0.01–1000), `clearTargetCpa`, `clearTargetRoas` (updateMask
  sem valor). ROAS por grupo em campanha de portfólio é recusado antes da API. Avisa quando o alvo do
  grupo é ignorado pela estratégia da campanha. A resposta traz `effective_targets_before` (alvo
  efetivo e origem). Erro da API agora volta traduzido, com o que foi tentado.
- **`delete_campaign` / `delete_ad_group`**: ID numérico obrigatório, leitura antes (confirma que é
  da conta e mostra nome/status), no-op sem escrita quando já removido, erro da API traduzido e
  resposta de dry-run que não afirma remoção.

## Correções pós-revisão

- `create_campaign` / `update_campaign`: "no passado" passou a ser **dia anterior a hoje** no fuso da
  conta. Antes, só a data de hoje virava `hoje 00:00:00` e era recusada como passada — um flight com
  orçamento total começando no mesmo dia era impossível, e a mensagem sugeria omitir o início, que é
  obrigatório com TOTAL. Agora a mensagem depende do tipo de orçamento.
- `get_bid_simulations`: `how_to_apply` de simulação SCALING não cita mais `targetCpaMicros` do ponto
  (que não existe em SCALING); explica o multiplicador, os overrides dos grupos e usa
  `scaled_targetCpaMicros`.
- Testes novos (mutation check: cada guarda abaixo desligada faz a suíte falhar): conflito de nome e
  ajuste removido em `update_bidding_adjustment`; início no passado e fim antes do início atual em
  campanha que ainda não começou (`update_campaign`); começar hoje em `create_campaign` e
  `update_campaign`; hints SCALING (campanha, portfólio, sem alvo, CPC).
- `src/tools.ts`: o import de módulo no topo foi retirado; as tools do lote carregam os helpers com
  import dinâmico dentro da própria implementação.
- Status dos itens 47, 64 e 82 rebaixado para **parcial** (tabela acima): partes que dependem de
  tools de outros lotes não foram entregues.

## Fluxos

- **Black Friday**: `get_bid_simulations` (TARGET_ROAS / BUDGET da campanha) → `update_campaign` /
  `update_budget` com o valor do ponto → `create_seasonality_adjustment` para os dias do evento →
  `list_bidding_adjustments` para conferir.
- **Flight promocional com orçamento total**: `create_campaign` com `budgetType: TOTAL`,
  `totalAmountMicros`, `startDateTime` (a data de hoje = começa hoje), `endDateTime` → ajustar fim
  com `update_campaign`.
- **Tag quebrada**: `create_data_exclusion` com o período da falha (fim pode ser futuro até o
  conserto) → `remove_bidding_adjustments` se a exclusão foi criada por engano.
- **Portfólio**: `create_bidding_strategy` → `assign_bidding_strategy` (prévia, depois
  `confirm: true`) → `update_bidding_strategy` → `list_bidding_strategies`.
- **Override por grupo**: `get_ad_group_bid_targets` → `update_ad_group` (`targetRoas` /
  `clearTargetRoas`).

## Parcial / limites e por quê

- **Orçamento total nas outras tools de criação**: `create_pmax_campaign`,
  `create_shopping_campaign` e `create_demand_gen_campaign` são de outros lotes — não foram tocadas.
  `create_campaign` cobre SEARCH, PERFORMANCE_MAX (casca) e DEMAND_GEN; Shopping com orçamento total
  só será possível quando o dono de `create_shopping_campaign` usar os helpers exportados
  (`checkTotalBudgetFlight`, `TOTAL_BUDGET_RULES`, `parseAdsDateTime`, `beforeAccountToday`,
  `readAccountInfo`).
- **`update_budget`** (lote budgets) grava `amount_micros`; num orçamento CUSTOM_PERIOD o campo certo
  é `total_amount_micros`.
- **Item 64 fica parcial — `get_ad_group_performance`** (outro lote) não ganhou os alvos efetivos; a
  mesma informação está em `get_ad_group_bid_targets` e na resposta do `update_ad_group`.
- **Item 47 fica parcial — `diagnose_campaigns`** (lote diagnostics) não foi tocada; o status do lance
  por campanha está em `list_bidding_strategies` (`system_status`, e `includeStandardCampaigns`).
- **"Começa hoje" (`hoje 00:00:00`)** segue a orientação do proto para granularidade diária, mas não
  foi confirmado contra a API real (não há credenciais neste ambiente). Se a API recusar, a operação é
  atômica: nada é criado e o erro volta traduzido.
- **Estratégia de MCC**: vincular/alterar exige o login-customer-id do MCC dono (configuração do
  servidor, não da tool) e mesma moeda da campanha — a tool explica o erro, mas não troca o login.
  A moeda de uma estratégia de MCC não é legível pela conta cliente, então não é pré-checada.
- **Alinhamento orçamento ↔ portfólio** (`aligned_campaign_budget_id`) é respeitado no vínculo, mas
  não há tool para criar/desfazer o alinhamento.
- **Dispositivos** de sazonalidade/exclusão limitados a MOBILE, TABLET e DESKTOP (os que as docs
  descrevem); o escopo CUSTOMER é só leitura na API.
- **Duração mínima do orçamento total** (3 dias em Pesquisa/PMax/Shopping, 7 em Demand Gen) é só
  aviso: a doc de ajuda cita o mínimo, mas não há código de erro da API para ele.
