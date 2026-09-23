# Lote conversions-offline — importação offline, ajustes, chamadas e GCLID

Módulo: `src/tools/conversions-offline.ts` · catálogo: `src/tools/conversions-offline.catalog.ts` ·
testes: `tests/conversions-offline.test.ts`.

## Regras comuns a todas as tools de escrita

- **Conta de destino = dona da ação de conversão** ("conversion customer"). A tool lê
  `customer.conversion_tracking_setting.google_ads_conversion_customer` e
  `conversion_action.owner_customer`. Com acompanhamento entre contas, a ação fica na MCC e o
  envio sai dela. É o que o Google exige para chamadas e ajustes ("Only the account that manages
  conversion actions is able to import adjustments") e o único destino que a Data Manager API
  aceita. A conta dona também passa por `checkCustomerAccess`: se estiver fora de
  `ALLOWED_CUSTOMER_IDS`, a tool não lê nem grava nada nela.
- **Dados pessoais só com hash e nunca em claro na resposta.** E-mail, telefone, nome, sobrenome
  e rua passam por normalização e SHA-256 (hex) aqui no servidor. Também dá para mandar o hash
  pronto em `hashedEmail` ou `hashedPhoneNumber`. As respostas mostram só o tipo de identificador
  (`email#`) e telefones mascarados (`+55113****4444`).
  - E-mail: remove os espaços e passa para minúsculas. Em `gmail.com` e `googlemail.com`, também
    remove os pontos e o `+sufixo` do usuário. Outros domínios mantêm ponto e `+`.
  - Telefone: vira E.164. Número sem `+` (ou `00`) só é aceito com `defaultPhoneCountryCode`
    (ex.: `"55"`), porque sem DDI ele viraria um E.164 errado que ainda passaria na regex.
    Número que **já traz o DDI sem `+`** (comum em CRM: `5511999998888`) não ganha o DDI de
    novo. Antes, virava `+555511999998888`: 15 dígitos, passava na regex e, depois do hash, a
    API não tinha como avisar. O tamanho decide nos planos que o módulo conhece: Brasil (55),
    com DDD + 8 ou 9 dígitos = 10 ou 11 no nacional e 12 ou 13 com o DDI; EUA/Canadá (1), com
    10; Portugal (351), com 9. Assim, `(55) 99999-8888` (DDD 55, RS) continua nacional. Tamanho
    que não fecha com nenhum dos dois (ex.: celular sem DDD) é recusado. Nos outros DDIs, número
    sem `+` que começa pelo DDI é recusado como ambíguo, com pedido de `+DDI`. Número com o 0 de
    tronco é sempre nacional.
  - Nome e sobrenome: minúsculas, sem pontuação, espaços das pontas removidos e espaços internos
    reduzidos a um só. Rua: minúsculas e espaços aparados. País, estado, cidade e CEP não levam
    hash.
- **Validação completa antes de qualquer chamada.** A tool confere formato de data/hora
  (`yyyy-MM-dd HH:mm:ss±HH:MM`, com data real e não futura), valor ≥ 0, moeda ISO 4217, IDs
  numéricos, `jobId` em [1, 2³¹), até 2.000 linhas e limite de identificadores. Também barra
  duplicatas no mesmo envio: `DUPLICATE_ORDER_ID`, `DUPLICATE_CLICK_CONVERSION_IN_REQUEST`,
  `DUPLICATE_CALL_CONVERSION_IN_REQUEST`, `DUPLICATE_ADJUSTMENT_IN_REQUEST` e
  `DUPLICATE_ENHANCEMENT_IN_REQUEST`. `orderId` com
  e-mail é recusado (`ORDER_ID_CONTAINS_PII`). Tudo isso sai numa lista única, e nada é enviado.
- **Leitura antes de gravar.** Antes do envio, a tool confere se a ação existe, qual o tipo, o
  status, a contagem (`ONE_PER_CLICK` não aceita gbraid/wbraid) e se usa sempre o valor padrão
  (nesse caso não aceita `RESTATEMENT`). Também confere os pré-requisitos de enhanced
  conversions for leads na conta de conversão.
- **Resultado por linha.** As tools enviam `partialFailure: true` e distribuem o
  `partial_failure_error` pelas linhas. O índice vem em `conversions` ou em
  `conversion_adjustments` — por isso o módulo tem `uploadFailuresByRow`, já que
  `partialFailureByOperation`, do tool-kit, procura `operations`. Os códigos mais comuns ganham
  uma dica em PT-BR (`ERROR_HINTS`).
- **Dry-run.** `validateOnly: true` (parâmetro que o wrapper põe em toda tool de escrita) ou
  `GOOGLE_ADS_DRY_RUN` fazem o client mandar `validateOnly`. A resposta diz "DRY-RUN … nada
  gravado" e nunca fala em linhas "aceitas".

## Tools

### `upload_offline_conversion` (escrita) — reescrita e movida de `src/tools.ts`
UploadClickConversions para ações `UPLOAD_CLICKS` ativas.
- Novidades:
  - `email`, `phone`, `hashedEmail` e `hashedPhoneNumber` (até 5 por conversão). Como diz o
    proto, este serviço aceita só e-mail e telefone; endereço fica para ajustes e para a Data
    Manager.
  - Linhas **sem clique** (enhanced conversions for leads).
  - `adUserDataConsent`, por linha ou como padrão.
  - `customerType` (NEW/RETURNING), `conversionEnvironment` (WEB/APP), `cartData` e
    `customVariables` (por ID; não aceitas com gbraid/wbraid).
  - `jobId` opcional e `defaultPhoneCountryCode`.
- Pré-requisitos: linha só com e-mail/telefone é recusada se a conta de conversão estiver com
  `accepted_customer_data_terms` ou `enhanced_conversions_for_leads_enabled` = false. Linha com
  gclid segue, mas com aviso.
- **Restrição de 15/06/2026.** Se a API recusar com `CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE`
  (erro RPC ou em todas as linhas), a tool explica a restrição e aponta para
  `upload_offline_conversions_data_manager`. A restrição vale para credenciais que não enviaram
  conversões offline nem enhanced conversions for leads entre 17/12/2025 e 15/06/2026. O Google
  a define pelo developer token; dizer que ela vale para o projeto do Cloud é inferência, e a
  mensagem avisa isso. Ajustes e chamadas não são afetados.
- Resposta: aceitas e recusadas por linha, `job_id` devolvido e avisos (linhas sem
  consentimento, por exemplo).
- Mudança de comportamento: `conversionDateTime` agora é validado (antes qualquer texto ia para a
  API). `validateOnly` segue funcionando, agora pelo wrapper.

### `upload_offline_conversions_data_manager` (escrita)
Data Manager API `POST https://datamanager.googleapis.com/v1/events:ingest`. É o substituto que o
Google indica para quem caiu na restrição.
- Destino: `operatingAccount` = conta dona da ação, `productDestinationId` = ID da ação. O
  `loginAccount` é preenchido pelo client com o login (equivale ao header `login-customer-id`).
- Eventos:
  - `eventTimestamp` (RFC 3339, convertido do formato da API). Quem manda RFC 3339 direto
    passa pela mesma conferência de calendário do formato da API: mês, dia que existe no mês,
    hora ≤ 23, minuto e segundo ≤ 59 e fuso até ±14:59. `Date.parse` sozinho aceitaria
    `2026-02-30`, e como a Data Manager é fast-fail, uma data dessas faria a API recusar o
    envio inteiro (até 2.000 eventos);
  - `adIdentifiers` (gclid, gbraid e wbraid);
  - `userData.userIdentifiers` (`emailAddress`, `phoneNumber` e `address` com
    givenName/familyName em hash, mais regionCode e postalCode);
  - `transactionId` (vem do orderId);
  - `conversionValue`, `currency`, `consent` (`CONSENT_GRANTED`/`CONSENT_DENIED`, por evento e
    no nível da requisição), `userProperties.customerType` (NEW/RETURNING/REENGAGED),
    `eventSource`, `cartData` e `customVariables` (pelo **nome**).
  - O corpo vai com `encoding: "HEX"`.
- Limites: 2.000 eventos e 10 identificadores por evento. O modelo é fast-fail: um erro recusa
  tudo. Reenviar um `transactionId` já recebido com outros dados vira ajuste; retratação só existe
  pela Google Ads API.
- Dry-run: o client manda `validateOnly: true`. Fora do dry-run, a resposta traz o `requestId`.
- Erros traduzidos: escopo insuficiente (`ACCESS_TOKEN_SCOPE_INSUFFICIENT`), API desativada no
  projeto e permissão negada.

### `get_data_manager_request_status` (leitura)
`GET requestStatus:retrieve?requestId=…`. Mostra, por destino, o status (SUCCESS, PROCESSING,
PARTIAL_SUCCESS ou FAILED) traduzido, o número de eventos e as contagens de erro e de aviso por
motivo. Destinos cuja `operatingAccount` está fora da allowlist ficam ocultos.

### `upload_conversion_adjustments` (escrita)
UploadConversionAdjustments. `RETRACTION` e `RESTATEMENT` valem para ações WEBPAGE,
UPLOAD_CLICKS ou SALESFORCE; `ENHANCEMENT`, **só para WEBPAGE** (proto
`ConversionAdjustmentUploadError.INVALID_CONVERSION_ACTION_TYPE`). A tool confere o tipo da ação
depois de lê-la e, se houver ENHANCEMENT para uma ação UPLOAD_CLICKS ou SALESFORCE, recusa o
envio inteiro apontando as linhas, sem gravar nada.
- `RETRACTION` zera a conversão (cancelamento, estorno, boleto/Pix não pago). **Exige
  `confirm: true`** em envio real, porque não se desfaz; com `validateOnly: true` valida sem
  confirm.
- `RESTATEMENT` troca o valor. Exige `adjustedValue` (o novo valor total) e aceita
  `currencyCode`.
- `ENHANCEMENT` (enhanced conversions for web):
  - exige `orderId`, porque o enhancement casa pelo pedido, e pelo menos um identificador
    (e-mail, telefone ou endereço com nome, sobrenome, país e CEP obrigatórios; rua, cidade e
    estado são opcionais);
  - `conversionDateTime` da conversão original é **opcional e recomendado** e vai em
    `gclidDateTimePair.conversionDateTime`, **sem gclid**. É o formato do guia e dos exemplos
    oficiais (Python/Java): `order_id` + `gclid_date_time_pair.conversion_date_time`;
  - `gclid` é opcional e, se vier, vai no par junto do `orderId` (exige `conversionDateTime`).
    O proto v25 diz, no campo `gclid_date_time_pair`: "If the adjustment_type is ENHANCEMENT,
    this value is optional but may be set in addition to the order_id". O guia também recomenda
    incluir o gclid quando existir;
  - um ENHANCEMENT por `orderId` em cada envio (`DUPLICATE_ENHANCEMENT_IN_REQUEST`, qualquer
    que seja o `adjustmentDateTime`). Junte os identificadores numa linha só;
  - aceita `userAgent`. Se o `conversionDateTime` tiver mais de 24 h, a resposta avisa: o guia
    pede o enhancement em até 24 h da conversão original.
- Identificação em `RETRACTION` e `RESTATEMENT`: `orderId` **ou** o par `gclid` +
  `conversionDateTime`, nunca os dois (`GCLID_DATE_TIME_PAIR_AND_ORDER_ID_BOTH_SET`). Também é
  recusado `orderId` com `conversionDateTime` sem gclid, e `conversionDateTime` sozinho. Ações
  WEBPAGE exigem orderId (`MISSING_ORDER_ID_FOR_WEBPAGE`). O ajuste precisa ser posterior à
  conversão. Duplicata: mesma conversão com o mesmo `adjustmentDateTime`
  (`DUPLICATE_ADJUSTMENT_IN_REQUEST`).
- Limites: 2.000 por envio e `jobId` opcional. Depois de criar a ação, é preciso esperar de 4 a
  6 h (`TOO_RECENT_CONVERSION_ACTION`).

### `upload_call_conversions` (escrita)
UploadCallConversions para ações `UPLOAD_CALLS` ativas.
- `callerId` em E.164 (normalizado).
- `callStartDateTime` e `conversionDateTime` com fuso; a conversão não pode ser anterior à
  chamada.
- Consentimento **obrigatório** (o guia de chamadas exige), por linha ou como padrão.
- Valor ≥ 0, moeda e `customVariables`.
- A requisição não tem `job_id`. `TOO_RECENT_CALL` ganha dica de espera: o proto fala em 6 h e o
  guia em 12 h, e a mensagem cita os dois. A chamada precisa ter número de encaminhamento do
  Google.

### `get_conversion_upload_health` (leitura)
`offline_conversion_upload_client_summary` e `offline_conversion_upload_conversion_action_summary`.
- Traz, por origem (API, interface/SFTP, conectores) e por ação:
  - status traduzido;
  - taxas de sucesso e de pendentes;
  - último upload;
  - os últimos 7 dias e os últimos 7 jobs (`job_id`);
  - os principais alertas (`topAlerts`, padrão 5), ordenados por percentual e com dica.
- O diagnóstico fica na conta que **fez** o upload, por isso a tool consulta a conta pedida e,
  se diferente e permitida, a conta de conversão. Parâmetros: `conversionActionId` (filtro),
  `includeConversionCustomer` e `format` (json/table/csv).
- Base: o último dia completo. Pendentes podem levar até 24 h.

### `lookup_gclid` (leitura)
`click_view` filtrado por **um dia** (`segments.date = 'D'`, obrigatório pela API) e
`click_view.gclid IN (…)`.
- Traz campanha, grupo, anúncio, palavra-chave (texto, correspondência e critério), dispositivo,
  rede, tipo de clique, página, local de presença, área de interesse, alvo geográfico da
  campanha (com o nome canônico via `geo_target_constant`) e lista de público.
- `lookbackDays` (0–30) varre dias anteriores a `date`, uma query por dia, e para quando todos
  os GCLIDs foram achados.
- Limites: até 90 dias atrás e até 100 GCLIDs. O GCLID só pode ter `[A-Za-z0-9._~-]` e ainda
  passa por `gaqlLiteral`. Quando um GCLID não aparece, a resposta lista as causas prováveis.

### `get_call_details` (leitura)
`call_view`. O recurso não tem `segments.date`, então a janela filtra
`call_view.start_call_date_time` entre `since 00:00:00` e `until 23:59:59`; com `days`, a
janela inclui hoje.
- Filtros: `campaignId`, `callStatus` (MISSED/RECEIVED), `minDurationSeconds`,
  `maxDurationSeconds` e `limit` (padrão 500, máximo 10.000).
- Resumo: total, perdidas (com taxa), atendidas, duração média, chamadas curtas abaixo de
  `shortCallSeconds` (padrão 60 s, o padrão de conversão) e a mesma quebra por campanha.
- Formatos: json, table ou csv. O DDD vem vazio em chamadas com menos de 15 s.

## Fluxos

- **Boleto/Pix não pago ou pedido cancelado:** `upload_conversion_adjustments` com
  `type: RETRACTION` e `orderId`. Valide antes com `validateOnly: true` e depois envie com
  `confirm: true`. Para devolução parcial, use `RESTATEMENT` com o valor novo total.
- **Lead qualificado no CRM:** `upload_offline_conversion` com gclid, e-mail, telefone e
  `adUserDataConsent`. Se vier `CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE`, use
  `upload_offline_conversions_data_manager` e depois `get_data_manager_request_status`.
  Acompanhe em `get_conversion_upload_health`.
- **`EVENT_NOT_FOUND` / `NO_CONVERSION_ACTION_FOUND`:** confira com `lookup_gclid` a conta e a
  data do clique.
- **Call center:** `get_call_details` para auditar perdidas e curtas, depois
  `upload_call_conversions` para as chamadas qualificadas.

## O que ficou parcial e por quê

- **Token OAuth com escopo `datamanager`.** O código da Data Manager está pronto (client, tools e
  testes), mas depende de o operador gerar de novo o refresh token consentindo **os dois**
  escopos (`https://www.googleapis.com/auth/adwords` e
  `https://www.googleapis.com/auth/datamanager`) e ativar a Data Manager API no projeto do
  Google Cloud. Pela documentação, o escopo é sensível e o app OAuth pode precisar de
  verificação. O servidor não tem fluxo de consentimento próprio (o token vem de fora, conforme o
  README), e o README e o `hosted-config` estão fora da propriedade deste lote. As instruções
  estão aqui e nas mensagens de erro da tool. Nada foi testado contra a API real (não há
  credenciais).
- **Não incluídos:** `user_ip_address` e session attributes, que na Google Ads API são só para
  quem está na allowlist (a Data Manager os aceita, mas eles ficaram fora deste lote), e
  `external_attribution_data`.
- **gclid junto do orderId em ENHANCEMENT (decisão, não pendência).** A revisão pediu para
  recusar ou descartar esse gclid, com base no comentário dos exemplos oficiais ("Enhancements
  MUST use order ID instead of GCLID date/time pair"). A decisão foi mantê-lo, porque as fontes
  primárias da v25 dizem o contrário. O proto permite o par "in addition to the order_id" em
  ENHANCEMENT. O guia de enhanced conversions for web, atualizado em 10/09/2026, recomenda
  "include gclid on the adjustment if it's available". O comentário dos exemplos quer dizer que o
  enhancement se identifica pelo orderId, e isso a tool exige. Se a API recusar mesmo assim
  (`GCLID_DATE_TIME_PAIR_AND_ORDER_ID_BOTH_SET`), a linha falha sozinha (partial failure) e a
  dica manda reenviar só com orderId + conversionDateTime.
- **`job_id` automático:** as tools não fixam um `job_id`. A API gera um único por envio e a
  resposta mostra esse valor, que aparece em `last_jobs` do diagnóstico. `jobId` explícito
  continua disponível para quem quiser agrupar envios.

## Mudança no client (`src/google-ads-client.ts`, no fim da classe, seção `// ── lote conversions-offline ──`)

Os métodos novos ficaram na própria classe porque o token OAuth e o refresh são privados:

- `dataManagerIngestEvents(body)`: bloqueado em read-only; em dry-run manda `validateOnly: true`;
  preenche `loginAccount` com o login quando ele falta.
- `dataManagerRequestStatus(requestId)`: leitura.
- `dataManagerRequest` (privado): repete em 429/503 e extrai `status`, `reason` e
  `fieldViolations` dos erros.

A Data Manager não usa developer token.
