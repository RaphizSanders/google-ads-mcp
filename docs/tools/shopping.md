# Lote shopping — Shopping, Merchant Center e grupos de produtos

Módulo: `src/tools/shopping.ts` (catálogo em `src/tools/shopping.catalog.ts`).
Testes: `tests/shopping.test.ts` (40 testes; toda GAQL validada contra os metadados da v25).

As três tools existentes do lote (`list_merchant_centers`, `create_shopping_campaign`,
`set_listing_group_filter`) saíram de `src/tools.ts` e agora são registradas pelo módulo,
porque dividem com as tools novas o mesmo motor de árvore de produtos. Em `src/tools.ts`
ficou só um comentário de uma linha no lugar de cada uma. A classificação delas continua em
`src/read-only.ts`, sem mudança.

## Tools

### Merchant Center

| Tool | Tipo | O que faz |
|---|---|---|
| `list_merchant_centers` | leitura (reescrita) | Lista os vínculos ativos (`product_link` do tipo MERCHANT_CENTER), os convites pendentes (`product_link_invitation`) e quais campanhas Shopping/PMax usam cada MC. Também aponta o MC usado por campanha que não tem vínculo direto na conta. |
| `respond_merchant_center_invitation` | escrita | Aceita ou recusa um convite PENDING_APPROVAL (`productLinkInvitations:update`). |
| `link_merchant_center` | escrita | Cria o vínculo direto (`productLinks:create`). |
| `unlink_merchant_center` | escrita | Remove o vínculo (`productLinks:remove`) e mostra antes quais campanhas deixam de receber produtos. |

- `list_merchant_centers {customerId, includeInvitationHistory?}`: a consulta antiga usava
  `merchant_center_link`, que não existe na v25. O erro era engolido e a tool dizia que os
  vínculos "não estavam disponíveis", então um MC vinculado mas ainda sem campanha não
  aparecia. Agora uma falha de leitura aparece em `read_errors`. Os nomes dos MCs não vêm
  pela API do Google Ads, só os IDs.
- `respond_merchant_center_invitation {invitationId, action: ACCEPT|REJECT, confirm}`:
  `invitationId` aceita o ID numérico ou o resource name, e um resource name de outra conta é
  recusado. O convite é lido antes: se já está no status pedido, nada é gravado. Se foi
  enviado por esta conta (REQUESTED), está encerrado ou não é de MC, a tool recusa. Exige
  `confirm: true`. **A recusa é definitiva**: depois dela, o MC precisa enviar outro convite.
  A API não tem `validate_only` neste método, então em validateOnly/dry-run nada é enviado e a
  resposta sai como erro, mostrando o corpo que seria enviado.
- `link_merchant_center {merchantId, confirm}`: se o MC já está vinculado, nada é gravado. Com
  convite pendente, a tool manda aceitar o convite em vez de criar outro vínculo. Exige
  `confirm: true`. Só funciona se o usuário do OAuth for administrador nas duas contas: a
  resposta CREATION_NOT_PERMITTED é traduzida com o caminho alternativo (solicitação pelo MC +
  `respond_merchant_center_invitation`). O método `CreateProductLink` não tem `validate_only`,
  então em dry-run nada é enviado.
- `unlink_merchant_center {productLinkId | merchantId, confirm}`: exige `confirm: true`. Em
  validateOnly/dry-run a API valida a remoção de verdade (`RemoveProductLinkRequest.validate_only`)
  sem remover nada. Vínculos criados pelo Business Manager não podem ser alterados pela API
  (INVALID_OPERATION, traduzido).

### Shopping padrão

| Tool | Tipo | O que faz |
|---|---|---|
| `create_shopping_campaign` | escrita (reescrita) | Cria orçamento + campanha (e, se pedido, grupo + anúncio de produto + raiz) num único `googleAds:mutate`. |
| `create_shopping_product_ad` | escrita | Cria o `shopping_product_ad` de um grupo SHOPPING_PRODUCT_ADS. |
| `set_shopping_product_groups` | escrita | Define a árvore de grupos de produtos (`ad_group_criterion.listing_group`) com lance por grupo e exclusões. |
| `get_product_group_performance` | leitura | Métricas por grupo de produtos (`product_group_view`), cada grupo identificado pelo caminho. |

- `create_shopping_campaign`:
  - `feedLabel` deixou de ser forçado para `"BR"`. Sem ele, a campanha usa todos os feeds do
    MC. O rótulo do feed não define país: a segmentação geográfica é configurada à parte.
  - Quando `feedLabel` é informado, ele é normalizado para maiúsculas e validado pelo formato
    (até 20 caracteres: A-Z, 0-9, `-`, `_`). Depois é comparado com `shopping_product.feed_label`
    numa amostra de até 10.000 produtos do MC, buscada primeiro por `merchant_center_id` e, se
    não vier nada, por `multi_client_account_id`. Se a amostra está completa e o rótulo não
    aparece, a campanha não é criada. Se a amostra foi cortada, o rótulo ausente gera só um
    aviso.
  - Estratégias:
    - `MAXIMIZE_CLICKS` (`target_spend`) é o padrão; `TARGET_SPEND` é sinônimo. Aceita
      `cpcBidCeilingMicros`.
    - `TARGET_ROAS` vai como `campaign.target_roas`, conforme a doc de Shopping padrão (antes
      ia como `maximizeConversionValue.targetRoas`).
    - `MANUAL_CPC`.
    - `MAXIMIZE_CONVERSION_VALUE` continua aceita quando pedida, com um aviso (ver "Parcial").
    - `MAXIMIZE_CONVERSIONS` é recusada antes da API: a tabela de estratégias da doc só a
      aceita como estratégia padrão em Pesquisa, Display, Vídeo e App.
  - Parâmetros novos: `enableLocal`, `withDefaultAdGroup`, `adGroupName` e
    `adGroupCpcBidMicros` (obrigatório em MANUAL_CPC).
  - Com `withDefaultAdGroup`, o mesmo mutate cria o grupo SHOPPING_PRODUCT_ADS, o anúncio de
    produto e o grupo de produtos raiz "todos os produtos". Grupo e anúncio nascem **ativos**
    dentro da campanha **pausada**: basta ativar a campanha para veicular.
  - O MC ausente de `product_link` gera só um aviso, porque o vínculo pode estar na conta de
    administrador. Se a API recusar, nada é criado (a operação é atômica).
  - A validação de entrada (prioridade 0–2, orçamento e IDs) roda antes de qualquer chamada.
- `create_shopping_product_ad {adGroupId, status?}`:
  - Confere que o grupo é SHOPPING_PRODUCT_ADS de uma campanha SHOPPING.
  - Se o grupo já tem anúncio de produto, nada é gravado, e um anúncio pausado não é
    reativado.
  - O anúncio nasce PAUSADO por padrão, como `create_ad` e o exemplo oficial.
  - Avisa quando o grupo ainda não tem árvore de produtos.
- `set_shopping_product_groups {adGroupId, units, defaultCpcBidMicros?, othersPolicy?, replace?}`:
  - A árvore inteira vai numa requisição, com IDs temporários (`adGroupCriteria/{ag}~-N`).
  - Em CPC manual, toda folha incluída precisa de lance. A ordem de preferência é:
    `cpcBidMicros` da folha → lance atual da mesma folha na conta → `defaultCpcBidMicros` → CPC
    do grupo. Se ainda faltar lance, a tool recusa e lista os caminhos sem lance.
  - Em estratégia automática, avisa que os lances de grupo de produtos são ignorados.
  - Resultado conforme o que mudou:
    - Só os lances mudaram: vira update de `cpc_bid_micros`, sem recriar nós.
    - A árvore é idêntica: nada é gravado.
    - A estrutura mudou: exige `replace: true` e mostra a árvore atual e a proposta. A
      substituição remove só a raiz antiga (a raiz leva a árvore inteira junto) e cria a nova na
      mesma requisição.
  - Aceita validateOnly.
- `get_product_group_performance {campaignId?, adGroupId?, days|dateRange, onlyUnits?, limit?, format}`:
  - Cada linha tem o caminho do grupo (ex.: `Marca=Nike › Condição=(outros)`), o tipo, o lance
    e as métricas `metricsView` (CTR, CPC, CPA, ROAS).
  - As linhas vêm ordenadas por custo.
  - Formatos: json, table e csv.

### Árvores de produtos (PMax e Shopping padrão)

| Tool | Tipo | O que faz |
|---|---|---|
| `set_listing_group_filter` | escrita (reescrita) | Árvore de filtros do asset group PMax, agora com vários níveis. |
| `get_listing_group_tree` | leitura | Lê a árvore atual (PMax ou Shopping), legível e em `units` prontas para regravar, opcionalmente com métricas. |
| `exclude_products` | escrita | Exclui itens por ID sem perder o resto da árvore (PMax ou Shopping padrão); recriar uma árvore subdividida exige `replace: true`. |

- **Formato `units`** (o mesmo nas duas tools de escrita): a entrada é a lista de folhas, cada
  uma descrita pelo caminho desde a raiz:
  `[{path: [{dimension, value?}], excluded?, cpcBidMicros?}]`.
  - `value` omitido = nó "outros" daquela dimensão.
  - `path: []` = raiz única (todos os produtos).
  - O nó "outros" que faltar é criado automaticamente. Com `othersPolicy` AUTO (padrão), ele
    fica excluído se o nível tem alguma inclusão, ou incluído se só há exclusões — mesma regra
    do formato antigo. INCLUDE e EXCLUDE forçam um dos dois.
  - `get_listing_group_tree` devolve as `units` da árvore atual. Para mudar a árvore: ler,
    editar as `units` e regravar.
- **Dimensões**:
  - PRODUCT_BRAND e PRODUCT_ITEM_ID;
  - PRODUCT_CHANNEL (ONLINE/LOCAL);
  - **PRODUCT_CONDITION** (NEW/USED/REFURBISHED; nova);
  - PRODUCT_CATEGORY_LEVEL1..5 (ID numérico de `product_category_constant`);
  - PRODUCT_TYPE_LEVEL1..5;
  - PRODUCT_CUSTOM_ATTRIBUTE0..4.
- **Regras da API checadas antes de qualquer chamada**, com o caminho de cada problema:
  - irmãos precisam usar a mesma dimensão;
  - valor duplicado entre irmãos (maiúsculas e minúsculas contam como iguais);
  - dimensão repetida no caminho;
  - nível N de categoria/tipo só refina um nó *com valor* do nível N-1, e os níveis vêm em
    ordem crescente;
  - subdivisão só com "outros" é recusada;
  - nó não pode ser folha e subdivisão ao mesmo tempo;
  - lance em PMax, lance em exclusão e raiz excluída são recusados;
  - `==` e `&+` não são aceitos no valor;
  - categoria precisa ser numérica, e condição/canal precisam estar no enum.
- `set_listing_group_filter {assetGroupId, units | filters, othersPolicy?, replace?, replaceOtherSources?}`:
  - Continua aceitando `filters` (um nível só, mesma semântica de antes).
  - Confere que o asset group existe, é de campanha PMax e que a campanha tem
    `shopping_setting.merchant_id`.
  - Resultado conforme a árvore atual:
    - Árvore idêntica: nada é gravado.
    - Raiz "todos os produtos": é trocada sem `replace`.
    - Árvore subdividida: só é substituída com `replace: true`. Antes, ela era apagada sem
      aviso. A substituição remove as folhas antes da raiz e recria tudo na mesma
      requisição (`googleAds:mutate`).
  - **Filtros de outra fonte (WEBPAGE, ou qualquer `listing_source` diferente de SHOPPING).**
    A API não aceita duas fontes no mesmo asset group
    (`AssetGroupListingGroupFilterError.MULTIPLE_LISTING_SOURCES`, proto v25: "All the filters
    under an AssetGroup should have the same listing source"). Por isso:
    - Sem `replaceOtherSources`, a tool recusa antes de qualquer escrita. A recusa lista cada
      filtro (fonte, tipo, condições como `URL contém "/promo"` e resource name) e mostra a
      árvore proposta.
    - Com `replaceOtherSources: true`, esses filtros são removidos na mesma requisição atômica
      que grava a árvore de produtos (remoções antes das criações). A resposta lista o que foi
      removido. Em validateOnly/dry-run, diz "que seriam removidos".
    - A versão antiga removia todos os nós do asset group sem aviso. A primeira versão deste
      lote dizia "preservar" os filtros WEBPAGE, mas montava uma requisição que a API recusa.
    - Se a API devolver MULTIPLE_LISTING_SOURCES mesmo assim, o erro vem traduzido, com o
      caminho para resolver.
- `get_listing_group_tree {assetGroupId | adGroupId | campaignId, includeMetrics?, days|dateRange}`:
  - Com `campaignId`, descobre se a campanha é PMax ou Shopping e lê todas as árvores dela.
  - Quando a API devolve o nó "outros" sem `case_value`, a dimensão vem dos irmãos.
  - Aponta árvores inválidas: várias raízes, órfãos, falta de "outros" ou dimensão não
    suportada pelo MCP.
  - As métricas vêm de `asset_group_product_group_view` (PMax) ou `product_group_view`
    (Shopping).
  - Filtros de outra fonte (WEBPAGE) aparecem em "Outros filtros (não-produto)", com as
    condições (`case_value.webpage.conditions`), e no JSON em `other_sources`. A saída avisa
    que uma árvore de produtos não convive com eles no mesmo asset group.
- `exclude_products {assetGroupId | adGroupId, itemIds, replace?}`, atômico:
  - Se a raiz já é dividida por ID do item, só acrescenta as exclusões e preserva os outros
    nós e o histórico deles. Um item que estava incluído é removido e recriado como excluído.
    Esse caso não precisa de `replace`.
  - Se a raiz é "todos os produtos" (um nó só, incluído), ela passa a ser dividida por ID do
    item sem `replace`. Só um nó é trocado.
  - Se a árvore é subdividida por outra dimensão (ex.: marca), excluir os itens exige remover
    a árvore inteira e recriá-la sob "outros" (ID do item). Os nós ganham IDs novos, e o
    histórico por nó (em `product_group_view` / `asset_group_product_group_view` e na
    interface) fica nos nós antigos. Por isso a tool:
    - sem `replace: true`, recusa sem escrever e mostra a árvore atual e a proposta (mesmo gate
      de `set_listing_group_filter` e `set_shopping_product_groups`);
    - com `replace: true`, remove e recria numa requisição atômica. No Shopping padrão, os
      lances atuais são copiados.
  - Raiz excluída (nenhum produto veicula) é no-op: os itens já estão excluídos.
  - Asset group com filtros de outra fonte (WEBPAGE): recusa sem escrever, lista os filtros e
    indica `set_listing_group_filter {replaceOtherSources: true}`.
  - Se a árvore usa ID do item abaixo da raiz, a tool recusa e manda editar a árvore
    completa.
  - Itens já excluídos são ignorados (se não sobra nada a fazer, nada é gravado).
  - Até 200 itens por chamada. Esse limite é do MCP, não da API, e existe porque a árvore
    ganha um nó por item.

## Fluxos

1. **Onboarding de e-commerce**:
   - `list_merchant_centers` → convite em `pending_invitations` →
     `respond_merchant_center_invitation {action: ACCEPT, confirm: true}`.
   - Como alternativa: `link_merchant_center`, se o usuário for admin nas duas contas.
2. **Shopping padrão que veicula**: `create_shopping_campaign {withDefaultAdGroup: true}`
   (budget, campanha, grupo, anúncio e raiz num mutate) → `set_shopping_product_groups`
   (dividir por marca/rótulo com lances) → `update_campaign status ENABLED`.
   - Com campanha já existente: `create_ad_group` → `create_shopping_product_ad` →
     `set_shopping_product_groups`.
3. **PMax por marca e depois por rótulo**:
   - `get_listing_group_tree {assetGroupId}` → editar as `units` →
     `set_listing_group_filter {units, replace: true}`.
   - O validateOnly confere a árvore na API antes de gravar.
4. **Tirar produtos sem estoque ou sem margem**: `exclude_products {assetGroupId, itemIds}`.
   - Se a árvore já é dividida por marca/rótulo, a primeira chamada devolve a prévia (atual ×
     proposta). Para aplicar, repita com `replace: true`.
5. **Asset group que hoje usa filtros de página (WEBPAGE) passa a filtrar produtos**:
   `get_listing_group_tree {assetGroupId}` (mostra os filtros WEBPAGE) →
   `set_listing_group_filter {units, replaceOtherSources: true}`.
6. **Otimização de lances no Shopping padrão**: `get_product_group_performance` →
   `set_shopping_product_groups` com os mesmos caminhos e lances novos. Só os lances são
   atualizados.

## Parcial e por quê

- ~~`create_pmax_campaign` forçando `feed_label: "BR"`~~ — resolvido pelo lote pmax-assets: `feedLabel`
  é opcional e, omitido, a campanha usa todos os feeds.
- **MAXIMIZE_CONVERSION_VALUE em Shopping padrão não foi validada contra uma conta real.** A
  doc da API de Shopping padrão lista só `manual_cpc`, `target_spend` e `target_roas`; o
  Google Ads Help lista Maximizar valor de conversão para Shopping. Ela continua disponível
  quando escolhida, com um aviso, e não é mais o padrão. O padrão agora é MAXIMIZE_CLICKS,
  documentada e sem exigir conversões. Como a criação é atômica, uma recusa da API não deixa
  nada órfão. Validar com `GOOGLE_ADS_DRY_RUN=true` numa conta real antes de recomendar.
- **Não há `validate_only` em `UpdateProductLinkInvitation` nem em `CreateProductLink`**
  (protos v25). Em validateOnly/dry-run essas duas tools não enviam nada e respondem com erro,
  mostrando o corpo que seria enviado. Elas não fingem que houve validação.
- **Vínculos do Business Manager** aparecem na leitura, mas a API não permite alterá-los
  (doc de Merchant Center). O erro é traduzido.
- **O nome do Merchant Center** não está disponível na API do Google Ads (`product_link` só
  traz o ID). Para ter o nome, seria preciso a Merchant API, com outro escopo OAuth.
- **Profundidade máxima da árvore**: a API recusa árvores fundas demais (TREE_TOO_DEEP), mas a
  doc não publica o número. O MCP não inventa um limite: a recusa é traduzida e nada é
  alterado.
- **Troca de WEBPAGE por SHOPPING numa requisição só não foi validada contra uma conta real.**
  O proto v25 garante que as duas fontes não podem coexistir no asset group, mas não diz se a
  checagem é feita no estado final da requisição ou operação por operação. O MCP manda as
  remoções dos filtros WEBPAGE antes das criações, no mesmo `googleAds:mutate` atômico. Se a
  API recusar, nada muda e o erro vem traduzido. Nesse caso, remova os filtros de página pela
  interface do Google Ads (nenhuma tool deste MCP remove só os filtros WEBPAGE) e grave a
  árvore depois. Validar com `validateOnly: true` numa conta real antes de usar em produção.
- **PRODUCT_CHANNEL_EXCLUSIVITY** (só Shopping padrão) não entra no formato `units`. Se
  aparece numa árvore existente, ela é lida e marcada como "dimensão não suportada", e
  qualquer regravação exige `replace: true`.

## Notas para integração

- `tests/gaql-sweep.test.ts`: `list_merchant_centers` saiu de `KNOWN_BROKEN`.
- `create_shopping_campaign` é atômica (um `googleAds:mutate`) e saiu de `CHAINED_WRITE_TOOLS` na
  integração: o `validateOnly` por chamada valida o pedido inteiro.
- Em `src/tools.ts`, os imports `LISTING_GROUP_DIMENSIONS` e `buildListingGroupCaseValue`
  ficaram sem uso depois da mudança. O bloco de imports não foi tocado para evitar conflito
  de merge. Os helpers equivalentes (com PRODUCT_CONDITION) estão em `src/tools/shopping.ts`.
- Sobreposição com o lote retail-reporting, que propõe `get_listing_group_performance` para
  PMax: aqui, `get_listing_group_tree {includeMetrics}` cobre métricas por nó de PMax e de
  Shopping, e `get_product_group_performance` é específica de Shopping padrão.
