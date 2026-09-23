# Lote account-admin — Administração do MCC

Contas, vínculos gerente ↔ cliente, usuários e aprovações multi-party, faturamento e edição
em massa. Módulo: `src/tools/account-admin.ts` (catálogo em `account-admin.catalog.ts`).
Tool existente alterada: `bulk_update_status` (em `src/tools.ts`).

Payloads, caminhos REST e enums foram conferidos nos protos oficiais da v25
(`services/*.proto`, `resources/*.proto`, `enums/*.proto`, `errors/*.proto`); toda query GAQL
passa pelo validador com os metadados reais da v25 nos testes (`tests/account-admin.test.ts`).

## Convenções do lote

- Toda tool chama `checkCustomerAccess` para **cada** conta envolvida (gerente, cliente,
  gerente pagador). Em `allAccounts` as contas fora da allowlist são puladas e contadas.
- Leituras que listam **outras** contas seguem a regra do `list_accounts`: no modo hospedado
  com allowlist fechada, conta fora de `ALLOWED_CUSTOMER_IDS` não aparece (nem ID, nem nome,
  nem status) — só a quantidade ocultada (`list_account_links`) ou um total agregado
  (`list_invoices`). No stdio sem allowlist e com `*` nada é ocultado.
- Leitura antes da escrita: o objeto precisa existir naquela conta, a resposta mostra
  antes/depois e nada é enviado quando não há mudança.
- `confirm: true` em tudo que é difícil de desfazer: desvincular/mover conta, aceitar convite,
  usuários, aprovações, orçamento de conta, criar conta, aplicar em massa.
- Dry-run / `validateOnly`:
  - serviços com `validate_only` no request (`createCustomerClient`, `customerClientLinks`,
    `customerManagerLinks`, `moveManagerLink`, `accountBudgetProposals`, mutates por serviço)
    vão para a API em modo validação e a resposta diz que nada foi gravado;
  - serviços **sem** `validate_only` (`customerUserAccesses`, `customerUserAccessInvitations`,
    `multiPartyAuthReview:resolve`, `BatchJobService`) são recusados antes de qualquer envio.
- Client (`src/google-ads-client.ts`, no fim da classe, seção `// ── lote account-admin ──`):
  - `withLoginCustomerId(id)`: cópia do client com outro `login-customer-id` para uma chamada
    (aceitar convite como a conta cliente; faturas pelo gerente pagador). Preserva dry-run e
    read-only, como `withDryRun`.
  - `customerGet(cid, path, params)`: GET de leitura fora do GAQL (`invoices`,
    `paymentsAccounts`, `batchJobs/{id}:listResults`), com a query string em lowerCamelCase.

## Edição em massa

### bulk_update_status (write — alterada)
Pausa/ativa campanhas, grupos ou anúncios em massa.
- Antes: um `mutate` sem partial failure — um ID ruim desfazia tudo e listas acima de 10.000
  falhavam.
- Agora: valida o formato dos IDs antes de chamar (anúncio = `adGroupId~adId`), remove
  duplicados, lê o status atual (blocos de 1.000 no `IN`), pula os que já estão no status,
  os `REMOVED` e os inexistentes, e grava em blocos de até 10.000 com `partialFailure: true`;
  cada falha volta com o motivo (`partialFailureByOperation`). Erro fora das operações (auth,
  cota) interrompe e lista o que não foi enviado. Até 50.000 IDs por chamada.
- `resourceIds` aceita array ou string JSON (flexArray). Listas longas na resposta são
  truncadas em 500 itens com a marca `(+N omitidos)`; as contagens do cabeçalho são exatas.
- **Em escala exige `confirm: true`:** quando mais de **100** itens mudariam (**20** com
  `status: ENABLED` — ativar volta a gastar na hora), a chamada só devolve o plano lido
  (quantos mudam, quais, status antes/depois, já no status, removidos, não encontrados),
  marca erro e não grava. O corte conta o que de fato muda depois da leitura (20.000 IDs em
  que só 3 mudam gravam direto). Chamadas menores seguem iguais às de antes (compatível com
  os agentes atuais). Em dry-run/`validateOnly` nada é gravado, então não pede `confirm`.

### bulk_mutate (write)
Edição genérica: até 10.000 operações `create`/`update`/`remove` de vários tipos.
- Parâmetros: `operations[{resource, action, resourceName?, fields?}]`, `preview` (padrão
  true), `confirm`.
- Recursos: campaigns, campaignBudgets, adGroups, adGroupAds, ads (só update),
  adGroupCriteria, campaignCriteria, campaignLabels/adGroupLabels/adGroupAdLabels/
  adGroupCriterionLabels (só create/remove), campaignAssets, adGroupAssets — ações conferidas
  nos `*Operation` dos protos.
- `fields` em JSON camelCase como na REST; o `updateMask` sai das folhas (snake_case).
  Objeto vazio (ex.: `{manualCpc: {}}`) é recusado (FIELD_HAS_SUBFIELDS) — estratégia de
  lance fica com `update_campaign`.
- Só o que muda é gravado: depois da leitura, cada update leva no payload **e** no
  `updateMask` apenas as folhas cujo valor atual difere (campo que a API não devolveu conta
  como mudança). O `update_mask` do preview é exatamente o que será enviado. Vale também
  para `create_batch_job`.
- Validação antes da API: resource name da própria conta e no formato do recurso,
  referências a outras contas dentro de `fields`, ação suportada, uma operação por objeto.
- Preview: lê o estado atual (GAQL por `resource_name IN (...)`, só os campos tocados) e
  mostra antes/depois, não encontrados, já removidos e sem mudança. Se a leitura falhar
  (campo inexistente), nada é enviado.
- Aplicar (`preview: false` + `confirm: true`): um mutate por tipo de recurso, com
  `partialFailure`, erro por operação. Escolha deliberada: o endpoint por serviço devolve o
  índice da operação em `fieldPathElements` ("operations"), o que dá o erro por item; o
  `googleAds:mutate` (batchMutate do client) não tem partial failure no client atual.
- Limite: 10.000 operações (limite do mutate da API). Acima → `create_batch_job`.

### create_batch_job (write, encadeada)
BatchJobService para listas grandes (até 50.000 por chamada; o job aceita 1 milhão).
- Mesmo formato de `operations` e mesma leitura antes da escrita do `bulk_mutate`.
- Preview por padrão; `preview: false` + `confirm: true` cria o job (`batchJobs:mutate`,
  `metadata.executionLimitSeconds` opcional), envia em blocos de 1.000 encadeando o
  `sequenceToken` (`:addOperations`) e executa (`:run`).
- Falha no envio → remove o job pendente (não roda pela metade).
- Sem `validate_only` na API: recusada em dry-run; está em `chained` (o `validateOnly` por
  chamada é recusado pelo wrapper).
- `operation_index` dos resultados = posição entre as operações **enviadas**, não na lista de
  entrada (as puladas não vão ao job). A resposta traz o mapeamento completo, sem corte:
  - `mapa_indices`: trechos contíguos `enviadaIni-enviadaFim:entradaIni` (ex.:
    `"0-399:600"` = enviadas 0..399 são as entradas 600..999);
  - `puladas`: por motivo (`sem_mudanca`, `nao_encontrado`, `ja_removido`), o total e os
    índices da entrada em trechos (`"0-599,812"`).
  Passe `mapa_indices` em `get_batch_job_results` (`indexMap`) e cada resultado volta com
  `input_index`. As operações vão na ordem recebida (sem reordenar por tipo).

### get_batch_job_status (read)
Status (PENDING/RUNNING/DONE), progresso e contagens (`FROM batch_job`); sem `batchJobId`
lista os mais recentes.

### get_batch_job_results (read)
Confere o status antes; só com DONE chama `GET batchJobs/{id}:listResults` (página de até
1.000, `pageToken`). Por operação: resource name ou erros (mensagem + código). `onlyErrors`.
`indexMap` (o `mapa_indices` de `create_batch_job`) acrescenta `input_index` a cada resultado;
mapa malformado ou de outro job (cobre um número de operações diferente do
`metadata.operation_count` do job) é recusado antes do `listResults`.

## Contas e vínculos do MCC

### create_client_account (write)
`POST customers/{mcc}:createCustomerClient`. Parâmetros: `managerCustomerId`, `name`,
`currencyCode` (BRL), `timeZone` (America/Sao_Paulo), `trackingUrlTemplate?`,
`finalUrlSuffix?`, `allowDuplicateName?`, `confirm`.
- Moeda e fuso são imutáveis: sem `confirm` a tool só mostra o que seria criado.
- Confere que a conta de destino é MCC e recusa nome já existente sob ele.
- `checkCustomerAccess` no MCC. Em hospedado com allowlist fechada avisa que a conta nova
  precisa entrar em `ALLOWED_CUSTOMER_IDS`.
- Limite da API: só gerentes com mais de US$ 1.000 de gasto e em dia com as políticas.
  `email_address`/`access_role` do request são só para allowlist do Google — não expostos.

### list_account_links (read)
`view=clients` (padrão): `customer_client_link` do MCC com nome da conta, status, oculta,
contagem por status e aviso de convites pendentes (limite 20 na hierarquia).
`view=managers`: `customer_manager_link` da conta cliente (limite 5 gerentes). Filtro `status`.
No modo hospedado com allowlist fechada, vínculos com contas (clients) ou gerentes (managers)
fora de `ALLOWED_CUSTOMER_IDS` saem da lista e das contagens por status; o cabeçalho diz
quantos foram ocultados. O aviso de 5 gerentes ativos considera também os ocultados (o limite
da API vale para todos), sem mostrar quais são.

### invite_client_account (write)
Cria `CustomerClientLink` PENDING. Não faz nada se já ACTIVE ou PENDING. Avisa perto do
limite de 20 pendentes. O cliente aceita na interface ou com `respond_to_manager_invitation`.

### cancel_client_invitation (write)
PENDING → CANCELED (`updateMask: status`). Sem convite pendente = nada enviado.

### set_client_link_hidden (write)
Campo `hidden` do vínculo (`updateMask: hidden`); só vínculo ACTIVE; no-op quando igual.

### unlink_client_account (write, confirm)
Pela visão do cliente: `customerManagerLinks:mutate` ACTIVE → INACTIVE. Religar exige novo
convite e aceite. A conta precisa ter um usuário ativo próprio (erro da API traduzido).

### move_client_account (write, confirm)
`customerManagerLinks:moveManagerLink` com o vínculo ACTIVE atual e o novo gerente. No-op se
origem = destino ou se já vinculada ao destino. Destino precisa estar na hierarquia do login.

### respond_to_manager_invitation (write, confirm)
Aceita (ACTIVE) ou recusa (REFUSED) convite PENDING, autenticando com
`login-customer-id` = conta cliente (`withLoginCustomerId`), como na documentação oficial.
Exige que o usuário OAuth deste servidor tenha acesso direto à conta cliente.

## Usuários e aprovações multi-party

### list_account_users (read)
`customer_user_access` (papel, e-mail, quem convidou, desde quando, `passkey_enabled`,
`pending_multi_party_auth_review`) + convites PENDING. Flags: `ADMIN`, `SEM_PASSKEY` (não se
aplica a EMAIL_ONLY), `APROVACAO_PENDENTE`, `CONVITE_ADMIN`. `allAccounts` + `managerCustomerId`
varre as contas ativas do MCC (até `maxAccounts`, 5 em paralelo); `email` filtra uma pessoa
(offboarding); `onlyIssues`; formato json/table/csv. Acesso herdado via gerente não aparece.

### invite_user / change_user_role / remove_user / revoke_user_invitation (write, confirm)
- `invite_user`: `customerUserAccessInvitations:mutate` create; no-op se o e-mail já tem
  acesso ou convite pendente.
- `change_user_role`: update `access_role`; no-op se igual; recusa rebaixar o último ADMIN e
  usuário com mudança já pendente de aprovação.
- `remove_user`: remove; recusa remover o último ADMIN.
- `revoke_user_invitation`: remove convite PENDING (por ID ou e-mail).
- Todos leem antes, exigem `confirm` e relatam quando a API devolve `multiPartyAuthReview`
  (mudança fica pendente até outro ADMIN aprovar; nada muda até lá). Recusados em dry-run.

### list_pending_approvals (read)
`FROM multi_party_auth_review` (padrão PENDING; filtro de status ou ALL).

### resolve_approval (write, confirm)
`multiPartyAuthReview:resolve` com `newStatus` APPROVED/REJECTED/REVOKED. Confere que o pedido
existe e está PENDING; `partialFailureError` por operação vira erro legível. Recusado em dry-run.
Regra da API: aprovar/rejeitar só outro ADMIN; revogar só quem pediu.

## Faturamento (somente faturamento mensal)

### get_billing_status (read)
`billing_setup` + `account_budget` (não cancelados): orçamento em vigor, próximo, limite
ajustado (fallback aprovado), veiculado, saldo, % restante e dias até o fim. Alertas:
saldo < `alertBelowPercent` (20), fim em ≤ `alertDaysToEnd` (7) dias sem próximo orçamento,
nenhum orçamento em vigor, proposta pendente, conta sem orçamento (pré-pago/cartão — a API
não expõe esse saldo). `allAccounts` varre as contas de anúncio do MCC: o MCC e os sub-MCCs
saem **antes** do corte em `maxAccounts` (não ocupam vaga), então `maxAccounts: 50` lê até 50
contas de anúncio, e as notas de allowlist/corte contam só contas de anúncio. Datas da API
estão no fuso da conta; os dias são aproximados pelo fuso do servidor.

### propose_account_budget (write, confirm)
`accountBudgetProposals:mutate` (uma operação por request; `validate_only` suportado).
- CREATE: `billingSetupId` (ou o único aprovado), `name`, limite (`spendingLimitMicros` ou
  `unlimitedSpending`), início (NOW padrão) e fim (obrigatório: FOREVER ou data). Avisa se
  já há orçamento em vigor (só um ativo por vez).
- UPDATE: lê o orçamento, envia só o que muda; máscara pelos nomes do oneof como no exemplo
  oficial (`proposed_spending_limit`, `proposed_end_time`, `proposed_start_time`) mais
  `proposed_name`, `proposed_notes`, `proposed_purchase_order_number`. No-op sem mudança.
  Início só muda antes de começar; avisa limite abaixo do já gasto.
- END (encerra agora — anúncios param) só em orçamento em andamento; REMOVE só antes do
  início; ambos sem outros campos (a API exige máscara vazia).
- Recusa quando o orçamento já tem proposta pendente; datas no passado e fim antes do início.

### cancel_account_budget_proposal (write, confirm)
Remove proposta PENDING (proposta aprovada não pode ser cancelada).

### list_invoices (read)
`GET customers/{cid}/invoices?billingSetup&issueYear&issueMonth[&includeGranularLevelInvoiceDetails]`.
Sem `billingSetupId` usa os billing setups aprovados. `granular=true` traz o custo por
campanha por orçamento (v23+). `payingManagerCustomerId` vira o `login-customer-id` (a API
exige o gerente pagador quando o header é enviado). Erros NOT_INVOICED_CUSTOMER /
BILLING_SETUP_NOT_ON_MONTHLY_INVOICING traduzidos. Faturas só a partir de 2019.
Fatura consolidada cobre todas as contas do perfil de pagamentos: no modo hospedado com
allowlist fechada, os `accountBudgetSummaries` de contas fora de `ALLOWED_CUSTOMER_IDS` não
saem um a um (sem ID, nome, orçamento ou campanhas) — viram `outras_contas_fora_da_allowlist`
(quantidade de orçamentos e soma de subtotal/imposto/total/veiculado), que fecha com o total
da fatura; o `pdf_url` dessa fatura sai como `null`, porque o PDF detalha essas contas.

### list_payments_accounts (read)
`GET customers/{cid}/paymentsAccounts` (ID, nome, moeda, perfil, gerente pagador), com
`payingManagerCustomerId` opcional como login.

## Fluxos

- **Onboarding de conta existente:** `invite_client_account` → cliente aceita (UI ou
  `respond_to_manager_invitation`) → `list_account_links` para conferir.
- **Conta nova:** `create_client_account` (sem confirm para revisar moeda/fuso) → confirm →
  faturamento na UI → `invite_user`.
- **Reorganizar sub-MCCs:** `move_client_account`; esconder contas antigas com
  `set_client_link_hidden`.
- **Offboarding:** `list_account_users allAccounts=true email=...` → `remove_user` por conta
  (se gerar aprovação: `list_pending_approvals` + `resolve_approval` por outro ADMIN).
- **Saldo de orçamento de conta:** `get_billing_status allAccounts=true` →
  `propose_account_budget UPDATE` (limite/fim) → acompanhar a proposta.
- **UTMs/URLs em massa:** `bulk_mutate` (preview) → confirm; acima de 10.000 →
  `create_batch_job` → `get_batch_job_status` → `get_batch_job_results onlyErrors=true`.

## Limitações e o que ficou de fora

- Faturamento só existe na API para contas em faturamento mensal; saldo pré-pago/cartão não é
  exposto (a tool diz isso em vez de reportar zero).
- O PDF da fatura (`pdf_url`) exige o token OAuth: a tool devolve o link, não baixa. No modo
  hospedado, o link é omitido quando a fatura inclui contas fora da allowlist.
- Criar/cancelar billing setup (`BillingSetupService`) não entrou: não estava na proposta e é
  mudança de pagamento de alto risco; o billing setup aparece só em leitura.
- `bulk_mutate`/`create_batch_job` não aceitam IDs temporários (create com dependência entre
  operações): cada create é independente. Criações encadeadas continuam nas tools
  específicas (ex.: `create_pmax_campaign`).
- `respond_to_manager_invitation` só funciona se o usuário OAuth do servidor tiver acesso
  direto à conta cliente; senão o cliente aceita pela interface.
- Aprovação multi-party (beta na API) só é resolvida com credenciais de outro ADMIN; a tool
  não tem como saber quem é o usuário atual e deixa a API decidir.
- As máscaras `proposed_end_time`/`proposed_start_time` seguem por analogia o exemplo oficial,
  que usa o nome do oneof (`proposed_spending_limit`); use `validateOnly` para conferir.
