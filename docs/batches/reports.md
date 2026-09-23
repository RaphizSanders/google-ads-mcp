# Lote reports — posicionamentos, landing pages, redes e visão do MCC

Módulo: `src/tools/reports.ts` · catálogo: `src/tools/reports.catalog.ts` · testes: `tests/reports.test.ts`.

As quatro tools do lote são de **leitura** (catálogo `read`): nenhuma grava na conta, nenhuma ganha
`validateOnly` e todas aparecem no modo read-only. Quando o relatório aponta uma ação, ele devolve os
dados no formato da tool de escrita que a executa — a decisão e a gravação ficam com ela.

Todas chamam `checkCustomerAccess` antes de qualquer consulta, validam IDs (`^\d+$`), números e datas
antes de chamar a API e traduzem para PT-BR os erros mais comuns destes relatórios (conta MCC,
conta desativada, sem permissão), mantendo a mensagem original da API junto.

Todo GAQL foi conferido contra a field reference v25 (`tests/fixtures/google-ads-v25-fields.json` e as
listas "selectable with" das páginas de cada recurso) e passa pelo `assertGaqlRules` nos testes.

---

## get_placement_report (leitura)

"Onde os anúncios apareceram" em Display, Vídeo, Demand Gen e PMax.

| view | recurso | o que mostra |
|---|---|---|
| `GROUP` (default) | `group_placement_view` | domínio, app ou canal do YouTube onde o anúncio rodou (UI: Conteúdo › Onde os anúncios foram exibidos) |
| `DETAIL` | `detail_placement_view` | URL específica ou vídeo do YouTube (UI: "Ver detalhes") |
| `MANAGED` | `managed_placement_view` + `ad_group_criterion` | posicionamentos que **você** segmentou, com desempenho |
| `PMAX` | `performance_max_placement_view` | onde a PMax apareceu — **só impressões** |

Parâmetros principais: `campaignId`, `adGroupId`, `placementType` (WEBSITE, MOBILE_APPLICATION,
MOBILE_APP_CATEGORY, YOUTUBE_VIDEO, YOUTUBE_CHANNEL, GOOGLE_PRODUCTS), `groupBy`
(PLACEMENT — soma entre campanhas e grupos —, CAMPAIGN ou AD_GROUP), `byNetwork`
(`segments.ad_network_type`), `minImpressions`, `minSpend`, `candidateMinSpend` (default 10),
`sortBy`, `limit` (default 100, máx. 1000), `format` json/table/csv.

Comportamento:
- As views vêm da API por grupo de anúncios × posicionamento; a tool agrega conforme `groupBy` e só
  depois aplica `minImpressions`/`minSpend` (um posicionamento com pouco tráfego em cada grupo, mas
  muito no total, não some). Teto de 20.000 linhas por consulta, avisado quando atingido.
- **Linha "Other" ("Total: Other")**: a API agrega os posicionamentos de baixo tráfego numa linha com
  `placement = "Other"`. Ela sai separada em `other_row`, não entra nos candidatos nem nos totais das
  linhas, e a resposta explica por que a soma das linhas fica abaixo do total da campanha.
- **PMax**: a API só expõe `metrics.impressions` nessa view. A tool recusa (antes de consultar)
  `adGroupId`, `minSpend`, `sortBy` diferente de impressions, `groupBy=AD_GROUP` e tipos que não
  existem em PMax (o proto lista só WEBSITE, MOBILE_APPLICATION e YOUTUBE_VIDEO). `campaign` é recurso
  de segmentação dessa view, então `campaign.id` vai sempre no SELECT.
- **MANAGED**: `placementType` vira `ad_group_criterion.type` (WEBSITE → PLACEMENT etc.;
  GOOGLE_PRODUCTS é recusado — não há critério desse tipo). Candidatos aqui recebem "revisar o
  critério" em vez de exclusão: é segmentação sua.

Candidatos a exclusão (heurísticos — a resposta diz isso):
- app, site ou YouTube com gasto ≥ `candidateMinSpend` e zero conversão (cita as view-through, se houver);
- CTR ≥ 3× a média do relatório, com ≥ 10 cliques e zero conversão (clique acidental / tráfego inválido);
- nome de canal, vídeo ou app com cara de conteúdo infantil (lista de termos PT/EN).

Cada candidato traz `exclusion: {type, value}` no formato de `exclude_placements` (lote
placements-brand-safety): `WEBSITE` com o site, `MOBILE_APP` com o app_id (`2-com.pacote` /
`1-123`), `YOUTUBE_CHANNEL` com o ID `UC…`, `YOUTUBE_VIDEO` com o ID de 11 caracteres — extraídos do
`placement`/`target_url` nos formatos do proto `PlacementTypeEnum`. Sem ID reconhecível, `exclusion` é
`null` e a ação sugerida é revisar manualmente (melhor não sugerir do que sugerir errado).
`exclusion_items` é a lista pronta, sem repetição e sem o que já está excluído.

Sites — o nível da exclusão segue o nível do relatório:
- `GROUP` e `PMAX`: o posicionamento é o domínio, e a exclusão é o domínio (`www.site.com.br`).
- `DETAIL`: o posicionamento é a **página** ("website URL" no proto de `detail_placement_view`), e a
  exclusão é a própria página, `domínio/caminho` — sem protocolo, query, fragmento e barra final
  (`www.uol.com.br/esporte/noticia-x.htm`). Uma página ruim nunca vira bloqueio do portal inteiro. O
  domínio sai à parte, em `domain_exclusion` + `domain_exclusion_warning` ("bloqueia o domínio
  INTEIRO…"), e **não** entra em `exclusion_items`: só vale quando o site todo é o problema (confira em
  `view=GROUP`). Se a URL tinha parâmetros (`?…`), `exclusion_note` avisa que a exclusão vale para o
  caminho sem eles.
- Limite da API para critério de posicionamento por URL (docs *Targeting › Criteria*: "Limits on URL
  length (250 chars) and depth (2 levels)"): página com mais de 2 níveis de caminho ou mais de 250
  caracteres sai com `exclusion: null`, ação "revisar manualmente" explicando o limite e o domínio só
  como alternativa em `domain_exclusion`. `adsenseformobileapps.com` (não aceito como site pela API)
  também sai sem exclusão, com a orientação de excluir o app.

Quando há candidatos, a tool lê as exclusões atuais (`customer_negative_criterion` e
`campaign_criterion` negativos das campanhas envolvidas) e marca `already_excluded` ("conta",
"campanha" ou "campanha (x de y)"). Regras para sites (comparação sem protocolo, `www`, fragmento e
barra final, em minúsculas):
- exclusão de **domínio** (sem caminho) cobre o domínio, os subdomínios e as páginas deles;
- exclusão de **página/seção** (com caminho) só cobre exatamente a mesma URL. Ela não bloqueia o resto
  do domínio: se a conta exclui só `uol.com.br/esporte`, o candidato `www.uol.com.br` (GROUP) continua
  "excluir" e entra em `exclusion_items`. Uma seção excluída também não é contada como cobrindo as
  páginas dentro dela (a tool não afirma cobertura que não conferiu — no pior caso sugere uma exclusão
  redundante, nunca esconde um site que ainda recebe anúncio). Exclusão com query só casa com a mesma
  query. Também informa em
`content_exclusions` se os rótulos `PARKED_DOMAIN` e `BRAND_SUITABILITY_CONTENT_FOR_FAMILIES` estão
excluídos na conta ou em quais campanhas, e sugere `set_content_exclusions` quando não estão. Falha
nessa leitura vira aviso; o relatório sai do mesmo jeito.

## get_landing_page_performance (leitura)

Desempenho por URL final definida pelo anunciante (`landing_page_view.unexpanded_final_url`): cliques,
gasto, conversões, taxa de conversão, CPA, ROAS, `speed_score` (1–10, velocidade após clique em anúncio
mobile), % de cliques mobile em página mobile-friendly e % de cliques AMP válidos.

Parâmetros: `campaignId`, `byCampaign` (linha por URL × campanha), `device`, `minClicks` (default 30),
`minSpeedScore` (default 5), `checkPolicy` (default true), `sortBy` (cost, clicks, conversions,
conv_rate, speed_score — a mais lenta primeiro), `limit` (default 50), `format`.

Alertas por URL: `speed_score` abaixo de `minSpeedScore`; taxa de conversão abaixo da metade da média
do relatório; cliques sem conversão (só quando a conta converte no período); menos de 80% dos cliques
mobile em página mobile-friendly; `DESTINATION_NOT_WORKING`.

Cruzamento com política: lê os anúncios DISAPPROVED / APPROVED_LIMITED / AREA_OF_INTEREST_ONLY
(`ad_group_ad.policy_summary`), procura o tópico `DESTINATION_NOT_WORKING` e casa as URLs finais e as
URLs da evidência (normalizadas: sem protocolo, `www`, query, fragmento e barra final) com as linhas.
A lista completa sai em `destination_not_working` (com device, código HTTP ou erro de DNS e última
checagem), com `in_report=false` para URL que não teve clique — anúncio reprovado não gera clique. O
detalhe de todas as políticas fica em `list_policy_issues` (lote diagnostics).

`campaign` e `segments.device` segmentam `landing_page_view`: quando filtrados, entram também no SELECT.
A URL expandida do AI Max (`expanded_landing_page_view`) fica de fora — ela já está em
`get_ai_max_report view=landing_pages`.

## get_network_breakdown (leitura)

Desempenho por rede (`segments.ad_network_type`): SEARCH (Google Search), SEARCH_PARTNERS, CONTENT
(Display), YOUTUBE, GOOGLE_TV, MIXED, GMAIL, DISCOVER, MAPS…, por campanha e no total da conta, com
a participação de cada rede no gasto e os toggles atuais (`campaign.network_settings`).

Parâmetros: `campaignId`, `channelType`, `level` (CAMPAIGN default, ou ACCOUNT só com o total),
`flagMinSpend` (default 50), `format`.

Em campanhas de Pesquisa, compara parceiros de pesquisa e expansão para Display com o Google Search
da própria campanha e alerta quando a rede gastou ≥ `flagMinSpend` e: não converteu (tendo o Search
convertido), teve CPA 50% acima, ou ROAS abaixo de 2/3 do Search. O alerta traz o comando certo:
`update_campaign networkSettings.targetSearchNetwork=false` (parceiros) ou
`targetContentNetwork=false` (Display) — ou avisa que o toggle já está desligado e o gasto é de
antes da mudança. PMax aparece dividida por rede só como informação (não há toggle de rede nela).
A consulta é sempre `FROM campaign` (o total da conta é a soma), evitando o filtro de campanha em
`FROM customer`, que a API recusa.

## get_mcc_performance_summary (leitura)

Visão consolidada do MCC: gasto, conversões, valor, ROAS e CPA de cada conta cliente no período, com
variação contra o período anterior de mesmo tamanho (`compareToPrevious`, default true).

A API não devolve métricas de MCC (`QueryError.REQUESTED_METRICS_FOR_MANAGER`: "issue separate
requests against each client account"). A tool lista as contas cliente ativas do MCC
(`customer_client`, todos os níveis, via `listChildAccounts`) e faz **uma** consulta por conta
(`FROM customer` com `segments.date` cobrindo os dois períodos), 5 em paralelo.

Parâmetros: `managerCustomerId` (default: MCC do login; se informado, precisa passar pela allowlist),
`customerIds` (subconjunto), `dateRange`/`days`, `includeZeroSpend`, `maxAccounts` (default 50, máx.
200), `sortBy` (spend, conversions, conversions_value, roas, cpa — maior CPA primeiro —, spend_change),
`format`.

Garantias:
- `customerIds` passa por `checkCustomerAccess` **antes** de qualquer chamada (nem lista o MCC): ID
  fora da allowlist recebe o mesmo `Access denied: customer … not in allowed list.` das tools por conta,
  exista ele sob o MCC ou não — a resposta não revela quais contas são clientes do MCC. "Não
  encontradas sob o MCC" só aparece para IDs liberados;
- sem `customerIds`, cada conta cliente passa por `checkCustomerAccess`: fora da allowlist não é
  consultada nem aparece. No modo hospedado nem a contagem das contas de fora sai (ela diria quantos
  outros clientes o MCC tem — `list_accounts` também filtra em silêncio); no modo local (stdio) a
  contagem "N fora da allowlist" continua, para diagnóstico. Hospedado sem allowlist não consulta nada;
- totais **por moeda** (`totals_by_currency`), nunca somados entre moedas; contas sem gasto entram no
  total (podem ter conversão importada) mas só são listadas com `includeZeroSpend`;
- erro numa conta (desativada, sem permissão) vai para `errors` com a explicação em PT-BR e não
  derruba as demais;
- alertas: parou de gastar, gasto sem conversão, CPA +30%, ROAS −30%, gasto ±50%.

---

## Fluxos

1. **Auditoria semanal de tráfego lixo / brand safety**: `get_placement_report` (GROUP; depois DETAIL
   nos domínios/canais suspeitos; PMAX para PMax) → conferir `candidates` → `exclude_placements` com
   `exclusion_items` (level ACCOUNT, CAMPAIGN ou AD_GROUP) → se `content_exclusions` mostrar rótulos
   faltando, `set_content_exclusions` com PARKED_DOMAIN e BRAND_SUITABILITY_CONTENT_FOR_FAMILIES.
2. **"Otimizar LP"**: palavras com QS mediano (`get_keyword_performance`) → `get_landing_page_performance`
   da campanha → páginas lentas / com conversão baixa / fora do ar → `list_policy_issues` para o
   detalhe da reprovação.
3. **Parceiros e expansão para Display**: `get_network_breakdown` → alertas → `update_campaign` com o
   `networkSettings` indicado.
4. **Revisão do MCC**: `get_mcc_performance_summary` → contas com alerta → relatórios por conta.

## Limites e o que ficou parcial (e por quê)

- **"Feito para crianças" e domínio estacionado por posicionamento**: a API v25 não expõe essas
  marcações nas views de posicionamento. A tool usa heurística (nome com termos infantis; site com
  gasto e sem conversão) e diz isso na resposta. O bloqueio em bloco existe e é indicado: rótulos de
  conteúdo `PARKED_DOMAIN` e `BRAND_SUITABILITY_CONTENT_FOR_FAMILIES` (este inclui os vídeos "Made
  for Kids" do YouTube, conforme o proto `ContentLabelTypeEnum`).
- **Já excluído**: confere exclusões da conta e das campanhas envolvidas. Não confere listas de
  exclusão compartilhadas (`placement_list` / shared sets NEGATIVE_PLACEMENTS) nem exclusões no nível
  do grupo de anúncios — um candidato pode já estar numa lista compartilhada. Exclusão de seção
  (`site.com/secao`) não é contada como cobrindo páginas dentro dela (conservador, ver acima).
- **Página funda demais (> 2 níveis) em DETAIL**: a API não aceita a exclusão só da página; a tool
  não alarga em silêncio para o domínio — oferece o domínio em `domain_exclusion`, com aviso, para
  decisão humana.
- **Canal do YouTube sem ID `UC…`**: se nem `placement` nem `target_url` trouxerem o ID do canal, o
  candidato sai sem `exclusion` (revisão manual).
- **mobile_friendly_clicks_percentage / AMP**: a API documenta como "percentage" em double; a tool
  trata como fração 0–1 (padrão das métricas de % da API) e converte para %, e aceita valor > 1 como
  já em %.
- **MCC**: `days` usa a data local do servidor (como `buildDateClause`); cada conta interpreta as
  datas no próprio fuso. Contas canceladas não entram (a lista é `status = ENABLED`). `maxAccounts`
  corta pela ordem de nome — as ignoradas saem em `skipped_by_limit`.
- **DESTINATION_NOT_WORKING em assets** (sitelinks etc.) não é cruzado aqui — só anúncios; o
  panorama completo é do `list_policy_issues`.

## Dependências de outros lotes (só por nome, no texto das respostas)

- `exclude_placements` e `set_content_exclusions` — lote placements-brand-safety. O formato de
  `exclusion_items` segue a proposta desse lote: `items[{type: WEBSITE|YOUTUBE_CHANNEL|YOUTUBE_VIDEO|MOBILE_APP, value}]`.
- `list_policy_issues` — lote diagnostics.
- `update_campaign` (núcleo) — já aceita `networkSettings.targetSearchNetwork/targetContentNetwork`.
