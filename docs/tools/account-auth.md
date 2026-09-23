# Lote account-auth — Autenticação, configurações da conta e metadados de campos

Base: `bc68023` (dev). Módulo `src/tools/account-auth.ts`, catálogo `src/tools/account-auth.catalog.ts`,
testes `tests/account-auth.test.ts` (33 testes; 23 mutações de guarda conferidas — todas pegas, mais uma
mutação equivalente documentada na seção de correções).

## Resumo dos itens

| Item | Status | O que foi feito |
|------|--------|-----------------|
| #2 Developer token extinto (09/09/2026) | parcial (README, `run-http.mjs` e `.env.example` pendentes — fora da posse do lote, ver abaixo) | Token opcional no client, no `index.ts` e na config hospedada; header só vai quando definido; erros de acesso (`CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION` e outros) explicados em PT-BR com o link da página "Google Ads API Overview" do projeto Cloud; tool `check_api_access` para diagnóstico. |
| #24 Resources com orientação errada | feito | `conversions` x `all_conversions`, categorias (sem `LEAD`), ECPC descontinuado, VIDEO/DEMAND_GEN/DISPLAY corrigidos, exemplos de GAQL válidos, nomes de tools sem o prefixo `google_` inexistente (resources e prompts), campanhas com ECPC ligado apontadas por `get_account_settings`. |
| #42 Configurações de conta e saúde do MCC | feito | `get_account_settings` (uma conta ou MCC inteiro, score ponderado), `update_account_settings` (MutateCustomer), `list_accounts` com status, sub-MCCs, rótulo, ocultas, hierarquia e contagem por status. |
| #43 Verificação de identidade do anunciante | feito | `get_identity_verification` (uma conta ou MCC, cache de 6 h, ordenado pelo prazo) e `start_identity_verification` (confirm, recusado em dry-run). GET genérico `customerGet` no client. |
| Extra 1: service account + 2SV | feito | Service account por `GOOGLE_ADS_SERVICE_ACCOUNT_KEY_PATH` / `GOOGLE_ADS_SERVICE_ACCOUNT_JSON` (JWT RS256 assinado localmente, sem dependência nova); `TWO_STEP_VERIFICATION_NOT_ENROLLED` e `invalid_grant` explicados. |
| Extra 2: metadados de campos | feito | `get_gaql_fields` e `validate_gaql` sobre o GoogleAdsFieldService (cache no processo); `run_gaql` aponta para eles em erro de query. |
| Extra 3: serviços restritos a allowlist | parcial (só documentação) | Não há o que implementar sem liberação do Google: lista verificada nos resources (troubleshooting) e na dica de `SERVICE_ACCESS_DENIED`. |

## Tools novas

### `check_api_access` — leitura
Diagnóstico de acesso. Mostra o modo de autenticação (OAuth de usuário ou service account, com o e-mail a
adicionar no Google Ads), se há developer token (e que ele é opcional/ignorado), o `login-customer-id`, o
modo (leitura/escrita/dry-run), as contas acessíveis (`customers:listAccessibleCustomers`, filtradas pela
allowlist; em modo hospedado o total não é exibido), se o MCC do login é acessível e é gerente, e — com
`customerId` — testa `SELECT ... FROM customer` na conta. Erros vêm com os códigos (`codigos`) e a explicação.
- O MCC do login passa pela allowlist como qualquer conta: se `checkCustomerAccess` nega (ex.: tenant hospedado
  limitado a um cliente), o MCC **não é consultado**, `login_customer_id` e os dados do MCC saem da resposta
  (`mcc_do_login` = `{ verificado: false, motivo }`) e só fica o sim/não `login_customer_id_acessivel`; as
  mensagens de problema também não citam o ID. Com `ALLOWED_CUSTOMER_IDS=*`, sem allowlist no stdio ou com o
  MCC na lista, o diagnóstico do MCC é completo.
- MCC do login com status diferente de ENABLED (SUSPENDED, CANCELED, CLOSED) entra em `problemas` com o
  significado do status — a resposta não diz mais "Acesso OK." nesse caso.
- Parâmetros: `customerId?`.
- Se `getClient()` falhar (credencial ausente/duplicada), devolve a mensagem de configuração em vez de estourar.

### `get_account_settings` — leitura
Uma conta (`customerId`) ou todas as contas-cliente do MCC do login (`allAccounts: true`).
Lê de `customer`: nome, status, gerente, conta de teste, moeda, fuso, `auto_tagging_enabled`,
`tracking_url_template`, `final_url_suffix`, `call_reporting_setting.*`, `conversion_tracking_setting.*`
(status, IDs, termos de dados do cliente, enhanced conversions for leads, conta de conversão),
`optimization_score` e `optimization_score_weight`.
- Alertas (alta/media/info): auto-tagging desligado; `NOT_CONVERSION_TRACKED`; tracking template sem
  `{lpurl}`; optimization score abaixo do mínimo; status SUSPENDED/CANCELED/CLOSED (significado do
  `customer_status.proto`); termos de dados do cliente não aceitos (exigidos para enhanced conversions
  para web); conta de teste; campanhas com `manual_cpc.enhanced_cpc_enabled = true` (ECPC descontinuado).
- `allAccounts`: contas não-gerente de todos os níveis, filtradas pela allowlist; só as ENABLED são
  consultadas (4 em paralelo), as demais entram com o alerta de status; erro de uma conta não derruba as
  outras. Resumo com contagem por status, auto-tagging desligado, sem conversão, score baixo e
  **optimization score ponderado do MCC** = Σ(score × `optimization_score_weight`) ÷ Σ peso das contas
  pontuadas (o proto descreve o agregado do gerente como a soma de score × peso).
- Parâmetros: `customerId` | `allAccounts`, `minOptimizationScore` (0–1 ou 0–100; padrão 0,7),
  `includeCampaignChecks` (ECPC; padrão true numa conta, false em allAccounts), `maxAccounts` (padrão 100,
  máx. 500), `format` json/table/csv.

### `update_account_settings` — escrita
`CustomerService.MutateCustomer` (`POST /v25/customers/{id}:mutate`, **uma** `operation` com `update` +
`updateMask`; `validateOnly` em dry-run). Campos: `descriptiveName`, `autoTaggingEnabled`,
`trackingUrlTemplate`, `finalUrlSuffix`, `callReportingEnabled`, `callConversionReportingEnabled`,
`callConversionActionId`.
- Lê a conta antes; só entram no `updateMask` as folhas que mudam (nunca a mensagem
  `call_reporting_setting` inteira); nada muda → nenhuma escrita.
- `""` limpa `trackingUrlTemplate`, `finalUrlSuffix` ou `callConversionActionId` (caminho no mask sem o campo).
- Tracking template sem `{lpurl}` / `{lpurl+2}` / `{lpurl+3}` / `{unescapedlpurl}` / `{escapedlpurl}` é
  recusado antes da API (a Central de Ajuda diz que o template de conta precisa inserir a URL final, senão
  a landing page quebra).
- `callConversionActionId` precisa existir na conta e não estar REMOVIDA (conferido por GAQL).
- Sem `confirm: true` devolve só a prévia antes → depois (isError, nada enviado). Com `validateOnly` a API
  valida sem confirm e a resposta diz "VALIDADO — nada foi gravado". Após gravar, relê a conta.
- Aviso explícito ao desligar auto-tagging (quebra GA4 e upload offline por GCLID).

### `get_identity_verification` — leitura
`IdentityVerificationService.GetIdentityVerification` (`GET /v25/customers/{id}/getIdentityVerification`).
Status (`PENDING_USER_ACTION`, `PENDING_REVIEW`, `SUCCESS`, `FAILURE`), prazos de início e conclusão,
dias até o prazo, `action_url` e expiração do link. Lista vazia = verificação não exigida.
- Cache de 6 h por conta (a documentação pede cache e polling espaçado; o método é limitado); `refresh: true` ignora.
- `allAccounts`: contas-cliente ENABLED e SUSPENDED (suspensão pode ser por falta de verificação), 2 em
  paralelo; separa "precisam de ação" (PENDING_USER_ACTION/FAILURE, ordenadas pelo prazo de conclusão),
  "em análise", concluídas, não exigidas e erros.
- Limite: a API devolve as datas como `yyyy-MM-dd HH:mm:ss` sem fuso documentado — lidas como UTC.

### `start_identity_verification` — escrita
`StartIdentityVerification` (`POST /v25/customers/{id}:startIdentityVerification`,
`verificationProgram: ADVERTISER_IDENTITY_VERIFICATION`). Relê o estado sem cache e só envia quando faz
sentido: não exigida → recusa; SUCCESS / PENDING_REVIEW → nada; PENDING_USER_ACTION com link válido →
devolve o link existente. Exige `confirm: true`. O método não tem `validate_only`: em dry-run/validateOnly
nada é enviado (fail-closed também no client, via `customerWriteAction`). Depois de iniciar, relê e devolve
o novo `action_url`.

### `get_gaql_fields` — leitura
GoogleAdsFieldService. Um de: `resource` (GET `googleAdsFields/{recurso}` + busca `name LIKE 'recurso.%'`):
recursos atribuídos, recursos de segmentação, segmentos e métricas compatíveis, e os campos do recurso com
selecionável/filtrável/ordenável, tipo, repetido e `enum_values`; `fields` (até 25, GET por campo; com um
só vem `selectable_with`); `namePrefix` (busca por prefixo, até 500 exibidos). `nameContains` e `include`
reduzem a saída. Cache de 12 h no processo (metadados só mudam com a versão).
- `customerId` é opcional: os metadados são globais (não leem dados de conta); quando informado, só
  confere o acesso pela allowlist.

### `validate_gaql` — leitura
Confere a query com os metadados reais antes de rodar (não executa). Regras: recurso do FROM existe; campo
existe (com sugestão de nome por distância de edição); prefixo é o FROM, recurso atribuído ou de
segmentação, ou segmento/métrica compatível; SELECT selecionável, WHERE filtrável, ORDER BY ordenável;
segmento (exceto date/week/month/quarter/year) e campo de recurso de segmentação no WHERE precisam estar
no SELECT; segmento de data no SELECT exige data no WHERE ("Query structure" da documentação); LIMIT inteiro
positivo. O teste cruza o resultado com `tests/gaql-validator.ts` em 10 queries.
- As palavras-chave das cláusulas são procuradas numa cópia da query com cada literal de string trocado por
  espaços do mesmo tamanho: `campaign.name = 'Limit Offer'` não vira um `LIMIT Offer'`, e `'... ORDER BY ...'`
  ou `'... PARAMETERS ...'` num literal não cortam o WHERE (campos depois do literal continuam conferidos).
- LIMIT é a última cláusula (só `PARAMETERS` vem depois): o valor é tudo até `PARAMETERS` ou o fim, então
  `LIMIT 10 20` e `LIMIT` sem valor são apontados. Literal sem aspas de fechamento também é apontado.

## Tools existentes alteradas (src/tools.ts)

- **`list_accounts`** — novos parâmetros `includeStatuses` (ENABLED/CANCELED/SUSPENDED/CLOSED; padrão
  ENABLED), `includeManagers`, `includeHidden`, `labelId`, `hierarchy`, `format`. Sem parâmetros continua
  listando só contas ENABLED não-gerente, mas o cabeçalho agora conta as contas por status e avisa das
  SUSPENDED/CANCELED/CLOSED que ficaram fora. Saída ganhou `level`, `manager`, `hidden`, `test_account`,
  `labels` (nomes dos rótulos de conta do MCC) e, com `hierarchy`, `parent_manager_id` (busca em largura
  com `customer_client.level <= 1` por MCC, como no guia oficial; até 100 MCCs). Allowlist aplicada à lista
  e à contagem.
- **`get_account_info`** — valida o ID, inclui `test_account` e explica status não-ENABLED.
- **`get_account_currency`** — lê a moeda direto da conta e devolve erro se a API não a trouxer (antes
  caía silenciosamente em "BRL" via `getAccountCurrency`).
- **`run_gaql`** — recusa texto que não começa com SELECT antes da API; em erro de query aponta
  `validate_gaql`/`get_gaql_fields`; descrição cita as tools de metadados e a semântica de conversões.

## Infraestrutura (arquivos do lote)

- **`src/google-ads-client.ts`**
  - `developerToken` opcional; header `developer-token` só quando definido.
  - Service account: `serviceAccount` na config, JWT RS256 (`iss` = e-mail, `scope` adwords, `aud` =
    token_uri, `exp` = `iat` + 3600) trocado por `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`;
    token só em memória, compartilhado entre instâncias pelo par e-mail + hash da chave (o `getClient()`
    cria um client por tool).
  - Renovação de token deduplicada (chamadas paralelas esperam a mesma promessa).
  - `GoogleAdsApiError` (`codes` = `"authorizationError.X"`…, `httpStatus`) e `explainApiErrorCodes`:
    dicas PT-BR para CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION, DEVELOPER_TOKEN_*, USER_PERMISSION_DENIED,
    INVALID_LOGIN_CUSTOMER_ID_…, ACTION_NOT_PERMITTED, ACTION_NOT_PERMITTED_FOR_SUSPENDED_ACCOUNT,
    CUSTOMER_NOT_ENABLED, PROJECT_DISABLED, SERVICE_ACCESS_DENIED, MISSING_TOS,
    TWO_STEP_VERIFICATION_NOT_ENROLLED, ADVANCED_PROTECTION_NOT_ENROLLED, NOT_ADS_USER, OAUTH_TOKEN_*,
    GOOGLE_ACCOUNT_DELETED, CUSTOMER_NOT_FOUND e quotaError.RESOURCE_EXHAUSTED. A mensagem continua
    começando com `Google Ads API: …` e ganha uma linha `Como resolver: …`.
  - `invalid_grant` / `invalid_client` no endpoint de token explicados (refresh token revogado, 2SV).
  - Novos métodos: `mutateCustomer`, `customerGet` (GET genérico em `customers/{id}/…` — reutilizável
    por outros lotes), `getIdentityVerification`, `startIdentityVerification`, `searchGoogleAdsFields`
    (pagina sozinho), `getGoogleAdsField` (valida o nome). Getters sem segredo: `authMode`,
    `serviceAccountEmail`, `hasDeveloperToken`, `loginCustomer`, `isReadOnly`, `apiVersion`.
  - `listChildAccounts(mccId?, { allStatuses, includeManagers, maxLevel })` — sem opções o GAQL é o de
    antes (manager = false e status ENABLED); seleciona também `hidden`, `test_account`, `applied_labels`,
    `client_customer`. `getCustomer` seleciona também `customer.test_account`.
- **`src/hosted-config.ts`** — `resolveGoogleAdsAuth(env)` (exatamente uma credencial entre as quatro
  variáveis; login obrigatório; developer token opcional; `~` expandido) e `parseServiceAccountKeyJson`
  (type `service_account`, `client_email`, `private_key` PEM, `token_uri` https).
- **`src/index.ts`** — usa `resolveGoogleAdsAuth`; o fallback do `.env` passou a olhar
  `GOOGLE_ADS_LOGIN_CUSTOMER_ID` (o token deixou de ser obrigatório).
- **`run-http.mjs`** e **`.env.example`** — **não alterados** (fora da lista de posse do lote; a primeira
  versão os mexeu e a mudança foi desfeita). Consequência: `node run-http.mjs` ainda sai com
  `process.exit(1)` quando o `.env` não tem `GOOGLE_ADS_DEVELOPER_TOKEN`. O servidor em si não precisa dele:
  sem token, rode `npm run build && PORT=3333 node dist/index.js` (ou `npm run dev:http`), que lê o `.env`
  pelo `src/index.ts`. Patch pronto para o integrador na seção "Pendente fora da posse".
- **`src/resources.ts`** — glossário (conversões, canais, lances), playbook (nomes reais das tools),
  referência GAQL (métricas, categorias, exemplo de compras válido, regras de WHERE/data, tools de
  metadados) e troubleshooting (acesso via projeto Cloud, cotas, 2SV, service account, serviços
  restritos, contas suspensas, verificação de identidade, checklist de conversões).
- **`src/prompts.ts`** — nomes de tools corrigidos (o prefixo `google_` não existe) e auditoria completa
  começando por `get_account_settings` / `get_identity_verification`.

## Fluxos

- **Onboarding / "não conecta"**: `check_api_access` → lê `problemas`; com `customerId` testa a conta.
- **Saúde do MCC**: `list_accounts` (cabeçalho com status) → `list_accounts includeStatuses=["SUSPENDED","CANCELED"]`
  → `get_account_settings allAccounts=true` → `get_identity_verification allAccounts=true`.
- **Corrigir auto-tagging / sufixo**: `get_account_settings` → `update_account_settings` (prévia) →
  mesmo com `confirm: true` (ou `validateOnly: true` para validar na API).
- **Montar GAQL**: `get_gaql_fields resource=<FROM>` → `validate_gaql` → `run_gaql`.

## Texto pronto para o README (o lote não edita o README)

Requisitos (substitui a linha do developer token):

- Projeto no Google Cloud com a Google Ads API ativada. Desde 09/09/2026 o **nível de acesso é do projeto
  Cloud** dono do OAuth client (Test → só contas de teste; Explorer, Basic, Standard → produção), pedido na
  página **Google Ads API Overview** do Cloud Console (`console.cloud.google.com/google/ads-apis/overview`).
  O API Center não processa mais pedidos. Cotas por projeto (janela de 24 h): Test 15.000 operações/dia
  (só teste), Explorer 2.880/dia em produção, Basic 15.000/dia, Standard sem limite diário.
- Developer token: **opcional** — a API ignora o header desde 09/09/2026 e uma versão major futura vai
  recusá-lo. Se `GOOGLE_ADS_DEVELOPER_TOKEN` estiver definido o servidor ainda envia; pode remover.
- Credencial (exatamente uma):
  - OAuth de usuário: `GOOGLE_ADS_CREDENTIALS_PATH` ou `GOOGLE_ADS_CREDENTIALS_JSON`. Desde 21/04/2026 a
    conta Google que autoriza precisa de verificação em duas etapas (sem ela: `TWO_STEP_VERIFICATION_NOT_ENROLLED`).
  - Service account: `GOOGLE_ADS_SERVICE_ACCOUNT_KEY_PATH` ou `GOOGLE_ADS_SERVICE_ACCOUNT_JSON` (chave JSON
    do Cloud Console). Adicione o e-mail da service account em Admin > Acesso e segurança da conta ou do
    MCC (até 20 contas por e-mail; para mais, adicione ao MCC). Não depende do funcionário que autorizou.

Tabela de variáveis: `GOOGLE_ADS_DEVELOPER_TOKEN` → Obrigatório: **Não**; novas linhas
`GOOGLE_ADS_SERVICE_ACCOUNT_KEY_PATH` / `GOOGLE_ADS_SERVICE_ACCOUNT_JSON` (alternativa à credencial OAuth).
Exemplos de configuração podem omitir `GOOGLE_ADS_DEVELOPER_TOKEN`.

Tools: acrescentar à seção "Descoberta de contas" `check_api_access`, `get_account_settings`,
`update_account_settings`, `get_identity_verification`, `start_identity_verification`, `get_gaql_fields`,
`validate_gaql` e atualizar a linha de `list_accounts`. Contagens do modo somente leitura: +5 leitura, +2 escrita.

## Pendente fora da posse — patch pronto para o integrador

`run-http.mjs` (troca as 5 linhas que exigem o token):

```js
// Developer token é opcional desde 09/09/2026 (a API ignora o header; o acesso
// vem do projeto Google Cloud do OAuth client). Repassado só se existir.
const token = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
if (token) globalThis.__GOOGLE_ADS_DEVELOPER_TOKEN = token;
```

`.env.example` (troca a linha `GOOGLE_ADS_DEVELOPER_TOKEN=seu_developer_token`):

```
# Credencial — defina EXATAMENTE UMA das quatro:
#   GOOGLE_ADS_CREDENTIALS_PATH / GOOGLE_ADS_CREDENTIALS_JSON (OAuth de usuário)
# Service account (e-mail dela adicionado como usuário da conta/MCC no Google Ads):
# GOOGLE_ADS_SERVICE_ACCOUNT_KEY_PATH=./service-account.json
# GOOGLE_ADS_SERVICE_ACCOUNT_JSON={...}
# Opcional desde 09/09/2026 (a API ignora o header; o acesso vem do projeto Google Cloud):
# GOOGLE_ADS_DEVELOPER_TOKEN=
```

## Parcial / fora do alcance — e por quê

- **README**: fora da posse do lote; o texto acima está pronto para o integrador.
- **`run-http.mjs` / `.env.example`**: fora da posse do lote; enquanto o patch acima não entrar, o launcher
  HTTP exige um `GOOGLE_ADS_DEVELOPER_TOKEN` no `.env` (qualquer valor serve hoje, porque a API ignora o
  header — mas uma versão major futura vai recusá-lo) ou use `PORT=3333 node dist/index.js`.
- **ECPC**: `get_account_settings` só aponta as campanhas com `enhanced_cpc_enabled=true`; mudar a estratégia
  é do lote de lances (a regra do lote é não mexer em lance fora do propósito da tool).
- **Serviços restritos** (ReachPlanService, AudienceInsightsService, ContentCreatorInsightsService,
  BenchmarksService, IncentiveService — allowlist; AssetGenerationService — beta fechado): nada a
  implementar sem liberação; documentados nos resources e na dica de `SERVICE_ACCESS_DENIED`.
- **ACTION_NOT_PERMITTED**: a proposta mandava apontar para a página do projeto Cloud, mas o proto define o
  erro como falta de permissão do usuário para a ação; a dica fala do nível de acesso do usuário na conta
  (Padrão/Administrador). O caso do projeto Cloud é `CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION`.
- **Consulta de campos por `IN`**: não usada; só as formas documentadas (`name = '…'` e `name LIKE '…%'`).
- **Fuso das datas da verificação de identidade**: não documentado; lidas como UTC (dito na resposta).
- **Correção da verificação independente**: o servidor não recusava iniciar — `getClient()` é lazy e cada
  tool falhava com "GOOGLE_ADS_DEVELOPER_TOKEN não definido"; o `run-http.mjs`, esse sim, saía com
  `process.exit(1)`. O primeiro foi corrigido; o `run-http.mjs` ficou pendente (fora da posse — ver acima). A cota de 2.880 operações/dia do Explorer está citada com a
  fonte certa (`/docs/api-policy/access-levels`).

## Fontes verificadas

- developers.google.com/google-ads/api/docs/api-policy/developer-token (sunset 09/09/2026, header opcional e
  ignorado, página Google Ads API Overview, CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION)
- …/docs/api-policy/access-levels (níveis e cotas por projeto Cloud)
- …/docs/oauth/security-requirements (2SV desde 21/04/2026) e …/docs/oauth/service-accounts (acesso direto,
  20 contas por e-mail); developers.google.com/identity/protocols/oauth2/service-account (JWT)
- …/docs/account-management/advertiser-identity-verification (cache, conta pode ser pausada, sessão única)
- …/docs/account-management/get-account-hierarchy (level <= 1 por MCC)
- …/docs/recommendations (score × optimization_score_weight), …/docs/concepts/field-service,
  …/docs/query/overview e …/docs/query/structure (regras de segmento/data)
- Protos v25: services/customer_service, resources/customer, resources/customer_client,
  enums/customer_status, services/identity_verification_service, enums/identity_verification_program(_status),
  services/google_ads_field_service, resources/google_ads_field, errors/authorization_error,
  errors/authentication_error, errors/quota_error, common/metrics, enums/conversion_action_category,
  common/bidding, services/benchmarks|audience_insights|content_creator_insights_service
- support.google.com/google-ads/answer/2464964 (ECPC), 15110871 (Video action → Demand Gen), 13695777 e
  15890515 (Demand Gen e Display), …/docs/video/overview (API só lê campanhas de Vídeo),
  …/docs/reach-forecasting, …/docs/insights/audience-insights, …/docs/insights/creator-insights,
  …/docs/billing/incentives, release notes (AssetGenerationService em beta fechado)

## Correções da revisão (branch `batch/account-auth-fix`)

- **Guarda de allowlist das tools de escrita sem teste** — novo teste chama `update_account_settings`
  (com `confirm` e com `validateOnly`) e `start_identity_verification` em modo hospedado com uma conta fora
  da allowlist: `isError`, "Access denied" e nenhuma leitura, escrita, consulta ou início de verificação;
  controle na conta liberada. Mutação: remover o guarda de cada tool derruba o teste.
- **`validate_gaql` recusava query válida com `'Limit ...'` num literal** — `parseGaqlClauses` agora procura
  as cláusulas na cópia mascarada (literais → espaços do mesmo tamanho) e lê o LIMIT até `PARAMETERS`/fim.
  Teste com `'Limit Offer'`, `'%PARAMETERS%'`, `"Joe's LIMIT x"`, aspas escapadas, `PARAMETERS`, segmento
  escondido depois de `'... ORDER BY ...'`, `LIMIT 10 20`, `LIMIT` vazio e literal aberto. Mutações:
  localizar as palavras-chave na query original, voltar ao LIMIT antigo e tirar a checagem de literal aberto
  derrubam o teste. (Extrair campos da query original com os literais removidos em vez da cópia mascarada é
  mutação equivalente — mesmo resultado — e por isso sobrevive.)
- **`check_api_access` consultava e exibia o MCC do login fora da allowlist** — `checkCustomerAccess` no MCC
  antes da sonda; negado → sem consulta, sem ID/status na resposta, só o sim/não. MCC liberado com status
  diferente de ENABLED vira problema. Mutações: forçar o MCC como liberado, voltar a sempre exibir
  `login_customer_id`, citar o ID na mensagem de "sem acesso direto" e remover o problema de status
  derrubam os testes.
- **Violação de posse** — `run-http.mjs` e `.env.example` voltaram ao estado de `bc68023`; item #2 rebaixado
  para parcial com o patch pronto acima.
