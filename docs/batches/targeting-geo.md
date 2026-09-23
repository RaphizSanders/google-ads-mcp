# Lote targeting-geo — Segmentação geográfica e de idioma

Módulo: `src/tools/targeting-geo.ts` (catálogo em `targeting-geo.catalog.ts`). Testes:
`tests/targeting-geo.test.ts` (36 testes; toda query passa por `assertGaqlRules` contra os
metadados reais da v25, e o client falso filtra as linhas pelo WHERE com igualdade exata — como o
GAQL, em que `=`/`IN` diferenciam maiúsculas em string).

As quatro tools existentes do lote (`get_geo_performance`, `list_geo_targets`,
`set_campaign_locations`, `set_campaign_languages`) saíram de `src/tools.ts` e agora são
registradas no módulo — no núcleo ficou só um comentário apontando para cá. Os nomes e a
classificação (read/write em `src/read-only.ts`) não mudaram; os parâmetros antigos continuam
aceitos.

Fontes conferidas: protos v25 (`common/criteria.proto` — `ProximityInfo`, `AddressInfo`,
`GeoPointInfo`, `LocationGroupInfo`; `resources/campaign.proto` — `GeoTargetTypeSetting`,
`DemandGenCampaignSettings.upgraded_targeting`; `resources/ad_group_criterion.proto` —
`location`/`language`; enums `PositiveGeoTargetType`, `NegativeGeoTargetType`,
`ProximityRadiusUnits`, `LocationGroupRadiusUnits`, `AssetSetType`, `DistanceBucket`,
`GeoTargetingType`; `errors/criterion_error.proto`, `context_error.proto`,
`campaign_criterion_error.proto`), o post do blog do Google Ads API de ago/2026 sobre idioma,
os guias "Location targeting", "Targeting criteria", "Performance Max — campaign criteria",
"Location assets", "Demand Gen — create campaign" e a field reference v25 de `campaign_criterion`.

---

## Tools novas

### `set_geo_target_type` — write
Presença x interesse (`Campaign.geo_target_type_setting`).
- `positive`: `PRESENCE` (só quem está/costuma estar na área — recomendado para lead-gen local)
  ou `PRESENCE_OR_INTEREST` (padrão do Google). `negative`: `PRESENCE` (recomendado) ou
  `PRESENCE_OR_INTEREST` (o guia diz que em geral não é suportado para exclusões — a tool avisa e a
  API decide). `SEARCH_INTEREST` não é oferecido: o guia diz que está descontinuado.
- `campaignId` ou `campaignIds` (até 50). Lê o valor atual, envia só as folhas que mudam
  (`geo_target_type_setting.positive_geo_target_type` / `.negative_geo_target_type`), pula as
  campanhas que já estão no valor pedido e devolve antes/depois por campanha.
- Várias campanhas: `partialFailure`, relatório por campanha. Mais de 10 campanhas mudando exige
  `confirm: true`. Campanha inexistente ou removida: recusa tudo, nada é enviado.

### `add_proximity_target` — write
Raio em volta de endereço ou lat/lng (`CampaignCriterion.proximity`).
- `targets[]` (1 a 100 por chamada): `latitude`/`longitude` (graus → micrograus) **ou** endereço
  (`streetAddress`, `cityName`, `postalCode`, `provinceCode`, `provinceName`, `countryCode` —
  país obrigatório e ao menos rua, cidade ou CEP; o Google geocodifica), `radius` (> 0),
  `radiusUnits` `KILOMETERS` (default do proto) ou `MILES`, `bidModifier` opcional (0.1–10, faixa do
  proto), `label` livre para o relatório.
- Tudo validado antes da API. Raio idêntico já existente (mesmo ponto/endereço, raio e unidade) não
  é recriado. Cada alvo é independente (`partialFailure`): criados, já existentes e erros, com os
  códigos do Google traduzidos (`INVALID_PROXIMITY_ADDRESS`, `INVALID_PROXIMITY_RADIUS`,
  `INVALID_LATITUDE`...). Depois de gravar, relê os critérios e mostra o ponto geocodificado.
- Raio só pode ser segmentado (não excluído) e só no nível da campanha (guia de critérios).
- **PMax:** a página de critérios de Performance Max não lista `PROXIMITY`; a tool avisa e deixa a
  API decidir — se recusar, use `add_location_group_target`.

### `add_location_group_target` — write
Raio em volta dos locais da conta (`CampaignCriterion.location_group`).
- Exatamente uma forma: `useCustomerLocations: true` (`enable_customer_level_location_asset_set`)
  ou `assetSetIds` (`location_group_asset_sets`). O proto não deixa usar as duas juntas.
- `radius` + `radiusUnits`: com conjuntos de locais o proto aceita `METERS` e `MILLI_MILES`;
  `KILOMETERS` e `MILES` são convertidos (×1000) e a conversão aparece no relatório.
- Antes de gravar: campanha existe; cada asset set existe, não está removido e é de locais
  (`LOCATION_SYNC`, `BUSINESS_PROFILE_DYNAMIC_LOCATION_GROUP`, `CHAIN_DYNAMIC_LOCATION_GROUP`,
  `STATIC_LOCATION_GROUP`); com `useCustomerLocations`, a conta tem um `LOCATION_SYNC` ativo em
  `customer_asset_set` (senão explica que falta conectar o Perfil da Empresa). Grupo idêntico já
  existente não é recriado.

### `remove_campaign_geo_targets` — write
Remove `LOCATION` (segmentado ou excluído), `PROXIMITY` e `LOCATION_GROUP` de uma campanha.
- `criterionIds` (de `get_campaign_geo_targeting`); só aceita critérios geográficos ativos da
  própria campanha. Sem `confirm: true` devolve a prévia e não grava (em dry-run/validateOnly a
  prévia não é exigida, porque nada é gravado).
- Se a remoção deixar a campanha sem nenhuma segmentação geográfica positiva, ela passaria a
  veicular no mundo todo: recusa, a menos que `allowWorldwide: true`. Remoção atômica.

### `get_campaign_geo_targeting` — read
A configuração atual por campanha (uma ou todas as ativas/pausadas, `limit` default 100):
`geo_target_type` (positive/negative), locais segmentados (nome, tipo, `bid_modifier`,
`criterion_id`), excluídos, raios, grupos de locais, idiomas e — em Demand Gen com segmentação
aprimorada — local e idioma por grupo. Avisos: campanha sem local (mundo todo), idioma legado em
Pesquisa, `PRESENCE_OR_INTEREST` com locais, nota de PMax. `format` json (aninhado) ou table/csv
(uma linha por critério).

---

## Tools alteradas

### `set_campaign_languages` — write (item 1: mudança de idioma do Google)
- **Pesquisa (inclui AI Max para Pesquisa):** recusa adicionar idioma, sem chamar a API de escrita,
  e explica: o Google anunciou que a partir do fim de setembro de 2026 o idioma de campanha deixa de
  existir em Pesquisa (a mudança está entrando em vigor agora — hoje é 23/09); os anúncios passam a
  ser combinados pelo idioma do anúncio; add/update volta `ContextError.OPERATION_NOT_PERMITTED_FOR_CONTEXT`;
  critérios antigos continuam nas consultas mas são ignorados. Orienta a escrever anúncios e landing
  page em pt-BR e lista os critérios legados.
- `cleanup: true` + `confirm: true`: remove todos os critérios de idioma numa requisição (limpeza
  opcional segundo o Google; em Pesquisa não dá para recriá-los depois). Sem `confirm`, prévia.
- **Performance Max:** grava e avisa que o idioma só vale fora da Pesquisa (YouTube, Display,
  Discover, Gmail); `CANNOT_TARGET_LANGUAGE` (idioma incompatível com o país da campanha, v24.2)
  vem explicado.
- **Demand Gen com `upgraded_targeting`:** grava `AdGroupCriterion.language` em todos os grupos
  ativos/pausados (ou `adGroupIds`), numa requisição atômica.
- **`adGroupIds` em qualquer outra campanha** (Pesquisa, Display, PMax, Demand Gen sem
  `upgraded_targeting`...): recusado antes de qualquer escrita. Nesses canais o idioma é da campanha
  e vale para todos os grupos; gravar ignorando `adGroupIds` seria mais amplo que o pedido. A
  mensagem pede para reenviar sem `adGroupIds` se a intenção for a campanha inteira. Vale também para
  `cleanup` em Pesquisa.
- `languageCodes` (ex.: `['pt','es','zh_CN']`) e/ou `languageIds`; código/ID inexistente ou não
  segmentável é recusado. Os códigos são comparados **sem diferenciar maiúsculas** e com `-` = `_`
  (`PT` → `pt`, `zh-cn` → `zh_CN`): como `=`/`IN` do GAQL diferenciam maiúsculas em string e os
  códigos reais são `pt`, `es`, `zh_CN`, a tool lê a tabela `language_constant` inteira (algumas
  dezenas de linhas, sem filtro de `targetable`, para distinguir "não existe" de "não é
  segmentável") e casa no cliente. `pt` e `PT` na mesma chamada viram um critério só.
- Por padrão adiciona; `replace: true` deixa exatamente a lista (remove + cria na mesma requisição,
  sem `partialFailure`). Idioma já aplicado não é recriado; sem mudança, nenhuma escrita. Relatório
  com antes/depois.

### `set_campaign_locations` — write
- Confere campanha (existe, não removida) e cada `geo_target_constant` (inexistente recusa tudo;
  `REMOVAL_PLANNED` gera aviso).
- Só grava a diferença: local já presente não é recriado; `replace: true` remove só os da mesma
  polaridade que saíram e mantém os que continuam (com o ajuste de lance — antes removia e recriava
  tudo, perdendo o `bid_modifier`). Remove + cria numa requisição atômica.
- Local já do outro lado (segmentado x excluído) é recusado antes da API (`CANNOT_TARGET_AND_EXCLUDE`).
- Demand Gen com `upgraded_targeting`: grava `AdGroupCriterion.location` nos grupos (ou `adGroupIds`).
  Em qualquer outra campanha `adGroupIds` é recusado antes de qualquer escrita (o local é da campanha
  inteira; gravar ignorando o filtro atingiria todos os grupos) — reenvie sem `adGroupIds`.
- Relatório com antes/depois e aviso de `PRESENCE_OR_INTEREST` apontando `set_geo_target_type`.

### `get_geo_performance` — read (item 60)
- `view`: `geographic` (default, `geographic_view`), `user_location` (`user_location_view`, com
  `targeted_location`), `targeted` (`location_view`: por local segmentado, com `criterion_id`,
  `bid_modifier` atual e a opção presença/interesse da campanha) e `distance` (`distance_view`; as
  faixas são cumulativas — a saída avisa para não somar).
- `granularity` (geographic/user_location): `country` (default), `region`, `state`, `province`,
  `metro`, `county`, `district`, `city`, `postal_code`, `most_specific` — via `segments.geo_target_*`
  (compatíveis com os dois recursos na v25).
- `basis` (geographic): `presence` / `interest` / `all` (`geographic_view.location_type`).
- `level`: `campaign` (default) ou `account`; `campaignId` filtra (em `geographic_view` e
  `distance_view` `campaign` é recurso de segmentação, então `campaign.id` vai também no SELECT).
- Nomes resolvidos em `geo_target_constant` (país e local); `location_id` alimenta
  `set_location_bid_adjustment` e `set_campaign_locations`. Métricas com CTR, CPC, CPA, ROAS.
  `format` json/table/csv. Entrada inválida (ID, limit, datas) recusada antes da query.

### `list_geo_targets` — read
- Novo `ids` para resolver IDs em nome, tipo, país, status (inclui `REMOVAL_PLANNED`) e pai; relata
  os não encontrados. `query` ficou opcional quando há `ids`.
- Validação: `countryCode` ISO de 2 letras, `targetType` só letras/espaços, `limit` 1–1000.
- `ids`: até 1000 por chamada (uma query `IN`). Mais que isso é recusado antes de consultar — antes a
  tool consultava só os 1000 primeiros e relatava o resto como "não encontrado". Divida em lotes.
- Com `countryCode`/`targetType`, um ID que existe mas é de outro país/tipo não volta; a saída diz
  "Não encontrados ou fora dos filtros countryCode/targetType" em vez de chamá-lo de inexistente.

---

## Fluxos

**Lead-gen local em Pesquisa**
```
create_campaign (SEARCH) → set_campaign_locations (cidade/estado)
→ set_geo_target_type positive=PRESENCE
→ anúncios e landing page em pt-BR (sem set_campaign_languages: idioma não vale mais em Pesquisa)
→ get_geo_performance granularity=city basis=presence → set_location_bid_adjustment / exclusões
```

**Clínica, concessionária, loja única:** `add_proximity_target` (endereço ou lat/lng + raio) →
`get_campaign_geo_targeting` (confere o ponto geocodificado) → `get_geo_performance view=targeted`.

**Rede de lojas / PMax:** conectar o Perfil da Empresa (conjunto `LOCATION_SYNC`) →
`add_location_group_target useCustomerLocations=true radius=5 radiusUnits=KILOMETERS` (ou
`assetSetIds` de um grupo de locais) → `get_geo_performance view=distance`.

**Limpeza de idioma legado em Pesquisa:** `get_campaign_geo_targeting` (aviso "Idiomas legados") →
`set_campaign_languages cleanup=true` (prévia) → `cleanup=true confirm=true`.

**Desfazer:** `get_campaign_geo_targeting` (criterion_id) → `remove_campaign_geo_targets confirm=true`.

---

## Parcial / fora deste lote — e por quê

- **`geoTargetType` nos `create_*` (item 40):** as tools de criação pertencem a outros lotes
  (`create_campaign` → bidding; `create_pmax_campaign` → pmax-assets; `create_demand_gen_campaign`
  e `create_display_campaign` → demand-gen; `create_shopping_campaign` → shopping;
  `create_video_campaign` → video-display). Aqui o caminho é `set_geo_target_type` logo depois da
  criação. Sugestão para a integração: aceitar `geoTargetTypeSetting.positiveGeoTargetType` no create
  (campo do próprio `Campaign`, sem passo extra).
- **`get_targeting_overview` / `remove_targeting_criteria`:** propostos no lote
  placements-brand-safety. Este lote entrega `get_campaign_geo_targeting` e
  `remove_campaign_geo_targets`, focados em geo/idioma (proteção contra "mundo todo", nomes
  resolvidos). Na integração as duas podem conviver ou ser consolidadas.
- **README:** a verificação independente pediu atualizar o fluxo de Pesquisa em `README.md:370`
  (termina em `→ set_campaign_languages`), mas README está fora da propriedade deste lote. Na
  consolidação: trocar por `→ set_campaign_locations → set_geo_target_type (PRESENCE para local)` e
  atualizar as linhas da tabela de `get_geo_performance`, `set_campaign_locations`,
  `set_campaign_languages` e `list_geo_targets`, além de listar as 5 tools novas. `src/prompts.ts` não
  menciona idioma (nada a mudar).
- **`create_pmax_campaign` grava `languageConstants/1014`:** continua válido para PMax (vale fora da
  Pesquisa). Não é deste lote.
- **`LocationGroupInfo.geo_target_constants` / `feed_item_sets`:** só funcionam com feeds de local,
  que o Google descontinuou em favor de assets; o proto proíbe misturar com asset sets. Não expostos.
- **`PROXIMITY` em PMax:** não listado na página de critérios de PMax; a tool não bloqueia, avisa.
- **Busca de local com alcance (`GeoTargetConstantService.SuggestGeoTargetConstants`):** o endpoint
  é `geoTargetConstants:suggest`, fora de `customers/{id}`, e exigiria método novo no client (lote
  account-auth). `list_geo_targets` continua via GAQL.
- **Data da mudança de idioma:** o Google diz "fim de setembro de 2026"; hoje é 23/09/2026, então as
  mensagens descrevem a mudança como entrando em vigor agora, não como confirmada.
- **Limites da tool (não do Google):** até 100 raios e 50 campanhas (`set_geo_target_type`) por
  chamada; `get_geo_performance` até 10000 linhas; `get_campaign_geo_targeting` até 1000 campanhas.
