/**
 * Resources MCP (glossário, playbook, benchmarks, GAQL reference) para contexto do agente.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export const GLOSSARY_URI = "google-ads://glossary";
export const PLAYBOOK_URI = "google-ads://playbook";
export const BENCHMARKS_URI = "google-ads://benchmarks";
export const GAQL_REFERENCE_URI = "google-ads://gaql-reference";
export const TROUBLESHOOTING_URI = "google-ads://troubleshooting";

export const glossaryContent = `# Glossário Google Ads — Tráfego Pago

## Métricas de gasto e eficiência
- **cost_micros:** Valor gasto em micros (1.000.000 = R$1,00). SEMPRE dividir por 1.000.000 para exibir.
- **CPC (custo por clique):** average_cpc em micros. Quanto se paga por clique.
- **CPM (custo por mil impressões):** cost_micros / impressions × 1.000.
- **CPA (custo por aquisição):** cost / conversions. Quanto custa cada conversão.

## Métricas de resultado
- **ROAS (Return on Ad Spend):** conversions_value / cost. ROAS > 1 = lucrativo.
- **Conversions (metrics.conversions):** SÓ as ações de conversão com include_in_conversions_metric = true (as primárias) — é o que os lances automáticos otimizam. Ação secundária NÃO entra aqui.
- **All conversions (metrics.all_conversions):** TODAS as ações, independentemente de include_in_conversions_metric (primárias + secundárias).
- **View-through conversions (metrics.view_through_conversions):** conversões após impressão sem clique — métrica separada.
- **Variantes by_conversion_date** (conversions_by_conversion_date, all_conversions_by_conversion_date...): com segments.date, a data passa a ser a da conversão, não a do clique/interação.
- **Purchase conversions:** Filtrar com segments.conversion_action_category = 'PURCHASE' (e selecionar esse segmento). Com segmentos de ação de conversão, selecione só métricas de conversão — custo, cliques e impressões não se dividem por ação.
- **conversions_value:** Receita atribuída das ações primárias. Já vem na moeda da conta (NÃO é micros).
- **CTR (click-through rate):** clicks / impressions × 100. Vem como decimal da API (0.05 = 5%).
- **Quality Score:** 1-10, avalia relevância do anúncio + LP + keyword. Score > 7 é bom.
- **Impression share:** % de impressões obtidas vs disponíveis. < 70% indica espaço para escala.

## Tipos de campanha
- **SEARCH:** Anúncios de texto na busca. Usa keywords + RSA (Responsive Search Ads).
- **SHOPPING:** Anúncios de produto com imagem/preço. Requer feed de produtos (Merchant Center).
- **PERFORMANCE_MAX (PMax):** Cross-channel automatizado. Google decide onde exibir.
- **DISPLAY:** Banners na Rede de Display do Google. O Google está levando Display para Demand Gen (migração voluntária desde jun/2026; depois, campanhas novas só em Demand Gen).
- **VIDEO:** Campanhas de vídeo do YouTube. Pela API só dá para LER e reportar campanhas de Vídeo existentes — criar ou editar não é suportado; para vídeo com criação via API, use DEMAND_GEN. As Video action campaigns viraram Demand Gen (criação removida em abr/2025, migração automática concluída até abr/2026).
- **DEMAND_GEN:** YouTube (in-stream, in-feed, Shorts), Discover, Gmail e Rede de Display do Google, com controle de canais.

## Bidding strategies
- **MAXIMIZE_CONVERSIONS:** Google otimiza para mais conversões (primárias) no budget; CPA desejado (tCPA) opcional.
- **MAXIMIZE_CONVERSION_VALUE:** Otimiza para maior valor de conversão; ROAS desejado (tROAS) opcional.
- **TARGET_CPA / TARGET_ROAS:** CPA ou ROAS alvo (hoje também configuráveis como opção dentro de Maximizar conversões / valor).
- **TARGET_SPEND (Maximizar cliques):** Mais cliques no budget, com teto de CPC opcional.
- **MANUAL_CPC:** Lances manuais por keyword. O Enhanced CPC (ECPC) foi descontinuado: não existe mais em Pesquisa e Display desde a semana de 31/03/2025 (campanhas com ECPC passaram a funcionar como CPC manual) e o flag é ignorado em Shopping. Para otimizar por conversão, recomende Maximizar conversões (tCPA opcional) ou Maximizar valor (tROAS opcional). get_account_settings aponta campanhas que ainda têm manual_cpc.enhanced_cpc_enabled=true.

## Hierarquia
Conta → Campanha → Ad Group → Ad/Keyword. Budget pode ser em campanha. Targeting (keywords, audiences) no Ad Group.

## Status
- **ENABLED:** Ativo e entregando.
- **PAUSED:** Pausado pelo usuário.
- **REMOVED:** Deletado (não aparece por padrão).
`;

export const playbookContent = `# Playbook de Performance — Google Ads

## Quando pausar
- **Campanha:** ROAS < 1 por 14+ dias sem tendência de melhora; CPA 3x acima da média.
- **Keyword:** Spend > R$50 sem conversão; CTR < 1% com impressions > 1000; Quality Score < 3.
- **Ad:** CTR significativamente abaixo dos outros ads no mesmo grupo (teste A/B natural).

## Quando escalar
- **Campanha:** ROAS > 3x, impression share < 80%, CPA estável. Escalar budget 20% por vez.
- **Keyword:** ROAS > 5x, impression share < 70%. Aumentar bid ou budget.
- **Produto Shopping:** ROAS > 10x com baixo volume. Verificar bid e orçamento.

## Sinais de problema
- **Queda de Quality Score:** Revisar relevância do anúncio, LP, e keyword. Score < 5 precisa de ação.
- **Aumento de CPC sem aumento de conversão:** Competição aumentou ou ad fatigue.
- **Search terms irrelevantes:** Adicionar negative keywords. Revisar semanalmente.
- **Budget limitado (limited by budget):** Campanha tem potencial mas budget insuficiente.

## Fluxo de análise recomendado
1. \`list_accounts\` → descobrir contas (o cabeçalho conta as SUSPENSAS/CANCELADAS)
2. \`get_account_settings\` → auto-tagging, acompanhamento de conversões, optimization score
3. \`get_campaign_performance\` → visão geral
4. \`get_performance_alerts\` → identificar problemas
5. \`get_purchase_conversions\` → separar compras de outras conversões
6. \`get_keyword_performance\` → keywords com melhor/pior ROAS
7. \`get_search_terms\` → termos de busca reais → negativos
8. \`get_shopping_products\` → performance por produto

## Ordem de otimização
1. Pausar o que está perdendo dinheiro (ROAS < 1, keywords sem conversão)
2. Adicionar negative keywords (search terms irrelevantes)
3. Escalar o que funciona (budget +20% em campanhas com bom ROAS)
4. Testar novos anúncios (RSA com novas headlines)
5. Otimizar bids (ajustar por device, hora, localização)
`;

export const benchmarksContent = `# Benchmarks Brasil — Google Ads

Valores de referência para contas brasileiras por vertical. Use para contextualizar a performance.

## E-commerce (Search + Shopping)
| Métrica | Bom | Médio | Ruim |
|---------|-----|-------|------|
| CTR Search | > 5% | 3-5% | < 3% |
| CTR Shopping | > 1.5% | 0.8-1.5% | < 0.8% |
| CPC Search | < R$1.50 | R$1.50-3.00 | > R$3.00 |
| CPC Shopping | < R$0.50 | R$0.50-1.00 | > R$1.00 |
| ROAS Search | > 5x | 3-5x | < 3x |
| ROAS Shopping | > 8x | 4-8x | < 4x |
| ROAS PMax | > 6x | 3-6x | < 3x |
| Conversion Rate | > 3% | 1-3% | < 1% |

## Lead Generation
| Métrica | Bom | Médio | Ruim |
|---------|-----|-------|------|
| CTR | > 4% | 2-4% | < 2% |
| CPC | < R$3.00 | R$3-8 | > R$8 |
| CPL (custo/lead) | < R$30 | R$30-80 | > R$80 |
| Taxa de conversão LP | > 5% | 2-5% | < 2% |

## Brand / Awareness
| Métrica | Bom | Médio | Ruim |
|---------|-----|-------|------|
| CPM Display | < R$10 | R$10-25 | > R$25 |
| CPV Video | < R$0.10 | R$0.10-0.25 | > R$0.25 |
| View rate Video | > 30% | 15-30% | < 15% |

## Quality Score
| Score | Classificação | Ação |
|-------|--------------|------|
| 8-10 | Excelente | Manter e escalar |
| 6-7 | Bom | Otimizar LP e ad relevance |
| 4-5 | Médio | Revisar keywords, ads e LP |
| 1-3 | Ruim | Reestruturar ou pausar |
`;

export const gaqlReferenceContent = `# GAQL — Google Ads Query Language

## Sintaxe básica
\`\`\`sql
SELECT field1, field2, ...
FROM resource
WHERE condition1 AND condition2
ORDER BY field [ASC|DESC]
LIMIT N
\`\`\`

## Recursos principais
| Resource | Descrição |
|----------|-----------|
| \`campaign\` | Campanhas com métricas |
| \`ad_group\` | Grupos de anúncios |
| \`ad_group_ad\` | Anúncios individuais |
| \`keyword_view\` | Performance por keyword |
| \`shopping_performance_view\` | Performance por produto |
| \`search_term_view\` | Termos de busca reais (\`segments.search_term_match_source\` separa palavra-chave x AI Max) |
| \`ai_max_search_term_ad_combination_view\` | AI Max: termo × landing page × titulos gerados (so segmento: date) |
| \`expanded_landing_page_view\` | URL final real do clique; \`segments.landing_page_source\` = ADVERTISER ou AUTOMATIC (expansao do AI Max) |
| \`geographic_view\` | Performance por localização |
| \`age_range_view\` | Performance por faixa etária |
| \`gender_view\` | Performance por gênero |
| \`customer\` | Métricas agregadas da conta |
| \`campaign_criterion\` | Critérios da campanha (negativos, localização) |
| \`ad_group_criterion\` | Critérios do ad group (keywords, audiences) |
| \`change_event\` | Histórico de alterações |
| \`conversion_action\` | Ações de conversão configuradas |
| \`asset\` | Assets (imagens, vídeos) |

## Campos de métricas comuns
\`\`\`
metrics.cost_micros          -- Gasto em micros (÷ 1.000.000 = BRL)
metrics.impressions          -- Impressões
metrics.clicks               -- Cliques
metrics.ctr                  -- CTR (decimal: 0.05 = 5%)
metrics.average_cpc          -- CPC médio em micros
metrics.conversions          -- Conversões das ações PRIMÁRIAS (include_in_conversions_metric = true)
metrics.conversions_value    -- Valor das primárias (moeda da conta, NÃO micros)
metrics.all_conversions      -- TODAS as ações (primárias + secundárias)
metrics.all_conversions_value
metrics.view_through_conversions        -- Pós-impressão, sem clique
metrics.conversions_by_conversion_date  -- Primárias pela data da conversão (com segments.date)
\`\`\`

## Segmentos (WHERE / breakdowns)
\`\`\`
segments.date                          -- Data (YYYY-MM-DD)
segments.device                        -- MOBILE, DESKTOP, TABLET, OTHER
segments.conversion_action_category    -- PURCHASE, SUBMIT_LEAD_FORM, QUALIFIED_LEAD, CONVERTED_LEAD,
                                       -- IMPORTED_LEAD, PHONE_CALL_LEAD, CONTACT, SIGNUP, DEFAULT...
                                       -- (NÃO existe LEAD). No WHERE, precisa estar no SELECT
segments.product_title                 -- Título do produto (Shopping)
segments.product_item_id              -- ID do item (Shopping)
\`\`\`

## Filtros de data
\`\`\`sql
-- Período específico
WHERE segments.date BETWEEN '2026-03-01' AND '2026-03-15'

-- Presets
WHERE segments.date DURING LAST_7_DAYS
WHERE segments.date DURING LAST_30_DAYS
WHERE segments.date DURING THIS_MONTH
WHERE segments.date DURING LAST_MONTH
\`\`\`

## Exemplos úteis

### Campanhas com métricas
\`\`\`sql
SELECT campaign.name, campaign.advertising_channel_type,
       metrics.cost_micros, metrics.impressions, metrics.clicks,
       metrics.conversions, metrics.conversions_value
FROM campaign
WHERE segments.date BETWEEN '2026-03-01' AND '2026-03-15'
  AND campaign.status != 'REMOVED' AND metrics.impressions > 0
ORDER BY metrics.cost_micros DESC
\`\`\`

### Produtos Shopping (top por receita)
\`\`\`sql
SELECT segments.product_title, segments.product_item_id,
       metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value
FROM shopping_performance_view
WHERE segments.date BETWEEN '2026-03-01' AND '2026-03-15'
ORDER BY metrics.conversions_value DESC
LIMIT 20
\`\`\`

### Apenas compras (filtrar conversões)
\`\`\`sql
SELECT campaign.name, segments.conversion_action_category,
       metrics.conversions, metrics.conversions_value
FROM campaign
WHERE segments.date DURING LAST_30_DAYS
  AND segments.conversion_action_category = 'PURCHASE'
ORDER BY metrics.conversions_value DESC
\`\`\`

### Search terms com spend sem conversão
\`\`\`sql
SELECT search_term_view.search_term, metrics.cost_micros, metrics.clicks
FROM search_term_view
WHERE segments.date DURING LAST_30_DAYS
  AND metrics.conversions = 0 AND metrics.cost_micros > 10000000
ORDER BY metrics.cost_micros DESC
LIMIT 30
\`\`\`

## Notas
- Não sabe o nome de um campo ou se ele combina com o FROM? \`get_gaql_fields\` (resource=...) lista campos, segmentos e métricas compatíveis; \`validate_gaql\` confere a query antes de rodar.
- \`cost_micros\` e \`average_cpc\`: SEMPRE dividir por 1.000.000
- \`conversions_value\`: NÃO dividir (já na moeda da conta)
- \`ctr\`: Vem como decimal (0.05 = 5%). Multiplicar por 100 para exibir como %
- Segmento usado no WHERE precisa estar no SELECT — exceto os de data (date, week, month, quarter, year)
- Segmento de data no SELECT exige um período finito no WHERE (ex.: \`segments.date DURING LAST_30_DAYS\`)
- Recurso de SEGMENTAÇÃO (ex.: \`campaign\` em FROM campaign_asset ou expanded_landing_page_view): campo dele no WHERE precisa estar no SELECT. Recurso ATRIBUÍDO (ex.: \`campaign\` em search_term_view) não tem essa exigência — confira na field reference de cada recurso
- Prefira ordenar (ORDER BY) por campos que estão no SELECT
- Use LIMIT para limitar o volume: run_gaql usa searchStream e devolve todas as linhas
- DURING aceita só: TODAY, YESTERDAY, LAST_7_DAYS, LAST_14_DAYS, LAST_30_DAYS, LAST_BUSINESS_WEEK, THIS_MONTH, LAST_MONTH, THIS_WEEK_SUN_TODAY, THIS_WEEK_MON_TODAY, LAST_WEEK_SUN_SAT, LAST_WEEK_MON_SUN. **Não existe LAST_60_DAYS nem LAST_90_DAYS** — use \`segments.date BETWEEN 'AAAA-MM-DD' AND 'AAAA-MM-DD'\`
- Datas da campanha: \`campaign.start_date_time\` / \`campaign.end_date_time\` (os antigos \`start_date\`/\`end_date\` não existem mais)
`;

export const troubleshootingContent = `# Troubleshooting — Google Ads

## Erros comuns da API

### RESOURCE_EXHAUSTED (429)
- **Causa:** Rate limit atingido (muitas requests por minuto).
- **Solução:** O MCP já faz retry automático com backoff exponencial. Se persistir, espaçar chamadas.

### PERMISSION_DENIED
- **Causa:** Token sem permissão ou conta não acessível pela MCC.
- **Solução:** Verificar se o token OAuth tem escopo \`https://www.googleapis.com/auth/adwords\`. Verificar se a conta está vinculada à MCC (o header login-customer-id precisa ser o MCC gerente — USER_PERMISSION_DENIED). \`check_api_access\` faz o diagnóstico.

## Acesso à API (desde 09/09/2026)
- **Developer token:** foi descontinuado em 09/09/2026. O header é opcional e ignorado; uma versão major futura vai recusá-lo. O servidor só envia se GOOGLE_ADS_DEVELOPER_TOKEN estiver definido — pode remover.
- **Nível de acesso:** é do projeto Google Cloud dono do OAuth client. Pede-se na página "Google Ads API Overview" do projeto no Cloud Console (console.cloud.google.com/google/ads-apis/overview), não mais no API Center.
- **Cotas (por projeto Cloud, janela de 24 h):** Test — só contas de teste, 15.000 operações/dia; Explorer — 2.880/dia em produção; Basic — 15.000/dia; Standard — sem limite diário.
- **CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION:** o projeto só tem acesso Test e a conta é de produção → pedir Explorer, Basic ou Standard.
- **TWO_STEP_VERIFICATION_NOT_ENROLLED:** desde 21/04/2026 a API exige verificação em duas etapas do usuário que autoriza o OAuth → ativar 2SV na conta Google (ou usar service account).
- **Service account:** alternativa ao refresh token de uma pessoa — o e-mail da service account é adicionado como usuário da conta/MCC em Admin > Acesso e segurança (até 20 contas por e-mail; para mais, adicione ao MCC). Variáveis GOOGLE_ADS_SERVICE_ACCOUNT_KEY_PATH ou GOOGLE_ADS_SERVICE_ACCOUNT_JSON.
- **CUSTOMER_NOT_ENABLED / ACTION_NOT_PERMITTED_FOR_SUSPENDED_ACCOUNT:** a conta não está ativa ou está suspensa — veja \`list_accounts\` com includeStatuses.

## Serviços restritos (não construa fluxos em cima sem liberação)
- **Só com allowlist (liberação pelo representante Google):** ReachPlanService (previsão de alcance no YouTube), AudienceInsightsService, ContentCreatorInsightsService, BenchmarksService, IncentiveService (créditos promocionais de conta nova).
- **Beta fechado:** AssetGenerationService (títulos e imagens por IA generativa, desde a v22).
- Sem liberação a API recusa as chamadas; não há como contornar pelo MCP.

### INVALID_ARGUMENT — "The required field was not present"
- **Causa:** Campo obrigatório faltando na mutação. Comum ao criar campanhas sem todos os campos.
- **Solução:** Verificar documentação do resource. Ex: PMax precisa de asset group, Shopping precisa de merchant_id.

### INVALID_ARGUMENT — "Bidding strategy type is incompatible with shared budget"
- **Causa:** Budget criado com \`explicitlyShared: true\` (default) mas bidding strategy não suporta budget compartilhado.
- **Solução:** Sempre criar budgets com \`explicitlyShared: false\` para campanhas individuais.

### MUTATE_NOT_ALLOWED — "The operation is not allowed for the given context"
- **Causa:** Tentativa de operação não suportada (ex: mudar objetivo de campanha existente, editar PMax ad group diretamente).
- **Solução:** Algumas operações exigem criar novos objetos em vez de editar.

## Learning Phase (Fase de Aprendizado)

### O que é
Quando uma campanha com Smart Bidding (Maximize Conversions, Target CPA, Target ROAS) é criada ou sofre mudança significativa, o Google entra em "learning phase" por ~7-14 dias.

### O que dispara
- Criar campanha nova
- Mudar estratégia de bidding
- Mudar budget em mais de 20%
- Mudar targeting significativamente
- Mudar conversion action

### Impacto
- Performance instável (CPA pode subir 2-3x)
- Não pausar/mudar durante learning — resete o ciclo
- Esperar pelo menos 50 conversões antes de avaliar

### Recomendação
- Avisar o usuário quando uma ação pode resetar learning phase
- Mudanças de budget: máximo 20% por vez
- Aguardar estabilização antes de otimizar

## Políticas de Anúncios — Reprovação

### Motivos comuns
1. **Marca registrada:** Usar marca de terceiro no texto do anúncio
2. **Pontuação/capitalização:** TODAS AS LETRAS MAIÚSCULAS, pontuação excessiva (!!!)
3. **Conteúdo enganoso:** Promessas irreais, preços falsos
4. **Landing page:** Página não funciona, conteúdo diferente do anúncio
5. **Produtos restritos:** Álcool, farmacêuticos, jogos de azar (precisam de certificação)

### Como resolver
- Verificar email de reprovação (detalha o motivo)
- Editar o anúncio e resubmeter
- Apelar se acreditar que foi erro (Google Ads → Policy Manager)

## Conta Suspensa

### Causas
- Pagamento recusado/atrasado
- Violação grave de política
- Atividade suspeita (ex: cliques inválidos)

### Resolução
- Pagamento: atualizar forma de pagamento e pagar débito
- Política: corrigir violação e apelar
- Suspensão por clique inválido: apelar com evidências

### Como achar pela API
- \`list_accounts\` conta as contas por status no cabeçalho; \`includeStatuses: ["SUSPENDED","CANCELED"]\` lista quais são.
- SUSPENDED só o suporte do Google reativa; CANCELED um administrador reativa; CLOSED é permanente.

## Verificação de identidade do anunciante
- Se o prazo de conclusão passar sem a verificação concluída, a conta pode ser pausada.
- \`get_identity_verification\` (uma conta ou allAccounts) mostra status, prazos e o link de ação; o método é limitado pela API, então o resultado fica em cache por 6 h.
- \`start_identity_verification\` abre uma sessão nova quando o link expirou (exige confirm: true).

## Conversões não aparecendo

### Checklist
1. Tag do Google Ads instalada corretamente? (verificar com Tag Assistant)
2. Conversion action configurada como PRIMARY? (só primary conta pra bidding e aparece em metrics.conversions; secundária só em all_conversions)
3. Auto-tagging ligado? Sem ele não há GCLID — quebra a importação do GA4 e o upload offline (\`get_account_settings\`)
4. Janela de atribuição correta? (default: 30 dias click, 1 dia view)
5. Enhanced conversions ativado? (melhora matching, especialmente iOS; exige aceitar os termos de dados do cliente)
6. Consent mode configurado? (GDPR/LGPD pode bloquear tracking)

### Delay normal
- Conversões podem levar até 72h pra aparecer (cross-device, data processing)
- Enhanced conversions: até 48h adicionais
- Offline conversions: depende do upload schedule
`;

export function registerGoogleAdsResources(server: McpServer): void {
  server.registerResource(
    "glossary", GLOSSARY_URI,
    { title: "Glossário Google Ads", description: "Definições de métricas, tipos de campanha e conceitos Google Ads." },
    (uri) => ({ contents: [{ uri: uri.toString(), mimeType: "text/plain" as const, text: glossaryContent }] })
  );

  server.registerResource(
    "playbook", PLAYBOOK_URI,
    { title: "Playbook Google Ads", description: "Orientações de otimização: quando pausar, escalar, e fluxo de análise." },
    (uri) => ({ contents: [{ uri: uri.toString(), mimeType: "text/plain" as const, text: playbookContent }] })
  );

  server.registerResource(
    "benchmarks", BENCHMARKS_URI,
    { title: "Benchmarks Brasil", description: "Valores de referência para contas brasileiras por vertical." },
    (uri) => ({ contents: [{ uri: uri.toString(), mimeType: "text/plain" as const, text: benchmarksContent }] })
  );

  server.registerResource(
    "gaql-reference", GAQL_REFERENCE_URI,
    { title: "GAQL Reference", description: "Referência completa do Google Ads Query Language com exemplos." },
    (uri) => ({ contents: [{ uri: uri.toString(), mimeType: "text/plain" as const, text: gaqlReferenceContent }] })
  );

  server.registerResource(
    "troubleshooting", TROUBLESHOOTING_URI,
    { title: "Troubleshooting", description: "Erros comuns, learning phase, políticas de anúncios, reprovação e conta suspensa." },
    (uri) => ({ contents: [{ uri: uri.toString(), mimeType: "text/plain" as const, text: troubleshootingContent }] })
  );
}
