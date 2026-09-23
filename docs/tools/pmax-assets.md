# Lote pmax-assets — Performance Max: criação e gestão de asset groups

Módulo: `src/tools/pmax-assets.ts` (`registerPmaxAssetsTools`). Catálogo: `src/tools/pmax-assets.catalog.ts`.
Testes: `tests/pmax-assets.test.ts` (50 testes; client falso com estado de conta e toda query validada contra os
metadados reais da v25; dois testes de ponta a ponta com o `GoogleAdsClient` real e `fetch` interceptado). Ver
"Cobertura e checagem por mutação" no fim.

As quatro tools do núcleo que este lote possui (`create_pmax_campaign`, `create_asset_group`,
`update_asset_group`, `list_asset_groups`) saíram de `src/tools.ts` e agora são registradas neste módulo, com o
mesmo nome. A classificação delas continua em `src/read-only.ts` (núcleo).

## Fontes conferidas (v25)

- performance-max/asset-requirements — mínimos e máximos por asset group, limites de caracteres, proporções.
- performance-max/asset-groups e performance-max/structure-requests — asset group e vínculos no mesmo
  `googleAds:mutate` atômico; todos os AssetOperation antes dos AssetGroupAssetOperation; a API confere os
  mínimos depois do último vínculo consecutivo; grupo de varejo só existe sem assets ou com o mínimo completo;
  atualização que deixa o grupo abaixo do mínimo é recusada.
- performance-max/create-campaign ("Brand guidelines") e performance-max/troubleshooting — exatamente 1
  BUSINESS_NAME e ≥1 LOGO na campanha (até 5 logos somando LOGO e LANDSCAPE_LOGO); varejo isento só se não
  houver AssetGroupAsset; `SHORT_DESCRIPTION_REQUIRED` = ao menos uma DESCRIPTION com até 60 caracteres;
  `BRAND_ASSETS_NOT_LINKED_AT_ASSET_GROUP_LEVEL` / `..._AT_CAMPAIGN_LEVEL`.
- performance-max/retail — `feed_label` opcional (sem ele, todos os feeds do Merchant Center).
- performance-max/optimizations — `asset_group.asset_coverage.ad_strength_action_items`.
- Protos: `resources/asset_group.proto` (final_mobile_urls, path1/path2, primary_status_reasons, AssetCoverage),
  `resources/asset_group_asset.proto`, `resources/campaign.proto` (brand_guidelines_enabled IMMUTABLE,
  BrandGuidelines), `resources/ad.proto` + `common/ad_type_infos.proto` (ResponsiveDisplayAdInfo e os 4
  formatos Demand Gen), `services/ad_service.proto` (update não suportado para TextAd, ExpandedDynamicSearchAd,
  GmailAd e ImageAd), `services/google_ads_service.proto` (MutateOperation), enums de field type, status,
  motivos e CTA; `errors/asset_group_error.proto`, `asset_link_error.proto`.

## Tools novas

### `list_asset_group_assets` — leitura
Assets vinculados a um asset group (`assetGroupId`) ou a todos os asset groups de uma campanha (`campaignId`).
Por asset group: `requirements` (contagem por tipo contra mínimo/máximo; com diretrizes de marca, nome da
empresa e logos são contados na campanha), `short_description_ok`, `coverage_actions` (ex.: "adicionar 3
HEADLINE", "adicionar 1 YOUTUBE_VIDEO (vertical 9:16)"), ad strength, primary status com motivos em PT-BR e os
assets por tipo de campo (texto, dimensões, vídeo, CTA, status do vínculo, origem, primary status e motivos,
aprovação/revisão e tópicos de política). Filtros: `fieldTypes`, `includeRemoved`. `format` json/table/csv
(table/csv = uma linha por vínculo).
Limite: vínculos criados automaticamente pelo Google aparecem, mas não contam para o mínimo.

### `update_asset_group_assets` — escrita
Adiciona, remove ou troca assets de asset groups existentes num único `googleAds:mutate` atômico:
AssetOperations (textos e CTA novos) → vínculos novos → remoções, tudo consecutivo.
- `assetGroupIds` (1-20; vários = mesma mudança em todos, tudo ou nada), `add: [{fieldType, asset | text |
  callToAction}]`, `remove: [{fieldType, asset}]`, `confirm`.
- Remoção ou mais de um asset group exigem `confirm: true`; sem ele devolve o plano e não grava.
  Com `validateOnly` valida sem pedir confirm.
- Lê os grupos e os vínculos antes; pula o que já está vinculado (inclusive texto igual) e remoção de vínculo
  inexistente; sem nada a fazer, não envia escrita.
- Recusa antes de enviar: passar do máximo por tipo; remoção que deixa o tipo abaixo do mínimo (trocar = add +
  remove juntos); sair a única descrição com até 60 caracteres; nome/logo no asset group quando a campanha tem
  diretrizes de marca; grupo de varejo sem assets recebendo menos que o mínimo completo; varejo com diretrizes de
  marca cuja campanha ainda não tem nome/logo (a API exige a marca na campanha no mesmo pedido).
- Avisos (não bloqueiam): tipo que já estava abaixo do mínimo; remoção de vínculo criado automaticamente.

### `update_display_ad` — escrita
Edita anúncio display responsivo (`RESPONSIVE_DISPLAY_AD`) via AdService (`ads:mutate`) com updateMask aninhado
(`responsive_display_ad.marketing_images`, `responsive_display_ad.long_headline.text`...).
- Listas por `addAssets`/`removeAssets` `[{field, asset}]` sobre o estado atual: MARKETING_IMAGES (1.91:1),
  SQUARE_MARKETING_IMAGES (1:1) — 1+ cada, até 15 somadas; LOGO_IMAGES (4:1) e SQUARE_LOGO_IMAGES (1:1) — até 5
  somados; YOUTUBE_VIDEOS (até 5).
- Textos substituem: `headlines` (1-5, 30), `longHeadline` (90), `descriptions` (1-5, 90), `businessName` (25),
  `callToActionText` (30), `mainColor`/`accentColor` (hex, juntas), `allowFlexibleColor` (true se não houver cores).
- Confere existência, tipo e proporção de cada asset novo; mostra antes/depois; sem mudança, não grava.
- Recusa ImageAd/TextAd e outros tipos (o AdService não edita; RSA é `update_ad`).

### `update_demand_gen_ad` — escrita
Mesmo fluxo para os quatro formatos Demand Gen:
- multi-asset: MARKETING (1.91:1), SQUARE (1:1), PORTRAIT (4:5), TALL_PORTRAIT (9:16) — até 20 somadas e ao
  menos uma paisagem ou quadrada; LOGO_IMAGES 1:1 (1-5); CLASSIC_DISPLAY_IMAGES; `headlines`, `descriptions`,
  `businessName`, `callToActionText`;
- vídeo: VIDEOS (1+), LOGO_IMAGES 1:1 (1+), COMPANION_BANNERS (1); `headlines`, `longHeadlines`, `descriptions`,
  `businessName` (AdTextAsset → `business_name.text`), `breadcrumb1/2`;
- carrossel: CAROUSEL_CARDS (2-10); `headline`, `description` (`headline.text`...), `businessName`,
  `callToActionText`, `logoImageAsset` (`logo_image.asset`);
- produto: `headline`, `description`, `businessName`, `breadcrumb1/2`, `logoImageAsset`.
Campo que não existe no formato do anúncio é recusado antes de enviar. Os limites de caracteres só são
conferidos onde o proto documenta (multi-asset); nos demais a API valida.

### `unlink_campaign_image_assets` — escrita
Inverso de `link_campaign_image_assets`: remove vínculos AD_IMAGE (a imagem fica na biblioteca). Exige
`confirm: true` (sem ele mostra o plano). Lê os vínculos antes; vínculo inexistente é ignorado; nada a
remover = nenhuma escrita. `partialFailure` com relato por imagem; erro de transporte → confere a conta.

## Tools existentes alteradas

### `create_asset_group` — escrita (reescrita)
Um único `googleAds:mutate` atômico: AssetOperations (textos, nome da empresa, CTA com IDs temporários) →
CampaignAssetOperations (só quando necessário, ver abaixo) → AssetGroupOperation (PAUSADO) → vínculos
consecutivos → raiz do listing group (`UNIT_INCLUDED`, `SHOPPING`) em varejo.
- Lê a campanha: recusa se não for PERFORMANCE_MAX (Demand Gen usa grupos de anúncios) ou se estiver removida;
  lê `brand_guidelines_enabled` e `shopping_setting.merchant_id`; confere nome único e o limite de 100 grupos.
- Diretrizes de marca ligadas: nome/logos ficam na campanha — informar aqui é recusado. Exceção documentada:
  campanha de varejo sem nome/logo na campanha — ao receber assets, `businessName`/`logoAssets` são vinculados
  NA CAMPANHA no mesmo pedido.
- Diretrizes desligadas: exatamente 1 nome da empresa e 1-5 logos 1:1 no asset group; logos 4:1 opcionais.
- Varejo: sem nenhum asset (o Google gera do feed) ou com o conjunto mínimo completo.
- Novos parâmetros: `finalMobileUrl`, `path1`, `path2`, `portraitMarketingImageAssets`, `logoAssets`,
  `landscapeLogoAssets`, `businessName`/`businessNameAsset`, `callToAction`. Textos agora são opcionais (varejo).
- Valida antes de chamar a API: IDs, URLs, contagens máximas, caracteres, repetidos, conta dos assets; depois,
  com a campanha lida, mínimos (inclusive a descrição curta), tipo e proporção de cada asset.
- validateOnly: o pedido agora é um só (sem passos encadeados), então valida inteiro em dry-run — hoje isso
  vale no modo global `GOOGLE_ADS_DRY_RUN`. O `validateOnly: true` por chamada continua **recusado** pelo wrapper
  (nada é enviado) enquanto a tool estiver em `CHAINED_WRITE_TOOLS`; ver "Pendente para o integrador".
- Erro da API: dicas em PT-BR (NOT_ENOUGH_*, SHORT_DESCRIPTION_REQUIRED, BRAND_ASSETS_NOT_LINKED_*,
  ASPECT_RATIO_NOT_ALLOWED, DUPLICATE_NAME...) e conferência na conta: "nada gravado" só quando confirmado; erro
  de transporte com o grupo criado é relatado como tal.

### `create_pmax_campaign` — escrita (reescrita)
Um único `googleAds:mutate`: orçamento → campanha (`brandGuidelinesEnabled: true`) → assets de texto (títulos,
descrições, nome da empresa, CTA) → CampaignAssets de marca (BUSINESS_NAME e TODOS os logos: LOGO e
LANDSCAPE_LOGO) → asset group → vínculos → raiz do listing group (varejo) → sinal de público → local Brasil +
idioma português. Não há mais chamada separada de `mutateAssets` antes, nem listing group/sinal "não fatais"
depois: qualquer recusa desfaz tudo.
- Mínimos corrigidos: descrições 2-5 (antes dizia 1+), ao menos uma com até 60 caracteres, títulos 3-15.
- Marca: exatamente 1 nome (`businessName` texto novo ou `businessNameAsset`), ≥1 logo 1:1, até 5 logos somados.
  Varejo sem assets de grupo dispensa a marca (se informada, vale o conjunto completo).
- Novos parâmetros: `finalMobileUrl`, `path1`, `path2`, `portraitMarketingImageAssets`, `landscapeLogoAssets`,
  `callToAction`, `businessName`, `brandMainColor`/`brandAccentColor` (hex, juntas), `brandFontFamily` (lista
  fechada do Google).
- `feedLabel` agora é opcional e não tem mais padrão 'BR' (sem ele, todos os feeds); validado (até 20: A-Z, 0-9,
  `-`, `_`) e só com `merchantId`.
- `audienceResourceName` precisa ser `customers/{id}/audiences/{id}` desta conta (lista de remarketing é
  recusada com a orientação de virar público antes).
- Confere nome de campanha repetido e tipo/proporção de cada asset antes de gravar.
- validateOnly: mesma situação de `create_asset_group` — valida o pedido inteiro no modo `GOOGLE_ADS_DRY_RUN`; o
  `validateOnly: true` por chamada é recusado sem enviar nada até o integrador aplicar a mudança abaixo.
- Erro da API: dicas em PT-BR e conferência na conta pelo nome — "nada foi gravado" só quando a campanha não
  aparece; se aparecer, relata o ID; se a conferência falhar, diz que o resultado é INCERTO.
- Campanha e asset group nascem PAUSADOS; a resposta indica ativar o asset group e depois a campanha.

### `update_asset_group` — escrita
Novos: `finalMobileUrl`, `path1`, `path2` (`""` limpa). Lê o grupo antes, recusa removido/inexistente, envia
só os campos que mudam (updateMask de folhas), sem mudança não grava, mostra antes/depois, confere nome
repetido na campanha e `path2` sem `path1`. A instrução antiga de "usar run_gaql para mutar" saiu; a descrição
aponta para `update_asset_group_assets`.

### `list_asset_groups` — leitura
Acrescenta `primary_status_reasons` (com explicação em PT-BR), `coverage_actions`, `final_mobile_urls`,
`path1`/`path2`, diretrizes de marca e merchant da campanha; valida `campaignId`; `format` json/table/csv.

## Fluxos

- Novo grupo por tema/oferta: `get_image_assets` → `create_asset_group` (o grupo nasce PAUSADO; para só validar,
  rode com `GOOGLE_ADS_DRY_RUN` — o `validateOnly` por chamada depende da pendência abaixo) →
  `list_asset_group_assets` → `update_asset_group` (status ENABLED).
- Refresh criativo semanal: `list_asset_group_assets` (cobertura + origem + política) →
  `update_asset_group_assets` com add + remove juntos e `confirm: true` → `list_asset_group_assets`.
- Mesma troca em vários grupos: `update_asset_group_assets` com `assetGroupIds` e `confirm: true` (atômico).
- Imagens de Pesquisa: `link_campaign_image_assets` / `unlink_campaign_image_assets` / `list_campaign_image_assets`.

## Parcial / fora do escopo

- Trocar nome/logos da CAMPANHA (diretrizes de marca) e migrar campanhas antigas para diretrizes de marca
  (`EnablePMaxBrandGuidelines`) ficam com o lote pmax-signals (item 83). `create_asset_group` só vincula marca na
  campanha no caso documentado (varejo sem marca recebendo os primeiros assets).
- Configurações de automação de assets / expansão de URL em `create_pmax_campaign` (pmax-signals, item 59) não
  foram expostas aqui.
- `LANDSCAPE_LOGO` no asset group: a tabela da documentação diz até 20; foi seguida como está.
- A contagem de mínimos ignora vínculos criados automaticamente pelo Google (critério conservador; a API é a
  palavra final e recusa o pedido inteiro se discordar — nada é gravado nesse caso).
- `update_demand_gen_ad` não edita `call_to_actions` (vídeo) nem `call_to_action` (produto), que usam assets
  CALL_TO_ACTION próprios.
- validateOnly por chamada em `create_pmax_campaign` e `create_asset_group` (itens 16 e 17): **parcial**, ver
  abaixo.

## Pendente para o integrador

`create_pmax_campaign` e `create_asset_group` gravam agora num único `googleAds:mutate` atômico, então o motivo
de estarem em `CHAINED_WRITE_TOOLS` (segundo passo usando o ID do primeiro) deixou de existir. Mas esse conjunto
fica em `src/tool-kit.ts`, fora da posse deste lote, e o catálogo do módulo só consegue **acrescentar** nomes a
ele, não retirar. A primeira versão do lote editou `src/tool-kit.ts`; a edição foi desfeita. Enquanto isso:

- `validateOnly: true` por chamada nessas duas tools é recusado pelo wrapper, com a mensagem de "passos
  encadeados", e **nada é enviado** (nem leitura). É o comportamento seguro de antes.
- No modo global `GOOGLE_ADS_DRY_RUN` as duas validam o pedido atômico inteiro e respondem "DRY-RUN
  (validateOnly): a API validou o pedido inteiro — nada foi gravado".

Para ligar o validateOnly por chamada, o integrador tira as duas linhas de `CHAINED_WRITE_TOOLS` em
`src/tool-kit.ts` (atenção: o lote demand-gen mexe em entradas vizinhas do mesmo conjunto):

```diff
 export const CHAINED_WRITE_TOOLS = new Set([
-  "create_pmax_campaign",
-  "create_asset_group",
   "create_display_campaign",
```

Os testes já cobrem os dois estados: `assertPerCallValidateOnly` lê `CHAINED_WRITE_TOOLS` e exige a recusa sem
envio enquanto os nomes estiverem lá, e o pedido inteiro em dry-run (um `batchMutate` com `validateOnly`) depois
da mudança. A suíte do lote foi rodada com a mudança aplicada e continua verde.

## Cobertura e checagem por mutação

Cada guarda abaixo foi quebrada de propósito, um por vez, e ao menos um teste falhou; depois o código foi
restaurado (50/50 verdes):

- `update_asset_group` com `dryRun` fixo em false (diria "atualizado" em validateOnly);
- `unlink_campaign_image_assets` com `dryRun` fixo em false, e o `confirm` exigido também em dry-run;
- limite somado das listas (`total > pool.max`): MARKETING + SQUARE ≤ 15 e logos ≤ 5 no display responsivo;
  ≤ 20 imagens no Demand Gen multi-asset (limites conferidos em `common/ad_type_infos.proto` v25);
- `create_asset_group` em campanha REMOVIDA;
- `create_pmax_campaign`: dica PT-BR do erro da API, conferência pós-erro (campanha criada apesar do erro) e
  `dryRun` fixo em false;
- `create_asset_group`: `dryRun` fixo em false e conferência pós-erro;
- `update_asset_group`, `update_display_ad` e `update_demand_gen_ad`: dica PT-BR do erro da API e o texto
  "nada foi gravado" / "(validação, nada gravado)";
- `update_display_ad` com `dryRun` fixo em false.
