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
- **Conversions:** Ações configuradas como conversão (compras, leads, etc.). Inclui TODAS as ações de conversão.
- **Purchase conversions:** Filtrar com conversion_action_category = 'PURCHASE' para obter apenas compras.
- **conversions_value:** Receita atribuída. Já vem em BRL (NÃO é micros).
- **CTR (click-through rate):** clicks / impressions × 100. Vem como decimal da API (0.05 = 5%).
- **Quality Score:** 1-10, avalia relevância do anúncio + LP + keyword. Score > 7 é bom.
- **Impression share:** % de impressões obtidas vs disponíveis. < 70% indica espaço para escala.

## Tipos de campanha
- **SEARCH:** Anúncios de texto na busca. Usa keywords + RSA (Responsive Search Ads).
- **SHOPPING:** Anúncios de produto com imagem/preço. Requer feed de produtos (Merchant Center).
- **PERFORMANCE_MAX (PMax):** Cross-channel automatizado. Google decide onde exibir.
- **DISPLAY:** Banners na rede de display (sites parceiros).
- **VIDEO:** YouTube ads (in-stream, bumper, discovery).
- **DEMAND_GEN:** Discovery + Gmail + YouTube Shorts.

## Bidding strategies
- **MAXIMIZE_CONVERSIONS:** Google otimiza para mais conversões no budget.
- **MAXIMIZE_CONVERSION_VALUE:** Otimiza para maior valor de conversão (ROAS).
- **TARGET_CPA:** Define CPA alvo e Google ajusta bids.
- **TARGET_ROAS:** Define ROAS alvo.
- **MANUAL_CPC:** Bids manuais por keyword (com Enhanced CPC opcional).

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
1. \`google_list_accounts\` → descobrir contas
2. \`google_get_campaign_performance\` → visão geral
3. \`google_get_performance_alerts\` → identificar problemas
4. \`google_get_purchase_conversions\` → separar compras de outras conversões
5. \`google_get_keyword_performance\` → keywords com melhor/pior ROAS
6. \`google_get_search_terms\` → termos de busca reais → negativos
7. \`google_get_shopping_products\` → performance por produto

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
| \`search_term_view\` | Termos de busca reais |
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
metrics.conversions          -- Conversões (TODAS as ações)
metrics.conversions_value    -- Receita (já em BRL, NÃO micros)
metrics.all_conversions      -- Conversões incluindo cross-device
metrics.all_conversions_value
\`\`\`

## Segmentos (WHERE / breakdowns)
\`\`\`
segments.date                          -- Data (YYYY-MM-DD)
segments.device                        -- MOBILE, DESKTOP, TABLET, OTHER
segments.conversion_action_category    -- PURCHASE, LEAD, DEFAULT, etc.
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
SELECT campaign.name, metrics.conversions, metrics.conversions_value
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
- \`cost_micros\` e \`average_cpc\`: SEMPRE dividir por 1.000.000
- \`conversions_value\`: NÃO dividir (já em BRL)
- \`ctr\`: Vem como decimal (0.05 = 5%). Multiplicar por 100 para exibir como %
- Não usar WHERE com campo que não está no SELECT (exceto segments.date)
- ORDER BY só aceita campos do SELECT
- LIMIT máximo: 10.000 por query
`;

export const troubleshootingContent = `# Troubleshooting — Google Ads

## Erros comuns da API

### RESOURCE_EXHAUSTED (429)
- **Causa:** Rate limit atingido (muitas requests por minuto).
- **Solução:** O MCP já faz retry automático com backoff exponencial. Se persistir, espaçar chamadas.

### PERMISSION_DENIED
- **Causa:** Token sem permissão ou conta não acessível pela MCC.
- **Solução:** Verificar se o token OAuth tem escopo \`https://www.googleapis.com/auth/adwords\`. Verificar se a conta está vinculada à MCC.

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

## Conversões não aparecendo

### Checklist
1. Tag do Google Ads instalada corretamente? (verificar com Tag Assistant)
2. Conversion action configurada como PRIMARY? (só primary conta pra bidding)
3. Janela de atribuição correta? (default: 30 dias click, 1 dia view)
4. Enhanced conversions ativado? (melhora matching, especialmente iOS)
5. Consent mode configurado? (GDPR/LGPD pode bloquear tracking)

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
