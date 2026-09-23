# Lote pmax-signals — Performance Max: sinais, automação, marca, prévias e combinações

Módulo: `src/tools/pmax-signals.ts` (catálogo em `src/tools/pmax-signals.catalog.ts`).
Testes: `tests/pmax-signals.test.ts` (50 testes; toda query passa por `tests/gaql-rules.ts`).

Fontes conferidas (v25): `common/audiences.proto`, `resources/audience.proto`,
`services/audience_service.proto`, `resources/asset_group_signal.proto`,
`services/asset_group_signal_service.proto`, `errors/{criterion,audience,asset_group_signal}_error.proto`,
`resources/campaign.proto` (asset_automation_settings, brand_guidelines, brand_guidelines_enabled),
`services/campaign_service.proto` (EnablePMaxBrandGuidelines),
`errors/brand_guidelines_migration_error.proto`,
`services/automatically_created_asset_removal_service.proto`,
`resources/final_url_expansion_asset_view.proto`, `services/shareable_preview_service.proto`,
`actions/generate_shareable_previews.proto`, `enums/preview_type.proto`,
`errors/shareable_preview_error.proto`, `resources/asset_group_top_combination_view.proto`,
`common/asset_usage.proto`, `common/criteria.proto` (WebpageInfo), `services/google_ads_service.proto`
(IDs temporários no googleAds:mutate). Guias: performance-max/asset-group-signals, optimizations,
create-campaign-criteria, asset-requirements, assets, troubleshooting, asset-reporting,
docs/assets/asset-automation-settings, samples/add-dynamic-page-feed-asset (condição CUSTOM_LABEL).

Convenções que valem para todas as tools do lote:

- `checkCustomerAccess` antes de tudo; IDs validados (`^\d+$`) antes de entrar no GAQL; textos
  com `gaqlLiteral`.
- Lê antes de gravar (o objeto precisa existir na conta, ser de PMax, não estar removido);
  sem mudança não há escrita.
- Remoção, troca ou ação irreversível exige `confirm: true`; sem ele a tool devolve o plano.
- Várias operações independentes: `partialFailure` e relatório por item. Operações dependentes
  (público novo + sinal; nome da empresa novo + vínculo; cópia de público + sinal): um
  `googleAds:mutate` atômico com IDs temporários — por isso nenhuma tool do lote é "chained".
- Dry-run/validateOnly: nunca diz que gravou. Endpoints sem `validate_only`
  (EnablePMaxBrandGuidelines, RemoveCampaignAutomaticallyCreatedAsset) não são chamados nesse
  modo — a tool mostra o plano e avisa.

## Item 49 — Sinais de PMax: públicos compostos e temas de pesquisa

### `create_audience` (write)
Cria um `Audience` com qualquer combinação de: `userLists`, `userInterests`, `customAudiences`,
`lifeEvents`, `detailedDemographics` (segmentos, em OU) e `ageRanges`, `genders`,
`incomeRanges`, `parentalStatuses` (dimensões, em E), mais `excludeUserLists` (a API só aceita
user list na exclusão). Referências: ID numérico ou resource name da mesma conta.
- `scope`: `CUSTOMER` (padrão; exige `name` único, 1–255) ou `ASSET_GROUP` (exige
  `assetGroupId`; a API proíbe `name`).
- `linkAsSignal` (padrão true com ASSET_GROUP): cria e vincula como sinal numa chamada atômica
  (`audienceOperation` com `customers/{cid}/audiences/-1` + `assetGroupSignalOperation`).
  O grupo aceita um público só (ONE_AUDIENCE_ALLOWED_PER_ASSET_GROUP): se já houver, exige
  `replaceExistingSignal` + `confirm` (o remove vai antes do create, no mesmo request).
- Idade: `"18-24"`, `"25-54"`, `"65+"`, `"UNDETERMINED"` (mínimos 18/25/35/45/55/65, máximos
  24/34/44/54/64, conforme AgeSegment). `UNDETERMINED` em gênero/renda/parental vira
  `include_undetermined`.
- Confere antes: nome livre, cada segmento existe (user_list, user_interest, custom_audience,
  life_event, detailed_demographic), grupo PMax. Avisa lista fechada ou vazia.
- Não envia `status` (OUTPUT_ONLY).

### `update_audience` (write)
Edita um público — o único jeito suportado de mudar um sinal de público. Cada campo informado
substitui só aquela parte (`[]` limpa); o resto fica. `updateMask`: `dimensions` (campo
repetido, vai inteiro), `exclusion_dimension.exclusions` (folha), `name`, `description`, `scope`.
`promoteToCustomerScope` (ASSET_GROUP → CUSTOMER, exige `name` e `confirm: true`). É
irreversível: o proto (`resources/audience.proto`) permite ASSET_GROUP → CUSTOMER mas não o
caminho de volta, e a API limpa `asset_group` sozinha. Sem `confirm` (inclusive em
validateOnly), a tool devolve o plano — `update_mask`, `changes`, `scope` e `asset_group`
antes/depois, composição antes/depois e `used_by` — com erro, e não envia nada. Num público que
já é CUSTOMER, `promoteToCustomerScope` é no-op e não pede `confirm`. Recusa público sem dimensão
positiva, segmento novo inexistente e nome em uso. Mostra antes/depois e os grupos de recursos
que usam o público (`used_by`).

### `list_asset_group_signals` (read)
Por `assetGroupId` ou `campaignId`: temas com `approval_status` e `disapproval_reasons`, e o
público de cada grupo com nome, escopo e composição. `format` json/table/csv.

### `manage_asset_group_signals` (write)
`addSearchThemes` (até 10 palavras, sem repetir, pula os existentes), `removeSearchThemes`
(pelo texto), `removeSignalIds`, `setAudience` (troca atômica remove+create se já houver
outro), `removeAudience`. Temas e remoções com partial failure: cada tema recusado volta com o
erro da API (ex.: SEARCH_THEME_POLICY_VIOLATION, TOO_MANY_WORDS) e dica em PT-BR. Remoção/troca
exige `confirm`.

### `copy_asset_group_signals` (write)
Copia sinais de um grupo para até 20 grupos: temas que faltam (reprovados não são copiados),
público CUSTOMER vinculado se o destino não tiver público, público ASSET_GROUP recriado com o
escopo do destino (atômico). Nunca troca o público que o destino já tem.

### Tools do núcleo alteradas (em `src/tools.ts`, só a implementação)
- `add_audience_signal`: mesmo schema; agora valida o ID, confere grupo PMax, aceita ID do
  público, não duplica tema, recusa segundo público com a orientação certa, respeita dry-run e
  traduz erro da API. Implementação em `addAudienceSignal` (import dinâmico do módulo).
- `create_audience_from_lists`: mesmo schema; usa o núcleo de `create_audience` (aceita ID ou
  resource name, confere listas e nome, não manda `status`).
- `get_asset_group_performance`: valida `campaignId` (antes era interpolado cru no GAQL),
  `assetGroupId` opcional, `status`, `primary_status`, CPA e `format` json/table/csv.

## Item 59 — Expansão de URL final e automação de assets do PMax

### `get_pmax_automation_settings` (read)
Automação por tipo (valor explícito ou padrão do PMax), exclusões de URL (critérios WEBPAGE
negativos), feeds de páginas vinculados e as URLs finais dos grupos (que sempre veiculam).

### `set_pmax_asset_automation` (write)
`finalUrlExpansion` (FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION), `textCustomization`
(TEXT_ASSET_AUTOMATION), `imageEnhancement` (GENERATE_IMAGE_ENHANCEMENT), `enhancedVideos`
(GENERATE_ENHANCED_YOUTUBE_VIDEOS), `imageExtraction` (GENERATE_IMAGE_EXTRACTION). Lê, junta e
reenvia a lista inteira (`updateMask asset_automation_settings`); igual ao atual não é enviado.
Bloqueia antes da API: desligar a personalização de texto com a expansão ligada (explícita ou
padrão) e com feed de páginas vinculado (a API exige remover o CampaignAssetSet PAGE_FEED antes —
OPERATION_NOT_PERMITTED_FOR_CONTEXT). Só PMax (Pesquisa/Shopping seguem em `set_ai_max_settings`).

### `set_pmax_url_exclusions` (write)
`rules: [{operator: EQUALS|CONTAINS, url}]` e `customLabels` viram critérios WEBPAGE negativos
(uma condição por critério; CUSTOM_LABEL vai só com operand + argument, como no sample oficial).
`removeCriterionIds` e `replace` removem (exigem `confirm`). Recusa EQUALS igual à URL final de
um grupo (o Google não exclui a URL final; ela continuaria veiculando) e avisa quando um CONTAINS
casa com uma URL final. Pula exclusões já existentes (só conta como "já excluída" uma exclusão
que não está em `removeCriterionIds`). Pedir uma regra em `rules`/`customLabels` e, na mesma
chamada, remover pelo `removeCriterionIds` a exclusão que já aplica essa regra é contraditório:
a chamada é recusada sem enviar nada, com a lista `conflicts` e a orientação (tirar o ID para
manter, ou tirar a regra para remover). Se houver outra exclusão igual que continua de pé, ela é
a "já excluída" e a remoção da duplicata segue normalmente. Partial failure por item. Não cria
regras de título/conteúdo de página (legadas no produto). Avisa quando a expansão está desligada.

### `list_url_expansion_assets` (read)
`final_url_expansion_asset_view` da campanha: texto, field type, URL escolhida, status, grupo,
métricas no período (`dateRange`/`days`). `format` json/table/csv.

### `remove_auto_created_assets` (write)
`RemoveCampaignAutomaticallyCreatedAsset` (`POST /v25/customers/{cid}:removeCampaignAutomaticallyCreatedAsset`,
`partialFailure: true` obrigatório no proto). Cada `{assetId, fieldType}` é conferido na
`final_url_expansion_asset_view` da campanha; o que não aparece lá não é enviado. Irreversível →
`confirm`. Sem `validate_only` no endpoint → não é chamado em dry-run/validateOnly.

## Item 83 — Diretrizes de marca

### `get_pmax_brand_settings` (read)
`brand_guidelines_enabled`, cores, fonte, nome da empresa/logos vinculados na campanha e as
regras (exatamente 1 BUSINESS_NAME, 1+ LOGO, até 5 logos somando LOGO e LANDSCAPE_LOGO). Em
campanha sem diretrizes, lista os nomes/logos que estão nos grupos (insumo da migração).

### `enable_pmax_brand_guidelines` (write)
`POST /v25/customers/{cid}/campaigns:enablePMaxBrandGuidelines`, até 10 campanhas. Um modo:
`autoPopulateBrandAssets: true` ou `businessNameAsset` + `logoAssets` (+ `landscapeLogoAssets`).
Opcionais: `finalUriDomain` (URL vira domínio), `mainColor` + `accentColor` (hex, juntas),
`fontFamily` (Open Sans, Roboto, Roboto Slab, Montserrat, Poppins, Lato, Oswald, Playfair
Display — exato). Confere campanhas (existe, PMax, não removida, já migrada = pulada) e assets
(tipo TEXT/IMAGE, nome até 25 caracteres, proporção 1:1 e 4:1). Irreversível → `confirm`; sem
`validate_only` → não é chamado em dry-run. Resultado por campanha a partir de
`EnablementResult.enablement_error`.

### `update_pmax_brand_assets` (write)
Troca nome da empresa (`businessNameAsset` ou `businessNameText`, que reaproveita asset de texto
igual ou cria um com ID temporário), adiciona/remove logos, ajusta cores e fonte (folhas
`brand_guidelines.main_color`, `.accent_color`, `.predefined_font_family`; `""` limpa). Tudo num
`googleAds:mutate` atômico, adicionando antes de remover; recusa o que deixaria a campanha fora
das regras (1 nome, 1+ LOGO, máx. 5). Remoção/troca → `confirm`. Exige diretrizes ativas.

## Item 93 — Prévias compartilháveis

### `get_shareable_preview` (read)
`POST /v25/customers/{cid}:generateShareablePreviews`. `assetGroupIds` → UI_PREVIEW (só PMax);
`adGroupAdIds` (`adGroupId~adId`) → YOUTUBE_LIVE_PREVIEW (formatos de vídeo/áudio). Até 10 itens.
Desde a v24 não há partial failure — por isso tudo é conferido na conta antes (grupo existe e é
PMax; anúncio existe e é VIDEO/AUDIO; RSA e display responsivo são recusados). Devolve as URLs e
`expiration_date_time`. É leitura: não altera a conta (os links são públicos para quem os tiver).

## Item 94 — Combinações de assets

### `get_pmax_top_combinations` (read)
`asset_group_top_combination_view` por `campaignId` e/ou `assetGroupId`, período opcional,
`limitPerGroup` (padrão 10). Cada asset é resolvido para texto, URL da imagem ou link do YouTube,
com o `served_asset_field_type`. `format` json/table/csv (uma linha por combinação).

## Fluxos

- Sinal de remarketing: `list_remarketing_lists` → `create_audience` (listas + interesses +
  exclusão de compradores, `assetGroupId` + `linkAsSignal`) → `list_asset_group_signals`.
- Ajustar sinal existente: `list_asset_group_signals` → `update_audience` (vale para todos os
  grupos que usam o público). Para reaproveitar um público exclusivo de um grupo em outros:
  `update_audience` com `promoteToCustomerScope` + `name` (devolve o plano) → revisar → repetir
  com `confirm: true`.
- Tema reprovado: `list_asset_group_signals` → `manage_asset_group_signals`
  (`removeSignalIds` + `addSearchThemes`, `confirm`).
- Cliente de lead/regulado: `get_pmax_automation_settings` → `set_pmax_url_exclusions`
  (`/blog`, `/carreiras`, políticas) → `list_url_expansion_assets` →
  `remove_auto_created_assets` (confirm) ou `set_pmax_asset_automation` (`finalUrlExpansion: false`).
- Rebrand: `get_pmax_brand_settings` → (`enable_pmax_brand_guidelines` se antiga) →
  `update_pmax_brand_assets` (nome + logos + cores, confirm).
- Aprovação do cliente: campanha PAUSED → `get_shareable_preview` → enviar links → ativar.

## Parcial / fora deste lote

- "Expor os mesmos controles no `create_pmax_campaign`" (automação de assets, exclusões): a tool
  pertence ao lote pmax-assets; não foi alterada aqui. As tools deste lote funcionam logo após
  a criação (campanha nasce PAUSED).
- "Reusar o helper do `set_ai_max_settings`": a lógica está inline em `src/tools.ts` (não é
  deste lote); a mescla da lista repetida foi reimplementada no módulo, com a mesma regra.
- Remoção de assets gerados: o serviço cobre os assets da expansão de URL final (conferidos
  na `final_url_expansion_asset_view`); outros assets automáticos se pausam/removem pelos
  vínculos CampaignAsset/AdGroupAsset, fora deste lote.
- Limites sem número documentado (quantidade de temas por grupo, de segmentos por público, de
  exclusões de URL, tamanho do tema): não são inventados aqui — a API decide e o erro volta
  por item, com dica.
