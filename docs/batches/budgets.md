# Lote budgets — orçamentos, ritmo de gasto e grupos de campanhas

Módulo: `src/tools/budgets.ts` (`registerBudgetsTools`), catálogo `src/tools/budgets.catalog.ts`,
testes `tests/budgets.test.ts`. A tool existente `update_budget` continua registrada em
`src/tools.ts`, mas a lógica agora mora no módulo (`runUpdateBudget`, import dinâmico para não
mexer no bloco de imports de `tools.ts`).

Fontes conferidas (v25): `resources/campaign_budget.proto`, `resources/campaign_group.proto`,
`services/campaign_budget_service.proto`, `services/campaign_group_service.proto`,
`services/google_ads_service.proto` (IDs temporários no `googleAds:mutate`),
`errors/campaign_budget_error.proto`, `errors/campaign_error.proto`, `errors/bidding_error.proto`,
`enums/campaign_primary_status_reason.proto`, `enums/experiment_status.proto` e as páginas
*Campaign Budgets* (overview, create, share, assign, remove, track performance, restrictions &
errors) da documentação do Google Ads API. Toda query foi validada contra
`tests/fixtures/google-ads-v25-fields.json`.

## Tools

### update_budget — escrita (alterada)

Altera um orçamento: valor diário, valor total da campanha, nome ou compartilhamento.

- Identificação: `budgetResourceName` (resource name **ou** ID numérico) **ou** `campaignId`
  (usa o orçamento da campanha). Exatamente um dos dois.
- Lê antes de gravar: `period`, `amount_micros`, `total_amount_micros`, `explicitly_shared`,
  `reference_count`, `status`, `type` e as campanhas não removidas que usam o orçamento.
- `amountMicros` só em orçamento diário (`DAILY`); `totalAmountMicros` só em orçamento total da
  campanha (`CUSTOM_PERIOD`). Os dois campos são mutuamente exclusivos na API — antes a tool
  sempre gravava `amount_micros`, errado para orçamento total.
- Orçamento usado por mais de uma campanha: exige `confirmShared: true`; a resposta lista as
  campanhas afetadas.
- Aumento acima do dobro do valor atual: exige `confirm: true` (erro de digitação em micros).
- `makeShared: true`: torna o orçamento compartilhado (`explicitly_shared` false → true, com
  `name` na mesma operação, como a API exige). Irreversível → exige `confirm: true`. Recusa
  orçamento total, campanha com experimento e campanha em grupo de campanhas.
- `name`: só em orçamento compartilhado (o individual herda o nome da campanha); nome repetido
  é recusado antes de gravar.
- Valor igual ao atual = nenhuma escrita. `updateMask` só com as folhas alteradas.
- Valores precisam ser inteiros positivos múltiplos de 10000 micros (R$ 0,01).
- Erros da API traduzidos (mínimo diário, múltiplo da moeda, valor alto demais etc.).
- A descrição não cita mais a tool inexistente `google_run_gaql`.

### list_budgets — leitura (nova)

Inventário de `campaign_budget`: valor diário ou total, período, compartilhado ou não,
`reference_count`, campanhas que usam cada orçamento, recomendação do Google
(`recommended_budget_amount_micros` e estimativas semanais) e órfãos.
Parâmetros: `budgetId`, `sharedOnly`, `unusedOnly` (órfãos), `includeRemoved`, `format`
(json/table/csv).

### get_budget_pacing — leitura (nova)

Ritmo de gasto do mês por orçamento.

- Mês: `month` (YYYY-MM, default o atual). "Hoje" é a data no fuso da conta
  (`customer.time_zone`). Mês passado = fechamento; mês futuro é recusado.
- Por orçamento diário: gasto até ontem, gasto parcial de hoje (fora do ritmo), esperado até
  ontem, % do ritmo (`ABAIXO_DO_RITMO` < 90%, `NO_RITMO`, `ACIMA_DO_RITMO` > 110%), projeção de
  fim de mês (linear, limitada ao teto de cobrança de 30,4 × diário; o valor sem teto também
  vem), e quanto por dia falta para chegar na referência.
- Referência do mês: `monthlyTargets` (verba combinada, por `budgetId` ou por `campaignId` — a
  meta da campanha vale para o orçamento dela) ou, sem meta, diário × dias do mês limitado a
  30,4 × diário. Meta acima do teto de cobrança vira alerta.
- Orçamento total (`CUSTOM_PERIOD`): medido contra `total_amount_micros` e as datas de início e
  fim da campanha (gasto desde o início, esperado proporcional, projeção limitada ao total).
  `measured_through` diz até que dia o gasto foi contado. **Mês fechado**: a medição para no
  último dia do mês pedido — a query do acumulado vai só até lá e o esperado / % de ritmo /
  projeção são os do fechamento; gasto posterior ao mês não entra. Status do fechamento:
  `ENCERRADA` (campanha terminou até o fim do mês), `NAO_INICIADA` (começou depois) ou
  `MES_ENCERRADO` (seguia rodando), nunca o status de hoje. `spend_month_to_date` do orçamento
  total é sempre o gasto dentro do mês; o acumulado fica em `pacing.spend_since_start`.
- Tabela/CSV: a coluna `spend` é o gasto dentro do mês em **toda** linha (diário ou total); a
  coluna `spend_since_start` traz o acumulado dos orçamentos totais (base do `expected`,
  `pace_pct` e `projected` deles) e fica vazia nos diários.
- Por campanha do orçamento: gasto do mês, `search_budget_lost_impression_share`,
  `content_budget_lost_impression_share`, `search_impression_share`, e o motivo
  `BUDGET_CONSTRAINED` / `BUDGET_MISCONFIGURED` de `campaign.primary_status_reasons`.
- Resumo da conta: orçamento diário ativo, gasto do mês, projeção linear e, com
  `accountMonthlyTargetMicros`, ritmo e diário necessário para a verba da conta.
- `campaignId` / `budgetId` restringem a um orçamento (compartilhado mostra todas as campanhas).
- `accountMonthlyTargetMicros` **não combina** com `campaignId`/`budgetId` (recusado antes de
  qualquer consulta): com filtro, o resumo soma só o gasto do orçamento filtrado e o ritmo /
  diário necessário da conta sairiam errados. Para a meta de um orçamento ou campanha, use
  `monthlyTargets`.

### create_shared_budget — escrita (nova)

Cria orçamento diário compartilhado (`explicitly_shared: true`, `period: DAILY`,
`delivery_method: STANDARD`). Com `campaignIds`, orçamento e campanhas vão num único
`googleAds:mutate` atômico (orçamento com ID temporário `-1`) — exige `confirm: true`; sem ele
devolve a prévia. Recusa antes de gravar: nome já usado, campanha removida, de rascunho ou
experimento, com experimento ativo, em grupo de campanhas, ou com orçamento total.

### assign_budget — escrita (nova)

Troca o orçamento de campanhas existentes para um orçamento que já existe. Sem `confirm: true`
devolve a prévia (antes/depois). Com confirmação grava só `campaign.campaign_budget`, com
`partialFailure` e relatório por campanha. Recusas por campanha, antes de gravar:

- removida, de rascunho ou experimento;
- experimento rodando/agendado (`ENABLED`/`INITIATED` — `CANNOT_CHANGE_BUDGET_ON_CAMPAIGN_WITH_TRIALS`);
  com experimento em montagem (`SETUP`) só é recusada se o destino for compartilhado;
- período diferente (diário × total — `CANNOT_CHANGE_BUDGET_PERIOD`);
- tipo de orçamento diferente (`INCOMPATIBLE_BUDGET_TYPE`);
- destino compartilhado e campanha em grupo de campanhas
  (`CANNOT_USE_SHARED_CAMPAIGN_BUDGET_WHILE_PART_OF_CAMPAIGN_GROUP`);
- destino alinhado a estratégia de portfólio e campanha com outra estratégia;
- destino individual que ficaria com mais de uma campanha (a tool recusa a chamada inteira).

Destino total (`CUSTOM_PERIOD`) é recusado (não é compartilhável). Campanha que já usa o
destino é pulada. A resposta avisa que trocar orçamento no meio do mês pode fazer a campanha
gastar mais no mês (recomendação da documentação do Google) e lista os orçamentos que podem
ter ficado órfãos.

### remove_budget — escrita (nova)

Remove orçamentos sem campanha. `confirm: true` obrigatório. Recusa orçamento em uso
(`reference_count > 0` ou campanha não removida → `CAMPAIGN_BUDGET_IN_USE`) e orçamento alinhado
a estratégia de portfólio (só sai junto com ela). Já removido é pulado. Várias remoções com
`partialFailure` e relatório por item.

### get_campaign_group_performance — leitura (nova)

Grupos de campanhas ativos (ou um, por `campaignGroupId`), as campanhas de cada um e o
desempenho somado no período (`dateRange`/`days`): impressões, cliques, CTR, gasto, CPC,
conversões, CPA, valor, ROAS. Sem filtro, soma à parte as campanhas sem grupo. Os grupos são
lidos sem filtro de status: campanha que ainda aponta para um grupo **removido** (por exemplo,
campanha REMOVED com histórico, que `remove_campaign_group` deixa ligada ao grupo) vira um balde
com o nome e o status `REMOVED` do grupo; grupo que nem aparece na leitura vira
`(grupo não encontrado)`. Grupo removido sem campanha não aparece. Cada campanha cai em um balde
só, então os baldes somam o total da conta no período (o cabeçalho traz esse total). As métricas vêm
de `FROM campaign` agregadas por `campaign.campaign_group`: `FROM campaign_group` só expõe
`average_cost`, `conversions` e `cost_per_conversion` na v25.

### create_campaign_group — escrita (nova)

Cria o grupo (`campaignGroups:mutate`) ou, com `campaignIds`, grupo + campanhas num
`googleAds:mutate` atômico (grupo com ID temporário). Recusa nome repetido e campanha com
orçamento compartilhado (regra da API).

### update_campaign_group — escrita (nova)

Renomeia o grupo. Mesmo nome = nenhuma escrita; nome repetido é recusado.

### remove_campaign_group — escrita (nova)

Remove grupo vazio, com `confirm: true`. Grupo com campanhas é recusado e as campanhas são
listadas (tire antes com `assign_campaign_group`). Essa recusa é política desta tool — a
documentação não diz o que acontece com as campanhas de um grupo removido. Campanhas já
REMOVED não contam (não dá para editá-las) e continuam apontando para o grupo; o histórico delas
segue aparecendo em `get_campaign_group_performance`, no balde do grupo removido.

### assign_campaign_group — escrita (nova)

Coloca campanhas num grupo, ou tira (`campaignGroupId: null` → `campaign_group` na máscara sem
valor, o que limpa o campo). `partialFailure` com relatório por campanha; no-op é pulado;
campanha com orçamento compartilhado é recusada.

Todas as tools de escrita aceitam `validateOnly` (nenhuma é encadeada: as que criam e ligam
usam um único `googleAds:mutate`) e respeitam o dry-run global — nunca dizem que gravaram.

## Fluxos

1. **Pacing semanal do cliente**: `get_budget_pacing` com `monthlyTargets` (verba por
   orçamento/campanha) e `accountMonthlyTargetMicros`. O `daily_needed_to_reach_reference` de
   cada orçamento é o valor para `update_budget`.
2. **Consolidar campanhas num orçamento compartilhado por linha de produto**:
   `list_budgets` → `create_shared_budget` com `campaignIds` e `confirm: true` (atômico), ou
   `update_budget makeShared` num orçamento existente + `assign_budget` → `list_budgets
   unusedOnly: true` → `remove_budget` dos órfãos.
3. **Campanha nova num orçamento compartilhado**: as tools `create_*` ainda criam um orçamento
   individual (ver abaixo). Crie a campanha, depois `assign_budget` para o compartilhado e
   `remove_budget` do individual que sobrou.
4. **Grupos para relatório**: `create_campaign_group` (com campanhas) →
   `get_campaign_group_performance`. Grupo e orçamento compartilhado não convivem na mesma
   campanha.

## Parcial / fora do lote

- **Parâmetro `campaignBudget` nas tools `create_*`** (proposta do item 37): não feito. As tools
  de criação (`create_campaign`, `create_display_campaign`, `create_video_campaign`,
  `create_shopping_campaign`, `create_demand_gen_campaign`, `create_pmax_campaign`) não são deste
  lote (a regra de posse só libera `update_budget` em `src/tools.ts`). O fluxo 3 cobre o caso até
  os donos dessas tools aceitarem um orçamento existente.
- **`google_run_gaql` em `src/prompts.ts:97`**: a verificação independente apontou que o prompt
  também cita a tool inexistente; `src/prompts.ts` é do lote account-auth. Corrigido só na
  descrição de `update_budget`; o prompt fica para o integrador/lote account-auth.
- **Estratégias incompatíveis com orçamento compartilhado**: a API tem
  `BIDDING_STRATEGY_TYPE_INCOMPATIBLE_WITH_SHARED_BUDGET`, mas nem o proto nem a documentação da
  API listam quais estratégias. A tool não inventa a lista: o erro vem traduzido por campanha.
- **Histórico de valores do orçamento**: o esperado do pacing usa o valor atual de cada
  orçamento; mudanças feitas durante o mês não são reconstruídas (daria para ler `change_event`,
  mas ele só cobre 29 dias e não é deste lote). A resposta avisa.
- **Pacing só no nível de orçamento**: meta por campanha num orçamento compartilhado vale para o
  orçamento inteiro (a resposta avisa); não há pacing por campanha dentro de um compartilhado.

## Testes

`tests/budgets.test.ts` (47 casos): o client falso valida toda query contra os metadados reais da
v25 (`assertGaqlRules`) e filtra os dados pelo WHERE. Checagem de mutação (guarda quebrada de
propósito → teste falha → código restaurado) feita também nas correções da revisão:

- orçamento total em mês fechado: query do acumulado até o fim do mês, `asOf` do fechamento,
  status `MES_ENCERRADO`/`NAO_INICIADA` do fechamento e coluna `spend` da tabela/CSV;
- recusa de `accountMonthlyTargetMicros` com `campaignId`/`budgetId`;
- `get_campaign_group_performance`: leitura de grupos sem filtro de status e balde de grupo
  removido / não encontrado;
- experimento em `SETUP` (inclusive campanha em `in_design_campaigns`) com destino
  compartilhado em `assign_budget` / `create_shared_budget` / `update_budget makeShared`;
- `remove_budget` de órfão alinhado a estratégia de portfólio.
