# Lote extensions — Extensões (assets vinculados), WhatsApp e formulário de lead

Módulo: `src/tools/extensions.ts` (catálogo em `src/tools/extensions.catalog.ts`).
Testes: `tests/extensions.test.ts` (client falso com GAQL validado contra os metadados reais
da v25, updateMask só com folhas, um teste de ponta a ponta com o `GoogleAdsClient` real e
fetch interceptado).

## Conceitos (API v25)

- **Vínculo** = onde o asset vale: `CustomerAsset` (conta inteira), `CampaignAsset`
  (campanha) ou `AdGroupAsset` (grupo). O mesmo asset (ex.: um sitelink) pode estar em
  vários vínculos.
- **Níveis aceitos por tipo** (tabela oficial em docs/assets/overview):
  sitelink, frase de destaque, snippet, chamada, preço, promoção, app, destaque de hotel e
  mensagem (WhatsApp): conta, campanha ou grupo. `LEAD_FORM`: só campanha.
  `BUSINESS_NAME` (asset TEXT) e `BUSINESS_LOGO` (asset IMAGE): conta ou campanha.
  `TEXT_DISCLAIMER` (novo na v25.1): o Google ainda não publicou os níveis — as tools
  deixam a API decidir e avisam para testar com `validateOnly: true`.
- **Herança**: o que está na conta vale nas campanhas (e o da campanha, nos grupos), a menos
  que a campanha/grupo exclua o tipo em `excluded_parent_asset_field_types`.
- **Automáticos**: assets criados pelo Google (origem `AUTOMATICALLY_CREATED`). A API só
  permite pausar/remover o vínculo e ler métricas; ligar/desligar o recurso automático da
  conta é só na interface.
- **Criação atômica**: toda criação manda asset + vínculo numa única chamada
  `googleAds:mutate`, com o asset em nome temporário `customers/{cid}/assets/-1`. Se o
  vínculo é recusado, o asset também não fica (antes sobrava asset órfão).

## Tools novas

### `get_extension_performance` — leitura (item 67)
Desempenho e status de veiculação por vínculo, mais totais por tipo.
- Parâmetros: `level` (account | campaign | ad_group | all, default all), `campaignId` **ou**
  `adGroupId` (escopo), `fieldTypes` (default: extensões + nome/logo/aviso legal, sem
  HEADLINE/DESCRIPTION/AD_IMAGE), `clickScope` (`asset_only` default | `all`), `source`,
  `includeRemoved`, `dateRange`/`days`, `format` json/table/csv.
- Por vínculo: impressões, cliques, CTR, custo, CPC, conversões, valor, CPA, status do
  vínculo, `primary_status` + motivos + detalhes (ex.: `ASSET_DISAPPROVED` com os motivos
  da avaliação), origem e `flags` (sem impressões, reprovado, LIMITED/NOT_ELIGIBLE, 1000+
  impressões sem clique no próprio asset).
- `clickScope=asset_only`: cliques/custo/conversões filtrados por
  `segments.asset_interaction_target.interaction_on_this_asset = TRUE` (a interação foi no
  próprio asset); impressões e `clicks_any_part_of_ad` vêm da consulta sem o segmento.
  `all`: interação em qualquer parte do anúncio servido junto.
- Totais por tipo: `asset_field_type_view` (agregado por tipo, inclui automáticos; não é a
  soma dos vínculos). `click_type` não é usado (saiu das views de asset na v24).
- Com `campaignId`/`adGroupId`, vínculos de conta (e de campanha, no escopo de grupo)
  aparecem com as métricas só daquela campanha/grupo (campaign/ad_group são recursos de
  segmentação de customer_asset/campaign_asset) — é a visão do que serviu ali.
- Inventário vem de uma consulta sem métricas: vínculo sem impressão aparece com zero.
- Consultas: por nível, inventário + métricas (+ só-no-asset); mais a view. `level=all` com
  asset_only = 10 consultas.

### `link_extension_assets` — escrita
Vincula assets **existentes** (IDs ou resource names, máx. 20) na conta, em campanhas
(`campaignIds`, máx. 50) ou grupos (`adGroupIds`, máx. 50), com o `fieldType` escolhido.
- Confere antes: nível permitido para o tipo; asset existe nesta conta, tem o tipo certo
  (ex.: BUSINESS_NAME exige TEXT) e não é automático; entidades existem e não estão
  removidas (qualquer falha bloqueia a chamada inteira).
- Vínculo já existente não é recriado; **pausado continua pausado**. Removido é recriado.
- Mensagem (WhatsApp): um asset por chamada e recusa se já houver outro ativo na entidade.
- Mais de 20 vínculos numa chamada exige `confirm: true`. Partial failure com relatório
  por item e erros explicados em PT-BR.

### `update_extension_link_status` — escrita
Pausa, reativa ou remove vínculos (conta/campanha/grupo), inclusive os automáticos.
- Entrada: `linkResourceNames` (de list_extensions/get_extension_performance), máx. 50;
  `status` ENABLED | PAUSED | REMOVED.
- Lê cada vínculo antes: inexistente/removido vira erro, já no status pedido não gera
  escrita. `REMOVED` exige `confirm: true` (usa a operação `remove`; é definitivo).
- Reativar (`ENABLED`) é explícito — é o propósito da tool.

### `update_extension_asset` — escrita
Edita o conteúdo de um asset: sitelink (texto, descrições, URL), frase de destaque, snippet
(cabeçalho, valores), chamada (número, país), promoção (alvo, % ou valor, cupom ou pedido
mínimo, ocasião, janela de resgate, idioma, URL), preço (qualificador, idioma, itens) e
mensagem WhatsApp (mensagem inicial, CTA, número). Também datas de veiculação
(`startDate`/`endDate`/`clearDates`) e horários (`adSchedule`/`clearAdSchedule`) em
sitelink, frase, promoção (datas + horários) e chamada (horários).
- `snippetHeader`: mesma validação de `create_structured_snippet` (texto exato de qualquer
  localidade da tabela oficial).
- Lê o asset; manda só as folhas que mudaram (`updateMask` sem mensagens com subcampos;
  para limpar cupom/pedido mínimo o campo é nomeado sem valor, o que a API permite); sem
  mudança, não grava. Parâmetro de outro tipo é recusado.
- Lista onde o asset está vinculado e avisa que a mudança vale em todos.
- Não edita assets automáticos (a API recusa) nem formulário de lead (ver pendências).

### `list_extension_exclusions` — leitura
Campanhas e grupos com `excluded_parent_asset_field_types` preenchido.

### `set_excluded_parent_extension_types` — escrita
`level` campaign | ad_group, `mode` add | remove | replace, `fieldTypes`. Lê a lista atual,
mostra antes/depois, não grava se nada muda; `replace` com lista vazia volta a herdar tudo.

### `create_brand_text_asset` — escrita
Cria o asset TEXT e vincula (atômico): `BUSINESS_NAME` (conta ou campanha) ou
`TEXT_DISCLAIMER`. Não recria se o mesmo texto já está vinculado; avisa se já há outro
ativo. Logotipo: `upload_image_asset` + `link_extension_assets` com `BUSINESS_LOGO`.

### `create_whatsapp_message_asset` — escrita
`BusinessMessageAsset` com `messageProvider=WHATSAPP`, `whatsappInfo {countryCode,
phoneNumber}`, `starterMessage` e `callToAction {callToActionSelection,
callToActionDescription}` (a doc exige CTA), vinculado na conta, campanha ou grupo.
- Regra do Google: só um recurso de mensagem ativo na conta; em campanha/grupo, um por
  provedor. A tool confere e recusa antes de gravar.
- **Allowlist**: o Google só libera pelo gerente de contas. Sem liberação a API recusa
  (`CUSTOMER_NOT_ON_ALLOWLIST_FOR_MESSAGE_ASSETS` / `..._WHATSAPP_MESSAGE_ASSETS`) e a tool
  devolve a explicação em PT-BR; nada fica gravado (operação atômica).

### `create_lead_form_asset` — escrita
`LeadFormAsset` + vínculo `LEAD_FORM` na campanha (atômico).
- Pré-requisito conferido antes: `customer.customer_agreement_setting.accepted_lead_form_terms`.
  É campo só de leitura — a API não aceita os termos; sem eles a tool para e explica.
- Validações: ao menos 1 campo, sem repetição; opções (2–12) só em pergunta pré-aprovada
  (tipos ≥ 1000 do enum); até 5 perguntas personalizadas (2–12 opções ou resposta livre);
  pré-aprovadas antigas não vão junto com personalizadas; webhook https com
  `webhookSecret` (google_secret) obrigatória; imagem de fundo IMAGE de exatamente
  1200x628; política de privacidade com URL.
- Avisa se a campanha não é Pesquisa/PMax ou já tem formulário ativo. A chave do webhook
  não volta na resposta.

### `list_lead_form_assets` — leitura
Formulários (textos, campos, perguntas, entrega por webhook com chave mascarada, política),
campanhas vinculadas com status/primary_status e se os termos foram aceitos.

### `list_lead_form_submissions` — leitura
`lead_form_submission_data`: data/hora, campanha, grupo, formulário, gclid, respostas dos
campos e das perguntas personalizadas. Filtros: período (submission_date_time), campanha,
grupo, formulário, `limit`. `redact: true` mascara as respostas e o gclid. json/table/csv
(no csv cada campo vira coluna `field_<TIPO>`). O Google guarda os leads por tempo limitado
(a ajuda fala em 60 dias).

## Tools existentes alteradas (movidas de `src/tools.ts` para o módulo)

| Tool | O que mudou |
|---|---|
| `list_extensions` | Lê conta, campanha e grupo (`level`; default pelo filtro, senão all); `adGroupId`; `fieldTypes` (default só extensões — sem HEADLINE/DESCRIPTION/AD_IMAGE que a v23 passou a devolver); `source`; `includeRemoved`; `limit` default 500; status, primary_status + motivos, origem, datas/horários, política e `link_resource_name`; json/table/csv. |
| `create_sitelink_extension` | `level`/`adGroupId`/conta; atômico; confere campanha/grupo; texto 1–25, descrições 1–35 sempre em par; `startDate`/`endDate`; `adSchedule`; duplicado conforme a regra abaixo (identidade = mesmo texto + URL → recusa). |
| `create_callout_extension` | Idem: nível, atômico, 1–25, datas, horários; duplicado pela regra abaixo (identidade = mesmo texto → recusa). |
| `create_structured_snippet` | Nível, atômico; cabeçalho = texto exato de **qualquer localidade da tabela oficial** (44 idiomas + tabela base em inglês); grafia errada sugere o oficial; 3–10 valores de 1–25 sem repetição; duplicado pela regra abaixo. |
| `create_call_extension` | Nível, atômico; país 2 letras; `callConversionReportingState` + `conversionActionId`; `adSchedule`; duplicado pela regra abaixo (identidade = mesmo número → recusa). |
| `create_price_extension` | Nível, atômico; `priceType` e `unit` validados contra o enum; `priceQualifier`; `languageCode`; moeda default = a da conta (antes fixa em BRL); 3–8 itens, 1–25, título ≠ descrição; duplicado pela regra abaixo (parecido = mesmo tipo → **cria e avisa**). |
| `create_promotion_extension` | Nível, atômico; **sem a janela de resgate de 90 dias inventada** (só se informada); `promotionCode` / `ordersOverAmount` (exclusivos); `upTo`; `startDate`/`endDate`/`adSchedule`; ocasião validada (NONE omitido); moeda da conta; duplicado pela regra abaixo (parecido = mesmo alvo → **cria e avisa**). |

### Duplicados na criação (regra única das `create_*`)

Antes de gravar, a tool lê os vínculos não removidos do mesmo tipo na entidade (conta,
campanha ou grupo) e compara o **conteúdo inteiro** do pedido com o de cada asset, campo a
campo (`assetContentFields` / `diffAssetContent`: ausente ≡ `UNSPECIFIED`, valores em micros
viram valor na moeda, percentual em %, telefone só dígitos, idioma sem diferença de
maiúsculas, horários como faixas ordenadas).

| Tipo | Campos comparados | Idêntico | Parecido (mesma identidade, conteúdo diferente) |
|---|---|---|---|
| Sitelink | texto, URL, descrições, datas, horários | não grava ("mesmo conteúdo pedido"; pausado continua pausado) | identidade = texto (sem maiúsculas) + URL → **recusa** (`isError`), lista `differs` e aponta `update_extension_asset` com o `assetId` |
| Frase de destaque | texto, datas, horários | não grava | identidade = texto (sem maiúsculas) → **recusa** e aponta a edição |
| Snippet | cabeçalho, valores (ordem e grafia) | não grava | identidade = cabeçalho + valores sem maiúsculas → **recusa** e aponta a edição |
| Chamada | país, número, horários e a conversão **se pedida** | não grava | identidade = número → **recusa**; se a diferença é a conversão de chamada (não editável em `update_extension_asset`), orienta remover o vínculo antigo e criar de novo |
| Preço | tipo, qualificador, idioma e, por item, título, descrição, valor, moeda, unidade, URL e URL mobile | não grava | identidade = mesmo tipo → **cria** e devolve `warnings` + `details.similar_existing` (asset, status do vínculo, `differs`) dizendo que o existente continua vinculado e como trocar em vez de somar |
| Promoção | alvo, % ou valor, "até", cupom / pedido mínimo / código de barras / QR, ocasião, idioma, janela de resgate, datas, horários, termos e URL | não grava | identidade = mesmo alvo → **cria** e avisa, como no preço (ex.: Black Friday ao lado da promoção permanente) |
| WhatsApp | provedor, país, número, mensagem inicial, CTA | não grava | qualquer outro ativo na entidade → recusa pela regra "um ativo", agora com `differs` e o caminho `update_extension_asset` |

Conversão de chamada não pedida fica fora da comparação porque a API preenche o padrão da
conta na leitura. Assets com campos que a tool não grava (URL mobile do preço, termos e código
de barras/QR da promoção) não passam por idênticos.

Horários (`adSchedule`): `[{dayOfWeek, startHour, startMinute?, endHour, endMinute?}]`,
minutos 0/15/30/45, até 6 faixas por dia e 42 no total, sem sobreposição (limites do proto).

## Fluxos

- **Podar sitelinks**: `get_extension_performance` (fieldTypes SITELINK) → escolher pelos
  `flags` e CTR no próprio asset → `update_extension_link_status` (PAUSED) → mais tarde
  `REMOVED` com `confirm: true`.
- **Sitelinks da conta com exceção**: criar com `level: "account"` →
  `set_excluded_parent_extension_types` na campanha que deve usar só os dela.
- **Trocar texto sem perder histórico do vínculo**: `update_extension_asset`.
- **Desligar automáticos numa campanha**: `list_extensions` com
  `source: AUTOMATICALLY_CREATED` → `update_extension_link_status` PAUSED/REMOVED.
- **Lead gen**: aceitar termos na interface → `create_lead_form_asset` (webhook para o CRM)
  → `list_lead_form_submissions` periodicamente.
- **WhatsApp**: `create_whatsapp_message_asset` (conta liberada) → `list_extensions`.

## Pendências e limites (honestos)

- **WhatsApp**: implementado por completo na API, mas a conta precisa estar na allowlist do
  Google. Não há como detectar a liberação antes de tentar; a recusa vem como erro
  explicado e nada é gravado. Facebook Messenger/Zalo (também no proto) não foram expostos
  — fora do escopo Brasil.
- **Formulário de lead — edição**: não há tool de update. O proto permite reordenar campos
  (não adicionar/remover) e mudar textos, mas a ajuda do Google avisa que a edição pode
  pausar as campanhas até nova aprovação; ficou para a interface. Pausar/remover o vínculo
  funciona via `update_extension_link_status`. `has_location_answer` e
  `custom_disclosure` (só allowlist) não foram expostos.
- **Aceite dos termos de lead form**: só na interface (campo output-only).
- **TEXT_DISCLAIMER**: o enum existe (v25.1) e a criação usa TextAsset, mas o Google não
  documenta níveis/limites; a API é quem valida.
- **Opt-in/out de automáticos**: só na interface (docs/assets/automated-assets).
- **Limites de caracteres** de nome da empresa, promoção, formulário: não estão no proto;
  a API valida e o erro volta explicado.
- `campaign_aggregate_asset_view` / `channel_aggregate_asset_view` não foram usados — a
  visão por vínculo + `asset_field_type_view` cobre a poda de extensões.

## Correções da revisão (branch `batch/extensions-fix`)

1. **Duplicado de preço/promoção comparava pouco** (média). `create_price_extension` olhava só
   tipo + título/descrição e `create_promotion_extension` só alvo + desconto + cupom; preços,
   moeda, URL, unidade, qualificador, idioma, pedido mínimo, ocasião, "até", datas e horários
   novos viravam "Nada a fazer: … mesmo conteúdo …" sem gravar — os preços antigos seguiam no ar
   e a promoção sazonal não era criada. Agora vale a regra de duplicados acima (conteúdo
   inteiro); parecido cria e avisa. A mensagem "mesmo conteúdo" também deixou de aparecer em
   sitelink/frase/snippet/chamada/WhatsApp quando só a identidade batia: nesses casos a tool
   recusa, mostra o que difere e aponta `update_extension_asset`. Para isso a leitura passou a
   trazer `call_asset.call_conversion_action` e os termos/código de barras/QR da promoção.
2. **Cabeçalho de snippet recusava valores oficiais** (baixa). A lista cobria só parte de pt/en/es
   ("Barrios" de es-419, "Neighbourhoods"/"Degree programmes" de en-GB/en-AU e "Featured Hotels"
   da tabela base ficavam de fora). Agora a lista é a tabela oficial inteira
   (`SNIPPET_HEADERS_BY_LOCALE`: base em inglês + 44 localidades, extraída de
   developers.google.com/google-ads/api/data/structured-snippet-headers em 2026-09-23), com
   comparação exata após trim/NFC, sugestão da grafia oficial quando só muda maiúscula/minúscula
   e o erro `INVALID_SNIPPETS_HEADER` da API explicado em PT-BR, caso o Google mude a tabela.
   A linha base diz "Services (Service catalog)": entram "Services" e "Service catalog".

Testes novos em `tests/extensions.test.ts` (seção "Revisão"), com mutation check: sem o valor
do item no conteúdo do preço, sem pedido mínimo/ocasião na promoção, tratando parecido como
igual, voltando o sitelink ao "mesmo conteúdo", comparando WhatsApp só pelo número, contando a
conversão não pedida na chamada, restringindo os cabeçalhos a pt-BR ou tirando o NFC — cada
quebra derruba ao menos um teste.

## Notas para integração

- As 7 tools existentes foram **removidas de `src/tools.ts`** e reimplementadas no módulo
  (ficou um comentário no lugar). Continuam classificadas nas listas do núcleo em
  `src/read-only.ts`; não estão no catálogo do módulo.
- As `create_*_extension`/`create_structured_snippet` gravam numa única chamada atômica e saíram de
  `CHAINED_WRITE_TOOLS` na integração: aceitam `validateOnly` por chamada, como as tools novas.
