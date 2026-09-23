# Google Ads MCP

Servidor MCP (Model Context Protocol) que transforma qualquer agente de IA em um gestor completo de trafego e performance para Google Ads.

Suporta o fluxo completo: **analise de performance**, **criacao de campanhas** (Search, Display, Shopping, PMax, Demand Gen; Video só leitura/relatório — a API não cria nem edita campanhas de Vídeo), **gestao de budget**, **controle de status**, **audiencias**, **extensoes de anuncio**, **catalogo de produtos** e **conversoes**.

Funciona em modo **local** (stdio) e **remoto** (HTTP/SSE), com suporte a deploy no **Railway**.

---

## Requisitos

- Node.js 20+
- Conta Google Ads com acesso MCC (Manager)
- Token OAuth 2.0 com escopo `https://www.googleapis.com/auth/adwords` (as tools da Data Manager API — `upload_offline_conversions_data_manager`, `get_data_manager_request_status` — pedem também `https://www.googleapis.com/auth/datamanager` no consentimento; service account já pede os dois)
- Projeto Google Cloud com a Google Ads API ativada e nivel de acesso Explorer, Basic ou Standard. **Desde 09/09/2026 o developer token foi descontinuado**: o acesso e do projeto Cloud dono do OAuth client (ou da service account) — peca o nivel na pagina "Google Ads API Overview" do projeto. `check_api_access` diagnostica a configuracao.

---

## Variaveis de ambiente

| Variavel | Obrigatorio | Descricao |
|----------|-------------|-----------|
| `GOOGLE_ADS_CREDENTIALS_PATH` | Sim (ou uma alternativa abaixo) | Caminho para JSON com OAuth credentials (token, refresh_token, client_id, client_secret) |
| `GOOGLE_ADS_CREDENTIALS_JSON` | Alternativa hospedada | JSON OAuth completo fornecido por secret do ambiente. Mutuamente exclusivo com `GOOGLE_ADS_CREDENTIALS_PATH`; refresh ocorre apenas em memória |
| `GOOGLE_ADS_SERVICE_ACCOUNT_KEY_PATH` / `GOOGLE_ADS_SERVICE_ACCOUNT_JSON` | Alternativa | Chave JSON de service account (JWT assinado localmente). O e-mail da service account e adicionado como usuario da conta/MCC no Google Ads — o acesso nao depende da conta de um funcionario nem de 2SV |
| `GOOGLE_ADS_DEVELOPER_TOKEN` | Nao | **Descontinuado em 09/09/2026** — a API ignora o header e uma versao futura vai recusa-lo. So e enviado se definido; pode remover |
| `GOOGLE_ADS_LOGIN_CUSTOMER_ID` | Sim | ID da MCC (Manager account), sem hifens |
| `GOOGLE_ADS_API_VERSION` | Nao | Versao da API (default: v25 — v21 ja foi desligada, v22/v23 estao proximas do sunset) |
| `MCP_API_KEY` | Em qualquer modo HTTP | Chave de autenticacao (`Authorization: Bearer`). Obrigatoria sempre que `PORT` estiver definido — sem ela o endpoint aceitaria qualquer requisicao. Nao se aplica ao stdio |
| `MCP_ALLOWED_HOSTS` | Em qualquer modo HTTP | Hostnames aceitos, separados por vírgula e sem porta. Ativa proteção contra DNS rebinding |
| `ALLOWED_CUSTOMER_IDS` | Em qualquer modo HTTP | Escopo de contas. **`*`** = toda conta alcancavel pelo MCC do login (agencia/gestor com um MCC so). Ou uma lista nao vazia de IDs de 10 digitos separados por virgula (um cliente por servico). Ausencia ou vazio derruba o boot — vazio e engano de configuracao, nao curinga; e `*` nao se mistura com IDs. Em stdio segue opcional. |
| `GOOGLE_ADS_READ_ONLY` | Nao | Modo somente leitura (`true`/`1`). Remove as 206 tools mutáveis do catálogo e bloqueia mutações no cliente. Ausente mantém compatibilidade com o comportamento atual |
| `GOOGLE_ADS_DRY_RUN` | Nao | Dry-run (`true`/`1`). Envia `validateOnly=true` nos endpoints `:mutate` e nos uploads de conversão: a API valida o payload inteiro e devolve os mesmos erros de uma gravação real, sem alterar a conta. `apply_recommendation`/`dismiss_recommendation` não aceitam `validateOnly` e são **recusados** em dry-run (fail-closed). As criações (campanha com orçamento, asset groups, extensões, listas de negativas) vão numa operação atômica e são validadas inteiras. Só `create_video_ad`, `create_batch_job`, `create_location_sync_asset_set` e `upload_customer_match_members` ainda gravam em passos dependentes: em dry-run não validam o pedido inteiro (a API não devolve `results` em `validateOnly`) e a resposta diz o que ficou sem validar. Desligado por padrão |
| `GOOGLE_ADS_TOOL_GROUPS` | Nao | Publica so os grupos de tools listados (virgula): `core` (as 95 do nucleo) e as areas de [Tools por área](#tools-por-área-250--módulos-em-srctools). O catalogo completo tem 345 tools e o `tools/list` ~640 KB; o `core` sozinho ~210 KB e cada area 9–31 KB. Ausente ou `all` = todas. Grupo desconhecido derruba o boot |
| `PORT` | Nao | Se definido, inicia servidor HTTP. Sem `PORT`, usa stdio |
| `MCP_MAX_BODY` | Nao | Modo HTTP: tamanho maximo do corpo de uma chamada (padrao `32mb`, formato do express: `10mb`, `500kb`). Acima disso a resposta e um erro JSON-RPC; o corpo so e lido depois da checagem do `MCP_API_KEY` |

---

## Instalacao e uso

### Modo local (stdio) — Cursor / Claude Code

```bash
git clone https://github.com/RaphizSanders/google-ads-mcp.git
cd google-ads-mcp
npm install
npm run build
```

Configure em `~/.claude.json` (ou `~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "google-ads": {
      "command": "node",
      "args": ["/caminho/absoluto/google-ads-mcp/dist/index.js"],
      "env": {
        "GOOGLE_ADS_CREDENTIALS_PATH": "/caminho/google_ads_token.json",
        "GOOGLE_ADS_LOGIN_CUSTOMER_ID": "1234567890"
      }
    }
  }
}
```

**Multiplas MCCs:** Use o mesmo codigo com entradas diferentes no JSON, mudando apenas `GOOGLE_ADS_LOGIN_CUSTOMER_ID`.

### Modo HTTP (remoto)

```bash
PORT=3333 GOOGLE_ADS_CREDENTIALS_PATH=./creds.json \
  GOOGLE_ADS_LOGIN_CUSTOMER_ID=123 \
  ALLOWED_CUSTOMER_IDS=1234567890 MCP_ALLOWED_HOSTS=localhost,127.0.0.1 \
  MCP_API_KEY=sua_chave node dist/index.js
```

Expor por HTTP exige `MCP_API_KEY`, `MCP_ALLOWED_HOSTS` e `ALLOWED_CUSTOMER_IDS` — o
processo recusa iniciar sem os tres, em modo de leitura ou de escrita. O modo stdio
(uso local no Cursor/Claude Code) nao passa por nenhuma dessas checagens.

### Deploy no Railway

1. Crie projeto no [Railway](https://railway.app) e conecte o repositorio
2. Configure variaveis de ambiente
3. URL do endpoint: `https://<seu-app>.up.railway.app/mcp`

### Modo somente leitura

Para integrações analíticas, defina `GOOGLE_ADS_READ_ONLY=true`. Nesse modo:

- `tools/list` publica somente as 139 tools classificadas como leitura;
- as 206 tools de criação, edição, upload e exclusão não são registradas;
- chamadas diretas à camada de mutação também são recusadas antes de qualquer acesso à API;
- uma tool nova e ainda não classificada permanece bloqueada por padrão.

O modo é opt-in para não alterar deployments existentes. Em ambientes de cliente, ele exige
`ALLOWED_CUSTOMER_IDS` e credenciais do MCP. Valores inválidos para `GOOGLE_ADS_READ_ONLY` fazem o
processo falhar na inicialização, evitando configuração ambígua.

Quando o modo read-only roda por HTTP (`PORT` definido), `MCP_API_KEY` e `MCP_ALLOWED_HOSTS`
são obrigatórios. O processo recusa iniciar se qualquer um estiver ausente. Para hospedagem,
prefira `GOOGLE_ADS_CREDENTIALS_JSON` como secret write-only; o refresh token permanece somente
em memória e nunca é gravado no filesystem do container.

`list_accounts` filtra a descoberta pela allowlist **quando o servidor está exposto por HTTP**
(`PORT` definido). Aí a ausência ou lista vazia nunca significa wildcard: o processo recusa
iniciar e a guarda de cada tool também nega o acesso, como defesa em profundidade.

Em **stdio** o critério é outro, e de propósito: o processo é iniciado pelo próprio cliente com a
credencial dele, não há superfície de rede nem outro inquilino para vazar, e `list_accounts` é o
ponto de descoberta — o id que você precisaria colocar na allowlist é justamente o que se vem
buscar aqui. Por isso uma allowlist vazia mantém o significado original de "sem filtro". Passar
`ALLOWED_CUSTOMER_IDS` em stdio continua funcionando e restringe normalmente.

---

## Tools (345 total — atualizado 2026-09-23)

As **95 do núcleo** estão nesta seção; as **250 das áreas** (segmentação, lances, negativas, conversões, PMax, Shopping, Demand Gen, públicos, diagnóstico, administração do MCC...) estão em [Tools por área](#tools-por-área-250--módulos-em-srctools), com documentação em [`docs/tools/`](docs/tools/).

### Descoberta de contas

| Tool | Descricao |
|------|-----------|
| `list_accounts` | Lista contas-filho da MCC com nome, moeda, timezone, status |
| `get_account_info` | Detalhes de uma conta especifica |
| `get_account_currency` | Moeda da conta (ex: BRL) |

### Insights e analise

| Tool | Descricao |
|------|-----------|
| `get_campaign_performance` | Metricas por campanha: spend, ROAS, conversoes, CTR, CPC, CPA — e se a campanha esta com AI Max (`ai_max`) |
| `get_ad_group_performance` | Metricas por ad group |
| `get_ad_performance` | Metricas por anuncio |
| `get_keyword_performance` | Metricas por keyword com quality score |
| `get_shopping_products` | Performance de produtos (Shopping/PMax) |
| `get_device_breakdown` | Metricas por dispositivo (Mobile, Desktop, Tablet, TV) |
| `get_daily_trend` | Tendencia diaria de metricas |
| `get_geo_performance` | Performance por localizacao geografica |
| `get_search_terms` | Termos de busca reais que acionaram anuncios, com a origem de cada termo (`match_source`: palavra-chave do anunciante, AI Max sem palavra-chave, AI Max broad match, DSA, PMax) e filtro por origem |
| `get_purchase_conversions` | Conversoes de COMPRA (filtra por categoria PURCHASE) |
| `get_performance_alerts` | Alertas: ROAS baixo, gasto sem conversao |
| `get_ai_max_report` | Relatorio do AI Max: termos vindos do AI Max com resumo por origem, combinacoes termo × landing page × titulo, e URLs finais do anunciante vs. escolhidas pela expansao de URL |
| `compare_periods` | Compara dois periodos com deltas absolutos e percentuais |
| `get_change_history` | Historico de alteracoes na conta |
| `get_asset_group_performance` | Metricas de asset groups (PMax) |
| `get_asset_performance` | Performance por asset: `performance_label` + metricas (RSA/Display) ou `primary_status` + metricas (PMax) |

### Criativos e assets

| Tool | Descricao |
|------|-----------|
| `get_ad_creatives` | Detalhes de RSAs: headlines, descriptions, final URL |
| `get_image_assets` | Lista imagens da biblioteca de assets |
| `get_video_assets` | Lista videos da biblioteca |
| `upload_image_asset` | Upload de imagem (base64) para biblioteca |
| `link_campaign_image_assets` | Vincula imagens da biblioteca a uma campanha de Pesquisa como recurso de imagem (`AD_IMAGE`). Valida conta, campanha SEARCH e asset IMAGE; nao duplica nem reativa vinculo pausado |
| `list_campaign_image_assets` | Imagens vinculadas por campanha: URL, dimensoes/proporcao, status do vinculo, `primary_status` com motivos e situacao de analise/politica |
| `upload_video_asset` | Linkar video do YouTube como asset |

### GAQL (Query Language)

| Tool | Descricao |
|------|-----------|
| `run_gaql` | Executa qualquer query GAQL — a tool mais flexivel |

### Criacao de campanhas

| Tool | Descricao |
|------|-----------|
| `create_campaign` | Cria campanha (Search, Display, PMax, Demand Gen) com budget numa unica operacao atomica — orcamento e campanha, ou nenhum. Aceita `TARGET_SPEND` (Maximizar cliques) com `cpcBidCeilingMicros`; `MANUAL_CPC` sem Enhanced CPC (descontinuado em 31/03/2025). `enableAiMax` cria campanha de Pesquisa com AI Max ligado. Criada PAUSED. |
| `create_pmax_campaign` | Cria campanha PMax completa: budget + campaign + asset group + listing group. Suporta Merchant Center. |
| `create_display_campaign` | Cria campanha Display |
| `create_video_campaign` | **Não suportado pela API**: o Google Ads não cria nem altera campanhas de video via API (`campaigns:mutate` e `adGroups:mutate` recusam). A tool retorna erro explicativo sem tocar na conta. Video programatico = `create_demand_gen_campaign`. Campanhas de video existentes sao so leitura e relatorio pela API |
| `create_shopping_campaign` | Cria campanha Shopping com Merchant Center |
| `create_demand_gen_campaign` | Cria campanha Demand Gen |

### Ad Groups e Anuncios

| Tool | Descricao |
|------|-----------|
| `create_ad_group` | Cria ad group (Search, Display, Shopping). Em campanha de CPC/CPM manual exige `cpcBidMicros`/`cpmBidMicros` — nunca cria grupo sem lance. Demand Gen vai para `create_demand_gen_ad_group`; PMax, `create_asset_group`; Vídeo é recusado (a API não cria) |
| `update_ad_group` | Edita nome, status, lances do grupo (`cpcBidMicros`, `cpmBidMicros`, `targetCpaMicros`) e a correspondencia de termos do AI Max (`disableSearchTermMatching`). Avisa lance muito baixo ou ignorado pela estrategia |
| `create_ad` | Cria RSA (Responsive Search Ad) com headlines e descriptions |
| `create_responsive_display_ad` | Cria ad responsivo de Display com imagens |
| `create_video_ad` | Tenta criar responsive video ad (YouTube) em ad group VIDEO_RESPONSIVE. A API trata campanhas de Video como so leitura: sem reserva a gravacao e recusada (`MUTATE_REQUIRES_RESERVATION`) e a tool explica o erro — para video por API use Demand Gen (`create_demand_gen_ad`). Pode deixar criado o asset YOUTUBE_VIDEO (inofensivo) antes da recusa |
| `update_ad` | Edita headlines, descriptions, final URL de um RSA existente |
| `update_ad_status` | Pausar ou ativar anuncio |

### Keywords

| Tool | Descricao |
|------|-----------|
| `create_keyword` | Adiciona keyword a um ad group |
| `remove_keyword` | Remove keyword |
| `update_keyword` | Ajusta lance (`cpcBidMicros`), status (pausar/ativar) e URL final de uma palavra-chave sem apaga-la |
| `add_negative_keyword` | Adiciona keyword negativa |
| `remove_negative_keyword` | Remove negativas da campanha ou do grupo por ID (`list_negative_keywords` mostra o `criterion_id`) ou por texto + correspondencia. Exige `confirm: true` (sem ele, so a previa) — tirar negativa libera trafego |
| `list_negative_keywords` | Lista keywords negativas |
| `create_shared_negative_list` | Cria lista de negativos compartilhada entre campanhas |

### PMax — Asset Groups

| Tool | Descricao |
|------|-----------|
| `create_asset_group` | Cria asset group com textos + imagens + videos |
| `update_asset_group` | Edita nome, status, final URL |
| `list_asset_groups` | Lista asset groups com ad_strength |
| `set_listing_group_filter` | Filtra produtos por marca, categoria (categoryId), tipo, canal, ID, custom attribute. Substitui a árvore numa requisição atômica; mesma dimensão em todos os filtros; com filtro de inclusão, o resto fica excluído |

### Targeting

| Tool | Descricao |
|------|-----------|
| `set_campaign_locations` | Segmentacao geografica (pais, estado, cidade). Por padrao adiciona a existente; `replace=true` substitui (remove antes os criterios de LOCATION da mesma polaridade) |
| `set_campaign_languages` | Segmentacao por idioma em PMax, Display e Demand Gen. Em Pesquisa o Google removeu o idioma (set/2026): a tool recusa, e `cleanup=true` + `confirm` so remove criterios antigos |
| `update_ad_group_targeting` | Adiciona audiencia a ad group |
| `add_placement` | Adiciona placement (site, app, canal YouTube) |
| `list_audience_segments` | Lista audiencias disponiveis |
| `create_audience_segment` | Cria audiencia customizada por keywords/URLs |
| `add_audience_signal` | Adiciona sinal de audiencia ou search theme a asset group PMax |
| `create_audience_from_lists` | Cria Audience a partir de user lists existentes (para sinais PMax) |

### Bid Adjustments

| Tool | Descricao |
|------|-----------|
| `set_device_bid_adjustment` | Ajuste de bid por dispositivo |
| `set_location_bid_adjustment` | Ajuste de bid por localizacao |
| `set_age_bid_adjustment` | Ajuste de bid por faixa etaria |
| `set_gender_bid_adjustment` | Ajuste de bid por genero |
| `set_ad_schedule` | Programacao por dia/hora |

### Gestao de campanha

| Tool | Descricao |
|------|-----------|
| `update_campaign` | Edita nome, status, estrategia de lance (`TARGET_SPEND`/Maximizar cliques, `MAXIMIZE_CONVERSIONS`, `MAXIMIZE_CONVERSION_VALUE`, `TARGET_IMPRESSION_SHARE`, `MANUAL_CPC`) com seus parametros (teto de CPC, CPA/ROAS alvo, parcela de impressoes) e redes (`networkSettings`). So o que muda vai no `updateMask` |
| `set_ai_max_settings` | Liga/desliga o AI Max (Pesquisa e Shopping), personalizacao de texto, expansao de URL final, termos excluidos e restricoes de mensagem |
| `update_budget` | Altera budget diario ou vitalicio |
| `bulk_update_status` | Pausa ou ativa multiplos objetos |
| `delete_campaign` | Remove campanha (com confirmacao) |
| `delete_ad_group` | Remove ad group |
| `delete_ad` | Remove anuncio |

### Extensoes de anuncio

| Tool | Descricao |
|------|-----------|
| `create_sitelink_extension` | Cria sitelink e vincula a campanha |
| `create_callout_extension` | Cria callout (ex: "Frete Gratis") |
| `create_structured_snippet` | Cria snippet estruturado (ex: Marcas: Nike, Adidas) |
| `create_call_extension` | Cria extensao de telefone |
| `create_price_extension` | Cria extensao de preco |
| `create_promotion_extension` | Cria extensao de promocao |
| `list_extensions` | Lista extensoes da conta/campanha |

### Conversoes

| Tool | Descricao |
|------|-----------|
| `list_conversion_actions` | Lista acoes de conversao configuradas |
| `create_conversion_action` | Cria acao de conversao (WEBPAGE, UPLOAD, PHONE_CALL, AD_CALL, CLICK_TO_CALL) |
| `update_conversion_action` | Edita nome, status, categoria, contagem, atribuicao, valor e janelas de lookback |
| `set_campaign_conversion_goals` | Define quais categorias de conversao guiam o lance da campanha (biddable) |
| `upload_offline_conversion` | Importa conversoes offline por gclid/gbraid/wbraid |

### Planejamento e recomendacoes

| Tool | Descricao |
|------|-----------|
| `generate_keyword_ideas` | Ideias de keywords com volume, concorrencia e faixa de CPC (Keyword Planner) |
| `list_geo_targets` | Busca geo target IDs por nome (para segmentacao e keyword planner) |
| `list_recommendations` | Recomendacoes do Google Ads com impacto estimado |
| `apply_recommendation` | Aplica recomendacoes (exige `confirm: true`) |
| `dismiss_recommendation` | Dispensa recomendacoes sem aplicar |

### Labels

| Tool | Descricao |
|------|-----------|
| `create_label` | Cria label para organizacao |
| `assign_label` | Vincula label a campanha, ad group ou ad |
| `list_labels` | Lista labels da conta |

### Remarketing

| Tool | Descricao |
|------|-----------|
| `list_remarketing_lists` | Lista listas de remarketing com tamanho, membership e status |
| `create_remarketing_list` | Cria lista rule-based (URL contains/equals + exclusoes). Suporta carrinho abandonado, visitantes de produto, etc. |
| `update_remarketing_list` | Edita nome, membership lifespan, descricao |

### Merchant Center

| Tool | Descricao |
|------|-----------|
| `list_merchant_centers` | Lista Merchant Centers vinculados (fallback duplo: merchant_center_link + campaign.shopping_setting) |

---

## Tools por área (250 — módulos em `src/tools/`)

Além das 95 do núcleo (acima), cada área tem um módulo próprio e uma página com parâmetros, fluxos e limitações em [`docs/tools/`](docs/tools/). O grupo de cada área é o nome usado em `GOOGLE_ADS_TOOL_GROUPS`. **L** = leitura, **E** = escrita (aceita `validateOnly`).

### Segmentação geográfica e de idioma

Grupo `targeting-geo` · 5 tools · [documentação](docs/tools/targeting-geo.md)

| Tool | | Descrição |
|------|---|-----------|
| `add_location_group_target` | E | Segmentação por raio em volta dos LOCAIS da conta (grupo de locais / LocationGroupInfo). WRITE OPERATION. |
| `add_proximity_target` | E | Segmentação por raio (proximidade) em volta de um endereço ou de latitude/longitude. WRITE OPERATION. |
| `get_campaign_geo_targeting` | L | Segmentação geográfica e de idioma atual por campanha. READ OPERATION. |
| `remove_campaign_geo_targets` | E | Remove critérios geográficos de uma campanha: local (LOCATION, segmentado ou excluído), raio (PROXIMITY) e |
| `set_geo_target_type` | E | Opções avançadas de local: presença x interesse (Campaign.geo_target_type_setting). WRITE OPERATION. |

### Ajustes de lance, programação e demografia

Grupo `bid-modifiers` · 9 tools · [documentação](docs/tools/bid-modifiers.md)

| Tool | | Descrição |
|------|---|-----------|
| `get_frequency_report` | L | Limites de frequência atuais e alcance/frequência reais das campanhas Display, Vídeo e Demand Gen: |
| `get_time_performance` | L | Desempenho por hora do dia, dia da semana ou hora × dia (dayparting), com CPA, ROAS e parcela de impressões |
| `list_ad_schedules` | L | Lista a programação de anúncios (dia/horário + ajuste de lance) de uma campanha ou da conta. |
| `list_bid_modifiers` | L | Lista, para uma campanha, todos os ajustes de lance e exclusões de segmentação: dispositivo, local, |
| `remove_ad_schedule` | E | Remove horários da programação de uma campanha. WRITE OPERATION — exige confirm: true. |
| `set_demographic_targeting` | E | Exclui, reinclui ou ajusta o lance de valores demográficos (idade, gênero, status parental, renda). WRITE OPERATION. |
| `set_device_targeting` | E | Exclui, reinclui ou ajusta o lance de um dispositivo, no caminho certo para cada tipo de campanha. WRITE OPERATION. |
| `set_frequency_cap` | E | Define o limite de frequência (quantas vezes a mesma pessoa vê os anúncios) de uma campanha DISPLAY. |
| `update_ad_schedule_bid` | E | Muda só o ajuste de lance de horários já programados (o dia/horário não muda). WRITE OPERATION. |

### Posicionamentos, exclusões e brand safety

Grupo `placements-brand-safety` · 16 tools · [documentação](docs/tools/placements-brand-safety.md)

| Tool | | Descrição |
|------|---|-----------|
| `add_ip_exclusions` | E | Exclui endereços IP (IPv4/IPv6 individuais ou blocos CIDR) na campanha ou na conta inteira — ex.: IPs da |
| `attach_mcc_exclusion_list` | E | Aplica uma lista de exclusão de posicionamentos de uma conta gerente (MCC) no nível de conta de contas clientes |
| `create_placement_exclusion_list` | E | Cria uma lista de exclusão de posicionamentos (shared set NEGATIVE_PLACEMENTS) com os itens e, opcionalmente, |
| `exclude_placements` | E | Exclui posicionamentos — sites, canais e vídeos do YouTube, apps e categorias de app — no grupo de anúncios, |
| `get_targeting_overview` | L | Mostra TODA a segmentação de uma campanha num lugar só: locais (e raio), idiomas, dispositivos, programação, |
| `list_account_exclusions` | L | Lista as exclusões no nível da conta (customer_negative_criterion): sites, canais/vídeos do YouTube, apps, |
| `list_mobile_app_categories` | L | Busca categorias de app (mobile_app_category_constant) para excluir ou segmentar como MOBILE_APP_CATEGORY |
| `list_placement_exclusion_lists` | L | Lista as listas de exclusão de posicionamentos (shared sets NEGATIVE_PLACEMENTS) da conta: tamanho, onde estão |
| `list_topics` | L | Busca tópicos (topic_constant) para segmentar ou excluir em Display/Vídeo/Demand Gen com set_topic_targeting. |
| `remove_account_exclusions` | E | Remove exclusões do nível da conta (customer_negative_criterion) — sites, YouTube, apps, rótulos de conteúdo, |
| `remove_targeting_criteria` | E | Desfaz segmentação: remove critérios de campanha ou de grupo de anúncios pelo resource name |
| `set_content_exclusions` | E | Exclui tipos de conteúdo (rótulos de conteúdo / content labels) na campanha ou na conta inteira — brand safety. |
| `set_optimized_targeting` | E | Liga/desliga a segmentação otimizada (optimized_targeting_enabled) de um grupo de anúncios e, com ela ligada, |
| `set_topic_targeting` | E | Segmenta tópicos no grupo de anúncios (negative false, padrão) ou exclui tópicos no grupo ou na campanha |
| `set_video_inventory_type` | E | Define o tipo de inventário de vídeo da conta (brand safety do YouTube e parceiros de vídeo): |
| `update_placement_exclusion_list` | E | Mantém uma lista de exclusão de posicionamentos existente: adiciona e remove itens, aplica e desaplica |

### Anúncios responsivos de Pesquisa, customizadores e auditoria de anúncios

Grupo `rsa-ads` · 8 tools · [documentação](docs/tools/rsa-ads.md)

| Tool | | Descrição |
|------|---|-----------|
| `create_customizer_attribute` | E | Cria um atributo de customizador de anúncio (ex.: Preco, Parcelas, Desconto, Cidade). WRITE OPERATION. |
| `list_ads` | L | Auditoria de anúncios de qualquer tipo: RSA, Display responsivo (RDA), Demand Gen (multi-asset, |
| `list_call_only_ads` | L | Inventário dos anúncios só de chamada (CALL_AD) para migrar: o Google não cria mais esse tipo |
| `list_customizers` | L | Customizadores de anúncio: atributos (nome, tipo TEXT/NUMBER/PRICE/PERCENT, status) e os valores |
| `migrate_call_only_ad` | E | Migra um grupo com anúncio só de chamada (CALL_AD) para RSA + recurso de chamada, numa única |
| `remove_customizer_attribute` | E | Remove um atributo de customizador (libera vaga no limite de 40 ativos). WRITE OPERATION. |
| `remove_customizer_value` | E | Remove o valor de um customizador num nível (CUSTOMER, CAMPAIGN, AD_GROUP, KEYWORD). WRITE OPERATION. |
| `set_customizer_value` | E | Define o valor de um customizador num nível: CUSTOMER (conta), CAMPAIGN, AD_GROUP ou KEYWORD. |

### Extensões (assets vinculados), WhatsApp e formulário de lead

Grupo `extensions` · 11 tools · [documentação](docs/tools/extensions.md)

| Tool | | Descrição |
|------|---|-----------|
| `create_brand_text_asset` | E | Cria um asset de texto de identidade e vincula na mesma operação atômica: |
| `create_lead_form_asset` | E | Cria um formulário de lead (LeadFormAsset) e vincula à campanha (LEAD_FORM só existe no nível |
| `create_whatsapp_message_asset` | E | Cria o recurso de mensagem pelo WhatsApp (click-to-message, BusinessMessageAsset) e vincula na |
| `get_extension_performance` | L | Desempenho e status de veiculação das extensões (sitelinks, frases de destaque, snippets, chamada, |
| `link_extension_assets` | E | Vincula assets JÁ EXISTENTES como extensão/identidade na conta, em campanhas ou em grupos. |
| `list_extension_exclusions` | L | Mostra campanhas e grupos que bloqueiam a herança de extensões do nível acima |
| `list_lead_form_assets` | L | Lista os formulários de lead da conta: textos, campos, perguntas personalizadas, entrega por |
| `list_lead_form_submissions` | L | Leads recebidos pelos formulários de lead (lead_form_submission_data): data/hora, campanha, grupo, |
| `set_excluded_parent_extension_types` | E | Define quais tipos de extensão uma campanha (ou grupo) NÃO herda do nível acima — |
| `update_extension_asset` | E | Edita um asset de extensão existente: sitelink, frase de destaque, snippet estruturado, chamada, |
| `update_extension_link_status` | E | Pausa, reativa ou remove vínculos de extensão (conta, campanha ou grupo) — inclusive os |

### Biblioteca de assets e locais do Perfil da Empresa

Grupo `asset-library` · 9 tools · [documentação](docs/tools/asset-library.md)

| Tool | | Descrição |
|------|---|-----------|
| `create_location_group_asset_set` | E | Cria um grupo de locais (subconjunto do LOCATION_SYNC) e, opcionalmente, já o vincula a campanhas — tudo numa |
| `create_location_sync_asset_set` | E | Cria a sincronização de locais da conta (asset set LOCATION_SYNC) e a vincula à conta (CustomerAssetSet). |
| `get_asset_usage` | L | Onde um asset (imagem, vídeo, texto, sitelink, local...) está em uso: vínculos na conta, em campanhas, |
| `link_location_asset_set` | E | Vincula um asset set de locais JÁ EXISTENTE: o LOCATION_SYNC à conta (level=CUSTOMER), ou um grupo de locais |
| `list_location_asset_sets` | L | Lista os asset sets de locais da conta: o LOCATION_SYNC (sincronização com o Perfil da Empresa, redes/chains |
| `list_location_assets` | L | Lista os location assets (locais) da conta — gerados pelo Google a partir do LOCATION_SYNC —, com Place ID, |
| `remove_location_asset_set` | E | Remove um asset set de locais (LOCATION_SYNC ou grupo de locais). WRITE OPERATION irreversível — exige confirm: true. |
| `unlink_location_asset_set` | E | Desvincula um asset set de locais da conta (level=CUSTOMER), de campanhas (CAMPAIGN) ou de grupos de anúncios |
| `update_asset_synthetic_attestation` | E | Declara se assets da biblioteca foram gerados/alterados por IA (synthetic_content_info.advertiser_attestation, v25). |

### Palavras-chave, termos de pesquisa e DSA

Grupo `keywords` · 5 tools · [documentação](docs/tools/keywords.md)

| Tool | | Descrição |
|------|---|-----------|
| `add_keywords` | E | Adiciona várias palavras-chave a um grupo de anúncios numa chamada. |
| `audit_dsa_and_legacy` | L | Auditoria (só leitura) de Anúncios Dinâmicos de Pesquisa (DSA) e das estruturas legadas que o |
| `bulk_update_keyword_status` | E | Pausa ou ativa várias palavras-chave de uma vez (sem apagar histórico). |
| `get_search_term_insights` | L | Search term insights: termos de pesquisa agrupados em categorias e subcategorias, com volume |
| `list_keywords` | L | Lista as palavras-chave com os IDs necessários para update_keyword, remove_keyword e |

### Palavras-chave negativas em todos os níveis

Grupo `negatives` · 7 tools · [documentação](docs/tools/negatives.md)

| Tool | | Descrição |
|------|---|-----------|
| `add_account_negative_keywords` | E | Adiciona palavras-chave negativas de nível de conta: valem para Pesquisa e Shopping de TODAS as campanhas |
| `attach_shared_set` | E | Vincula uma lista compartilhada de exclusão a campanhas ou à conta inteira. |
| `detach_shared_set` | E | Desvincula uma lista compartilhada de campanhas ou da conta. A lista e as palavras continuam existindo. |
| `get_shared_set_members` | L | Mostra o conteúdo de uma lista compartilhada: cada item com criterion_id (para remover), tipo, |
| `list_shared_sets` | L | Lista as listas compartilhadas de exclusão da conta: tipo, status, nº de palavras (member_count), |
| `remove_account_negative_keywords` | E | Remove palavras-chave negativas de nível de conta (da lista vinculada à conta). |
| `update_shared_set_members` | E | Adiciona e/ou remove palavras de uma lista compartilhada de negativas (NEGATIVE_KEYWORDS ou a lista de |

### Planejador de palavras-chave e recomendações

Grupo `planner-recommendations` · 6 tools · [documentação](docs/tools/planner-recommendations.md)

| Tool | | Descrição |
|------|---|-----------|
| `forecast_search_campaign` | L | Previsão de uma campanha de Pesquisa proposta (Keyword Planner → previsão): quantos cliques/conversões |
| `generate_recommendations` | L | Recomendações para uma campanha de Pesquisa ou Performance Max que AINDA NÃO EXISTE (construção de campanha): |
| `get_keyword_historical_metrics` | L | Volume de busca, sazonalidade (mês a mês), concorrência e faixa de lance para UMA LISTA de palavras-chave |
| `list_recommendation_subscriptions` | L | Lista as assinaturas de auto-aplicação de recomendações (RecommendationSubscription): quais tipos o Google |
| `set_recommendation_subscription` | E | Liga (ENABLED) ou pausa (PAUSED) a auto-aplicação de tipos de recomendação na conta |
| `suggest_ad_group_themes` | L | Sugere, para cada keyword, em qual grupo de anúncios EXISTENTE ela se encaixa e com qual match type |

### Orçamentos, ritmo de gasto e grupos de campanhas

Grupo `budgets` · 10 tools · [documentação](docs/tools/budgets.md)

| Tool | | Descrição |
|------|---|-----------|
| `assign_budget` | E | Troca o orçamento de campanhas existentes para um orçamento que já existe (em geral, um compartilhado). |
| `assign_campaign_group` | E | Coloca campanhas num grupo de campanhas, ou tira do grupo (campaignGroupId null). |
| `create_campaign_group` | E | Cria um grupo de campanhas (campaign_group) para relatório por linha de produto / etapa de funil e, |
| `create_shared_budget` | E | Cria um orçamento diário COMPARTILHADO (explicitly_shared) e, opcionalmente, já move campanhas para ele. |
| `get_budget_pacing` | L | Ritmo de gasto do mês por orçamento (pacing): gasto até ontem × esperado, % do ritmo, projeção de fim de mês, |
| `get_campaign_group_performance` | L | Grupos de campanhas (campaign_group): quais campanhas estão em cada grupo e o desempenho somado no período |
| `list_budgets` | L | Inventário de orçamentos da conta (campaign_budget): valor diário ou total, período, se é compartilhado, |
| `remove_budget` | E | Remove orçamentos SEM campanha (órfãos) — por exemplo, os individuais que sobraram depois de assign_budget. |
| `remove_campaign_group` | E | Remove um grupo de campanhas VAZIO. WRITE OPERATION — exige confirm: true. |
| `update_campaign_group` | E | Renomeia um grupo de campanhas. WRITE OPERATION. Sem mudança (mesmo nome) não grava nada. |

### Estratégias de lance, simulações, sazonalidade e datas de campanha

Grupo `bidding` · 12 tools · [documentação](docs/tools/bidding.md)

| Tool | | Descrição |
|------|---|-----------|
| `assign_bidding_strategy` | E | Vincula campanhas a uma estratégia de portfólio (da conta ou de MCC compartilhada com ela). |
| `create_bidding_strategy` | E | Cria uma estratégia de lance de portfólio (compartilhável entre campanhas). WRITE OPERATION — não muda |
| `create_data_exclusion` | E | Cria uma exclusão de dados do Smart Bidding: manda ignorar as conversões de um período com problema |
| `create_seasonality_adjustment` | E | Cria um ajuste de sazonalidade do Smart Bidding: avisa que a taxa de conversão vai mudar num evento FUTURO |
| `get_ad_group_bid_targets` | L | Lances e alvos efetivos por grupo de anúncios: CPC, CPA alvo e ROAS alvo do grupo (override) ao lado |
| `get_bid_simulations` | L | Simulações de lance do Google (what-if): quanto a campanha / grupo / palavra-chave / portfólio teria gasto, |
| `list_bidding_adjustments` | L | Lista ajustes de sazonalidade e exclusões de dados do Smart Bidding, com status no tempo |
| `list_bidding_strategies` | L | Lista as estratégias de lance de portfólio da conta e, com includeManagerOwned (default true), as de MCC |
| `remove_bidding_adjustments` | E | Remove ajustes de sazonalidade ou exclusões de dados (ver list_bidding_adjustments). |
| `remove_bidding_strategy` | E | Remove uma estratégia de portfólio SEM campanhas vinculadas. WRITE OPERATION — exige confirm: true. |
| `update_bidding_adjustment` | E | Altera um ajuste de sazonalidade ou uma exclusão de dados existente (ver list_bidding_adjustments). |
| `update_bidding_strategy` | E | Altera nome e parâmetros de uma estratégia de portfólio (vale para TODAS as campanhas dela). |

### Experimentos, rastreamento de URL, rótulos e aquisição de clientes

Grupo `experiments-tracking` · 21 tools · [documentação](docs/tools/experiments-tracking.md)

| Tool | | Descrição |
|------|---|-----------|
| `create_campaign_draft` | E | Cria um rascunho de campanha (CampaignDraftService) para preparar mudanças sem afetar a campanha real. |
| `create_experiment` | E | Cria um experimento com os dois braços numa única operação atômica (googleAds:mutate). WRITE OPERATION. |
| `end_experiment` | E | Encerra um experimento agora (experiments:endExperiment), sem aplicar as mudanças. WRITE OPERATION. |
| `get_experiment_results` | L | Resultado de um experimento: tratamento × controle com lift, intervalo de confiança e p-valor, e se a |
| `get_label_performance` | L | Desempenho só dos itens com certos rótulos — campanhas, grupos, anúncios ou palavras-chave. READ OPERATION. |
| `get_lifecycle_goals` | L | Metas de ciclo de vida da conta (v25: Goal + CampaignGoalConfig). READ OPERATION. |
| `get_new_vs_returning_performance` | L | Conversões de clientes novos × recorrentes por campanha (segments.new_versus_returning_customers). |
| `get_tracking_settings` | L | Rastreamento de URL em todos os níveis: modelo de acompanhamento (tracking template), sufixo de URL |
| `graduate_experiment` | E | Gradua o experimento (experiments:graduateExperiment): a campanha de tratamento vira campanha |
| `list_campaign_drafts` | L | Lista rascunhos de campanha (status PROPOSED, PROMOTING, PROMOTED, PROMOTE_FAILED, REMOVED) com a |
| `list_experiments` | L | Lista os experimentos da conta com os braços (controle/tratamento, divisão de tráfego, campanhas e |
| `promote_campaign_draft` | E | Aplica um rascunho na campanha original (campaignDrafts:promote). WRITE OPERATION — assíncrono e |
| `promote_experiment` | E | Promove o experimento (experiments:promoteExperiment): copia as mudanças do tratamento para a campanha |
| `remove_label` | E | Remove um rótulo da conta (e, com ele, os vínculos com campanhas, grupos, anúncios, palavras-chave e |
| `schedule_experiment` | E | Agenda um experimento em SETUP (experiments:scheduleExperiment). WRITE OPERATION — assíncrono. |
| `set_new_customer_acquisition` | E | Aquisição de clientes novos (v25: Goal NEW_CUSTOMER_ACQUISITION + CampaignGoalConfig). WRITE OPERATION. |
| `set_tracking` | E | Define modelo de acompanhamento, sufixo de URL final e parâmetros personalizados em conta, campanhas, |
| `tag_user_list_customer_type` | E | Marca (ou desmarca) listas de público com o tipo de cliente usado pelas metas de ciclo de vida |
| `update_experiment_campaign` | E | Altera uma campanha em RASCUNHO — o tratamento de um experimento (in_design_campaigns) ou o de um |
| `update_label` | E | Altera nome, cor ou descrição de um rótulo. WRITE OPERATION — só o que muda é enviado. |
| `update_status_by_label` | E | Pausa ou ativa tudo que tem certos rótulos (campanhas, grupos, anúncios ou palavras-chave). WRITE |

### Ações e metas de conversão

Grupo `conversions-core` · 8 tools · [documentação](docs/tools/conversions-core.md)

| Tool | | Descrição |
|------|---|-----------|
| `audit_conversion_tracking` | L | Auditoria do acompanhamento de conversões, com alertas por regra. |
| `create_custom_conversion_goal` | E | Cria uma meta de conversão personalizada (CustomConversionGoal): um conjunto de ações que a campanha |
| `get_conversion_tag` | L | Tag de instalação de uma ação de conversão: Google tag, event snippet, ID de conversão (AW-) e rótulo. |
| `get_conversion_tracking_settings` | L | Configuração de acompanhamento de conversões da conta (customer.conversion_tracking_setting). |
| `list_conversion_goals` | L | Metas de conversão: o que cada campanha usa para os lances. |
| `set_account_conversion_goals` | E | Define as metas de conversão PADRÃO DA CONTA (CustomerConversionGoal): quais categoria × origem guiam os |
| `set_campaign_goal_config` | E | Configura a meta de conversão da campanha (ConversionGoalCampaignConfig). |
| `update_custom_conversion_goal` | E | Altera ou remove uma meta de conversão personalizada (CustomConversionGoal). |

### Importação offline, ajustes de conversão, chamadas e GCLID

Grupo `conversions-offline` · 7 tools · [documentação](docs/tools/conversions-offline.md)

| Tool | | Descrição |
|------|---|-----------|
| `get_call_details` | L | Chamadas uma a uma (call_view) de anúncios de chamada e assets de ligação com número de encaminhamento do |
| `get_conversion_upload_health` | L | Saúde da importação offline (cliques, chamadas, ajustes, store sales) — o diagnóstico do Google por origem |
| `get_data_manager_request_status` | L | Status de um envio feito por upload_offline_conversions_data_manager (Data Manager requestStatus:retrieve). |
| `lookup_gclid` | L | Resolve GCLIDs pelo click_view: campanha, grupo, anúncio, palavra-chave (texto e correspondência), dispositivo, |
| `upload_call_conversions` | E | Importa conversões de chamadas (qualificadas no CRM/call center) para uma ação UPLOAD_CALLS. |
| `upload_conversion_adjustments` | E | Ajusta conversões já registradas: RETRACTION (zera — pedido cancelado, estornado, boleto/Pix não pago), |
| `upload_offline_conversions_data_manager` | E | Envia conversões offline pela Data Manager API (events:ingest) — o caminho que o Google indica depois da |

### Regras de valor, detalhamento de conversões, lift e leads

Grupo `conversions-reporting` · 11 tools · [documentação](docs/tools/conversions-reporting.md)

| Tool | | Descrição |
|------|---|-----------|
| `create_conversion_value_rule` | E | Cria uma regra de valor de conversão e a coloca no conjunto de regras do escopo, numa operação atômica |
| `create_lead_form` | E | Cria um formulário de lead (LeadFormAsset) e o vincula às campanhas (CampaignAsset LEAD_FORM) numa |
| `get_conversion_lag` | L | Atraso das conversões: quantos dias passam entre a impressão e a conversão (segments.conversion_lag_bucket) |
| `get_conversions_by_action` | L | Detalha as conversões por AÇÃO de conversão (e opcionalmente por campanha × ação). |
| `get_lead_form_submissions` | L | Leads recebidos pelos formulários de lead (lead_form_submission_data): data/hora, campanha, grupo, |
| `get_lift_results` | L | Resultados de estudos de Conversion Lift e Brand Lift (recursos lift_measurement_*, v25.1, somente leitura). |
| `get_value_rule_impact` | L | Efeito das regras de valor no valor de conversão: compara metrics.conversions_value (depois dos ajustes) |
| `link_lead_form_to_campaigns` | E | Vincula um formulário de lead existente a campanhas (action LINK, padrão) ou desvincula (action UNLINK, |
| `list_conversion_value_rules` | L | Lista as regras de valor de conversão e os conjuntos de regras (conta inteira ou por campanha). |
| `list_lead_forms` | L | Lista os formulários de lead (assets LEAD_FORM) da conta, as campanhas em que estão vinculados e se a conta |
| `update_conversion_value_rule` | E | Altera uma regra de valor de conversão: ação (operation/value), condições, status (ENABLED/PAUSED) |

### Performance Max: criação e gestão de asset groups

Grupo `pmax-assets` · 5 tools · [documentação](docs/tools/pmax-assets.md)

| Tool | | Descrição |
|------|---|-----------|
| `list_asset_group_assets` | L | Lista os assets vinculados aos asset groups de Performance Max, agrupados por tipo de campo. READ OPERATION. |
| `unlink_campaign_image_assets` | E | Remove vínculos de imagem (AD_IMAGE) de uma campanha — o inverso de link_campaign_image_assets. |
| `update_asset_group_assets` | E | Adiciona, remove ou troca assets de asset groups de Performance Max existentes, num ÚNICO pedido atômico |
| `update_demand_gen_ad` | E | Edita um anúncio Demand Gen (imagem/multi-asset, vídeo, carrossel ou produto) pelo AdService, com updateMask |
| `update_display_ad` | E | Edita um anúncio display responsivo (RESPONSIVE_DISPLAY_AD) pelo AdService, com updateMask aninhado. |

### Performance Max: sinais, automação, marca, prévias e combinações

Grupo `pmax-signals` · 15 tools · [documentação](docs/tools/pmax-signals.md)

| Tool | | Descrição |
|------|---|-----------|
| `copy_asset_group_signals` | E | Copia os sinais de um grupo de recursos PMax para outros grupos (da mesma conta). |
| `create_audience` | E | Cria um público (Audience) para sinal de Performance Max ou segmentação de Demand Gen. |
| `enable_pmax_brand_guidelines` | E | Migra campanhas PMax existentes para diretrizes de marca (CampaignService.EnablePMaxBrandGuidelines). |
| `get_pmax_automation_settings` | L | Mostra a automação de assets de uma campanha PMax e o que controla a expansão de URL final. |
| `get_pmax_brand_settings` | L | Mostra as diretrizes de marca de uma campanha PMax: se estão ativas, cores, fonte, nome da empresa e |
| `get_pmax_top_combinations` | L | Mostra as combinações de assets que o Google mais veiculou juntas em cada grupo de recursos PMax |
| `get_shareable_preview` | L | Gera links de prévia compartilháveis para aprovação do cliente (ShareablePreviewService). |
| `list_asset_group_signals` | L | Lista os sinais dos grupos de recursos PMax: temas de pesquisa (com status de aprovação e motivos de |
| `list_url_expansion_assets` | L | Lista os textos gerados pela expansão de URL final (final_url_expansion_asset_view) de uma campanha: |
| `manage_asset_group_signals` | E | Adiciona e remove sinais de um grupo de recursos PMax em lote. |
| `remove_auto_created_assets` | E | Remove de uma campanha textos gerados automaticamente pela expansão de URL final |
| `set_pmax_asset_automation` | E | Liga/desliga a automação de assets de uma campanha Performance Max. |
| `set_pmax_url_exclusions` | E | Gerencia as exclusões de URL da expansão de URL final de uma campanha PMax (critérios WEBPAGE negativos). |
| `update_audience` | E | Edita um público (Audience) existente — é o único jeito suportado de mudar um sinal de público do PMax. |
| `update_pmax_brand_assets` | E | Troca nome da empresa e logotipos de uma campanha PMax com diretrizes de marca, e ajusta cores e fonte. |

### Shopping, Merchant Center e grupos de produtos

Grupo `shopping` · 8 tools · [documentação](docs/tools/shopping.md)

| Tool | | Descrição |
|------|---|-----------|
| `create_shopping_product_ad` | E | Cria o anúncio de produto (shopping_product_ad) de um grupo SHOPPING_PRODUCT_ADS de campanha |
| `exclude_products` | E | Exclui itens (por ID do item do Merchant Center) da árvore de produtos de um asset group PMax |
| `get_listing_group_tree` | L | Lê a árvore de produtos atual: filtros de um asset group PMax (assetGroupId) ou grupos de |
| `get_product_group_performance` | L | Desempenho por grupo de produtos de campanhas Shopping padrão (product_group_view): cada grupo |
| `link_merchant_center` | E | Vincula diretamente um Merchant Center à conta (ProductLinkService.CreateProductLink). |
| `respond_merchant_center_invitation` | E | Aceita ou recusa um convite de vínculo enviado por um Merchant Center (status PENDING_APPROVAL). |
| `set_shopping_product_groups` | E | Define os grupos de produtos (listing groups) de um grupo de anúncios Shopping padrão, com lance |
| `unlink_merchant_center` | E | Desvincula um Merchant Center da conta (ProductLinkService.RemoveProductLink). |

### Relatórios de varejo, status de produtos, canais do PMax e listas de marcas

Grupo `retail-reporting` · 10 tools · [documentação](docs/tools/retail-reporting.md)

| Tool | | Descrição |
|------|---|-----------|
| `attach_brand_list` | E | Anexa uma lista de marcas a uma campanha ou grupo de anúncios. WRITE OPERATION. |
| `create_brand_list` | E | Cria uma lista de marcas (shared set BRANDS) com as marcas informadas. WRITE OPERATION. |
| `detach_brand_list` | E | Desanexa uma lista de marcas de uma campanha ou grupo de anúncios (remove o critério BRAND_LIST). |
| `get_cart_data_sales` | L | Vendas por produto a partir de conversões com dados do carrinho (cart_data_sales_view, v24+). |
| `get_listing_group_performance` | L | Métricas por grupo de produtos (listing group). READ OPERATION. |
| `get_pmax_channel_performance` | L | Performance Max por canal: onde o PMax gasta e converte (Pesquisa, YouTube, Display, Discover, |
| `get_product_status` | L | Status dos produtos do Merchant Center nos anúncios (shopping_product): por que um produto não |
| `list_brand_lists` | L | Lista as listas de marcas (shared sets BRANDS) da conta. READ OPERATION. |
| `suggest_brands` | L | Sugere marcas pelo começo do nome (BrandSuggestionService.SuggestBrands). READ OPERATION. |
| `update_brand_list` | E | Altera uma lista de marcas: adiciona (add), remove (remove) e/ou renomeia (name). WRITE OPERATION. |

### Demand Gen e remarketing dinâmico de varejo em Display

Grupo `demand-gen` · 7 tools · [documentação](docs/tools/demand-gen.md)

| Tool | | Descrição |
|------|---|-----------|
| `create_demand_gen_ad` | E | Cria um anúncio Demand Gen num grupo de campanha DEMAND_GEN. |
| `create_demand_gen_ad_group` | E | Cria um grupo de anúncios Demand Gen (sem type, como a API exige) numa campanha DEMAND_GEN existente. |
| `create_lookalike_segment` | E | Cria um segmento lookalike (semelhante) a partir de listas-semente (compradores, CRM, visitantes). |
| `list_demand_gen_ad_groups` | L | Lista os grupos Demand Gen com canais (channel controls), segmentação otimizada, lances do grupo e |
| `list_lookalike_segments` | L | Lista os segmentos lookalike da conta (sementes, nível de expansão, países, tamanho estimado). READ OPERATION. |
| `set_demand_gen_ad_group_targeting` | E | Define localização, idioma e público de grupos Demand Gen (critérios de GRUPO, como exige o upgraded targeting). |
| `update_demand_gen_ad_group` | E | Altera canais, segmentação otimizada e lances (CPC/CPA/ROAS alvo) de um grupo Demand Gen. |

### Vídeo, YouTube e anúncios de Display

Grupo `video-display` · 8 tools · [documentação](docs/tools/video-display.md)

| Tool | | Descrição |
|------|---|-----------|
| `create_image_ad` | E | Cria um anúncio de imagem (banner de tamanho fixo, IMAGE_AD) num grupo de anúncios de Display. |
| `get_video_performance` | L | Relatório de vídeo (YouTube) para campanhas de Vídeo e Demand Gen. READ OPERATION. |
| `get_youtube_video_uploads` | L | Lista os vídeos enviados ao YouTube pela API (you_tube_video_upload). READ OPERATION. |
| `list_youtube_video_links` | L | Lista os vínculos de vídeos do YouTube com a conta (data_link, tipo VIDEO). READ OPERATION. |
| `remove_youtube_video_upload` | E | Remove vídeos enviados pela API (YouTubeVideoUploadService.RemoveYouTubeVideoUpload). |
| `request_youtube_video_link` | E | Pede a um criador do YouTube o vínculo de um vídeo dele com esta conta (DataLinkService.CreateDataLink). |
| `respond_youtube_video_link` | E | Responde ou encerra um vínculo de vídeo do YouTube (DataLinkService.UpdateDataLink / RemoveDataLink). |
| `upload_youtube_video` | E | Sobe um arquivo de vídeo para o YouTube pela API do Google Ads (YouTubeVideoUploadService, upload resumável). |

### Públicos, remarketing e Customer Match

Grupo `audiences` · 11 tools · [documentação](docs/tools/audiences.md)

| Tool | | Descrição |
|------|---|-----------|
| `add_audience_segment_targeting` | E | Segmenta ou exclui públicos numa campanha ou grupo: remarketing/RLSA, Customer Match, afinidade, no mercado, |
| `create_customer_match_list` | E | Cria uma lista de Customer Match (CRM) vazia, para receber e-mails/telefones. |
| `create_logical_user_list` | E | Cria uma lista lógica combinando listas existentes: regras {operator ALL\|ANY\|NONE, userListIds}, todas em E. |
| `get_audience_performance` | L | Desempenho por segmento de público (remarketing, no mercado, afinidade, personalizados, Customer Match...) por campanha ou grupo. |
| `get_customer_match_status` | L | Status das listas de Customer Match: taxa de correspondência, tamanho (Pesquisa/Display), elegibilidade, |
| `get_demographic_performance` | L | Desempenho por faixa demográfica: AGE, GENDER, PARENTAL ou INCOME (uma dimensão por vez — a API não cruza idade × gênero). |
| `remove_audience_segment_targeting` | E | Remove critérios de público (alvos ou exclusões) de uma campanha ou grupo. |
| `search_audience_segments` | L | Busca segmentos de público para segmentar ou excluir: AUDIENCE, USER_LIST (remarketing/Customer Match), |
| `set_targeting_mode` | E | Define Observação (bid_only=true: só observa e ajusta lance) ou Segmentação (bid_only=false: restringe o alcance) |
| `update_custom_audience` | E | Edita um segmento personalizado (custom audience): nome, descrição e membros (keywords, URLs, apps). |
| `upload_customer_match_members` | E | Envia e-mails e telefones para uma lista de Customer Match (CONTACT_INFO). Normaliza (minúsculas, gmail sem |

### Diagnóstico de veiculação, parcela de impressões e reprovações

Grupo `diagnostics` · 6 tools · [documentação](docs/tools/diagnostics.md)

| Tool | | Descrição |
|------|---|-----------|
| `diagnose_campaigns` | L | Por que a campanha não está gastando/veiculando? Lista TODAS as campanhas não removidas (inclusive as |
| `get_account_health` | L | Saúde da conta em uma chamada: status da conta, índice de otimização, auto-tagging, status do |
| `get_impression_share` | L | Parcela de impressões (impression share): quanto das impressões possíveis você levou e por que perdeu |
| `list_policy_issues` | L | Reprovações e limitações de política: anúncios (ad_group_ad.policy_summary), assets vinculados a |
| `request_ad_policy_exemption` | E | Cria um anúncio responsivo de pesquisa (RSA) — ou altera o texto/URL de um RSA existente — pedindo |
| `request_keyword_policy_exemption` | E | Cria uma palavra-chave pedindo exceção de política (exempt_policy_violation_keys) — ex.: marca de |

### Relatórios de posicionamento, landing page, redes e visão do MCC

Grupo `reports` · 4 tools · [documentação](docs/tools/reports.md)

| Tool | | Descrição |
|------|---|-----------|
| `get_landing_page_performance` | L | Desempenho por landing page (URL final definida pelo anunciante, landing_page_view). READ OPERATION. |
| `get_mcc_performance_summary` | L | Visão consolidada do MCC: gasto, conversões, valor, ROAS e CPA de cada conta cliente no período, com |
| `get_network_breakdown` | L | Desempenho por rede (segments.ad_network_type): Google Search × parceiros de pesquisa (SEARCH_PARTNERS) × |
| `get_placement_report` | L | Relatório de posicionamentos: onde os anúncios de Display, Vídeo, Demand Gen e PMax apareceram. READ OPERATION. |

### Autenticação, configurações da conta e metadados de campos

Grupo `account-auth` · 7 tools · [documentação](docs/tools/account-auth.md)

| Tool | | Descrição |
|------|---|-----------|
| `check_api_access` | L | Diagnóstico de acesso à Google Ads API. READ OPERATION — não altera nada. |
| `get_account_settings` | L | Configurações de conta: auto-tagging, tracking template, sufixo de URL final, relatório de chamadas, |
| `get_gaql_fields` | L | Metadados reais dos campos GAQL (GoogleAdsFieldService) — READ OPERATION, não lê dados de conta. |
| `get_identity_verification` | L | Verificação de identidade do anunciante: status (PENDING_USER_ACTION, PENDING_REVIEW, SUCCESS, FAILURE), |
| `start_identity_verification` | E | Inicia uma sessão de verificação de identidade do anunciante (programa ADVERTISER_IDENTITY_VERIFICATION) |
| `update_account_settings` | E | Altera configurações da conta (Customer): auto-tagging, tracking template, sufixo de URL final, |
| `validate_gaql` | L | Confere uma query GAQL contra os metadados reais da API ANTES de rodar (não executa a query nem lê a conta). |

### Administração do MCC: contas, vínculos, usuários, faturamento e edição em massa

Grupo `account-admin` · 24 tools · [documentação](docs/tools/account-admin.md)

| Tool | | Descrição |
|------|---|-----------|
| `bulk_mutate` | E | Edição em massa genérica: até 10.000 operações (create/update/remove) de vários tipos |
| `cancel_account_budget_proposal` | E | Cancela uma proposta de orçamento de conta ainda PENDING (remove a proposta). WRITE OPERATION. |
| `cancel_client_invitation` | E | Cancela um convite PENDING do MCC para uma conta (status CANCELED). WRITE OPERATION. |
| `change_user_role` | E | Muda o papel de um usuário na conta (ADMIN, STANDARD, READ_ONLY, EMAIL_ONLY). WRITE OPERATION. |
| `create_batch_job` | E | Edição em massa acima de 10.000 operações via BatchJobService (assíncrono). WRITE OPERATION. |
| `create_client_account` | E | Cria uma conta cliente nova sob um MCC (CustomerService.CreateCustomerClient). WRITE OPERATION. |
| `get_batch_job_results` | L | Resultados de um batch job concluído (DONE): por operação, o resource name gravado ou os |
| `get_batch_job_status` | L | Status de batch jobs (BatchJobService): PENDING, RUNNING ou DONE, progresso e contagem de |
| `get_billing_status` | L | Situação de faturamento: configuração de pagamento (billing setup) e orçamento da conta |
| `invite_client_account` | E | Convida uma conta existente para ser gerenciada pelo MCC (cria o vínculo PENDING). |
| `invite_user` | E | Convida um e-mail para acessar a conta com um papel (ADMIN, STANDARD, READ_ONLY, EMAIL_ONLY). |
| `list_account_links` | L | Vínculos entre gerente e contas. view=clients (padrão): contas que o MCC gerencia ou |
| `list_account_users` | L | Auditoria de acesso: usuários com acesso direto à conta (papel, quem convidou, desde |
| `list_invoices` | L | Faturas de um mês (InvoiceService) — só contas em faturamento mensal. Valores, impostos, |
| `list_payments_accounts` | L | Contas de pagamento (payments accounts) visíveis entre o login e a conta: ID, nome, moeda, |
| `list_pending_approvals` | L | Pedidos de aprovação multi-party (MPA) da conta: convites, mudanças de papel e remoções |
| `move_client_account` | E | Move uma conta cliente de um gerente para outro na mesma hierarquia (MoveManagerLink: |
| `propose_account_budget` | E | Proposta de orçamento de conta (account budget) — só contas em faturamento mensal. |
| `remove_user` | E | Remove o acesso de um usuário à conta (offboarding). WRITE OPERATION — para voltar é preciso |
| `resolve_approval` | E | Resolve um pedido de aprovação multi-party: APPROVED ou REJECTED (por outro ADMIN, não quem |
| `respond_to_manager_invitation` | E | Aceita (ACTIVE) ou recusa (REFUSED) o convite PENDING de um gerente, pela conta cliente. |
| `revoke_user_invitation` | E | Revoga um convite de usuário PENDING (por invitationId ou emailAddress). WRITE OPERATION. |
| `set_client_link_hidden` | E | Oculta ou reexibe uma conta cliente na lista do MCC (campo hidden do vínculo). WRITE OPERATION. |
| `unlink_client_account` | E | Desvincula uma conta cliente de um gerente (vínculo ACTIVE → INACTIVE, pela visão do |

---

## Resources (5 total)

| URI | Descricao |
|-----|-----------|
| `google-ads://glossary` | Glossario: CPC, CPM, ROAS, Quality Score, impression share, objetivos |
| `google-ads://playbook` | Playbook: quando pausar/escalar, otimizacao de lances, saturacao |
| `google-ads://benchmarks` | Benchmarks Brasil: CTR, CPC, CPM, CPA, ROAS por vertical |
| `google-ads://gaql-reference` | Referencia GAQL: resources, campos, segmentos, metricas, exemplos |
| `google-ads://troubleshooting` | Erros comuns, learning phase, politicas, reprovacao, conta suspensa |

---

## Prompts (9 total)

| Prompt | Descricao | Argumentos |
|--------|-----------|------------|
| `weekly_review` | Revisao semanal: campanhas ativas, ROAS, CPA, acoes | `customerId` |
| `full_account_audit` | Auditoria completa: overview → alertas → sugestoes → top 5 acoes | `customerId` |
| `campaign_diagnosis` | Diagnostico de campanha: config + tendencia + acao recomendada | `customerId`, `campaignId` |
| `budget_optimization` | Realocacao de budget baseada em ROAS | `customerId` |
| `keyword_optimization` | Otimizacao de keywords: quality score, match types, negativos | `customerId` |
| `compare_periods` | Compara performance entre dois periodos | `customerId`, datas |
| `pmax_optimization` | Otimizacao PMax: asset groups, produtos, sinais de audiencia | `customerId`, `campaignId` |
| `search_terms_audit` | Auditoria de termos: negativar irrelevantes, adicionar novos | `customerId` |
| `creative_analysis` | Analise de criativos: RSAs, headlines, fadiga | `customerId` |

---

## Compatibilidade com a Google Ads API (varredura 2026-09-09)

Enums e campos foram validados contra os protos oficiais da v25.

| Item | Situacao |
|------|----------|
| Versao default | `v25`. A v21 ja foi desligada; v22/v23 seguem respondendo mas estao proximas do sunset. Sobrescreva com `GOOGLE_ADS_API_VERSION` se precisar. |
| `ConversionActionCategory` | `LEAD` foi removido da API e `SIGN_UP` nao existe (o nome real e `SIGNUP`). As tools aceitam os nomes antigos como apelido e traduzem: `LEAD` → `SUBMIT_LEAD_FORM`, `SIGN_UP` → `SIGNUP`. |
| `ConversionActionType` | `UPLOAD` e `PHONE_CALL` nao existem no enum. Traduzidos para `UPLOAD_CLICKS` e `WEBSITE_CALL`. O tipo e IMUTAVEL apos a criacao. |
| `AttributionModel` | Os nomes reais tem prefixo: `DATA_DRIVEN` → `GOOGLE_SEARCH_ATTRIBUTION_DATA_DRIVEN`, `LAST_CLICK` → `GOOGLE_ADS_LAST_CLICK`. As tools aceitam os dois formatos. Os modelos baseados em regras (first click, linear, time decay, position based) foram desligados pelo Google em 2023 e nao sao mais oferecidos. |
| `data_driven_model_status` | Campo OUTPUT_ONLY — nunca e enviado no mutate (enviar causava erro na criacao). |
| `contains_eu_political_advertising` | Enviado como nome do enum (`DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING`) em vez do numero 3. |
| `asset_group_asset.performance_label` | Nao existe (o rotulo LOW/GOOD/BEST so existe em `ad_group_ad_asset_view`). Em PMax o sinal equivalente e `primary_status`, e o recurso aceita metricas + `segments.date`. |
| `recommendation.impact` | Selecionavel como mensagem inteira; as sub-paths (`impact.base_metrics.clicks`) nao existem no metadata de campos. |
| Demais enums | Varredura completa dos 396 enums da v25: nenhum outro valor invalido no projeto. |

---

## PMax Creation — Notas Importantes (API v23+)

A criacao de campanhas Performance Max na API v23 tem particularidades criticas:

| Regra | Detalhe |
|-------|---------|
| **Brand Guidelines** | Auto-ativado em PMax novas. NAO pode ser desativado via API. |
| **Business Name + Logo** | Devem ser linkados como `campaignAssets` (nivel campanha), NAO no asset group. O asset group herda automaticamente. |
| **Batch atomico** | Usar `googleAds:mutate` para criar budget + campaign + campaignAssets + assetGroup + assetGroupAssets em uma unica chamada. Evita race conditions. |
| **salesCountry** | DEPRECATED na v23. Usar `feedLabel` (ex: `"BR"`). |
| **containsEuPoliticalAdvertising** | Campo obrigatorio. Usar enum numerico `3` (nao boolean ou string). |
| **Listing group filter** | Para PMax Shopping, criar separadamente apos o batch principal (problema de `caseValue` no batch). |
| **Audience signals** | Usar `add_audience_signal` apos criacao. Para remarketing, usar `list_remarketing_lists` para encontrar listas populadas, `create_audience_from_lists` para criar Audience, e depois linkar como signal. |

---

## Fluxos de criacao de campanha

### Search

```
create_campaign (SEARCH) → create_ad_group → create_ad (RSA) → create_keyword
→ set_campaign_locations → set_geo_target_type (PRESENCE para negocio local)
→ create_sitelink_extension → create_callout_extension
```

### AI Max em campanha de Pesquisa

```
set_ai_max_settings (enableAiMax + controles)
→ update_ad_group (disableSearchTermMatching nos grupos que nao devem expandir, ex.: marca)
→ get_ai_max_report (termos, combinacoes, landing pages)
```

- **O que cada controle faz:** `enableAiMax` liga o AI Max; `textCustomization` e `finalUrlExpansion` sao as automacoes `TEXT_ASSET_AUTOMATION` e `FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION`; `termExclusions` (ate 25, 30 caracteres) e `messagingRestrictions` (ate 40, 300 caracteres) orientam os textos gerados. As duas listas **substituem** a atual (`[]` limpa).
- **Escrita minima:** o `updateMask` leva so os campos que mudam; valor igual ao atual nao e reenviado; os tipos de automacao nao pedidos sao preservados. Nao mexe em orcamento, lances, segmentacao nem palavras-chave.
- **Com AI Max ligado** a API trata as palavras-chave como correspondencia ampla e trava `keyword_match_type`. Em Shopping, a personalizacao de texto vem sempre ligada com o AI Max.
- **Leitura dos relatorios:** `search_term_view` com `match_source` e `ai_max_search_term_ad_combination_view` se sobrepoem — nunca some metricas entre elas. Termos de baixo volume ficam fora por privacidade, entao os totais ficam abaixo do total da campanha.

### Imagens em campanha de Pesquisa

```
upload_image_asset (sobe cada imagem; guarde o resource name)
→ link_campaign_image_assets (campaignId + assetResourceNames)
→ list_campaign_image_assets (confirma vinculo e analise)
```

- **O que o vinculo faz:** cria um `campaignAsset` com `fieldType: AD_IMAGE` e `status: ENABLED`. Nao mexe em campanha, orcamento, lances nem segmentacao.
- **Validacoes antes de gravar:** a campanha existe na conta e e `SEARCH`; cada imagem existe na conta e e do tipo `IMAGE`; resource name de outra conta e recusado sem chamar a API.
- **Idempotente:** imagem ja vinculada nao e recriada; vinculo `PAUSED` continua pausado (a tool nunca reativa). O retorno separa criados, ja existentes e erros por imagem.
- **Testar em producao sem gravar:** rode com `GOOGLE_ADS_DRY_RUN=true` — a API valida o vinculo (`validateOnly`) e nada e gravado.
- **Regras do Google:** ao menos uma imagem quadrada 1:1 (min. 300x300); paisagem 1.91:1 opcional (min. 600x314); ate 20 imagens por campanha; a conta precisa ser elegivel a imagens em Pesquisa. Vinculo novo fica `PENDING` / `ASSET_UNDER_REVIEW` e so veicula depois de aprovado — `list_campaign_image_assets` mostra isso e avisa quando falta imagem quadrada.

### Performance Max (E-commerce)

```
upload_image_asset (landscape, square, logo)
→ create_pmax_campaign (com merchantId, headlines, descriptions, imagens)
→ set_campaign_locations
```

### Display

```
create_display_campaign → create_ad_group → upload_image_asset
→ create_responsive_display_ad → update_ad_group_targeting (audiencia)
```

### Video (YouTube)

```
Video programatico: create_demand_gen_campaign → create_demand_gen_ad_group → create_demand_gen_ad
(upload_youtube_video sobe o arquivo para o YouTube, se preciso).
Campanhas VIDEO existentes: so leitura e relatorio (get_video_performance, get_placement_report) —
a API nao cria nem altera campanhas de Video.
```

### Shopping

```
create_shopping_campaign (merchantId) → create_ad_group
→ Produtos puxados automaticamente do Merchant Center
```

### Remarketing (Carrinho Abandonado)

```
create_remarketing_list (URL /cart, excluir /thank-you, 30 dias)
→ create_display_campaign → create_ad_group
→ update_ad_group_targeting (vincular lista)
→ create_responsive_display_ad
```

---

## Bidding Strategies suportadas

| Estrategia | Tipos de campanha | Descricao |
|------------|-------------------|-----------|
| `MAXIMIZE_CONVERSIONS` | Todos | Maximiza conversoes dentro do budget |
| `MAXIMIZE_CONVERSION_VALUE` | Search, Shopping, PMax | Maximiza receita (ROAS) |
| `TARGET_CPA` | Search, Display, Video | Meta de custo por conversao |
| `TARGET_ROAS` | Search, Shopping | Meta de retorno sobre investimento |
| `MANUAL_CPC` | Search, Display | CPC manual com Enhanced CPC |
| `MANUAL_CPV` | Video | CPV manual para awareness |

---

## Seguranca

- **Tudo PAUSED por padrao**: Todas as tools de criacao criam objetos pausados.
- **Budgets em MICROS**: R$1,00 = 1.000.000 micros. Descricoes explicitas.
- **`MCP_API_KEY`**: Protege o endpoint HTTP.
- **`ALLOWED_CUSTOMER_IDS`**: Escopo de contas. Obrigatoria sob HTTP (ausente/vazia derruba o boot), opcional em stdio. Use `*` para servir todo o MCC (agencia) ou a lista de IDs para isolar um cliente por servico.
- **`GOOGLE_ADS_DRY_RUN`**: Valida payloads de escrita contra a API sem gravar (`validateOnly`).
- **`validateOnly` por chamada**: toda tool de escrita aceita `validateOnly: true` — a API valida a operacao inteira (`validate_only`) e nada e gravado; a resposta comeca com `VALIDATE-ONLY`. As criacoes de campanha (Search, Display, Shopping, Demand Gen, PMax), asset groups, extensoes e listas de negativas vao num unico `googleAds:mutate` atomico com IDs temporarios, entao o `validateOnly` valida o pedido inteiro. Recusam o modo, sem enviar nada: endpoints sem `validate_only` (`apply_recommendation`, `dismiss_recommendation`) e as poucas tools que ainda gravam em passos dependentes (`create_video_ad`, `create_batch_job`, `create_location_sync_asset_set`, `upload_customer_match_members`).
- **Delete com confirmacao**: `confirm: true` obrigatorio para remocao.
- **OAuth auto-refresh**: Token renova automaticamente, persiste no arquivo.

---

## Auth — Formato do credentials JSON

```json
{
  "token": "ya29.xxxxx",
  "refresh_token": "1//xxxxx",
  "token_uri": "https://oauth2.googleapis.com/token",
  "client_id": "xxxxx.apps.googleusercontent.com",
  "client_secret": "xxxxx",
  "scopes": ["https://www.googleapis.com/auth/adwords"],
  "expiry": "2026-03-18T12:00:00.000Z"
}
```

---

## Atualizacao

```bash
cd google-ads-mcp
git pull
npm ci
npm run build
# Reiniciar Claude Code para carregar
```

---

## Licenca

MIT
