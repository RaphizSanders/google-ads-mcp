# Lote rsa-ads — anúncios responsivos de Pesquisa, customizadores e auditoria de anúncios

Módulo: `src/tools/rsa-ads.ts` (`registerRsaAdsTools`) · catálogo: `src/tools/rsa-ads.catalog.ts` ·
testes: `tests/rsa-ads.test.ts`.

As 7 tools de anúncio que eram do núcleo (`create_ad`, `update_ad`, `update_ad_status`,
`delete_ad`, `get_ad_creatives`, `get_ad_performance`, `get_asset_performance`) passaram a ser
registradas no módulo. Em `src/tools.ts` cada bloco virou uma linha de comentário apontando para
cá; a classificação read/write delas continua em `src/read-only.ts` (não foi mexida). As 8 tools
novas estão no catálogo do lote (3 de leitura, 5 de escrita, nenhuma encadeada).

Toda tool confere a conta (`checkCustomerAccess`), valida IDs numéricos e enums no código antes
de montar GAQL ou payload, e as de escrita leem antes de gravar, mostram antes/depois, não enviam
nada quando nada muda e respeitam o dry-run/validateOnly (a resposta diz "DRY-RUN (validateOnly)").

---

## 1. Fixação (pin) de títulos e descrições — `create_ad` e `update_ad`

**Problema:** `update_ad` reenviava a lista de títulos só como texto e apagava todos os pins (marca,
aviso legal fixados em HEADLINE_1) numa edição de rotina; `create_ad` não tinha como fixar.

### `create_ad` (write)
Cria RSA **PAUSADO** num grupo de anúncios.
- `headlines` (3–15, até 30 caracteres) e `descriptions` (2–4, até 90): cada item é um texto ou
  `{ text, pin }`. Títulos aceitam `HEADLINE_1/2/3`; descrições `DESCRIPTION_1/2`
  (`AdTextAsset.pinned_field`, enum `ServedAssetFieldType`). Pin do tipo errado é recusado.
- A chave do pin pode ser `pin`, `pinnedField` ou `pinned_field` — as duas últimas são o formato que
  `list_ads`, `get_ad_creatives`, `get_asset_performance` e a API devolvem, então o item lido pode
  ser reenviado como está. Os três nomes estão no schema: antes o zod descartava
  `pinnedField`/`pinned_field` (chave que ele não conhece some antes do handler) e o RSA era criado
  sem o pin, sem aviso, enquanto a mesma lista enviada como string JSON mantinha o pin.
- Nada é descartado em silêncio: chave desconhecida no item (ex.: `position`) e dois nomes de pin com
  valores diferentes no mesmo item são recusados antes da API, na lista em array ou em string JSON.
  Chaves só de leitura que as leituras devolvem junto do texto (`approval_status`,
  `assetPerformanceLabel`/`policySummaryInfo`, output-only no `AdTextAsset`) são ignoradas.
  Vale igual para `update_ad` e para `rsa` do `migrate_call_only_ad`.
- `finalUrl` (http/https), `path1`/`path2` (até 15).
- Antes de gravar: confere que o grupo existe na conta, não está removido, é `SEARCH_STANDARD` e a
  campanha é `SEARCH`; confere os `{CUSTOMIZER.Nome:Padrão}` contra os atributos ativos da conta
  (sem padrão = aviso). `{KeyWord:...}`, `{LOCATION(City):...}` e `{COUNTDOWN(...)}` passam direto.
- Texto repetido e texto puro acima do limite são recusados antes da API; texto com `{...}` tem o
  tamanho medido pela API (o que conta é o texto servido).
- Avisos: mais de uma posição fixada, todos os títulos fixados, pin em HEADLINE_3/DESCRIPTION_2
  (posições que nem sempre aparecem — o Google manda texto obrigatório para H1, H2 ou D1).
- Retorna `ad_id` e o resource name. Erro da API vira "A API recusou o anúncio: … Nada foi criado."

### `update_ad` (write)
Lê o RSA (`ad_group_ad.ad.responsive_search_ad.headlines/descriptions`, que trazem o
`pinnedField` de cada texto) e só envia o que muda.
- `headlines` / `descriptions`: substituem a lista inteira. Item em texto **mantém o pin atual
  daquele texto**; `{ text, pin }` define; `pin: null` solta. `keepExistingPins: false` descarta os
  pins dos textos sem pin informado.
- `addHeadlines` / `removeHeadlines` / `addDescriptions` / `removeDescriptions`: mexem só nos
  textos citados (a API exige a lista completa, então a tool monta a lista a partir da atual,
  preservando os outros textos e pins). Não combinam com a lista completa do mesmo tipo.
- `setPins: [{ text, pin }]`: muda só a fixação de textos que já estão no anúncio. O pin é
  obrigatório em cada item (`null` solta; aceita também `pinnedField`/`pinned_field`): item sem pin é
  recusado — antes, enviado como string JSON, soltava o pin em silêncio.
- `finalUrl`, `path1`, `path2` (`""` limpa o path). `adGroupId` opcional confere o grupo.
- `updateMask` só com as folhas que mudaram (`responsive_search_ad.headlines`,
  `responsive_search_ad.descriptions`, `responsive_search_ad.path1/path2`, `final_urls`).
- Mesmo conjunto de (texto, pin) em outra ordem = nada muda = nenhuma escrita.
- Mostra antes/depois com `[PIN]`, avisa pins que saíram junto com textos removidos e confere
  customizadores só nos textos novos (referência antiga não trava a edição).
- Títulos/descrições/pins/paths só para RSA; `finalUrl` vale para qualquer tipo.

---

## 2. Relatório de assets — `get_asset_performance` (read)

**Problema:** o nível AD rotulava todo asset de RSA como `PENDING`, porque desde a v23 a API não
devolve `performance_label` para Pesquisa e Display (enum ganhou `NOT_APPLICABLE`). E a descrição
prometia anúncio responsivo de Display, que a visão não suporta.

- `level=AD` (default): `ad_group_ad_asset_view` — RSA, Demand Gen e App (o proto da v25 diz que
  a visão não suporta anúncio responsivo de Display; a descrição foi corrigida).
- Uma linha por asset **em cada anúncio**, com `campaign_id`, `ad_group_id`, `ad_id`, `ad_type`,
  `field_type`, `pinned_field`, `source` (ADVERTISER/AUTOMATICALLY_CREATED), aprovação quando não
  é APPROVED e `performance_label` **só quando a API devolve um rótulo real** (PENDING, LEARNING,
  LOW, GOOD, BEST — nunca inventado, nunca `NOT_APPLICABLE`).
- Métricas: impressões, cliques, CTR, conversões, taxa de conversão, valor, gasto, CPA, ROAS, e a
  comparação com a média do mesmo tipo de asset no anúncio: `ctr_index`, `conv_rate_index`
  (1 = média), `ctr_rank` (1/N = maior CTR), `share_of_impressions_pct` e `signal`
  ("acima da média" se CTR > 1,2× e conversão ≥ média; "abaixo da média" se CTR < 0,8× e
  conversão < 0,8× ou sem conversões no grupo; "poucos dados" abaixo de `minImpressions`, default 100).
- Por padrão só assets ativos no anúncio (`ad_group_ad_asset_view.enabled = TRUE`);
  `includeRemoved` inclui os que saíram. Filtros: `campaignId`, `adGroupId`, `adId`, `fieldType`.
- `groupBy=ASSET` soma o mesmo asset em todos os anúncios (sem IDs de anúncio, como era antes).
- Avisa quando o período começa antes de **2025-06-05** (o Google só tem estatística completa por
  asset de RSA a partir dessa data — Ajuda do Google Ads 9564897).
- `level=PMAX` continua igual (primary_status + métricas), agora com IDs validados.

---

## 3. Auditoria de anúncios — `list_ads` (nova, read) e IDs nas leituras antigas

### `list_ads` (read)
Auditoria de qualquer tipo: RSA, Display responsivo, Demand Gen (multi-asset, carrossel, vídeo,
produto), vídeo responsivo e só de chamada.
- Filtros: `campaignId`, `adGroupId`, `adType` (`ALL`, `RSA`, `RDA`, `DEMAND_GEN` = os 4 tipos,
  `DEMAND_GEN_MULTI_ASSET`, `DEMAND_GEN_CAROUSEL`, `DEMAND_GEN_VIDEO_RESPONSIVE`,
  `DEMAND_GEN_PRODUCT`, `VIDEO_RESPONSIVE`, `CALL_ONLY`), `adStrength` (lista, ex.
  `["POOR","AVERAGE"]` — no lugar do `minStrength` da proposta, cobre "abaixo de" e "acima de"),
  `onlyIssues`, `includePaused` (default true), `includeRemoved`, `limit` (default 100).
- Por anúncio: `ad_id`, `ad_group_id`, `campaign_id` (encadeiam com update_ad / update_ad_status /
  delete_ad), status, `primary_status` e motivos, aprovação, `review_status`, tópicos de política,
  `ad_strength`, `action_items`, URLs, contagem de assets por campo e o conteúdo: textos com
  `pinned_field` (e aprovação por texto quando não é APPROVED), imagens/logos/vídeos/cards/CTA
  resolvidos numa consulta a `asset` (nome, URL, dimensões, ID e título do YouTube).
- `issues` em PT-BR: reprovado, aprovado com restrições, área de interesse, em contestação,
  primary_status NOT_ELIGIBLE/LIMITED, força POOR/AVERAGE, sugestões pendentes, só de chamada.
  `onlyIssues` filtra no código (OR entre campos), por isso aí o LIMIT é aplicado depois.
- `includeTopCombinations` (+ `combinationsPerAd`, default 3, e período): combinações mais
  exibidas de cada RSA via `ad_group_ad_asset_combination_view` (só impressões — é a única métrica
  da visão), com o texto de cada posição.
- Só seleciona os campos de conteúdo dos tipos pedidos. `format` json/table/csv.

### `get_ad_creatives` (read) e `get_ad_performance` (read)
- Agora trazem `ad_group_id` e `campaign_id` (update_ad_status e delete_ad pedem o grupo),
  `ad_strength` e aprovação. `get_ad_creatives` mostra `pinned_field` por texto e paths;
  ambas ganharam filtro `adGroupId`, validação de IDs/limit e `format`.

### `update_ad_status` (write) e `delete_ad` (write)
- Leem o anúncio antes (tem que existir no grupo), não reenviam status igual / remoção repetida,
  recusam anúncio removido. `update_ad_status` avisa ao ativar anúncio reprovado.
- `delete_ad` exige `confirm: true` (antes de qualquer chamada), mostra o que sai (tipo, status,
  títulos com pins) e avisa quando o grupo fica sem anúncio ativo.

---

## 4. Customizadores de anúncio (novas)

Sintaxe no RSA: `{CUSTOMIZER.Nome:Padrão}`. O valor usado é o do nível mais específico
(palavra-chave > grupo > campanha > conta); sem valor, o padrão do texto.

### `list_customizers` (read)
Atributos (id, nome, tipo, status, sintaxe) e valores por nível (`customer_customizer`,
`campaign_customizer`, `ad_group_customizer`, `ad_group_criterion_customizer`). Filtros:
`attribute` (nome ou ID), `level`, `campaignId`, `adGroupId`, `includeRemoved`. Com `includeUsage`
(default) varre os RSAs não removidos: `used_by_ads`, `ads_using`, `ads_without_value` (RSAs que
usam o atributo sem valor na conta, na campanha nem no grupo — valores por palavra-chave do grupo
contam como cobertura, embora só valham para aquelas palavras), `unused_attributes` e
`broken_references` (texto que cita atributo inexistente). Resumo `enabled_attributes: N/40`.
- `level`, `campaignId` e `adGroupId` filtram só o que aparece em `values` (com `campaignId`/`adGroupId`
  o valor da conta sai da lista; com `adGroupId` o da campanha também). `ads_without_value` sempre
  usa os valores **ativos** de todos os níveis acima de cada anúncio, qualquer que seja o filtro —
  antes, `campaignId`, `adGroupId` ou `level` escondiam o valor da conta/campanha também da conta de
  cobertura e o anúncio aparecia como "cai no padrão" quando na verdade mostrava o valor herdado.
  Valor removido (visível com `includeRemoved`) não conta como cobertura. Com `includeUsage: false`
  só os níveis exibidos são consultados.

### `create_customizer_attribute` (write)
`name` (1–40, letras/números/_/espaço, sem começar com _ — pontuação quebra a sintaxe e a Ajuda do
Google desaconselha) e `type` (`TEXT`, `NUMBER`, `PRICE`, `PERCENT`). Mesmo nome e tipo já ativo =
nada é criado (devolve o existente); mesmo nome com outro tipo = recusado; 40 ativos = recusado
com orientação. REST: `customizerAttributes:mutate`.

### `set_customizer_value` (write)
`attribute` (nome ou ID), `level` (`CUSTOMER`, `CAMPAIGN`, `AD_GROUP`, `KEYWORD`), IDs do alvo
(`campaignId`; `adGroupId`; `adGroupId` + `criterionId`) e `value`.
- Valida o valor pelo tipo: PRICE com moeda colada no número, antes ou depois, sem espaço
  (`R$99,90`, `BRL99,90`, `99,90BRL`; `R$ 99,90` é recusado com a sugestão sem espaço — a doc da
  API diz que `$ 100` é inválido), PERCENT com `%`, NUMBER numérico, TEXT livre (aviso acima de 30
  caracteres, porque num título o anúncio cairia no padrão).
- Confere o alvo: campanha/grupo existem e não estão removidos; palavra-chave é `KEYWORD`, não
  negativa e não removida.
- Lê o valor atual do nível: igual = nenhuma escrita; sem valor = uma criação.
- **Troca de valor = remover o atual e criar o novo, em duas chamadas** (ver "Parcial" abaixo). Se a
  criação falhar, o valor antigo é recriado e a resposta diz se o rollback deu certo.
- REST (anotações `google.api.http` da v25, com as maiúsculas delas): `CustomerCustomizers:mutate`,
  `campaignCustomizers:mutate`, `adGroupCustomizers:mutate`, `AdGroupCriterionCustomizers:mutate`.
- validateOnly: sem valor atual, a criação é validada pela API; com valor atual, só a remoção é
  validada (a criação não pode ser validada enquanto o valor atual existe) e a resposta diz isso.

### `remove_customizer_value` (write)
Mesmos parâmetros de alvo + `confirm: true`. Sem valor atual = nenhuma escrita. Avisa que os
anúncios passam a usar o nível acima ou o padrão.

### `remove_customizer_attribute` (write)
`attribute` + `confirm: true`. Recusa se algum RSA não removido usa o atributo (lista os anúncios),
a menos que `force: true`. Atributo já removido = nenhuma escrita. Serve para liberar vaga no
limite de 40.

### Validação nos RSAs
`create_ad`, `update_ad` e `migrate_call_only_ad` conferem `{CUSTOMIZER.Nome}` contra os atributos
ativos (sem diferenciar maiúsculas) antes de gravar.

---

## 5. Anúncios só de chamada (item extra, novas)

Deprecação oficial: sem criação de `CallAdInfo` desde jan/2026; os existentes param de veicular em
**fevereiro de 2027**; a v23 removeu `CallAd`/`CallAdInfo` da API. O enum `AdType.CALL_AD` continua
na v25, então dá para inventariar, mas não ler telefone nem textos do anúncio antigo.

### `list_call_only_ads` (read)
Anúncios `CALL_AD` ativos (e pausados, default) com: IDs, status, primary_status, aprovação,
métricas no período (impressões, cliques, `phone_calls`, custo, conversões — em consulta separada
para anúncio sem impressão não sumir do inventário), RSAs ativos no grupo, cobertura de recurso de
chamada (do grupo, da campanha ou da conta, com telefone) e `migration_status` ("pronto" = RSA ativo
+ recurso de chamada; senão, o que falta). Mostra os dias até fev/2027.

### `migrate_call_only_ad` (write)
Tudo numa única gravação atômica (`googleAds:mutate` com ID temporário `assets/-1`), então o
validateOnly funciona e não há estado parcial:
1. recurso de chamada **no grupo** (`AdGroupAsset` com `field_type=CALL` — o `create_call_extension`
   existente só vincula na campanha): número novo (`phoneNumber` + `countryCode`, default BR) ou
   asset existente (`callAssetId`, conferido como tipo CALL). Telefone já vinculado ao grupo (mesmos
   dígitos) não é duplicado; vínculo pausado **não é reativado**.
2. RSA opcional (`rsa`: finalUrl, headlines/descriptions com pins, paths), PAUSADO por padrão ou
   `rsaStatus: ENABLED`.
3. `pauseCallOnlyAd` (exige `callOnlyAdId` e `confirm: true`): recusado se o grupo ficaria sem RSA
   ativo. Já pausado = nada enviado para ele.

---

## Fluxos

- **Editar copy sem perder pins:** `get_ad_creatives` (ou `list_ads`) → `update_ad` com
  `addHeadlines`/`removeHeadlines` ou a lista completa → conferir `changes` (antes/depois com [PIN]).
- **Trocar títulos fracos:** `get_asset_performance` (`adId`, `fieldType=HEADLINE`, olhar
  `signal`/`ctr_index`/`ctr_rank`) → `update_ad` com `removeHeadlines` + `addHeadlines`.
- **Auditoria semanal:** `list_ads onlyIssues=true` → corrigir (`update_ad`), pausar
  (`update_ad_status`) ou remover (`delete_ad confirm=true`) com os IDs devolvidos.
- **Preço/parcelas por categoria (e-commerce):** `create_customizer_attribute` (Preco PRICE,
  Parcelas TEXT) → `set_customizer_value` por grupo → RSA com `{CUSTOMIZER.Preco:ótimo preço}` →
  `list_customizers` para ver cobertura e referências quebradas.
- **Migração call-only:** `list_call_only_ads` → `migrate_call_only_ad` (telefone no grupo + RSA
  ENABLED + pausar o call-only, confirm) → `list_call_only_ads` de novo.

---

## Parcial / decisões e por quê

- **Troca de valor de customizador não é atômica.** A proposta pedia remove+create atômico. O
  proto da v25 (`errors/mutate_error.proto`) tem `MutateError.ID_EXISTS_IN_MULTIPLE_MUTATES` —
  "Cannot mutate the same resource twice in one request" —, e o resource name do valor é derivado
  do alvo + atributo (`campaignCustomizers/{campaign}~{attribute}`), então remover e recriar o mesmo
  recurso numa requisição deve ser recusado. A tool faz duas chamadas (remove → cria) com rollback
  (recria o valor antigo se a criação falhar) e diz no retorno se o rollback falhou. Não testado
  contra a API real (sem credenciais aqui).
- **Anúncio só de chamada:** telefone e textos do `CALL_AD` não podem ser lidos (a v23 removeu o
  conteúdo da API); a migração pede o número. A tool `create_call_extension` (núcleo, fora deste
  lote) continua vinculando só na campanha; a vinculação no grupo ficou dentro de
  `migrate_call_only_ad`.
- **PRICE com vírgula decimal (`R$99,90`)**: a doc da API só define moeda antes/depois e sem espaço;
  a Ajuda mostra exemplos com ponto. A tool aceita vírgula ou ponto; a palavra final é da API (use
  `validateOnly` para conferir).
- **`list_customizers.ads_without_value`** é aproximado para valores por palavra-chave (valem só
  quando aquela palavra-chave aciona o anúncio).
- **Visão de combinações** só existe para RSA e só tem impressões.
- Nada foi validado contra a API real; as queries foram validadas contra os metadados reais da v25
  (`tests/fixtures/google-ads-v25-fields.json`) e os payloads contra os protos oficiais da v25.

## Evidência consultada
- Protos v25: `common/ad_asset.proto` (AdTextAsset.pinned_field), `enums/served_asset_field_type.proto`,
  `common/ad_type_infos.proto` (RSA, RDA, Demand Gen, vídeo; sem CallAdInfo), `resources/ad.proto`,
  `resources/ad_group_ad.proto` (ad_strength, action_items, policy_summary, primary_status),
  `resources/ad_group_ad_asset_view.proto` (enabled, pinned_field, source; "não suporta RDA"),
  `resources/ad_group_ad_asset_combination_view.proto`, `common/customizer_value.proto`,
  `resources/{customizer_attribute,customer_customizer,campaign_customizer,ad_group_customizer,ad_group_criterion_customizer}.proto`,
  `services/*customizer*_service.proto` (rotas REST), `services/google_ads_service.proto`
  (MutateOperation), `services/ad_service.proto`, `errors/mutate_error.proto`, `enums/ad_type.proto`
  (CALL_AD), `common/asset_types.proto` (CallAsset), `resources/ad_group_asset.proto`.
- Docs: responsive-search-ads/overview (pinnedField), ads/mutate-ads (UpdateResponsiveSearchAd com
  pinned_field), ads/customize-responsive-search-ads (sintaxe, 40 atributos, regras de PRICE,
  customizadores embutidos), release-notes v23 (rótulo removido para Pesquisa/Display; CallAd
  removido), deprecations (call-only: jan/2026 e fev/2027), fields/v25/ad_group_ad_asset_combination_view.
- Ajuda do Google Ads: 7684791 (pins: texto obrigatório em H1, H2 ou D1), 9564897 (estatística por
  asset a partir de 05/06/2025), 10711524 (tipos de dados e nomes de atributos).
