# Lote conversions-core — Ações e metas de conversão

Módulo: `src/tools/conversions-core.ts` (catálogo em `src/tools/conversions-core.catalog.ts`).
Testes: `tests/conversions-core.test.ts`.

## Conta de conversão (base de tudo)

Com **acompanhamento de conversões entre contas** (conversões gerenciadas na MCC), a API exige
o ID da **conta de conversão** (`customer.conversion_tracking_setting.google_ads_conversion_customer`)
como `customer_id` para criar e gerenciar ações de conversão, metas da conta
(`CustomerConversionGoal`) e metas personalizadas (`CustomConversionGoal`). As metas por campanha
(`CampaignConversionGoal`, `ConversionGoalCampaignConfig`) continuam na conta da campanha.
Fontes: `conversions/getting-started` e `conversions/goals/overview` (developers.google.com) e os
protos v25 de `customer`, `conversion_action` e das metas.

- O módulo lê essa configuração uma vez por sessão (cache de 10 min por conta; a
  `get_conversion_tracking_settings` e a `audit_conversion_tracking` sempre releem).
- Toda gravação de ação, meta da conta ou meta personalizada vai para a conta de conversão. Se ela
  não estiver em `ALLOWED_CUSTOMER_IDS`, a tool recusa **antes de enviar** e diz o que fazer.
- Edição de ação existente vai para a conta **dona** da ação (`conversion_action.owner_customer`).
  Ação da MCC é **compartilhada**: vale para todas as contas que usam a MCC como conta de conversão,
  por isso `update_conversion_action` exige `confirm: true` nela (ver abaixo).
- Toda resposta de escrita diz qual conta foi usada.
- Quando a conta de conversão é uma MCC diferente da do login (`CONVERSION_TRACKING_MANAGED_BY_ANOTHER_MANAGER`),
  a resposta avisa que a API pode recusar por permissão.
- Helpers exportados para outros lotes: `resolveConversionCustomer(client, customerId)`,
  `createConversionCustomerCache()`, `conversionWriteTarget(info, allowlist, hosted)`,
  `explainConversionError(msg)`.

## Tools novas

### get_conversion_tracking_settings — leitura
Configuração de acompanhamento da conta: conta de conversão, `conversion_tracking_status`, IDs de
acompanhamento (o `cross_account_conversion_tracking_id` sobrepõe o da conta), ID `AW-` em uso,
termos de dados do cliente, conversões otimizadas para leads, Google tag da conta
(`customer.remarketing_setting.google_global_site_tag`) e se a conta de conversão está liberada no
allowlist. Parâmetros: `customerId`.
(Substitui a sugestão de pôr `conversion_tracking_setting.*` em `get_account_info`, que não é deste lote.)

### get_conversion_tag — leitura
Tag de instalação de uma ação (`conversion_action.tag_snippets`): Google tag, event snippet, o
`send_to` `AW-ID/rótulo` separado em **ID de conversão** e **rótulo** (campos do GTM) e passos de
instalação (página de confirmação ou clique, Vinculador de conversões, e `value`/`currency`/
`transaction_id` em compras). Parâmetros: `customerId`, `conversionActionId`, `pageFormat`
(HTML|AMP, padrão HTML), `trigger` (PAGE_LOAD → snippet WEBPAGE; CLICK → WEBPAGE_ONCLICK).
Ações de chamada do site usam o snippet WEBSITE_CALL; CLICK_TO_CALL o seu. Importações
(UPLOAD_*), AD_CALL e GA4 não têm tag — a tool explica. Avisa se o `AW-` do snippet diferir do ID
em uso na conta.

### list_conversion_goals — leitura
- Metas da conta (categoria × origem, `biddable`) com as ações primárias e secundárias de cada uma.
- Metas personalizadas ativas e suas ações.
- Por campanha: `goal_config_level` (CUSTOMER = herda as metas da conta; CAMPAIGN = metas próprias),
  meta personalizada em uso, metas da campanha e **as ações que de fato guiam o lance** (ação ENABLED
  + primária + meta biddable no nível que a campanha usa; ou as ações da meta personalizada, que
  valem mesmo secundárias).
Parâmetros: `customerId`, `campaignId?`, `format` (json|table|csv).
Metas da conta e personalizadas são lidas na conta de conversão; se ela estiver fora do allowlist
ou a leitura falhar, lê na conta cliente e avisa.

### audit_conversion_tracking — leitura
Bloco da conta + tabela por ação (configuração e conversões do período, último evento recebido) e
alertas por regra, ordenados por severidade:

| código | severidade | regra |
|---|---|---|
| SEM_ACOMPANHAMENTO | alta | `NOT_CONVERSION_TRACKED` |
| PRIMARIA_SEM_CONVERSOES | alta | ação ENABLED primária com 0 `all_conversions` no período |
| COMPRA_PRIMARIA_DUPLICADA | alta | mais de uma PURCHASE primária (destaca GA4 + tag juntos) |
| COMPRA_UMA_POR_CLIQUE | média | PURCHASE com ONE_PER_CLICK |
| COMPRA_SEM_VALOR | média | PURCHASE com valor fixo zerado ou conversões com valor 0 |
| MODELO_DADOS_INDISPONIVEL | média | DATA_DRIVEN com modelo STALE/EXPIRED/NEVER_GENERATED |
| MICRO_CONVERSAO_PRIMARIA | média | PAGE_VIEW/ADD_TO_CART/BEGIN_CHECKOUT/ENGAGEMENT primária |
| META_DA_CONTA_MICRO_BIDDABLE | média | meta da conta de micro-conversão com biddable=true |
| ECL_DESLIGADO | média | UPLOAD_CLICKS ativo e conversões otimizadas para leads desligadas |
| TERMOS_DADOS_CLIENTE | média/info | termos de dados do cliente não aceitos |
| GA4_NAO_IMPORTADO | info | eventos GA4 vinculados e não importados (status HIDDEN) |
| TAG_PARADA | média | primária sem evento recebido há 7+ dias |
| CONVERSOES_NA_MCC | info | conversões gerenciadas em outra conta |

Parâmetros: `customerId`, `days` (padrão 30) ou `dateRange`, `format`. Métricas por ação vêm de
`FROM customer` segmentado por `segments.conversion_action`; o último evento vem de
`metrics.conversion_last_received_request_date_time`. Se qualquer uma dessas leituras falhar, vira
aviso, não erro: a auditoria de configuração sai de qualquer jeito.

**Auditoria numa MCC** (caso comum: a conta de conversão do acompanhamento entre contas). A API
recusa métricas em conta de administrador (`QueryError.REQUESTED_METRICS_FOR_MANAGER`, v25
`errors/query_error.proto`). Quando `customer.manager = true`, a tool não pede métricas e devolve só
a auditoria de configuração (ONE_PER_CLICK, valor fixo zerado, DDA, micro-conversões primárias,
metas de micro biddable, ECL, termos de dados, GA4 HIDDEN), com um aviso dizendo que o volume de
conversões se audita em cada conta cliente. As regras de volume (PRIMARIA_SEM_CONVERSOES, TAG_PARADA
e a parte de valor de COMPRA_SEM_VALOR) **não são avaliadas**, em vez de virarem zero, e as colunas de
conversão da tabela vêm `null`. O bloco `conta` traz `mcc` e `metricas_lidas`. Nos formatos
`table`/`csv` os avisos aparecem no topo como `[aviso] ...`.

### set_account_conversion_goals — escrita (exige `confirm: true`)
Liga/desliga `biddable` das metas da conta (`CustomerConversionGoal`, `customerConversionGoals:mutate`
na conta de conversão, `updateMask: biddable`). Sem `confirm` devolve a prévia: o que muda e
quantas campanhas herdam as metas da conta (e, com MCC, que as outras contas da MCC também mudam).
Só pares que existem; pares sem mudança não são enviados; par repetido é recusado. O serviço não
tem `partial_failure`: a chamada é atômica.

### create_custom_conversion_goal — escrita
Cria `CustomConversionGoal` na conta de conversão com `name`, `conversionActions` (resource names da
conta de conversão) e `status: ENABLED`. Antes: confere que as ações existem e estão ENABLED, e que
não há meta com o mesmo nome ou exatamente as mesmas ações. Parâmetros: `customerId`, `name`,
`conversionActionIds[]`. Próximo passo: `set_campaign_goal_config`.

### update_custom_conversion_goal — escrita (remoção exige `confirm: true`)
Renomeia (`name`), substitui a lista (`conversionActionIds`) ou inclui/tira ações
(`addConversionActionIds` / `removeConversionActionIds`, `updateMask: conversion_actions` com a lista
inteira), ou remove (`remove: true`, operação `remove`). Recusa remover meta em uso por campanha
(a API devolveria `CANNOT_REMOVE_LINKED_CUSTOM_CONVERSION_GOAL`), lista as campanhas afetadas quando
as ações mudam e não grava quando nada muda.

### set_campaign_goal_config — escrita (reset exige `confirm: true`)
`ConversionGoalCampaignConfig` da campanha (conta da campanha):
- `customConversionGoalId` → `custom_conversion_goal = customers/{conta de conversão}/customConversionGoals/{id}`
  (`updateMask: custom_conversion_goal`); confere que a meta existe e está ENABLED.
- `resetToAccountDefaults: true` → `goal_config_level = CUSTOMER` (`updateMask: goal_config_level`);
  a prévia lista as metas próprias que seriam descartadas.
Sem mudança, nada é enviado. Depois de gravar, relê a configuração e mostra o que a API devolveu.

## Tools existentes alteradas (agora registradas no módulo)

As quatro saíram de `src/tools.ts` (ficou um comentário no lugar) e são registradas em
`src/tools/conversions-core.ts`, para dividirem o cache da conta de conversão. Continuam
classificadas nas listas do núcleo em `src/read-only.ts`.

### list_conversion_actions — leitura
Agora devolve, por ação: origem, conta dona (`owner_customer_id`), `include_in_conversions_metric`
(somente leitura), atribuição e `data_driven_model_status`, valor padrão/moeda/valor fixo, janelas,
duração da ligação e propriedade/evento do GA4. Omite REMOVED por padrão (`status` filtra),
aceita `format` e informa a conta de conversão e quantas ações pertencem a outra conta.

### create_conversion_action — escrita
- Cria na conta de conversão; recusa se ela estiver fora do allowlist.
- `includeInConversionsMetric` não é mais enviado (a API recusa com `IMMUTABLE_FIELD`): vira
  `primary`, com aviso; se divergir de `primary`, a chamada é recusada.
- Regras por tipo antes da API: WEBSITE_CALL/AD_CALL sempre com `alwaysUseDefaultValue=true` (enviado
  mesmo sem `valueSetting`), sem view-through e click-through 1–60; view-through 1–30;
  click-through até 90 nos demais, com aviso acima de 30 (a documentação da API cita [1,30] para a
  maioria dos tipos e a Central de Ajuda 30/60/90 conforme a origem — a API decide);
  `phoneCallDurationSeconds` só em tipos de chamada, 0–10000.
- Micro-conversões (PAGE_VIEW, ADD_TO_CART, BEGIN_CHECKOUT, ENGAGEMENT) nascem **secundárias** se
  `primary` não vier.
- Nome duplicado (não REMOVED) na conta de conversão é recusado antes da API.
- Depois de criar: relê a ação, informa se a meta da conta da categoria × origem ficou biddable (e
  se foi criada agora) e, em WEBPAGE/chamada, devolve o ID/rótulo e o event snippet da tag.
- Categoria aceita `YOUTUBE_FOLLOW_ON_VIEWS` (v25). Moeda do valor padrão = a da conta de conversão.
- Erros da API vêm com explicação em PT-BR (DATA_DRIVEN_MODEL_*, DUPLICATE_NAME, VALUE_MUST_BE_UNSET...).

### update_conversion_action — escrita
- Lê a ação antes; grava na conta dona (`owner_customer`); ação do sistema (sem dona) é recusada.
- Só os campos que mudam vão no `updateMask`; sem mudança, nada é enviado; resposta com antes → depois.
- `includeInConversionsMetric` → `primary_for_goal` (mesma regra do create).
- Troca para DATA_DRIVEN só com `data_driven_model_status = AVAILABLE`; senão recusa explicando.
- Regras por tipo usando o tipo atual da ação.
- **`confirm: true` obrigatório** (sem ele, isError com a prévia: ação, antes → depois, conta e motivo;
  nada é enviado, nem com `validateOnly`):
  - `status` HIDDEN ou REMOVED quando o status muda. Pelo proto v25 (`enums/conversion_action_status.proto`),
    REMOVED = "conversões não são registradas" e HIDDEN = "não são registradas **e** a ação não aparece
    na interface" — ou seja, HIDDEN tem o mesmo efeito de parar de registrar e ainda esconde a ação de
    quem abre a conta. Se a ação era ENABLED e primária, a prévia avisa que as campanhas perdem o sinal
    de lance.
  - **Ação compartilhada**: a dona é outra conta (em geral a MCC, conta de conversão da conta cliente)
    ou a conta consultada é a própria MCC (`customer.manager`). Mudar `primary`, categoria, contagem,
    atribuição etc. nela muda os lances e a coluna "Conversões" de **todas** as contas que usam essa
    conta de conversão; a prévia e a resposta dizem isso. Mesma lógica de `set_account_conversion_goals`.
  - O gate é conferido depois de ler a ação (para mostrar a prévia) e só quando há mudança: pedir
    HIDDEN numa ação já HIDDEN é no-op sem confirm. Voltar para ENABLED não exige confirm (é pedido
    explícito).
- Valor padrão não troca a moeda existente (só preenche se estiver vazia).
- Mudança de categoria informa a meta da conta da nova categoria.

### set_campaign_conversion_goals — escrita
Mesmo comportamento (só pares existentes, só o que muda), agora com:
- aviso quando a campanha herdava as metas da conta: a mudança passa `goal_config_level` a CAMPAIGN
  e as metas da conta deixam de valer para ela (como voltar: `set_campaign_goal_config`);
- aviso quando a campanha usa meta personalizada;
- categoria `YOUTUBE_FOLLOW_ON_VIEWS` e origem `LOCAL_SERVICES_ADS` aceitas.
Continua gravando na conta da campanha, como a API exige para `CampaignConversionGoal`.

## Fluxos

- **Conta com conversões na MCC**: `get_conversion_tracking_settings` → se a MCC não estiver no
  allowlist, incluí-la; `create_conversion_action` grava na MCC automaticamente.
- **Nova conversão no site**: `create_conversion_action` (WEBPAGE) → a resposta já traz ID/rótulo;
  `get_conversion_tag` para o Google tag completo e os passos do GTM.
- **Bidar a PMax só em "Compra aprovada"**: `create_custom_conversion_goal` (IDs da ação) →
  `set_campaign_goal_config customConversionGoalId` → conferir com `list_conversion_goals`.
- **Auditoria**: `audit_conversion_tracking` → `update_conversion_action primary=false` nas compras
  duplicadas / micro-conversões; `set_account_conversion_goals` para desligar metas de micro.
- **Conversões na MCC**: `audit_conversion_tracking` na MCC (configuração das ações compartilhadas) +
  `audit_conversion_tracking` em cada conta cliente (volumes). Ajustes nas ações da MCC via
  `update_conversion_action` pedem `confirm: true`, porque valem para todas as contas cliente.

## Limites e o que ficou parcial

- `upload_offline_conversion`: resolvido na integração pelo lote conversions-offline — o upload vai
  para a conta dona da ação / conta de conversão (`conversion_tracking_setting.google_ads_conversion_customer`),
  depois da checagem da allowlist. `get_account_info` não é deste lote.
- `conversionCategorySchema` do `tool-kit.ts` não foi alterado (regra de propriedade); as tools deste
  lote usam `conversionCategoryV25Schema`, que inclui `YOUTUBE_FOLLOW_ON_VIEWS`.
- Janela click-through: a documentação da API diz [1,30] "para a maioria" dos tipos não-chamada; a
  tool aceita até 90 com aviso, porque a Central de Ajuda aceita 60/90 conforme a origem.
- `create_conversion_action` mantém DATA_DRIVEN como padrão (comportamento anterior); se a API recusar
  por modelo indisponível em ação nova (`DATA_DRIVEN_MODEL_UNKNOWN`), o erro explica e sugere LAST_CLICK.
- O status HIDDEN de ações do GA4 é só lido e apontado; importar um evento do GA4 não é feito aqui.
- `set_account_conversion_goals` só enxerga as campanhas da conta consultada; com MCC, as demais contas
  que usam a mesma conta de conversão também mudam (a prévia avisa).
- A prévia de `update_conversion_action` numa ação compartilhada não lista as contas cliente afetadas:
  saber quais contas usam a MCC como conta de conversão exigiria ler a configuração de cada conta cliente.
  A prévia diz que vale para todas as que usam essa conta de conversão.
- `audit_conversion_tracking` numa MCC não traz volumes (limite da API para contas de administrador);
  para volumes, rode em cada conta cliente.
