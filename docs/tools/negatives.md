# Lote negatives — palavras-chave negativas em todos os níveis

Item 27 do levantamento. Módulo `src/tools/negatives.ts`, catálogo `src/tools/negatives.catalog.ts`,
testes `tests/negatives.test.ts`.

As quatro tools que já existiam (`add_negative_keyword`, `list_negative_keywords`,
`remove_negative_keyword`, `create_shared_negative_list`) saíram de `src/tools.ts` e agora são
registradas pelo módulo. No `tools.ts` ficou só um comentário no lugar de cada uma. Elas continuam
classificadas no núcleo de `src/read-only.ts`, por isso não estão no catálogo do lote.

## Onde uma negativa pode morar (API v25)

| Nível | Recurso | Como a tool grava |
|---|---|---|
| Grupo de anúncios | `AdGroupCriterion` com `negative: true` e `keyword` | `adGroupCriteria:mutate` com partialFailure |
| Campanha (Pesquisa, Shopping, PMax) | `CampaignCriterion` com `negative: true` e `keyword` | `campaignCriteria:mutate` com partialFailure |
| Lista compartilhada | `SharedSet` do tipo `NEGATIVE_KEYWORDS` + `SharedCriterion`, ligada à campanha por `CampaignSharedSet` | `sharedCriteria:mutate`, `campaignSharedSets:mutate` |
| Conta inteira | `SharedSet` do tipo `ACCOUNT_LEVEL_NEGATIVE_KEYWORDS`, ligada à conta por `CustomerNegativeCriterion.negative_keyword_list` (uma por conta) | `sharedCriteria:mutate`, `customerNegativeCriteria:mutate` ou `googleAds:mutate` atômico |
| Lista do MCC | `SharedSet` que pertence ao MCC, ligada a campanhas ou à conta da cliente | igual às anteriores, com o resource name `customers/{mcc}/sharedSets/{id}` |

## Limites aplicados antes de chamar a API

| Limite | Valor | Fonte |
|---|---|---|
| Texto da palavra | 80 caracteres e 10 palavras | `KeywordInfo.text`, common/criteria.proto v25 |
| Negativas por campanha | 10.000 | Guia de critérios de campanha do PMax ("up to 10,000 negative keywords") e página de limites da conta na Ajuda do Google Ads |
| Display e Vídeo | só as primeiras 1.000 contam (a tool avisa, não bloqueia) | Página de limites da conta na Ajuda do Google Ads |
| Palavras por lista compartilhada | 5.000 | Página de limites da conta na Ajuda do Google Ads |
| Listas de negativas por conta | 20 | Página de limites da conta na Ajuda do Google Ads |
| Negativas de nível de conta | 1.000 | Artigo da Ajuda sobre negativas de nível de conta |
| Operações por mutate | 10.000 | Página de quotas da API (`TOO_MANY_MUTATE_OPERATIONS`) |

## Tools

### `list_negative_keywords` (leitura, alterada)
- Junta todas as origens, cada uma com `criterion_id` e `resource_name`: `CAMPAIGN`, `AD_GROUP`,
  `SHARED_LIST` (palavras das listas ligadas às campanhas) e `ACCOUNT` (a lista de nível de conta).
- `campaignId` mostra o que vale para a campanha, incluindo as listas ligadas a ela e a lista da conta.
- `adGroupId` descobre a campanha do grupo e mostra o que vale para o grupo: negativas do grupo, da
  campanha, das listas da campanha e da conta.
- `source` restringe a uma origem.
- `limit` é o máximo de linhas por origem. O padrão passou de 100 para 1000, com teto de 10000.
  Quando o limite é atingido, a resposta avisa.
- `format` aceita json, table ou csv. As observações vão num bloco separado, para não quebrar o CSV.
- Uma lista de outra conta (MCC) aparece como observação, com o `customerId` a usar. Os itens dessa
  lista só podem ser lidos na conta dona.
- Sem filtro, a resposta avisa quais listas não estão ligadas a nenhuma campanha.
- Criterions removidos, e os de campanhas ou grupos removidos, ficam de fora
  (`status != 'REMOVED'`). Na origem `AD_GROUP` o filtro vale para o criterion, o grupo e a
  campanha: um grupo continua `ENABLED` quando a campanha é removida, e sem o filtro de campanha as
  negativas dele apareceriam como se valessem.

### `add_negative_keyword` (escrita, alterada)
- `level` aceita `CAMPAIGN` ou `AD_GROUP`. Sem `level`, a tool usa `AD_GROUP` quando `adGroupId` vem e
  `CAMPAIGN` nos outros casos.
- Aceita um lote em `keywords: [{text, matchType}]`. A forma antiga, `keyword` + `matchType`,
  continua valendo.
- Para cada item a tool:
  - valida o texto: tira espaços extras, recusa `[ ]`, aspas e `-`/`+`, e aplica o limite de 80
    caracteres e 10 palavras;
  - remove duplicatas da própria entrada, sem diferenciar maiúsculas e minúsculas;
  - pula o que já existe no mesmo nível com o mesmo texto e a mesma correspondência;
  - grava com partialFailure, e cada item tem o próprio resultado.
- Antes de gravar, a tool confere:
  - se a campanha ou o grupo existe e não foi removido;
  - no nível de grupo, se o grupo é mesmo da `campaignId` informada;
  - no nível de campanha, se o total não passa de 10.000. Para Display e Vídeo acima de 1.000 ela só
    avisa.
- Quando a API recusa o pedido inteiro, a resposta diz "Nada foi adicionado". Cada código de erro
  vem com uma dica em PT-BR.
- Em dry-run ou validateOnly, a resposta usa a chave `validated`, não `added`.

### `remove_negative_keyword` (escrita, alterada)
- Passou a aceitar `level: AD_GROUP` com `adGroupId`. Nesse caso remove em `adGroupCriteria`.
- Continua identificando por `criterionIds` ou por `keywords [{text, matchType}]`, e continua
  informando o que não achou.
- Toda remoção exige `confirm: true` (na revisão da integração passou de "acima de 20" para sempre, como `remove_keyword` e as listas compartilhadas): tirar negativa libera tráfego. Sem ele, a tool devolve a prévia e não grava.
  O validateOnly dispensa o confirm, porque não grava nada.
- O formato de resposta (`removed`, `not_found`, `errors`) é o mesmo de antes, e os testes antigos
  continuam passando.

### `create_shared_negative_list` (escrita, reescrita)
- Antes eram três mutates separados, sem conferência. Agora é uma única operação atômica
  `googleAds:mutate` com ID temporário `customers/{cid}/sharedSets/-1`, na ordem:
  1. `sharedSetOperation`
  2. `sharedCriterionOperation`, uma por palavra
  3. `campaignSharedSetOperation`, uma por campanha

  Ou tudo é criado, ou nada.
- Antes de enviar, a tool confere:
  - o nome, de 1 a 255 bytes;
  - se já existe uma lista ativa com o mesmo nome (a API exige nome único por tipo);
  - o limite de 20 listas por conta;
  - se as campanhas existem e não foram removidas;
  - o limite de 5.000 palavras e as duplicatas.
- Se a API não devolve o `sharedSetResult`, a resposta é de erro e pede para conferir antes de
  repetir.

### `list_shared_sets` (leitura, nova)
- Lista as listas `NEGATIVE_KEYWORDS` e `ACCOUNT_LEVEL_NEGATIVE_KEYWORDS`. Com `type` dá para pedir
  uma delas, ou `ALL_NEGATIVES`, que inclui `NEGATIVE_PLACEMENTS`.
- Para cada lista: `member_count`, `reference_count`, capacidade, as campanhas ligadas e se está
  ligada à conta (`attached_to_account`).
- `mcc_lists` mostra as listas de outra conta (MCC) ligadas aqui.
- `includeRemoved` também mostra as listas removidas.
- Com o `customerId` do MCC, mostra as listas do próprio MCC.

### `get_shared_set_members` (leitura, nova)
- Mostra os itens de uma lista, com `criterion_id`, tipo, valor (texto, URL, canal ou vídeo do
  YouTube, app) e correspondência.
- Também traz as campanhas ligadas e, na lista de nível de conta, se ela está ligada à conta.
- `contains` filtra pelo texto. `limit` tem padrão 5000.
- Se a lista é de outra conta, a tool recusa e indica o `customerId` certo.

### `update_shared_set_members` (escrita, nova)
- `add`, `remove` e `removeCriterionIds` vão numa única chamada a `sharedCriteria:mutate` com
  partialFailure. As remoções vão primeiro, para liberar espaço.
- Pula o que já está na lista e informa o que não achou.
- Recusa a mesma palavra em `add` e em `remove` ao mesmo tempo.
- Só aceita listas de palavras-chave (`NEGATIVE_KEYWORDS` ou `ACCOUNT_LEVEL_NEGATIVE_KEYWORDS`) que
  estejam `ENABLED`. Respeita a capacidade: 5.000 palavras, ou 1.000 na lista de nível de conta.
- Exige `confirm: true` quando:
  - remove alguma palavra;
  - a lista é a de nível de conta;
  - a conta é um MCC (`customer.manager`), porque a lista pode valer para várias contas.

  Sem confirm, devolve a prévia. Incluir numa lista comum não precisa de confirm.
- Lista de MCC: rode com o `customerId` do MCC. A tool recusa se o resource name for de outra conta.

### `attach_shared_set` (escrita, nova)
- `campaignIds` liga uma lista `NEGATIVE_KEYWORDS` ou `NEGATIVE_PLACEMENTS` às campanhas por
  `CampaignSharedSet`. Isso vale também para Performance Max, suportado desde ago/2025.
  - Pula as campanhas que já têm a lista e relata as inexistentes ou removidas.
  - Grava com partialFailure, com resultado por campanha.
- `toAccount: true` torna uma lista `ACCOUNT_LEVEL_NEGATIVE_KEYWORDS` a lista de negativas da conta,
  por `CustomerNegativeCriterion`.
  - Exige `confirm`.
  - A conta aceita uma lista só. Se já houver outra ligada, a tool recusa e aponta o
    `detach_shared_set`.
- Para lista do MCC, passe `sharedSetId` como `customers/{mcc}/sharedSets/{id}`. A tool:
  1. confere se o MCC está na allowlist;
  2. lê a lista no MCC (tipo e status);
  3. confere, pelo `customer_client` do MCC, se a conta está sob ele. O proto avisa que o vínculo
     "existiria sem efeito" se o MCC não for gestor da conta.
- Recusa lista removida (a API devolveria `RESOURCE_NOT_FOUND`) e lista de tipo errado para o destino.

### `detach_shared_set` (escrita, nova)
- Tira a lista das campanhas indicadas em `campaignIds`, de todas as campanhas com
  `allCampaigns: true`, ou da conta com `fromAccount: true` (remove o `CustomerNegativeCriterion`).
- Sempre exige `confirm: true`, porque as campanhas voltam a receber o tráfego que a lista bloqueava.
  Sem confirm, devolve a prévia.
- A lista e as palavras continuam existindo.

### `add_account_negative_keywords` (escrita, nova)
- A tool escolhe uma de três situações, sempre com `confirm: true` (ou validateOnly):
  1. Já existe uma lista própria ligada à conta: grava só as palavras novas em `sharedCriteria`, com
     partialFailure.
  2. Não há lista ligada, mas existe uma lista `ACCOUNT_LEVEL_NEGATIVE_KEYWORDS` ativa sem vínculo:
     faz um `googleAds:mutate` atômico com as palavras + o vínculo à conta. Se houver mais de uma
     lista assim, a tool pede para escolher com `attach_shared_set`.
  3. Não há lista nenhuma: faz um `googleAds:mutate` atômico que cria a lista (ID temporário -1,
     nome de `listName`, padrão "Negativas da conta"), as palavras e o vínculo.
- Se a lista ligada é de um MCC, a tool recusa, porque mudar essa lista afeta todas as contas que a
  usam. Ela aponta `update_shared_set_members` com o `customerId` do MCC.
- Recusa também uma lista ligada que esteja REMOVED.
- Aplica o limite de 1.000 negativas por conta.

### `remove_account_negative_keywords` (escrita, nova)
- Remove itens da lista ligada à conta, por texto + correspondência ou por `criterionIds`.
- Exige `confirm`.
- Recusa quando não há lista ligada ou quando a lista é do MCC.

## Fluxos

- **Limpeza semanal de termos de pesquisa:**
  1. `get_search_terms`
  2. `add_negative_keyword` com o lote. A tool pula o que já existe.
  3. Negativas que servem para várias campanhas vão para `update_shared_set_members`.
- **Negativas da marca / conta toda:**
  1. `list_negative_keywords source=ACCOUNT`
  2. `add_account_negative_keywords` sem confirm, para ver a prévia
  3. a mesma chamada com `confirm: true`
- **Lista do MCC para várias clientes:**
  1. `list_shared_sets customerId={mcc}`
  2. `update_shared_set_members customerId={mcc}`
  3. `attach_shared_set customerId={cliente} sharedSetId=customers/{mcc}/sharedSets/{id}`
- **PMax:**
  - `add_negative_keyword level=CAMPAIGN`, até 10.000 por campanha;
  - listas por `attach_shared_set`;
  - a lista da conta já vale para o PMax.

## O que ficou de fora ou parcial, e por quê

- **validateOnly em `create_shared_negative_list`:** resolvido na integração — a tool é atômica e saiu
  de `CHAINED_WRITE_TOOLS`; `validateOnly: true` por chamada valida o pedido inteiro.
- **Criar a lista de nível de conta:** a documentação da API e o time da API (fórum, ago/2023,
  "v14 supports retrieving, creating and updating account-level negative keywords") indicam que é
  possível. Mesmo assim, o erro `CUSTOMER_CANNOT_CREATE_SHARED_SET_OF_THIS_TYPE` existe. Se a API
  recusar numa conta, a tool traduz o erro, diz para criar a lista pela interface e explica que a
  próxima chamada passa a usar a lista existente. Não houve teste contra a API real, porque não há
  credenciais neste ambiente.
- **Exclusões de idade e gênero no PMax:** aparecem no `merged_from` do item, mas não estão na
  proposta. São do lote `bid-modifiers` ("Demographic and device targeting: exclusions (including
  PMax)").
- **Itens de listas de placements e de marcas:** `update_shared_set_members` edita só palavras-chave.
  Placements são do lote `placements-brand-safety` e marcas do `retail-reporting`.
  `list_shared_sets` e `get_shared_set_members` leem listas de placements, e `attach_shared_set`
  aceita `NEGATIVE_PLACEMENTS` para campanhas, porque o mecanismo é o mesmo `CampaignSharedSet`.
- **Renomear ou apagar uma lista:** não fazia parte da proposta e não foi implementado.
- **Negativas de campanha Smart:** usam keyword themes, e este lote não trata.

## Evidências consultadas

- Protos v25 (`googleapis/google/ads/googleads/v25`):
  - recursos `shared_set`, `shared_criterion`, `campaign_shared_set`, `customer_negative_criterion`;
  - serviços `shared_set_service`, `shared_criterion_service`, `campaign_shared_set_service` e
    `customer_negative_criterion_service` (REST `.../{sharedSets,sharedCriteria,campaignSharedSets,customerNegativeCriteria}:mutate`,
    todos com `partial_failure`);
  - `google_ads_service`: os oneofs `sharedSetOperation`, `sharedCriterionOperation`,
    `campaignSharedSetOperation` e `customerNegativeCriterionOperation`, e os resultados `*Result`;
  - enums `shared_set_type`, `criterion_type` (`NEGATIVE_KEYWORD_LIST`) e `keyword_match_type`;
  - erros `shared_set_error`, `shared_criterion_error`, `campaign_shared_set_error` e
    `criterion_error` (`CANNOT_HAVE_MULTIPLE_NEGATIVE_KEYWORD_LIST_PER_ACCOUNT`, `KEYWORD_*`).
- GAQL: toda query validada contra `tests/fixtures/google-ads-v25-fields.json`. Pontos que
  orientaram o desenho:
  - em `FROM shared_set`, `campaign` é recurso de segmentação; por isso os vínculos são lidos em
    `FROM campaign_shared_set`;
  - `shared_set` é recurso atribuído de `shared_criterion` e de `customer_negative_criterion`.
- Documentação:
  - developers.google.com/google-ads/api/docs/targeting/shared-sets;
  - performance-max/create-campaign-criteria (10.000 negativas);
  - docs/mutating/best-practices (IDs temporários);
  - docs/best-practices/quotas (10.000 operações);
  - Ads Developer Blog de 04/08/2025 (listas de negativas em PMax via `CampaignSharedSetService`);
  - Ads Developer Blog de 16/05/2022 (lista removida → `RESOURCE_NOT_FOUND`).
- Artigos da Ajuda do Google Ads: 6372658 (limites), 11396330 (negativas de nível de conta, 1.000)
  e 15726455 (negativas no PMax).

## Testes

`tests/negatives.test.ts` tem 43 testes. O client falso valida toda query com `assertGaqlRules` e
grava cada escrita. Os testes cobrem:
- a allowlist de todas as 11 tools;
- o formato de cada payload e query;
- as validações feitas antes de qualquer chamada;
- os casos em que não há nada a mudar (no-op);
- os erros por item e do pedido inteiro, com as dicas;
- dry-run global e validateOnly;
- os gates de confirm, inclusive o de `detach_shared_set` com `fromAccount` (sem confirm é só
  prévia; validateOnly valida sem gravar);
- a guarda de `partialFailure`: fora do dry-run, uma operação sem `resourceName` na resposta vira
  erro ("a API não confirmou a operação") e nunca aparece como adicionada ou removida;
- o fluxo de MCC (allowlist, lista lida no MCC, hierarquia);
- dois fluxos com o `GoogleAdsClient` real e `fetch` interceptado, que conferem a URL REST e o corpo.

Como teste de mutação, 10 guardas foram quebradas uma de cada vez e os testes pegaram todas:
- confirm em listas, em lote de remoção e na lista da conta;
- dedupe;
- limite de 10.000;
- limite de 80 caracteres;
- hierarquia do MCC;
- allowlist da conta dona da lista;
- lista da conta do MCC;
- filtro `status != 'REMOVED'`.

Na revisão do lote, mais 3 guardas passaram pelo mesmo teste e hoje os testes pegam cada uma:
- confirm de `detach_shared_set` com `fromAccount`;
- a guarda "a API não confirmou a operação" do `partialFailure` (e a exceção dela no dry-run);
- o filtro `campaign.status != 'REMOVED'` na origem `AD_GROUP` de `list_negative_keywords`.
