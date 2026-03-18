# Google Ads MCP

Servidor MCP (Model Context Protocol) que transforma qualquer agente de IA em um gestor completo de trafego e performance para Google Ads.

Suporta o fluxo completo: **analise de performance**, **criacao de campanhas** (Search, Display, Video, Shopping, PMax, Demand Gen), **gestao de budget**, **controle de status**, **audiencias**, **extensoes de anuncio**, **catalogo de produtos** e **conversoes**.

Funciona em modo **local** (stdio) e **remoto** (HTTP/SSE), com suporte a deploy no **Railway**.

---

## Requisitos

- Node.js 20+
- Conta Google Ads com acesso MCC (Manager)
- Token OAuth 2.0 com escopo `https://www.googleapis.com/auth/adwords`
- Developer Token (solicitar em Google Ads → Tools → API Center)

---

## Variaveis de ambiente

| Variavel | Obrigatorio | Descricao |
|----------|-------------|-----------|
| `GOOGLE_ADS_CREDENTIALS_PATH` | Sim | Caminho para JSON com OAuth credentials (token, refresh_token, client_id, client_secret) |
| `GOOGLE_ADS_DEVELOPER_TOKEN` | Sim | Developer token da Google Ads API |
| `GOOGLE_ADS_LOGIN_CUSTOMER_ID` | Sim | ID da MCC (Manager account), sem hifens |
| `GOOGLE_ADS_API_VERSION` | Nao | Versao da API (default: v23) |
| `MCP_API_KEY` | Nao | Chave de autenticacao para modo HTTP |
| `ALLOWED_CUSTOMER_IDS` | Nao | Restringe acesso a contas especificas. IDs separados por virgula |
| `PORT` | Nao | Se definido, inicia servidor HTTP. Sem `PORT`, usa stdio |

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
        "GOOGLE_ADS_DEVELOPER_TOKEN": "seu_developer_token",
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
  GOOGLE_ADS_DEVELOPER_TOKEN=xxx GOOGLE_ADS_LOGIN_CUSTOMER_ID=123 \
  MCP_API_KEY=sua_chave node dist/index.js
```

### Deploy no Railway

1. Crie projeto no [Railway](https://railway.app) e conecte o repositorio
2. Configure variaveis de ambiente
3. URL do endpoint: `https://<seu-app>.up.railway.app/mcp`

---

## Tools (78 total — atualizado 2026-03-18)

### Descoberta de contas

| Tool | Descricao |
|------|-----------|
| `list_accounts` | Lista contas-filho da MCC com nome, moeda, timezone, status |
| `get_account_info` | Detalhes de uma conta especifica |
| `get_account_currency` | Moeda da conta (ex: BRL) |

### Insights e analise

| Tool | Descricao |
|------|-----------|
| `get_campaign_performance` | Metricas por campanha: spend, ROAS, conversoes, CTR, CPC, CPA |
| `get_ad_group_performance` | Metricas por ad group |
| `get_ad_performance` | Metricas por anuncio |
| `get_keyword_performance` | Metricas por keyword com quality score |
| `get_shopping_products` | Performance de produtos (Shopping/PMax) |
| `get_device_breakdown` | Metricas por dispositivo (Mobile, Desktop, Tablet, TV) |
| `get_daily_trend` | Tendencia diaria de metricas |
| `get_geo_performance` | Performance por localizacao geografica |
| `get_search_terms` | Termos de busca reais que acionaram anuncios |
| `get_purchase_conversions` | Conversoes de COMPRA (filtra por categoria PURCHASE) |
| `get_performance_alerts` | Alertas: ROAS baixo, gasto sem conversao |
| `compare_periods` | Compara dois periodos com deltas absolutos e percentuais |
| `get_change_history` | Historico de alteracoes na conta |
| `get_asset_group_performance` | Metricas de asset groups (PMax) |

### Criativos e assets

| Tool | Descricao |
|------|-----------|
| `get_ad_creatives` | Detalhes de RSAs: headlines, descriptions, final URL |
| `get_image_assets` | Lista imagens da biblioteca de assets |
| `get_video_assets` | Lista videos da biblioteca |
| `upload_image_asset` | Upload de imagem (base64) para biblioteca |
| `upload_video_asset` | Linkar video do YouTube como asset |

### GAQL (Query Language)

| Tool | Descricao |
|------|-----------|
| `run_gaql` | Executa qualquer query GAQL — a tool mais flexivel |

### Criacao de campanhas

| Tool | Descricao |
|------|-----------|
| `create_campaign` | Cria campanha (Search, Display, Shopping, PMax, Video, Demand Gen) com budget. Criada PAUSED. |
| `create_pmax_campaign` | Cria campanha PMax completa: budget + campaign + asset group + listing group. Suporta Merchant Center. |
| `create_display_campaign` | Cria campanha Display |
| `create_video_campaign` | Cria campanha Video (YouTube) |
| `create_shopping_campaign` | Cria campanha Shopping com Merchant Center |
| `create_demand_gen_campaign` | Cria campanha Demand Gen |

### Ad Groups e Anuncios

| Tool | Descricao |
|------|-----------|
| `create_ad_group` | Cria ad group |
| `update_ad_group` | Edita nome, status, CPC de ad group |
| `create_ad` | Cria RSA (Responsive Search Ad) com headlines e descriptions |
| `create_responsive_display_ad` | Cria ad responsivo de Display com imagens |
| `create_video_ad` | Cria ad de video (YouTube) |
| `update_ad` | Edita headlines, descriptions, final URL de um RSA existente |
| `update_ad_status` | Pausar ou ativar anuncio |

### Keywords

| Tool | Descricao |
|------|-----------|
| `create_keyword` | Adiciona keyword a um ad group |
| `remove_keyword` | Remove keyword |
| `add_negative_keyword` | Adiciona keyword negativa |
| `list_negative_keywords` | Lista keywords negativas |
| `create_shared_negative_list` | Cria lista de negativos compartilhada entre campanhas |

### PMax — Asset Groups

| Tool | Descricao |
|------|-----------|
| `create_asset_group` | Cria asset group com textos + imagens + videos |
| `update_asset_group` | Edita nome, status, final URL |
| `list_asset_groups` | Lista asset groups com ad_strength |
| `set_listing_group_filter` | Filtra produtos por marca, categoria, ID, custom attribute |

### Targeting

| Tool | Descricao |
|------|-----------|
| `set_campaign_locations` | Segmentacao geografica (pais, estado, cidade) |
| `set_campaign_languages` | Segmentacao por idioma |
| `update_ad_group_targeting` | Adiciona audiencia a ad group |
| `add_placement` | Adiciona placement (site, app, canal YouTube) |
| `list_audience_segments` | Lista audiencias disponiveis |
| `create_audience_segment` | Cria audiencia customizada por keywords/URLs |

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
| `update_campaign` | Edita nome, status, budget, bidding strategy |
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
| `create_conversion_action` | Cria acao de conversao (WEBPAGE, UPLOAD, PHONE_CALL) |

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

## Fluxos de criacao de campanha

### Search

```
create_campaign (SEARCH) → create_ad_group → create_ad (RSA) → create_keyword
→ set_campaign_locations → set_campaign_languages
→ create_sitelink_extension → create_callout_extension
```

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
upload_video_asset (YouTube ID) → create_video_campaign
→ create_ad_group → create_video_ad
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
- **`ALLOWED_CUSTOMER_IDS`**: Restringe quais contas o agente pode acessar.
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
