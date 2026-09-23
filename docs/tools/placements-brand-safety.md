# Lote placements-brand-safety — Posicionamentos, exclusões e brand safety

Módulo: `src/tools/placements-brand-safety.ts` (catálogo em `placements-brand-safety.catalog.ts`).
Tool existente alterada: `add_placement` (em `src/tools.ts`, a lógica agora vem do módulo por import dinâmico).
Testes: `tests/placements-brand-safety.test.ts` (45 testes; toda GAQL passa pelo validador da v25).

Fontes checadas (v25): `common/criteria.proto` (PlacementInfo, YouTubeChannelInfo, YouTubeVideoInfo,
MobileApplicationInfo, MobileAppCategoryInfo, ContentLabelInfo, IpBlockInfo, PlacementListInfo, TopicInfo),
`resources/customer_negative_criterion.proto`, `resources/shared_set.proto`, `resources/shared_criterion.proto`,
`resources/customer.proto` (`video_brand_safety_suitability`), `enums/content_label_type.proto`,
`enums/brand_safety_suitability.proto`, `errors/criterion_error.proto`, `services/google_ads_service.proto`
(MutateOperation com `customer_operation`, `shared_set_operation`…), as páginas
`developers.google.com/google-ads/api/docs/targeting/{criteria,shared-sets,targeting-settings}`,
`performance-max/create-campaign-criteria`, as notas de versão (v24 tirou `Campaign.video_brand_safety_suitability`),
o Ads Developer Blog de ago/2026 (idioma em Pesquisa) e a Central de Ajuda (limites: answer/6372658; formatos de
posicionamento: answer/2454012; IP: answer/2456098).

## Resumo das tools

| Tool | Tipo | Para quê |
|---|---|---|
| `add_placement` (alterada) | escrita | Um posicionamento com o tipo certo: segmentar ou excluir no grupo; só excluir na campanha |
| `exclude_placements` | escrita | Excluir sites, canais/vídeos do YouTube, apps e categorias de app no grupo, campanha ou conta |
| `create_placement_exclusion_list` | escrita (atômica) | Criar lista de exclusão de posicionamentos e aplicar em campanhas/conta |
| `update_placement_exclusion_list` | escrita | Adicionar/remover itens e aplicar/desaplicar a lista em campanhas e na conta inteira |
| `attach_mcc_exclusion_list` | escrita | Aplicar a lista de uma MCC no nível de conta dos clientes |
| `list_placement_exclusion_lists` | leitura | Listas, tamanho, onde estão aplicadas e itens |
| `set_content_exclusions` | escrita | Rótulos de conteúdo (brand safety) na campanha ou na conta |
| `set_video_inventory_type` | escrita | Inventário de vídeo da conta: ampliado, padrão ou limitado |
| `add_ip_exclusions` | escrita | Excluir IPs/CIDR na campanha ou na conta |
| `list_account_exclusions` | leitura | Todas as exclusões da conta + inventário de vídeo atual |
| `remove_account_exclusions` | escrita | Remover exclusões da conta (inclusive lista de MCC) |
| `get_targeting_overview` | leitura | Toda a segmentação de uma campanha e dos grupos, com resource names |
| `remove_targeting_criteria` | escrita (atômica) | Desfazer critérios de campanha/grupo pelo resource name |
| `list_topics` | leitura | Buscar tópicos (topic_constant) |
| `list_mobile_app_categories` | leitura | Buscar categorias de app |
| `set_topic_targeting` | escrita | Segmentar tópicos no grupo; excluir no grupo ou na campanha |
| `set_optimized_targeting` | escrita | Ligar/desligar segmentação otimizada e expansão demográfica do grupo |

Nenhuma tool do lote é "encadeada": onde um passo depende do ID criado no anterior
(`create_placement_exclusion_list`), tudo vai numa requisição `googleAds:mutate` com ID temporário
(`customers/{id}/sharedSets/-1`), então `validateOnly` funciona em todas.

## Tipos de posicionamento e conversões (todas as tools de posicionamento)

`type`: `WEBSITE`, `YOUTUBE_CHANNEL`, `YOUTUBE_VIDEO`, `MOBILE_APP`, `MOBILE_APP_CATEGORY`
(critérios `placement`, `youtube_channel`, `youtube_video`, `mobile_application`, `mobile_app_category`).
Sem `type`, a tool detecta pelo valor:

- `youtube.com/channel/UC…` → `YOUTUBE_CHANNEL` (channel ID `UC` + 22 caracteres);
- `youtube.com/watch?v=…`, `youtu.be/…`, `youtube.com/shorts/…`, `/embed/`, `/live/` → `YOUTUBE_VIDEO` (11 caracteres);
- `play.google.com/store/apps/details?id=pkg` → app `2-pkg`; `apps.apple.com/…/id123` → app `1-123`;
  `mobileapp::1-…` / `mobileapp::2-…` (formato da interface) → app;
- o resto é site: sem espaço, um por item, até 250 caracteres e até 2 níveis de caminho;
  `adsenseformobileapps.com` é recusado (use o app).

URL do YouTube nunca vai como site (a API recusa com `CriterionError.YOUTUBE_URL_UNSUPPORTED`); mesmo com
`type: WEBSITE` a tool converte e avisa. **@handle, `/c/` e `/user/` são recusados**: a API do Google Ads não
resolve handle em channel ID; a mensagem ensina a copiar o ID (`UC…`) no YouTube. Erros da API conhecidos
(ID de canal/vídeo inválido, app inválido, domínio bloqueado, URL longa, positivo em Pesquisa, lista inexistente,
nome duplicado…) voltam com uma linha `Dica:` em PT-BR.

## Polaridade no nível de campanha (só exclusão)

Na **campanha**, posicionamento e tópico só existem como **exclusão** (`negative: true`); a segmentação positiva
de conteúdo é por **grupo de anúncios**. Fonte: guia de critérios da API, seção "Campaign criteria" —
`PlacementInfo`: "They can only be configured as negative"; `TopicInfo`, `YouTubeChannelInfo`,
`YouTubeVideoInfo` e `MobileAppCategoryInfo`: "Only negative criteria are supported at the campaign level". O
Google Ads Scripts (`AdsApp.CampaignDisplay`) diz o mesmo: "Only excluded placements / topics / YouTube channels
/ YouTube videos can be created at the campaign level". A tabela resumida atual do guia (✅/✅ em "Campaign, Ad
group") perdeu essas notas por nível — não vale como fonte da polaridade.

`add_placement` e `set_topic_targeting` recusam positivo na campanha **antes de qualquer chamada**, com a
orientação de usar `level AD_GROUP` + `adGroupId` para segmentar ou `negative: true` para excluir. Para
`MOBILE_APP` (`MobileApplicationInfo`) o guia não traz nota de polaridade por nível; a tool aplica a mesma regra
porque app é posicionamento (`mobileapp::` na interface e no Scripts, onde só há exclusão de posicionamento na
campanha) — escolha conservadora: o caminho positivo continua disponível no grupo.

## Detalhe por tool

### add_placement (escrita — alterada)
- Parâmetros: `adGroupId` ou `campaignId`, `level` (`AD_GROUP` padrão, `CAMPAIGN`), `type`, `value`
  (`url` continua aceito como nome antigo), `negative`.
- `level AD_GROUP` (padrão; ou sem `level` com `adGroupId`): segmentação (padrão) ou exclusão (`negative: true`).
- `level CAMPAIGN` (ou sem `level` e só com `campaignId`): **só exclusão** — sem `negative: true` a tool recusa
  antes de qualquer chamada (a API não aceita posicionamento positivo na campanha; veja "Polaridade no nível de
  campanha"). `{campaignId, value}` sozinho não vira mais "campanha + positivo".
- Positivo (no grupo) só em Display, Vídeo e Demand Gen (Pesquisa recusa
  `CANNOT_TARGET_PLACEMENTS_FOR_SEARCH_CAMPAIGNS`); Performance Max é recusada com o caminho certo
  (`exclude_placements` level `ACCOUNT`).
- Lê o grupo/campanha (existe nesta conta, não removido) e os posicionamentos existentes: igual → nada é gravado;
  polaridade oposta → recusa e mostra o resource name para remover.
- Compatível com a chamada antiga `{customerId, adGroupId, url}`.

### exclude_placements (escrita)
- `level`: `AD_GROUP` (`adGroupId`), `CAMPAIGN` (`campaignId`), `ACCOUNT` (conta inteira — vale para todas as
  campanhas, inclusive PMax e a rede de parceiros de Pesquisa). `items`: `[{type, value}]` ou valores.
- Pula o que já está excluído, recusa item que está como segmentação positiva no mesmo nível, grava o resto com
  `partialFailure` e relata excluídos / já existentes / conflitos / erros por item.
- PMax no nível de campanha é recusado (a API só aceita AD_SCHEDULE, AGE_RANGE, BRAND, DEVICE, KEYWORD, LANGUAGE,
  LOCATION, LOCATION_GROUP e WEBPAGE em campanha PMax) com a orientação de usar `ACCOUNT`.
- Limites: 5.000 itens por chamada; 65.000 exclusões de posicionamento na conta (conferido antes de gravar).

### create_placement_exclusion_list (escrita, atômica)
- `name`, `items`, `attachCampaignIds?`, `attachToAccount?`. Cria o shared set `NEGATIVE_PLACEMENTS`, os
  `SharedCriterion`, os `CampaignSharedSet` e (conta) o `CustomerNegativeCriterion.placement_list` numa só
  requisição `googleAds:mutate` — ou cria tudo, ou nada.
- Confere antes: nome único entre as listas ativas, limite de 20 listas por conta (3 numa MCC), campanhas
  existentes. Numa MCC recusa `attachCampaignIds/attachToAccount` (lista de MCC só vai para clientes).

### update_placement_exclusion_list (escrita)
- `sharedSetId`, `addItems?`, `removeItems?`, `attachCampaignIds?`, `detachCampaignIds?`, `attachToAccount?`,
  `detachFromAccount?`, `confirm?`.
- Lê a lista (precisa ser `NEGATIVE_PLACEMENTS` e ativa) e os itens; não recria item existente; relata item a
  remover que não está na lista; não duplica campanha já aplicada. Remover itens, desaplicar campanhas ou
  `detachFromAccount` exige `confirm: true` (`validateOnly` dispensa).
- **Nível da conta** (o caminho que alcança PMax), para lista já existente — criada antes sem `attachToAccount` ou
  criada na interface: `attachToAccount: true` cria `customerNegativeCriteria` `{placementList: {sharedSet}}`;
  `detachFromAccount: true` remove esse critério. Antes lê os critérios `PLACEMENT_LIST` da conta: lista já
  aplicada não é duplicada, detach de lista que não está na conta é no-op (nada é gravado), e só o critério desta
  lista é removido (lista de MCC aplicada na conta nunca é tocada). O relatório traz `account.attached_before` /
  `attached_after`. `attachToAccount` e `detachFromAccount` juntos são recusados. Em MCC é recusado (lista de MCC
  vai para os clientes com `attach_mcc_exclusion_list`).
- Itens, vínculos e conta vão com `partialFailure` (`sharedCriteria`, `campaignSharedSets` e
  `customerNegativeCriteria`), relatório por item. Limite de 65.000 itens por lista (250.000 em MCC).

### attach_mcc_exclusion_list (escrita, várias contas)
- `managerCustomerId`, `sharedSetId`, `clientCustomerIds`, `confirm`.
- Confere: a conta é MCC, a lista é `NEGATIVE_PLACEMENTS` ativa na MCC, cada cliente está na hierarquia
  (`customer_client`), cada cliente passa na allowlist. Cliente que já recebe a lista é pulado; até 5 listas de
  MCC por cliente. Cada cliente é gravado separadamente (`customerNegativeCriteria:mutate` no cliente, com
  `placement_list.shared_set = customers/{MCC}/sharedSets/{id}`). Exige `confirm: true`.
- Para tirar de um cliente: `list_account_exclusions` no cliente → `remove_account_exclusions`.

### list_placement_exclusion_lists (leitura)
- Listas ativas com quantidade de itens, campanhas que usam, se estão na conta inteira e, com `includeItems` ou
  `sharedSetId`, os itens. Mostra também as listas de MCC aplicadas na conta. `format` json/table/csv.

### set_content_exclusions (escrita)
- `level` `CAMPAIGN|ACCOUNT`, `campaignId?`, `labels` (ContentLabelType v25, inclusive os `BRAND_SUITABILITY_*`:
  conteúdo para famílias/Made for Kids, jogos, saúde, notícias, política, religião), `mode` `ADD` (padrão) ou
  `REPLACE`, `confirm?`.
- Mostra antes/depois; sem mudança não grava; `REPLACE` que remove rótulo exige `confirm: true`.
  PMax só no nível `ACCOUNT`. Na campanha o critério vai com `negative: true`; na conta não existe esse campo.

### set_video_inventory_type (escrita)
- `suitability`: `EXPANDED_INVENTORY`, `STANDARD_INVENTORY`, `LIMITED_INVENTORY` (ou `EXPANDED/STANDARD/LIMITED`).
- Desde a v24 o ajuste é só na conta (`Customer.video_brand_safety_suitability`). Grava via `googleAds:mutate` com
  `customer_operation` e `updateMask: video_brand_safety_suitability` (assim o `validateOnly` funciona; o endpoint
  `customers/{id}:mutate` não passa pelo dry-run do client). Exige `confirm: true`; valor igual não é gravado.

### add_ip_exclusions (escrita)
- `level` `CAMPAIGN|ACCOUNT`, `campaignId?`, `ips`. Aceita IPv4/IPv6 individual e CIDR; `a.b.c.*` vira `a.b.c.0/24`.
- Limite de 500 IPs por campanha e 500 na conta, somando os existentes. IP já excluído é pulado.
- Na campanha, recusa Vídeo, Hotel, App (`MULTI_CHANNEL`), Performance Max e Display inteligente
  (Central de Ajuda) e orienta usar `ACCOUNT`.

### list_account_exclusions (leitura)
- Todas as `customer_negative_criterion` agrupadas por tipo (sites, YouTube, apps, categorias, rótulos, IPs,
  listas de posicionamento — nomeando as da conta e marcando as de MCC — e a lista de negativas da conta), com
  `criterion_id` para remoção, e o `video_brand_safety_suitability` atual. Filtro `type`; `format` json/table/csv.

### remove_account_exclusions (escrita)
- `criterionIds` ou `resourceNames` (`customers/{id}/customerNegativeCriteria/{id}`, só desta conta), `confirm`.
- Sem `confirm` mostra o que sairia. Remoção com `partialFailure` e relatório por item.

### get_targeting_overview (leitura)
- `campaignId`, `includeAdGroups?` (padrão true), `adGroupId?`, `format`.
- Campanha: canal, presença/interesse (`geo_target_type_setting`), redes, Observação×Segmentação
  (`targeting_setting.target_restrictions`), `use_audience_grouped`; critérios (exceto palavras-chave) agrupados
  por tipo com `negative`, `bid_modifier`, `display_name`, detalhe e `resource_name`; listas compartilhadas
  aplicadas; ajustes de lance ≠ 1; contagem das exclusões da conta. Grupos: segmentação otimizada, expansão
  demográfica, target restrictions e critérios (exceto KEYWORD e LISTING_GROUP).
- Em campanha de Pesquisa com critério de idioma, uma nota avisa que o Google não usa mais idioma em Pesquisa
  (set/2026) e que remover é só limpeza.

### remove_targeting_criteria (escrita, atômica)
- `resourceNames` (`…/campaignCriteria/{c}~{id}` ou `…/adGroupCriteria/{g}~{id}`), `confirm`.
- Recusa: outra conta, critério inexistente, palavra-chave (use `remove_keyword`/`remove_negative_keyword`),
  listing group de Shopping (use `set_shopping_product_groups` ou `exclude_products`; `set_listing_group_filter` é só de asset group PMax) e exclusão de conta (use `remove_account_exclusions`).
- Avisa quando a campanha fica sem local positivo (passa a valer para todos os países) ou sem idioma (exceto
  Pesquisa, onde idioma não é mais usado). Remove tudo numa requisição `googleAds:mutate` (tudo ou nada).

### list_topics / list_mobile_app_categories (leitura)
- Filtro por trecho do caminho/nome (em inglês), sem caixa e sem acento; `parentId` em `list_topics`.

### set_topic_targeting (escrita)
- `level` `AD_GROUP|CAMPAIGN`, `adGroupId`/`campaignId`, `topicIds`, `negative?` (padrão false).
- No grupo: segmentar (padrão) ou excluir. Na campanha: **só excluir** — `level CAMPAIGN` sem `negative: true` é
  recusado antes de qualquer chamada (`TopicInfo`: só negativo na campanha).
- Confere que os tópicos existem; pula o que já está com a mesma polaridade; recusa polaridade oposta.
  PMax recusada. `partialFailure`. Só acrescenta — para tirar, `remove_targeting_criteria`.

### set_optimized_targeting (escrita)
- `adGroupId`, `enabled?`, `excludeDemographicExpansion?`, `confirm?`. Display, Demand Gen e Vídeo.
- Ampliar o alcance (ligar a otimização, ou liberar a expansão demográfica com ela ligada) exige
  `confirm: true` — sem ele devolve antes/depois e não grava (acrescentado na revisão da integração).
- Antes/depois; `updateMask` só com as folhas que mudam (`optimized_targeting_enabled`,
  `exclude_demographic_expansion`); valor igual não é gravado; avisa que a expansão demográfica só vale com a
  otimização ligada.

## Fluxos

- **Tirar lixo de Display/PMax**: relatório de posicionamentos (lote reports) → `exclude_placements` level
  `ACCOUNT` (vale para PMax) ou `CAMPAIGN`/`AD_GROUP` para Display e Vídeo.
- **Lista de brand safety da agência**: `create_placement_exclusion_list` com `customerId` = MCC →
  `attach_mcc_exclusion_list` para os clientes → manutenção com `update_placement_exclusion_list` na MCC.
- **Lista por cliente**: `create_placement_exclusion_list` com `attachToAccount` e/ou `attachCampaignIds`.
  Lista que já existe (criada antes ou na interface): `update_placement_exclusion_list` com `attachToAccount: true`
  (conta inteira, inclusive PMax) e/ou `attachCampaignIds`; para tirar da conta, `detachFromAccount: true` +
  `confirm: true`.
- **Segmentar por posicionamento/tópico em Display/Vídeo**: `add_placement` / `set_topic_targeting` com
  `level AD_GROUP` (a campanha só aceita exclusão).
- **Brand safety de vídeo**: `set_video_inventory_type` + `set_content_exclusions` (ex.:
  `BRAND_SUITABILITY_CONTENT_FOR_FAMILIES` para sair de conteúdo infantil) + `exclude_placements` com
  `MOBILE_APP_CATEGORY` de jogos/infantil.
- **Lead-gen**: `add_ip_exclusions` level `ACCOUNT` (cobre PMax) ou `CAMPAIGN` em Pesquisa/Display.
- **Auditar e desfazer**: `get_targeting_overview` → `remove_targeting_criteria` com os `resource_name`.

## Limitações e o que ficou de fora

- **Positivo na campanha**: posicionamento (inclusive YouTube, app e categoria de app) e tópico positivos na
  campanha são recusados antes da API — a API só aceita exclusão nesse nível. Para `MOBILE_APP` a recusa é uma
  escolha conservadora (o guia não traz nota própria para `MobileApplicationInfo`); o grupo continua aceitando.

- **@handle do YouTube**: não há como converter em channel ID pela API do Google Ads (nem por outra API com o
  escopo OAuth deste servidor); a tool recusa e explica como pegar o `UC…`.
- **Valor do inventário de vídeo em `get_account_info`**: `get_account_info` pertence ao lote account-auth;
  o valor atual aparece em `list_account_exclusions` e na prévia de `set_video_inventory_type`. Para exibir em
  `get_account_info`, basta incluir `customer.video_brand_safety_suitability` na consulta de lá.
- **`update_ad_group` com segmentação otimizada**: `update_ad_group` pertence ao lote bidding; a função veio como
  a tool dedicada `set_optimized_targeting`.
- **Lista de MCC é só no nível de conta** (regra do Google): não há como aplicar lista de MCC em campanha.
- **PMax**: posicionamento, conteúdo, IP e tópico no nível de campanha são recusados antes da API (a lista
  oficial de critérios de campanha PMax não os inclui); o caminho é o nível de conta.
- **PARKED_DOMAIN**: continua no enum da v25, mas domínios estacionados deixaram de ser inventário da rede de
  parceiros de Pesquisa em 10/02/2026 (Central de Ajuda) — excluir não tem mais efeito prático.
- Os limites (65.000/250.000 itens, 20/3 listas, 5 listas de MCC por cliente, 500 IPs) vêm da Central de Ajuda e
  dos protos; se o Google mudar, a API passa a ser a fonte (os erros voltam mapeados).
