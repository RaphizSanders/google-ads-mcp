/**
 * Lote shopping: Shopping, Merchant Center e grupos de produtos.
 *
 * - Vínculo com o Merchant Center: product_link / product_link_invitation (v25; o antigo
 *   merchant_center_link não existe mais), aceitar/recusar convite, vincular e desvincular.
 * - Shopping padrão: campanha com grupo, anúncio de produto e árvore de grupos de produtos
 *   (ad_group_criterion.listing_group) num único googleAds:mutate, lances por grupo e
 *   desempenho por grupo (product_group_view).
 * - PMax varejo: árvore de filtros (asset_group_listing_group_filter) com vários níveis,
 *   PRODUCT_CONDITION, leitura da árvore atual e exclusão de itens sem perder o resto.
 *
 * As duas árvores têm as mesmas regras (irmãos na mesma dimensão, "outros" obrigatório em
 * toda subdivisão, dimensão não repete no caminho, níveis hierárquicos em ordem), então
 * o motor abaixo é um só; muda apenas a operação gerada (engine PMAX ou SHOPPING).
 *
 * Tools de leitura chamam checkCustomerAccess (o teste de allowlist confere no fonte).
 */
import { z } from "zod";
import type { GoogleAdsClient } from "../google-ads-client.js";
import {
  DATE_RANGE_DESC,
  DAYS_DESC,
  EU_POLITICAL_DECLARATION,
  LOW_BID_MICROS,
  MANUAL_BID_STRATEGIES,
  addMetrics,
  buildDateClause,
  checkCustomerAccess,
  dateRangeSchema,
  emptyTotals,
  ensureArray,
  explainBiddingError,
  flexArray,
  formatAsCsv,
  formatAsTable,
  formatJson,
  formatSchema,
  isPositiveMicros,
  metricsView,
  money,
  text,
} from "../tool-kit.js";
import type { MetricTotals, ToolContext } from "../tool-kit.js";

type Row = Record<string, unknown>;
type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const fail = (message: string): ToolResult => ({ content: [text(message)], isError: true });
const ok = (message: string): ToolResult => ({ content: [text(message)] });
const isId = (value: unknown): value is string => typeof value === "string" && /^\d+$/.test(value);
const obj = (value: unknown): Row => (value && typeof value === "object" ? (value as Row) : {});

// ══ Dimensões de produto ═══════════════════════════════════════════════

/**
 * Dimensões aceitas nas duas árvores. Na v25 os nomes JSON e os enums coincidem entre
 * ListingGroupFilterDimension (PMax) e ListingDimensionInfo (Shopping padrão):
 * productBrand.value, productItemId.value, productChannel.channel (ONLINE/LOCAL),
 * productCondition.condition (NEW/USED/REFURBISHED), productCategory {categoryId, level},
 * productType {value, level}, productCustomAttribute {value, index}.
 */
interface DimensionSpec {
  key: string;
  valueField: "value" | "categoryId" | "channel" | "condition";
  fixed?: Record<string, string>;
  family?: "category" | "type";
  level?: number;
  allowed?: readonly string[];
  label: string;
}

export const PRODUCT_DIMENSIONS: Record<string, DimensionSpec> = (() => {
  const dims: Record<string, DimensionSpec> = {
    PRODUCT_BRAND: { key: "productBrand", valueField: "value", label: "Marca" },
    PRODUCT_ITEM_ID: { key: "productItemId", valueField: "value", label: "ID do item" },
    PRODUCT_CHANNEL: { key: "productChannel", valueField: "channel", allowed: ["ONLINE", "LOCAL"], label: "Canal" },
    PRODUCT_CONDITION: {
      key: "productCondition",
      valueField: "condition",
      allowed: ["NEW", "USED", "REFURBISHED"],
      label: "Condição",
    },
  };
  for (let n = 1; n <= 5; n++) {
    dims[`PRODUCT_CATEGORY_LEVEL${n}`] = {
      key: "productCategory", valueField: "categoryId", fixed: { level: `LEVEL${n}` }, family: "category", level: n,
      label: `Categoria N${n}`,
    };
  }
  for (let n = 1; n <= 5; n++) {
    dims[`PRODUCT_TYPE_LEVEL${n}`] = {
      key: "productType", valueField: "value", fixed: { level: `LEVEL${n}` }, family: "type", level: n,
      label: `Tipo de produto N${n}`,
    };
  }
  for (let i = 0; i <= 4; i++) {
    dims[`PRODUCT_CUSTOM_ATTRIBUTE${i}`] = {
      key: "productCustomAttribute", valueField: "value", fixed: { index: `INDEX${i}` }, label: `Rótulo personalizado ${i}`,
    };
  }
  return dims;
})();

const DIMENSION_NAMES = Object.keys(PRODUCT_DIMENSIONS) as [string, ...string[]];

/** Subcampos de case_value lidos na GAQL (os mesmos nas duas árvores). */
const CASE_VALUE_FIELDS = [
  "product_brand.value",
  "product_item_id.value",
  "product_channel.channel",
  "product_condition.condition",
  "product_category.category_id",
  "product_category.level",
  "product_type.value",
  "product_type.level",
  "product_custom_attribute.value",
  "product_custom_attribute.index",
];

export function normalizeDimensionValue(
  dimension: string,
  raw: string | undefined | null
): { value?: string } | { error: string } {
  const spec = PRODUCT_DIMENSIONS[dimension];
  if (!spec) return { error: `dimensão desconhecida "${dimension}" (válidas: ${DIMENSION_NAMES.join(", ")})` };
  if (raw === undefined || raw === null) return {};
  const value = String(raw).trim();
  if (!value) return { error: `${dimension}: value vazio — para o nó "outros" omita value` };
  if (spec.allowed) {
    const upper = value.toUpperCase();
    if (!spec.allowed.includes(upper)) return { error: `${dimension} aceita ${spec.allowed.join(", ")} (recebido "${value}")` };
    return { value: upper };
  }
  if (spec.valueField === "categoryId" && !/^\d+$/.test(value)) {
    return {
      error: `${dimension} exige o ID numérico da categoria (SELECT product_category_constant.category_id FROM product_category_constant), recebido "${value}"`,
    };
  }
  // A API recusa esses separadores (CriterionError.INVALID_LISTING_DIMENSION)
  if (value.includes("==") || value.includes("&+")) return { error: `${dimension}: o valor não pode conter "==" nem "&+" ("${value}")` };
  return { value };
}

/** case_value em JSON REST. value undefined = nó "outros" (mesma dimensão, sem valor). */
export function caseValueOf(dimension: string, value?: string): Row {
  const spec = PRODUCT_DIMENSIONS[dimension];
  const body: Row = { ...(spec.fixed ?? {}) };
  if (value !== undefined) body[spec.valueField] = value;
  return { [spec.key]: body };
}

/** Lê o case_value devolvido pela API. Sem valor = "outros". */
function decodeCaseValue(caseValue: unknown): { dimension?: string; value?: string; unknownKey?: string } {
  const cv = obj(caseValue);
  for (const [name, spec] of Object.entries(PRODUCT_DIMENSIONS)) {
    const body = cv[spec.key];
    if (!body || typeof body !== "object") continue;
    const fields = body as Row;
    if (spec.fixed && !Object.entries(spec.fixed).every(([k, v]) => fields[k] === v)) continue;
    const raw = fields[spec.valueField];
    const empty = raw === undefined || raw === null || raw === "" || raw === "UNSPECIFIED" || raw === "UNKNOWN";
    return { dimension: name, value: empty ? undefined : String(raw) };
  }
  const keys = Object.keys(cv).filter((k) => cv[k] !== undefined && cv[k] !== null);
  return keys.length ? { unknownKey: keys[0] } : {};
}

const dimensionLabel = (dimension?: string) =>
  dimension ? `${PRODUCT_DIMENSIONS[dimension]?.label ?? dimension} [${dimension}]` : "";

/** Chave de comparação: texto sem diferença de maiúsculas (a API trata irmãos assim como duplicados). */
function valueKey(dimension: string, value?: string): string {
  if (value === undefined) return "*";
  return PRODUCT_DIMENSIONS[dimension]?.valueField === "value" ? value.toLowerCase() : value;
}

// ══ Árvore ═════════════════════════════════════════════════════════════

export interface PathElement {
  dimension: string;
  value?: string;
}

export interface UnitSpec {
  path: PathElement[];
  excluded?: boolean;
  cpcBidMicros?: number;
}

export interface LgNode {
  dimension?: string;
  value?: string;
  unit: boolean;
  excluded: boolean;
  cpcBidMicros?: number;
  children: LgNode[];
  resourceName?: string;
  /** Criado pelo MCP (nó "outros" que não veio na especificação). */
  auto?: boolean;
}

type Engine = "PMAX" | "SHOPPING";
type OthersPolicy = "AUTO" | "INCLUDE" | "EXCLUDE";

const pathKey = (path: PathElement[]) => path.map((p) => `${p.dimension}=${valueKey(p.dimension, p.value)}`).join("/");

export function pathLabel(path: PathElement[]): string {
  if (path.length === 0) return "Todos os produtos";
  return path
    .map((p) => `${PRODUCT_DIMENSIONS[p.dimension]?.label ?? p.dimension}=${p.value === undefined ? "(outros)" : p.value}`)
    .join(" › ");
}

function sortChildren(children: LgNode[]): LgNode[] {
  return [...children].sort((a, b) => {
    if (a.value === undefined && b.value !== undefined) return 1;
    if (b.value === undefined && a.value !== undefined) return -1;
    return String(a.value ?? "").localeCompare(String(b.value ?? ""));
  });
}

function walkTree(node: LgNode, visit: (node: LgNode, path: PathElement[]) => void, path: PathElement[] = []): void {
  visit(node, path);
  for (const child of sortChildren(node.children)) {
    walkTree(child, visit, [...path, { dimension: child.dimension!, value: child.value }]);
  }
}

function hasIncluded(node: LgNode): boolean {
  return node.unit ? !node.excluded : node.children.some(hasIncluded);
}

/**
 * Monta a árvore a partir das unidades (folhas) informadas por caminho. Cria as
 * subdivisões intermediárias e o nó "outros" que faltar, e aplica as regras da API antes
 * de qualquer chamada (os erros listam o caminho de cada problema).
 */
export function buildTreeFromUnits(
  units: UnitSpec[],
  engine: Engine,
  othersPolicy: OthersPolicy = "AUTO"
): { tree?: LgNode; errors: string[]; notes: string[] } {
  const errors: string[] = [];
  const notes: string[] = [];
  if (units.length === 0) return { errors: ["informe ao menos uma unidade (units)"], notes };

  const root: LgNode = { unit: false, excluded: false, children: [] };
  const childIndex = new Map<LgNode, Map<string, LgNode>>();
  const explicitUnits = new Set<LgNode>();

  units.forEach((unit, index) => {
    const label = `units[${index}]`;
    const path: PathElement[] = [];
    for (const element of unit.path ?? []) {
      const normalized = normalizeDimensionValue(element.dimension, element.value);
      if ("error" in normalized) {
        errors.push(`${label}: ${normalized.error}`);
        return;
      }
      path.push({ dimension: element.dimension, value: normalized.value });
    }
    let node = root;
    for (const element of path) {
      if (explicitUnits.has(node)) {
        errors.push(`${label}: o caminho ${pathLabel(path)} passa por um nó que outra unidade já declarou como folha`);
        return;
      }
      const map = childIndex.get(node) ?? new Map<string, LgNode>();
      childIndex.set(node, map);
      const key = `${element.dimension}=${valueKey(element.dimension, element.value)}`;
      let child = map.get(key);
      if (!child) {
        child = { dimension: element.dimension, value: element.value, unit: false, excluded: false, children: [] };
        map.set(key, child);
        node.children.push(child);
      }
      node = child;
    }
    if (explicitUnits.has(node)) {
      errors.push(`${label}: ${pathLabel(path)} aparece mais de uma vez (valores iguais sem diferença de maiúsculas contam como duplicados)`);
      return;
    }
    if (node.children.length > 0) {
      errors.push(`${label}: ${pathLabel(path)} é subdividido por outra unidade — não pode ser folha também`);
      return;
    }
    if (unit.cpcBidMicros !== undefined) {
      if (engine === "PMAX") {
        errors.push(`${label}: PMax não usa lance por grupo de produtos — remova cpcBidMicros`);
        return;
      }
      if (unit.excluded) {
        errors.push(`${label}: ${pathLabel(path)} está excluído — lance não se aplica a exclusão`);
        return;
      }
      if (!isPositiveMicros(unit.cpcBidMicros)) {
        errors.push(`${label}: cpcBidMicros deve ser inteiro positivo em micros (recebido ${unit.cpcBidMicros})`);
        return;
      }
    }
    node.unit = true;
    node.excluded = unit.excluded === true;
    node.cpcBidMicros = unit.cpcBidMicros;
    explicitUnits.add(node);
  });
  if (errors.length) return { errors, notes };

  if (root.unit && root.excluded) errors.push("a raiz (todos os produtos) não pode ser excluída — nada veicularia");

  const validate = (node: LgNode, ancestors: PathElement[]) => {
    if (node.unit) return;
    if (node.children.length === 0) {
      errors.push(`${pathLabel(ancestors)}: nó sem unidade abaixo`);
      return;
    }
    const dims = [...new Set(node.children.map((c) => c.dimension!))];
    if (dims.length > 1) {
      errors.push(`${pathLabel(ancestors)}: irmãos precisam usar a mesma dimensão (recebido ${dims.join(", ")})`);
      return;
    }
    const dimension = dims[0];
    const spec = PRODUCT_DIMENSIONS[dimension];
    if (ancestors.some((a) => a.dimension === dimension)) {
      errors.push(`${pathLabel(ancestors)}: ${dimension} já foi usada acima no caminho — a API não repete dimensão`);
    }
    if (spec.family) {
      const sameFamily = ancestors.filter((a) => PRODUCT_DIMENSIONS[a.dimension]?.family === spec.family);
      if (sameFamily.some((a) => (PRODUCT_DIMENSIONS[a.dimension].level ?? 0) > (spec.level ?? 0))) {
        errors.push(`${pathLabel(ancestors)}: níveis de ${spec.family === "category" ? "categoria" : "tipo de produto"} precisam vir em ordem crescente`);
      }
      if ((spec.level ?? 1) > 1) {
        const parentLevel = sameFamily.find((a) => PRODUCT_DIMENSIONS[a.dimension].level === (spec.level ?? 1) - 1);
        if (!parentLevel || parentLevel.value === undefined) {
          errors.push(
            `${pathLabel(ancestors)}: ${dimension} só pode refinar um nó com valor de nível ${(spec.level ?? 1) - 1} da mesma hierarquia ` +
              `(nem "outros" pode ser refinado pelo nível seguinte)`
          );
        }
      }
    }
    const valued = node.children.filter((c) => c.value !== undefined);
    if (valued.length === 0) {
      errors.push(`${pathLabel(ancestors)}: subdivisão por ${dimension} sem nenhum valor — informe ao menos um valor além de "outros"`);
    }
    // Filhos primeiro: o "outros" automático deste nível depende de os filhos já estarem completos
    for (const child of node.children) validate(child, [...ancestors, { dimension, value: child.value }]);
    if (!node.children.some((c) => c.value === undefined)) {
      const excluded = othersPolicy === "EXCLUDE" || (othersPolicy === "AUTO" && valued.some(hasIncluded));
      node.children.push({ dimension, unit: true, excluded, children: [], auto: true });
      notes.push(
        `"Outros" de ${dimensionLabel(dimension)} em ${pathLabel(ancestors)} criado automaticamente: ${excluded ? "EXCLUÍDO" : "INCLUÍDO"}` +
          (othersPolicy === "AUTO" ? (excluded ? " (há inclusões nesse nível: só o listado veicula)" : " (só há exclusões nesse nível)") : "")
      );
    }
  };
  validate(root, []);
  return errors.length ? { errors, notes } : { tree: root, errors, notes };
}

/** Preenche o lance das unidades positivas sem lance (Shopping padrão). Devolve as que ficaram sem. */
function fillDefaultBids(tree: LgNode, defaultBid: number | undefined): { missing: string[]; filled: number } {
  const missing: string[] = [];
  let filled = 0;
  walkTree(tree, (node, path) => {
    if (!node.unit || node.excluded || node.cpcBidMicros !== undefined) return;
    if (defaultBid !== undefined) {
      node.cpcBidMicros = defaultBid;
      filled++;
    } else {
      missing.push(pathLabel(path));
    }
  });
  return { missing, filled };
}

export function treeToUnits(tree: LgNode): UnitSpec[] {
  const units: UnitSpec[] = [];
  walkTree(tree, (node, path) => {
    if (!node.unit) return;
    units.push({
      path: path.map((p) => (p.value === undefined ? { dimension: p.dimension } : { dimension: p.dimension, value: p.value })),
      ...(node.excluded ? { excluded: true } : {}),
      ...(node.cpcBidMicros !== undefined ? { cpcBidMicros: node.cpcBidMicros } : {}),
    });
  });
  return units;
}

function indexByPath(tree: LgNode): Map<string, { node: LgNode; path: PathElement[] }> {
  const index = new Map<string, { node: LgNode; path: PathElement[] }>();
  walkTree(tree, (node, path) => index.set(pathKey(path), { node, path }));
  return index;
}

/** Assinatura estrutural (sem lances): caminhos, tipo de nó e inclusão/exclusão. */
function structureSignature(tree: LgNode): string {
  const lines: string[] = [];
  walkTree(tree, (node, path) => lines.push(`${pathKey(path)}|${node.unit ? (node.excluded ? "X" : "I") : "S"}`));
  return lines.sort().join("\n");
}

function countNodes(tree: LgNode): number {
  let count = 0;
  walkTree(tree, () => count++);
  return count;
}

function usesDimension(tree: LgNode, dimension: string): boolean {
  let found = false;
  walkTree(tree, (node) => {
    if (node.dimension === dimension) found = true;
  });
  return found;
}

/** Texto legível da árvore, com lance e métricas quando houver. */
export function renderTree(tree: LgNode, metrics?: Map<string, MetricTotals>): string {
  const lines: string[] = [];
  const describe = (node: LgNode): string => {
    const parts: string[] = [];
    if (node.unit) {
      parts.push(node.excluded ? "EXCLUÍDO" : "INCLUÍDO");
      if (!node.excluded && node.cpcBidMicros !== undefined) parts.push(`lance ${money(node.cpcBidMicros)}`);
    } else {
      const dim = node.children[0]?.dimension;
      parts.push(`subdividido por ${dimensionLabel(dim)}`);
    }
    const m = node.resourceName ? metrics?.get(node.resourceName) : undefined;
    if (m) {
      const v = metricsView(m);
      parts.push(`${v.impressions} impr · ${v.clicks} cliques · R$ ${v.spend.toFixed(2)} · ${v.conversions} conv · ROAS ${v.roas ?? "-"}`);
    }
    if (node.auto) parts.push("(criado automaticamente)");
    return parts.join(" · ");
  };
  lines.push(`Todos os produtos — ${describe(tree)}`);
  const draw = (node: LgNode, prefix: string) => {
    const children = sortChildren(node.children);
    children.forEach((child, i) => {
      const last = i === children.length - 1;
      const name = `${PRODUCT_DIMENSIONS[child.dimension!]?.label ?? child.dimension} = ${child.value === undefined ? "(outros)" : `"${child.value}"`}`;
      lines.push(`${prefix}${last ? "└─" : "├─"} ${name} — ${describe(child)}`);
      draw(child, `${prefix}${last ? "   " : "│  "}`);
    });
  };
  draw(tree, "");
  return lines.join("\n");
}

// ══ Árvore existente (leitura) ════════════════════════════════════════

interface RawNode {
  resourceName: string;
  parent?: string;
  unit: boolean;
  excluded: boolean;
  cpcBidMicros?: number;
  caseValue?: unknown;
}

/** Remonta a árvore a partir das linhas da API; "outros" sem case_value herda a dimensão dos irmãos. */
function assembleTree(raw: RawNode[]): { tree?: LgNode; problems: string[] } {
  const problems: string[] = [];
  if (raw.length === 0) return { problems };
  const names = new Set(raw.map((n) => n.resourceName));
  const childrenOf = new Map<string, RawNode[]>();
  const roots: RawNode[] = [];
  for (const node of raw) {
    if (node.parent && names.has(node.parent)) {
      childrenOf.set(node.parent, [...(childrenOf.get(node.parent) ?? []), node]);
    } else {
      if (node.parent) problems.push(`nó órfão ${node.resourceName} (pai ${node.parent} não encontrado)`);
      roots.push(node);
    }
  }
  if (roots.length > 1) problems.push(`a árvore tem ${roots.length} raízes — está inválida na conta`);

  const build = (node: RawNode, dimension?: string, value?: string): LgNode => {
    const kids = childrenOf.get(node.resourceName) ?? [];
    const decoded = kids.map((k) => ({ raw: k, ...decodeCaseValue(k.caseValue) }));
    const siblingsDim = decoded.find((d) => d.dimension)?.dimension;
    for (const d of decoded) {
      if (d.unknownKey) problems.push(`dimensão não suportada pelo MCP (${d.unknownKey}) em ${d.raw.resourceName} — a árvore pode ser lida, mas não reescrita pelo MCP`);
    }
    if (!node.unit && kids.length > 0 && !decoded.some((d) => d.value === undefined && !d.unknownKey)) {
      problems.push(`subdivisão ${node.resourceName} sem o nó "outros"`);
    }
    return {
      dimension,
      value,
      unit: node.unit,
      excluded: node.excluded,
      cpcBidMicros: node.cpcBidMicros,
      resourceName: node.resourceName,
      children: decoded.map((d) => build(d.raw, d.dimension ?? (d.unknownKey ? `?${d.unknownKey}` : siblingsDim), d.value)),
    };
  };
  return { tree: build(roots[0]), problems };
}

const PMAX_TREE_FIELDS = [
  "asset_group_listing_group_filter.resource_name",
  "asset_group_listing_group_filter.id",
  "asset_group_listing_group_filter.type",
  "asset_group_listing_group_filter.listing_source",
  "asset_group_listing_group_filter.parent_listing_group_filter",
  ...CASE_VALUE_FIELDS.map((f) => `asset_group_listing_group_filter.case_value.${f}`),
  "asset_group_listing_group_filter.case_value.webpage.conditions",
  "asset_group.id",
  "asset_group.name",
  "asset_group.status",
  "campaign.id",
  "campaign.name",
];

const SHOPPING_TREE_FIELDS = [
  "ad_group_criterion.resource_name",
  "ad_group_criterion.criterion_id",
  "ad_group_criterion.status",
  "ad_group_criterion.negative",
  "ad_group_criterion.cpc_bid_micros",
  "ad_group_criterion.listing_group.type",
  "ad_group_criterion.listing_group.parent_ad_group_criterion",
  ...CASE_VALUE_FIELDS.map((f) => `ad_group_criterion.listing_group.case_value.${f}`),
  "ad_group_criterion.listing_group.case_value.product_channel_exclusivity.channel_exclusivity",
  "ad_group.id",
  "ad_group.name",
  "ad_group.status",
  "campaign.id",
  "campaign.name",
];

interface LoadedTree {
  ownerId: string;
  ownerName: string;
  ownerStatus: string;
  campaignId: string;
  campaignName: string;
  raw: RawNode[];
  /**
   * Filtros PMax de outra fonte de listagem (ex.: WEBPAGE). A API não aceita duas fontes no
   * mesmo asset group (MULTIPLE_LISTING_SOURCES): com eles presentes, a árvore de produtos só
   * é gravada se o usuário mandar removê-los (replaceOtherSources: true).
   */
  otherSources: OtherSourceFilter[];
}

interface OtherSourceFilter {
  resourceName: string;
  listingSource: string;
  type: string;
  /** Resumo legível das condições (ex.: URL contém "/promo"). */
  detail: string;
}

/** Condições de um filtro WEBPAGE (custom_label / url_contains), para o usuário saber o que seria removido. */
function describeWebpageConditions(caseValue: unknown): string {
  const conditions = (obj(obj(caseValue).webpage).conditions as Row[] | undefined) ?? [];
  const parts = conditions.map((c) => {
    const condition = obj(c);
    if (condition.urlContains !== undefined) return `URL contém "${condition.urlContains}"`;
    if (condition.customLabel !== undefined) return `rótulo "${condition.customLabel}"`;
    return JSON.stringify(condition);
  });
  return parts.join(" E ");
}

function describeOtherSource(o: OtherSourceFilter): string {
  return `${o.listingSource}${o.type ? ` ${o.type}` : ""}${o.detail ? ` (${o.detail})` : ""} — ${o.resourceName}`;
}

/** Recusa antes de gravar: árvore de produtos não convive com filtros de outra fonte no mesmo asset group. */
function otherSourcesRefusal(ownerLabel: string, others: OtherSourceFilter[], howToReplace: string): string {
  const sources = [...new Set(others.map((o) => o.listingSource))].join(", ");
  return (
    `Nada foi alterado: o ${ownerLabel} tem ${others.length} filtro(s) de outra fonte de listagem (${sources}):\n` +
    `- ${others.map(describeOtherSource).join("\n- ")}\n\n` +
    `Um asset group aceita filtros de UMA fonte só (listing_source): a API recusa árvore de produtos (SHOPPING) ao lado ` +
    `desses filtros (MULTIPLE_LISTING_SOURCES). ${howToReplace} Para manter esses filtros, segmente os produtos em outro asset group.`
  );
}

/** Árvores PMax (só listing_source SHOPPING) por asset group. */
async function loadPmaxTrees(client: GoogleAdsClient, customerId: string, where: string): Promise<Map<string, LoadedTree>> {
  const rows = await client.searchStream(customerId,
    `SELECT ${PMAX_TREE_FIELDS.join(", ")} FROM asset_group_listing_group_filter WHERE ${where}`);
  const trees = new Map<string, LoadedTree>();
  for (const row of rows) {
    const filter = obj(row.assetGroupListingGroupFilter);
    const assetGroup = obj(row.assetGroup);
    const campaign = obj(row.campaign);
    const ownerId = String(assetGroup.id ?? String(filter.resourceName ?? "").split("/").pop()?.split("~")[0] ?? "");
    const tree = trees.get(ownerId) ?? {
      ownerId,
      ownerName: String(assetGroup.name ?? ""),
      ownerStatus: String(assetGroup.status ?? ""),
      campaignId: String(campaign.id ?? ""),
      campaignName: String(campaign.name ?? ""),
      raw: [],
      otherSources: [],
    };
    trees.set(ownerId, tree);
    const source = String(filter.listingSource ?? "SHOPPING");
    const type = String(filter.type ?? "");
    if (source !== "SHOPPING") {
      tree.otherSources.push({
        resourceName: String(filter.resourceName),
        listingSource: source,
        type,
        detail: source === "WEBPAGE" ? describeWebpageConditions(filter.caseValue) : "",
      });
      continue;
    }
    tree.raw.push({
      resourceName: String(filter.resourceName),
      parent: filter.parentListingGroupFilter ? String(filter.parentListingGroupFilter) : undefined,
      unit: type !== "SUBDIVISION",
      excluded: type === "UNIT_EXCLUDED",
      caseValue: filter.caseValue,
    });
  }
  return trees;
}

/** Árvores do Shopping padrão (ad_group_criterion LISTING_GROUP) por ad group. */
async function loadShoppingTrees(client: GoogleAdsClient, customerId: string, where?: string): Promise<Map<string, LoadedTree>> {
  const rows = await client.searchStream(customerId,
    `SELECT ${SHOPPING_TREE_FIELDS.join(", ")} FROM ad_group_criterion
     WHERE ad_group_criterion.type = 'LISTING_GROUP' AND ad_group_criterion.status != 'REMOVED'${where ? ` AND ${where}` : ""}`);
  const trees = new Map<string, LoadedTree>();
  for (const row of rows) {
    const criterion = obj(row.adGroupCriterion);
    const listingGroup = obj(criterion.listingGroup);
    const adGroup = obj(row.adGroup);
    const campaign = obj(row.campaign);
    const ownerId = String(adGroup.id ?? String(criterion.resourceName ?? "").split("/").pop()?.split("~")[0] ?? "");
    const tree = trees.get(ownerId) ?? {
      ownerId,
      ownerName: String(adGroup.name ?? ""),
      ownerStatus: String(adGroup.status ?? ""),
      campaignId: String(campaign.id ?? ""),
      campaignName: String(campaign.name ?? ""),
      raw: [],
      otherSources: [],
    };
    trees.set(ownerId, tree);
    const bid = criterion.cpcBidMicros;
    tree.raw.push({
      resourceName: String(criterion.resourceName),
      parent: listingGroup.parentAdGroupCriterion ? String(listingGroup.parentAdGroupCriterion) : undefined,
      unit: String(listingGroup.type ?? "") !== "SUBDIVISION",
      excluded: criterion.negative === true,
      cpcBidMicros: bid !== undefined && bid !== null && bid !== "" ? Number(bid) : undefined,
      caseValue: listingGroup.caseValue,
    });
  }
  return trees;
}

// ══ Operações ══════════════════════════════════════════════════════════

interface TreeTarget {
  engine: Engine;
  cid: string;
  ownerId: string;
}

/** Cria a (sub)árvore em pré-ordem, com IDs temporários: pai antes dos filhos, numa requisição só. */
function createOperations(tree: LgNode, target: TreeTarget, parentResource?: string, counter = { n: 0 }): Row[] {
  const ops: Row[] = [];
  const add = (node: LgNode, parent?: string) => {
    counter.n -= 1;
    const caseValue = node.dimension ? { caseValue: caseValueOf(node.dimension, node.value) } : {};
    let resourceName: string;
    if (target.engine === "PMAX") {
      resourceName = `customers/${target.cid}/assetGroupListingGroupFilters/${target.ownerId}~${counter.n}`;
      ops.push({
        assetGroupListingGroupFilterOperation: {
          create: {
            resourceName,
            assetGroup: `customers/${target.cid}/assetGroups/${target.ownerId}`,
            type: node.unit ? (node.excluded ? "UNIT_EXCLUDED" : "UNIT_INCLUDED") : "SUBDIVISION",
            listingSource: "SHOPPING",
            ...caseValue,
            ...(parent ? { parentListingGroupFilter: parent } : {}),
          },
        },
      });
    } else {
      resourceName = `customers/${target.cid}/adGroupCriteria/${target.ownerId}~${counter.n}`;
      ops.push({
        adGroupCriterionOperation: {
          create: {
            resourceName,
            adGroup: `customers/${target.cid}/adGroups/${target.ownerId}`,
            status: "ENABLED",
            listingGroup: {
              type: node.unit ? "UNIT" : "SUBDIVISION",
              ...caseValue,
              ...(parent ? { parentAdGroupCriterion: parent } : {}),
            },
            ...(node.unit && node.excluded ? { negative: true } : {}),
            ...(node.unit && !node.excluded && node.cpcBidMicros !== undefined ? { cpcBidMicros: String(node.cpcBidMicros) } : {}),
          },
        },
      });
    }
    for (const child of sortChildren(node.children)) add(child, resourceName);
  };
  add(tree, parentResource);
  return ops;
}

/**
 * Remoção da árvore atual. PMax: todos os nós, filhos antes dos pais (como no exemplo
 * oficial). Shopping padrão: só a raiz — remover a raiz remove a árvore inteira, e
 * remover descendentes na mesma requisição daria LISTING_GROUP_CANNOT_BE_REMOVED.
 */
function removeOperations(raw: RawNode[], engine: Engine, only?: Set<string>): Row[] {
  const nodes = only ? raw.filter((n) => only.has(n.resourceName)) : raw;
  if (engine === "SHOPPING") {
    const names = new Set(nodes.map((n) => n.resourceName));
    return nodes
      .filter((n) => !n.parent || !names.has(n.parent))
      .map((n) => ({ adGroupCriterionOperation: { remove: n.resourceName } }));
  }
  const parentOf = new Map(raw.map((n) => [n.resourceName, n.parent ?? ""]));
  const depth = (name: string, seen = 0): number => {
    const parent = parentOf.get(name);
    return parent && seen < 50 ? 1 + depth(parent, seen + 1) : 0;
  };
  return [...nodes]
    .sort((a, b) => depth(b.resourceName) - depth(a.resourceName))
    .map((n) => ({ assetGroupListingGroupFilterOperation: { remove: n.resourceName } }));
}

function subtreeNames(node: LgNode): Set<string> {
  const names = new Set<string>();
  walkTree(node, (n) => {
    if (n.resourceName) names.add(n.resourceName);
  });
  return names;
}

/** Traduz os erros de árvore mais comuns. */
function explainTreeError(message: string): string {
  const hints: string[] = [];
  if (/TREE_WAS_INVALID_BEFORE_MUTATION|invalid before the mutation/i.test(message)) {
    hints.push("A árvore atual já estava inválida na conta: reconstrua-a inteira (replace: true).");
  }
  if (/TOO_DEEP|too deep/i.test(message)) hints.push("A árvore passou da profundidade máxima aceita pela API — use menos níveis.");
  if (/OTHERS_CASE|EVERYTHING_ELSE/i.test(message)) hints.push("Toda subdivisão precisa do nó \"outros\" (o MCP cria sozinho quando ele não é informado).");
  if (/INVALID_PRODUCT_BIDDING_CATEGORY|bidding category/i.test(message)) {
    hints.push("categoryId inválido — use o ID de product_category_constant do nível certo.");
  }
  if (/LISTING_GROUP_ALREADY_EXISTS|already exists/i.test(message)) hints.push("Já existe árvore neste grupo — releia com get_listing_group_tree e use replace: true.");
  if (/MULTIPLE_LISTING_SOURCES|same listing source/i.test(message)) {
    hints.push(
      "Um asset group aceita filtros de uma fonte só (listing_source): árvore de produtos (SHOPPING) não convive com filtros de " +
        "página (WEBPAGE). Releia com get_listing_group_tree; para trocar os filtros de página pela árvore de produtos, use " +
        "set_listing_group_filter com replaceOtherSources: true."
    );
  }
  return hints.length ? `${message}\n${hints.join("\n")}` : message;
}

/** Mensagens das falhas de vínculo com o Merchant Center (ProductLinkError / ProductLinkInvitationError). */
function explainProductLinkError(message: string): string {
  const hints: string[] = [];
  if (/CREATION_NOT_PERMITTED|creation request is not permitted/i.test(message)) {
    hints.push(
      "Vínculo direto exige acesso de administrador nas DUAS contas (Google Ads e Merchant Center). Sem isso, envie a " +
        "solicitação pelo Merchant Center e aceite aqui com respond_merchant_center_invitation."
    );
  }
  if (/LINK_EXISTS|active link already exists/i.test(message)) hints.push("Já existe vínculo ativo com este Merchant Center (list_merchant_centers).");
  if (/INVITATION_EXISTS|pending link already exists/i.test(message)) {
    hints.push("Já existe convite pendente para este Merchant Center — aceite com respond_merchant_center_invitation.");
  }
  if (/INVALID_OPERATION|operation is invalid/i.test(message)) {
    hints.push("Vínculos criados pelo Business Manager (ou de parceiro) não podem ser alterados pela API — faça pelo Business Manager/Merchant Center.");
  }
  if (/PERMISSION_DENIED|doesn't have the permission/i.test(message)) hints.push("O usuário do OAuth não tem permissão para esta ação nesta conta.");
  if (/INVALID_STATUS|invitation status is invalid/i.test(message)) {
    hints.push("O convite não está mais pendente (já aceito, recusado, revogado ou expirado) — releia com list_merchant_centers.");
  }
  return hints.length ? `${message}\n${hints.join("\n")}` : message;
}

const responsesOf = (result: Row): Row[] => (result.mutateOperationResponses as Row[] | undefined) ?? [];
const resourceOfResponse = (response: Row): string | undefined => {
  const inner = Object.values(response ?? {})[0] as Row | undefined;
  return inner?.resourceName ? String(inner.resourceName) : undefined;
};

// ══ Esquemas compartilhados ════════════════════════════════════════════

const pathElementSchema = z.object({
  dimension: z.enum(DIMENSION_NAMES).describe("Dimensão do nível (ex.: PRODUCT_BRAND, PRODUCT_CONDITION, PRODUCT_CUSTOM_ATTRIBUTE0)."),
  value: z
    .string()
    .optional()
    .describe("Valor. OMITIDO = nó \"outros\" (todo o resto daquela dimensão). Categoria = ID numérico; condição NEW/USED/REFURBISHED; canal ONLINE/LOCAL."),
});

const unitSchema = z.object({
  path: z.array(pathElementSchema).describe("Caminho desde a raiz até a folha. [] = raiz única (todos os produtos)."),
  excluded: z.boolean().optional().describe("true = excluir estes produtos. Default: false (incluídos)."),
  cpcBidMicros: z.number().optional().describe("Só Shopping padrão: CPC da folha em micros (1000000 = R$1)."),
});

const othersPolicySchema = z
  .enum(["AUTO", "INCLUDE", "EXCLUDE"])
  .optional()
  .describe(
    "Nó \"outros\" que você não informar: AUTO (default) = excluído se o nível tem alguma inclusão (só o listado veicula), incluído se só há exclusões; INCLUDE/EXCLUDE força."
  );

// ══ Registro ═══════════════════════════════════════════════════════════

export function registerShoppingTools(ctx: ToolContext): void {
  const { mcp, getClient, allowedCustomerIds, hosted } = ctx;

  // ── Merchant Center ─────────────────────────────────────────────────

  mcp.registerTool(
    "list_merchant_centers",
    {
      description: [
        "Lista os Merchant Centers da conta: vínculos ativos (product_link), convites pendentes",
        "(product_link_invitation) e quais campanhas Shopping/PMax usam cada MC.",
        "Vínculo sem campanha aparece aqui; convite PENDING_APPROVAL se aceita com",
        "respond_merchant_center_invitation. Nomes do MC não vêm pela API do Google Ads (só o ID).",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        includeInvitationHistory: z
          .boolean()
          .optional()
          .describe("true = também convites encerrados (aceitos, recusados, revogados, expirados). Default: false."),
      },
    },
    async ({ customerId, includeInvitationHistory }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();
      const readErrors: string[] = [];
      const safeRead = async (label: string, query: string): Promise<Row[]> => {
        try {
          return await client.searchStream(customerId, query);
        } catch (err) {
          readErrors.push(`${label}: ${(err as Error).message}`);
          return [];
        }
      };

      const links = await safeRead("product_link",
        `SELECT product_link.resource_name, product_link.product_link_id, product_link.type,
                product_link.merchant_center.merchant_center_id
         FROM product_link
         WHERE product_link.type = 'MERCHANT_CENTER'`);
      const invitations = await safeRead("product_link_invitation",
        `SELECT product_link_invitation.resource_name, product_link_invitation.product_link_invitation_id,
                product_link_invitation.status, product_link_invitation.type,
                product_link_invitation.merchant_center.merchant_center_id
         FROM product_link_invitation
         WHERE product_link_invitation.type = 'MERCHANT_CENTER'`);
      const campaigns = await safeRead("campaign",
        `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type,
                campaign.shopping_setting.merchant_id, campaign.shopping_setting.feed_label
         FROM campaign
         WHERE campaign.shopping_setting.merchant_id > 0 AND campaign.status != 'REMOVED'`);

      const campaignsByMerchant = new Map<string, Row[]>();
      for (const row of campaigns) {
        const campaign = obj(row.campaign);
        const setting = obj(campaign.shoppingSetting);
        const mid = String(setting.merchantId ?? "");
        if (!mid) continue;
        campaignsByMerchant.set(mid, [
          ...(campaignsByMerchant.get(mid) ?? []),
          {
            id: String(campaign.id ?? ""),
            name: campaign.name,
            type: campaign.advertisingChannelType,
            status: campaign.status,
            feed_label: setting.feedLabel || "(todos os feeds)",
          },
        ]);
      }

      const linked = links.map((row) => {
        const link = obj(row.productLink);
        const mid = String(obj(link.merchantCenter).merchantCenterId ?? "");
        const using = campaignsByMerchant.get(mid) ?? [];
        return {
          merchant_id: mid,
          product_link_id: String(link.productLinkId ?? ""),
          resource_name: link.resourceName,
          campaigns_using: using,
          feed_labels_in_use: [...new Set(using.map((c) => String(c.feed_label)))],
        };
      });
      const linkedIds = new Set(linked.map((l) => l.merchant_id));

      const invitationRows = invitations.map((row) => {
        const inv = obj(row.productLinkInvitation);
        return {
          invitation_id: String(inv.productLinkInvitationId ?? ""),
          merchant_id: String(obj(inv.merchantCenter).merchantCenterId ?? ""),
          status: String(inv.status ?? ""),
          resource_name: inv.resourceName,
        };
      });
      const pending = invitationRows
        .filter((i) => i.status === "PENDING_APPROVAL")
        .map((i) => ({ ...i, next_step: "Aceite ou recuse com respond_merchant_center_invitation (recusa é definitiva)." }));
      const sent = invitationRows
        .filter((i) => i.status === "REQUESTED")
        .map((i) => ({ ...i, next_step: "Convite enviado por esta conta — aguarda aprovação no Merchant Center." }));
      const history = invitationRows.filter((i) => i.status !== "PENDING_APPROVAL" && i.status !== "REQUESTED");

      const withoutLink = [...campaignsByMerchant.entries()]
        .filter(([mid]) => !linkedIds.has(mid))
        .map(([mid, using]) => ({
          merchant_id: mid,
          campaigns_using: using,
          note: "Usado por campanha mas sem product_link nesta conta (vínculo pela conta de administrador, Business Manager, ou vínculo removido).",
        }));

      const result = {
        linked,
        pending_invitations: pending,
        sent_invitations: sent,
        ...(includeInvitationHistory ? { invitation_history: history } : {}),
        merchants_in_campaigns_without_link: withoutLink,
        ...(readErrors.length ? { read_errors: readErrors } : {}),
      };
      const summary = [
        `${linked.length} Merchant Center(s) vinculado(s)`,
        `${pending.length} convite(s) aguardando sua aprovação`,
        `${sent.length} convite(s) enviado(s) aguardando o MC`,
        `${withoutLink.length} MC(s) em campanhas sem vínculo direto`,
      ].join(" · ");
      return {
        content: [text(`${summary}${readErrors.length ? `\nFalha ao ler: ${readErrors.join(" | ")}` : ""}\n\n${formatJson(result)}`)],
        ...(readErrors.length && !links.length && !campaigns.length ? { isError: true } : {}),
      };
    }
  );

  mcp.registerTool(
    "respond_merchant_center_invitation",
    {
      description: [
        "Aceita ou recusa um convite de vínculo enviado por um Merchant Center (status PENDING_APPROVAL).",
        "WRITE OPERATION — exige confirm: true. RECUSAR É DEFINITIVO: um convite recusado não pode",
        "ser aceito depois; o Merchant Center precisa enviar outro.",
        "Pegue o invitationId em list_merchant_centers (pending_invitations).",
        "A API não tem validate_only para este método: em validateOnly/dry-run nada é enviado.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        invitationId: z.string().describe("ID numérico do convite ou customers/{cid}/productLinkInvitations/{id}."),
        action: z.enum(["ACCEPT", "REJECT"]).describe("ACCEPT = aceitar; REJECT = recusar (definitivo)."),
        confirm: z.boolean().optional().describe("Precisa ser true para aplicar."),
      },
    },
    async ({ customerId, invitationId, action, confirm }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = customerId.replace(/-/g, "");
      const ref = String(invitationId ?? "").trim();
      const match = /^customers\/([\d-]+)\/productLinkInvitations\/(\d+)$/.exec(ref);
      if (match && match[1].replace(/-/g, "") !== cid) {
        return fail(`${ref} pertence à conta ${match[1]}, não à ${cid}. Nada foi alterado.`);
      }
      const id = match ? match[2] : ref;
      if (!isId(id)) return fail(`invitationId inválido ("${invitationId}") — use o ID numérico ou o resource name. Nada foi alterado.`);

      const client = getClient();
      const rows = await client.searchStream(customerId,
        `SELECT product_link_invitation.resource_name, product_link_invitation.product_link_invitation_id,
                product_link_invitation.status, product_link_invitation.type,
                product_link_invitation.merchant_center.merchant_center_id
         FROM product_link_invitation
         WHERE product_link_invitation.product_link_invitation_id = ${id}`);
      const inv = obj(rows[0]?.productLinkInvitation);
      if (!inv.resourceName) return fail(`Convite ${id} não encontrado na conta ${cid}. Nada foi alterado.`);
      if (inv.type !== "MERCHANT_CENTER") {
        return fail(`O convite ${id} é do tipo ${inv.type}, não Merchant Center — esta tool só trata convites de MC. Nada foi alterado.`);
      }
      const mid = String(obj(inv.merchantCenter).merchantCenterId ?? "");
      const status = String(inv.status ?? "");
      const target = action === "ACCEPT" ? "ACCEPTED" : "REJECTED";
      if (status === target) {
        return ok(`Nada a fazer: o convite ${id} (Merchant Center ${mid}) já está ${status}.`);
      }
      if (status === "REQUESTED") {
        return fail(`O convite ${id} foi enviado por esta conta ao Merchant Center ${mid} e aguarda aprovação lá — não se aceita/recusa deste lado. Nada foi alterado.`);
      }
      if (status !== "PENDING_APPROVAL") {
        return fail(`O convite ${id} (Merchant Center ${mid}) está ${status} — só convites PENDING_APPROVAL podem ser respondidos. Nada foi alterado.`);
      }
      const body = { resourceName: String(inv.resourceName), productLinkInvitationStatus: target };
      const preview = `Convite ${id} · Merchant Center ${mid} · ${status} → ${target}`;
      if (client.isDryRun) {
        return fail(
          `DRY-RUN: a API não oferece validate_only para UpdateProductLinkInvitation — nada foi enviado nem validado.\n${preview}\n` +
            `Corpo que seria enviado a productLinkInvitations:update:\n${formatJson(body)}`
        );
      }
      if (confirm !== true) {
        return fail(
          `Prévia (nada foi alterado): ${preview}.\n` +
            (action === "REJECT" ? "ATENÇÃO: a recusa é definitiva — o Merchant Center terá de enviar novo convite.\n" : "") +
            "Envie confirm: true para aplicar."
        );
      }
      try {
        const result = await client.customerWriteAction<Row>(cid, "productLinkInvitations:update", body);
        return ok(
          `${action === "ACCEPT" ? "Convite aceito" : "Convite recusado"}: ${preview}.\n` +
            (action === "ACCEPT"
              ? "O vínculo fica ativo; confira com list_merchant_centers e use o MC em create_shopping_campaign."
              : "Para vincular este MC no futuro, o Merchant Center precisa enviar um novo convite.") +
            `\n\n${formatJson(result)}`
        );
      } catch (err) {
        return fail(`Nada foi alterado. Erro: ${explainProductLinkError((err as Error).message)}`);
      }
    }
  );

  mcp.registerTool(
    "link_merchant_center",
    {
      description: [
        "Vincula diretamente um Merchant Center à conta (ProductLinkService.CreateProductLink).",
        "WRITE OPERATION — exige confirm: true. Só funciona se o usuário do OAuth for administrador",
        "nas DUAS contas; sem isso, envie a solicitação pelo Merchant Center e aceite com",
        "respond_merchant_center_invitation. A API não tem validate_only para este método:",
        "em validateOnly/dry-run nada é enviado.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        merchantId: z.string().describe("ID numérico do Merchant Center."),
        confirm: z.boolean().optional().describe("Precisa ser true para aplicar."),
      },
    },
    async ({ customerId, merchantId, confirm }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = customerId.replace(/-/g, "");
      const mid = String(merchantId ?? "").trim();
      if (!isId(mid)) return fail(`merchantId inválido ("${merchantId}") — use o ID numérico do Merchant Center. Nada foi alterado.`);

      const client = getClient();
      const links = await client.searchStream(customerId,
        `SELECT product_link.resource_name, product_link.product_link_id, product_link.merchant_center.merchant_center_id
         FROM product_link
         WHERE product_link.type = 'MERCHANT_CENTER' AND product_link.merchant_center.merchant_center_id = ${mid}`);
      const existing = obj(links[0]?.productLink);
      if (existing.resourceName) {
        return ok(`Nada a fazer: o Merchant Center ${mid} já está vinculado (product_link ${existing.productLinkId}).`);
      }
      const invitations = await client.searchStream(customerId,
        `SELECT product_link_invitation.product_link_invitation_id, product_link_invitation.status,
                product_link_invitation.merchant_center.merchant_center_id
         FROM product_link_invitation
         WHERE product_link_invitation.type = 'MERCHANT_CENTER'
           AND product_link_invitation.merchant_center.merchant_center_id = ${mid}`);
      const open = invitations.map((r) => obj(r.productLinkInvitation)).find((i) => i.status === "PENDING_APPROVAL" || i.status === "REQUESTED");
      if (open?.status === "PENDING_APPROVAL") {
        return fail(
          `Já existe convite pendente do Merchant Center ${mid} (convite ${open.productLinkInvitationId}). ` +
            "Aceite com respond_merchant_center_invitation em vez de criar vínculo novo. Nada foi alterado."
        );
      }
      if (open?.status === "REQUESTED") {
        return fail(`Já existe convite enviado ao Merchant Center ${mid} aguardando aprovação lá (convite ${open.productLinkInvitationId}). Nada foi alterado.`);
      }
      const body = { productLink: { merchantCenter: { merchantCenterId: mid } } };
      if (client.isDryRun) {
        return fail(
          "DRY-RUN: a API não oferece validate_only para CreateProductLink — nada foi enviado nem validado.\n" +
            `Corpo que seria enviado a productLinks:create:\n${formatJson(body)}`
        );
      }
      if (confirm !== true) {
        return fail(`Prévia (nada foi alterado): vincular o Merchant Center ${mid} à conta ${cid}. Envie confirm: true para aplicar.`);
      }
      try {
        const result = await client.customerWriteAction<Row>(cid, "productLinks:create", body);
        return ok(`Merchant Center ${mid} vinculado à conta ${cid}: ${String(result.resourceName ?? "(sem resource name na resposta)")}.\n\n${formatJson(result)}`);
      } catch (err) {
        return fail(`Nada foi alterado. Erro: ${explainProductLinkError((err as Error).message)}`);
      }
    }
  );

  mcp.registerTool(
    "unlink_merchant_center",
    {
      description: [
        "Desvincula um Merchant Center da conta (ProductLinkService.RemoveProductLink).",
        "WRITE OPERATION — exige confirm: true. Campanhas Shopping/PMax que usam o MC param de",
        "receber produtos; a tool lista quais antes de aplicar. Vínculos criados pelo Business",
        "Manager não podem ser removidos pela API. Aceita validateOnly (a API valida sem remover).",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        productLinkId: z.string().optional().describe("ID do product_link (list_merchant_centers). Use este OU merchantId."),
        merchantId: z.string().optional().describe("ID do Merchant Center vinculado. Use este OU productLinkId."),
        confirm: z.boolean().optional().describe("Precisa ser true para aplicar."),
      },
    },
    async ({ customerId, productLinkId, merchantId, confirm }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = customerId.replace(/-/g, "");
      if ((productLinkId === undefined) === (merchantId === undefined)) {
        return fail("Informe productLinkId OU merchantId (exatamente um). Nada foi alterado.");
      }
      const idValue = String(productLinkId ?? merchantId).trim();
      if (!isId(idValue)) return fail(`${productLinkId !== undefined ? "productLinkId" : "merchantId"} inválido ("${idValue}") — use o ID numérico. Nada foi alterado.`);
      const where = productLinkId !== undefined
        ? `product_link.product_link_id = ${idValue}`
        : `product_link.type = 'MERCHANT_CENTER' AND product_link.merchant_center.merchant_center_id = ${idValue}`;

      const client = getClient();
      const rows = await client.searchStream(customerId,
        `SELECT product_link.resource_name, product_link.product_link_id, product_link.type,
                product_link.merchant_center.merchant_center_id
         FROM product_link
         WHERE ${where}`);
      const link = obj(rows[0]?.productLink);
      if (!link.resourceName) return fail(`Nenhum vínculo encontrado (${productLinkId !== undefined ? `product_link ${idValue}` : `Merchant Center ${idValue}`}) na conta ${cid}. Nada foi alterado.`);
      if (link.type !== "MERCHANT_CENTER") {
        return fail(`O product_link ${link.productLinkId} é do tipo ${link.type}, não Merchant Center. Nada foi alterado.`);
      }
      const mid = String(obj(link.merchantCenter).merchantCenterId ?? "");
      const campaigns = isId(mid)
        ? await client.searchStream(customerId,
          `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign.shopping_setting.merchant_id
           FROM campaign
           WHERE campaign.shopping_setting.merchant_id = ${mid} AND campaign.status != 'REMOVED'`)
        : [];
      const using = campaigns.map((r) => obj(r.campaign)).map((c) => `${c.name} (${c.id}, ${c.advertisingChannelType}, ${c.status})`);
      const impact = using.length
        ? `ATENÇÃO: ${using.length} campanha(s) usam este MC e param de receber produtos:\n- ${using.join("\n- ")}`
        : "Nenhuma campanha ativa ou pausada usa este MC.";
      const preview = `Desvincular Merchant Center ${mid} (product_link ${link.productLinkId}) da conta ${cid}.\n${impact}`;

      if (client.isDryRun) {
        // RemoveProductLinkRequest tem validate_only: a API valida sem remover. customerWriteAction
        // recusa qualquer ação em dry-run, então o pedido vai pelo caminho sem escrita, com
        // validateOnly explícito no corpo.
        try {
          await client.customerAction<Row>(cid, "productLinks:remove", { resourceName: String(link.resourceName), validateOnly: true });
          return ok(`DRY-RUN (validateOnly): a API validou a remoção — nada foi removido.\n${preview}`);
        } catch (err) {
          return fail(`DRY-RUN: a API recusou a validação — nada foi removido. Erro: ${explainProductLinkError((err as Error).message)}`);
        }
      }
      if (confirm !== true) return fail(`Prévia (nada foi alterado): ${preview}\nEnvie confirm: true para aplicar.`);
      try {
        const result = await client.customerWriteAction<Row>(cid, "productLinks:remove", { resourceName: String(link.resourceName) });
        return ok(`Vínculo removido: ${preview}\n\n${formatJson(result)}`);
      } catch (err) {
        return fail(`Nada foi alterado. Erro: ${explainProductLinkError((err as Error).message)}`);
      }
    }
  );

  // ── Campanha Shopping padrão ─────────────────────────────────────────

  mcp.registerTool(
    "create_shopping_campaign",
    {
      description: [
        "Cria uma campanha Shopping padrão vinculada ao Merchant Center. WRITE OPERATION — nasce PAUSADA.",
        "Orçamento + campanha (+ grupo, anúncio de produto e grupo de produtos 'todos os produtos', com",
        "withDefaultAdGroup) vão num único googleAds:mutate: ou tudo, ou nada.",
        "",
        "feedLabel é opcional: omitido = TODOS os feeds do MC (o rótulo não define país; a segmentação",
        "geográfica é à parte). Quando informado, é conferido contra os produtos do MC.",
        "Estratégias (docs de Shopping padrão): MAXIMIZE_CLICKS (target_spend, default; TARGET_SPEND é",
        "sinônimo), TARGET_ROAS (campaign.target_roas; exige targetRoas) e MANUAL_CPC.",
        "MAXIMIZE_CONVERSION_VALUE: listada no Google Ads Help, mas não na doc da API para Shopping padrão",
        "— enviada como maximizeConversionValue; se a API recusar, nada é criado. MAXIMIZE_CONVERSIONS",
        "não é estratégia padrão válida para Shopping e é recusada.",
        "Sem withDefaultAdGroup a campanha não veicula até ter grupo, create_shopping_product_ad e",
        "set_shopping_product_groups.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        name: z.string().describe("Nome da campanha."),
        merchantId: z.string().describe("ID do Merchant Center vinculado (list_merchant_centers)."),
        dailyBudgetMicros: z.number().describe("Orçamento diário em MICROS (100000000 = R$100/dia)."),
        feedLabel: z
          .string()
          .optional()
          .describe("Rótulo do feed (até 20 caracteres: A-Z, 0-9, - e _). Omitido = todos os feeds do MC."),
        biddingStrategy: z
          .enum(["MAXIMIZE_CLICKS", "TARGET_SPEND", "TARGET_ROAS", "MANUAL_CPC", "MAXIMIZE_CONVERSION_VALUE", "MAXIMIZE_CONVERSIONS"])
          .optional()
          .describe("Default: MAXIMIZE_CLICKS (Maximizar cliques)."),
        targetRoas: z.number().optional().describe("ROAS alvo em decimal (5.0 = 500%). Obrigatório em TARGET_ROAS; opcional em MAXIMIZE_CONVERSION_VALUE."),
        cpcBidCeilingMicros: z.number().optional().describe("Teto de CPC em micros (só MAXIMIZE_CLICKS)."),
        campaignPriority: z.number().optional().describe("Prioridade 0 (baixa), 1 (média) ou 2 (alta). Default: 0."),
        enableLocal: z.boolean().optional().describe("true = inclui produtos vendidos em lojas físicas (inventário local)."),
        withDefaultAdGroup: z
          .boolean()
          .optional()
          .describe("true = cria também grupo SHOPPING_PRODUCT_ADS, anúncio de produto e a raiz 'todos os produtos' (ATIVOS dentro da campanha PAUSADA)."),
        adGroupName: z.string().optional().describe("Nome do grupo (withDefaultAdGroup). Default: \"<campanha> — Todos os produtos\"."),
        adGroupCpcBidMicros: z
          .number()
          .optional()
          .describe("CPC do grupo e da raiz em micros (withDefaultAdGroup). Obrigatório em MANUAL_CPC."),
      },
    },
    async ({
      customerId, name, merchantId, dailyBudgetMicros, feedLabel, biddingStrategy, targetRoas, cpcBidCeilingMicros,
      campaignPriority, enableLocal, withDefaultAdGroup, adGroupName, adGroupCpcBidMicros,
    }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = customerId.replace(/-/g, "");

      // ── Validação de entrada, antes de qualquer chamada ──
      const problems: string[] = [];
      const campaignName = String(name ?? "").trim();
      if (!campaignName) problems.push("name vazio");
      const mid = String(merchantId ?? "").trim();
      if (!isId(mid)) problems.push(`merchantId inválido ("${merchantId}") — use o ID numérico do Merchant Center`);
      if (!isPositiveMicros(dailyBudgetMicros)) problems.push(`dailyBudgetMicros deve ser inteiro positivo em micros (recebido ${dailyBudgetMicros})`);
      const priority = campaignPriority ?? 0;
      if (!Number.isInteger(priority) || priority < 0 || priority > 2) problems.push(`campaignPriority aceita 0, 1 ou 2 (recebido ${campaignPriority})`);
      let label: string | undefined;
      if (feedLabel !== undefined) {
        label = feedLabel.trim().toUpperCase();
        if (!/^[A-Z0-9_-]{1,20}$/.test(label)) {
          problems.push(`feedLabel inválido ("${feedLabel}") — até 20 caracteres: letras maiúsculas, números, hífen e sublinhado. Omita para usar todos os feeds`);
        }
      }
      const strategy = biddingStrategy === "TARGET_SPEND" ? "MAXIMIZE_CLICKS" : biddingStrategy ?? "MAXIMIZE_CLICKS";
      if (strategy === "MAXIMIZE_CONVERSIONS") {
        problems.push(
          "MAXIMIZE_CONVERSIONS não é estratégia padrão válida para Shopping (a doc da API só a aceita como padrão em Pesquisa, " +
            "Display, Vídeo e App). Use TARGET_ROAS, MAXIMIZE_CLICKS ou MANUAL_CPC — ou PMax para maximizar conversões"
        );
      }
      if (strategy === "TARGET_ROAS" && !(typeof targetRoas === "number" && targetRoas > 0)) problems.push("TARGET_ROAS exige targetRoas > 0 (5.0 = 500%)");
      if (targetRoas !== undefined && strategy !== "TARGET_ROAS" && strategy !== "MAXIMIZE_CONVERSION_VALUE") {
        problems.push("targetRoas só vale com TARGET_ROAS ou MAXIMIZE_CONVERSION_VALUE");
      }
      if (targetRoas !== undefined && !(targetRoas > 0)) problems.push(`targetRoas deve ser maior que zero (recebido ${targetRoas})`);
      if (cpcBidCeilingMicros !== undefined) {
        if (strategy !== "MAXIMIZE_CLICKS") problems.push("cpcBidCeilingMicros só vale com MAXIMIZE_CLICKS");
        else if (!isPositiveMicros(cpcBidCeilingMicros)) problems.push(`cpcBidCeilingMicros deve ser inteiro positivo em micros (recebido ${cpcBidCeilingMicros})`);
      }
      const manual = strategy === "MANUAL_CPC";
      if (!withDefaultAdGroup && (adGroupName !== undefined || adGroupCpcBidMicros !== undefined)) {
        problems.push("adGroupName / adGroupCpcBidMicros só valem com withDefaultAdGroup: true");
      }
      if (withDefaultAdGroup) {
        if (adGroupCpcBidMicros !== undefined && !isPositiveMicros(adGroupCpcBidMicros)) {
          problems.push(`adGroupCpcBidMicros deve ser inteiro positivo em micros (recebido ${adGroupCpcBidMicros})`);
        }
        if (manual && adGroupCpcBidMicros === undefined) {
          problems.push("MANUAL_CPC com withDefaultAdGroup exige adGroupCpcBidMicros (lance do grupo 'todos os produtos')");
        }
        if (adGroupName !== undefined && !adGroupName.trim()) problems.push("adGroupName vazio");
      }
      if (problems.length) return fail(`Nada foi criado:\n- ${problems.join("\n- ")}`);

      const client = getClient();
      const warnings: string[] = [];

      // ── Leitura: MC vinculado e feed labels existentes ──
      const links = await client.searchStream(customerId,
        `SELECT product_link.resource_name, product_link.merchant_center.merchant_center_id
         FROM product_link
         WHERE product_link.type = 'MERCHANT_CENTER' AND product_link.merchant_center.merchant_center_id = ${mid}`);
      if (links.length === 0) {
        warnings.push(
          `O Merchant Center ${mid} não aparece em product_link desta conta (pode estar vinculado pela conta de administrador). ` +
            "Se não estiver vinculado, a API recusa e nada é criado — veja list_merchant_centers."
        );
      }
      const SAMPLE = 10000;
      let products = await client.searchStream(customerId,
        `SELECT shopping_product.feed_label, shopping_product.merchant_center_id
         FROM shopping_product
         WHERE shopping_product.merchant_center_id = ${mid}
         LIMIT ${SAMPLE}`);
      if (products.length === 0) {
        // merchantId pode ser o da conta multicliente (MCA)
        products = await client.searchStream(customerId,
          `SELECT shopping_product.feed_label, shopping_product.multi_client_account_id
           FROM shopping_product
           WHERE shopping_product.multi_client_account_id = ${mid}
           LIMIT ${SAMPLE}`);
      }
      const labels = new Set(products.map((r) => String(obj(r.shoppingProduct).feedLabel ?? "")).filter(Boolean));
      const complete = products.length < SAMPLE;
      if (products.length === 0) {
        warnings.push(`Nenhum produto do Merchant Center ${mid} visível nesta conta — a campanha não terá o que veicular até o feed aparecer.`);
      } else if (label !== undefined && !labels.has(label)) {
        if (complete) {
          return fail(
            `Nada foi criado: o feedLabel "${label}" não existe nos produtos do Merchant Center ${mid} ` +
              `(feed labels encontrados: ${[...labels].sort().join(", ") || "nenhum"}). Omita feedLabel para usar todos os feeds.`
          );
        }
        warnings.push(`feedLabel "${label}" não apareceu na amostra de ${SAMPLE} produtos (labels vistos: ${[...labels].sort().join(", ")}). Confira no Merchant Center.`);
      } else if (label === undefined && labels.size > 1) {
        warnings.push(`O MC tem ${labels.size} feed labels (${[...labels].sort().join(", ")}): sem feedLabel a campanha usa todos.`);
      }

      // ── Escrita atômica ──
      const budgetTmp = `customers/${cid}/campaignBudgets/-1`;
      const campaignTmp = `customers/${cid}/campaigns/-2`;
      const adGroupTmp = `customers/${cid}/adGroups/-3`;
      const campaignData: Row = {
        resourceName: campaignTmp,
        name: campaignName,
        status: "PAUSED",
        advertisingChannelType: "SHOPPING",
        campaignBudget: budgetTmp,
        containsEuPoliticalAdvertising: EU_POLITICAL_DECLARATION,
        shoppingSetting: {
          merchantId: mid,
          campaignPriority: priority,
          ...(label !== undefined ? { feedLabel: label } : {}),
          ...(enableLocal !== undefined ? { enableLocal } : {}),
        },
        // Shopping padrão recusa target_content_network=true (CANNOT_TARGET_CONTENT_NETWORK)
        networkSettings: { targetGoogleSearch: true, targetSearchNetwork: true, targetContentNetwork: false },
      };
      if (strategy === "MANUAL_CPC") campaignData.manualCpc = {};
      else if (strategy === "TARGET_ROAS") campaignData.targetRoas = { targetRoas };
      else if (strategy === "MAXIMIZE_CONVERSION_VALUE") campaignData.maximizeConversionValue = targetRoas ? { targetRoas } : {};
      else campaignData.targetSpend = cpcBidCeilingMicros ? { cpcBidCeilingMicros: String(cpcBidCeilingMicros) } : {};

      const groupName = withDefaultAdGroup ? (adGroupName?.trim() || `${campaignName} — Todos os produtos`) : "";
      const operations: Row[] = [
        {
          campaignBudgetOperation: {
            create: {
              resourceName: budgetTmp,
              name: `Budget — ${campaignName}`,
              amountMicros: String(dailyBudgetMicros),
              deliveryMethod: "STANDARD",
              explicitlyShared: false,
            },
          },
        },
        { campaignOperation: { create: campaignData } },
      ];
      if (withDefaultAdGroup) {
        const bid = adGroupCpcBidMicros !== undefined ? { cpcBidMicros: String(adGroupCpcBidMicros) } : {};
        operations.push(
          { adGroupOperation: { create: { resourceName: adGroupTmp, name: groupName, campaign: campaignTmp, type: "SHOPPING_PRODUCT_ADS", status: "ENABLED", ...bid } } },
          { adGroupAdOperation: { create: { adGroup: adGroupTmp, status: "ENABLED", ad: { shoppingProductAd: {} } } } },
          { adGroupCriterionOperation: { create: { adGroup: adGroupTmp, status: "ENABLED", listingGroup: { type: "UNIT" }, ...bid } } }
        );
        if (!manual && adGroupCpcBidMicros !== undefined) warnings.push(`A campanha usa ${strategy}: o lance automático ignora o CPC do grupo.`);
      }
      if (adGroupCpcBidMicros !== undefined && adGroupCpcBidMicros < LOW_BID_MICROS) {
        warnings.push(`CPC muito baixo (${money(adGroupCpcBidMicros)}): o grupo pode não ganhar leilões.`);
      }
      if (strategy === "MAXIMIZE_CLICKS" && !cpcBidCeilingMicros) warnings.push("Maximizar cliques sem teto: o Google pode pagar CPCs altos (defina cpcBidCeilingMicros se precisar).");
      if (strategy === "MAXIMIZE_CONVERSION_VALUE") {
        warnings.push("MAXIMIZE_CONVERSION_VALUE não consta na doc da API para Shopping padrão (só no Google Ads Help). Se a API recusar, use TARGET_ROAS.");
      }

      let result: Row;
      try {
        result = await client.batchMutate(customerId, operations);
      } catch (err) {
        return fail(
          "Nada foi criado (orçamento, campanha e grupo vão na mesma operação atômica).\n" +
            `Erro: ${explainBiddingError((err as Error).message, strategy)}`
        );
      }
      const dryRun = client.isDryRun;
      const responses = responsesOf(result);
      const created = {
        campaign: resourceOfResponse(responses.find((r) => r.campaignResult) ?? {}),
        adGroup: resourceOfResponse(responses.find((r) => r.adGroupResult) ?? {}),
        ad: resourceOfResponse(responses.find((r) => r.adGroupAdResult) ?? {}),
        productGroup: resourceOfResponse(responses.find((r) => r.adGroupCriterionResult) ?? {}),
      };
      if (!dryRun && !created.campaign) {
        return fail(`A API não confirmou a criação da campanha — confira na conta antes de repetir.\n\n${formatJson(result)}`);
      }
      const bidding =
        strategy === "TARGET_ROAS" ? `TARGET_ROAS (${targetRoas})`
          : strategy === "MAXIMIZE_CLICKS" ? `MAXIMIZE_CLICKS${cpcBidCeilingMicros ? ` (teto ${money(cpcBidCeilingMicros)})` : ""}`
            : strategy === "MAXIMIZE_CONVERSION_VALUE" && targetRoas ? `MAXIMIZE_CONVERSION_VALUE (ROAS ${targetRoas})` : strategy;
      const lines = [
        dryRun ? "DRY-RUN (validateOnly): a API validou a operação — nada foi criado." : "Campanha Shopping criada (PAUSADA):",
        `- Nome: ${campaignName}`,
        `- Merchant Center: ${mid} · feed: ${label ?? "todos os feeds"} · prioridade ${priority}${enableLocal !== undefined ? ` · local ${enableLocal ? "sim" : "não"}` : ""}`,
        `- Orçamento: ${money(dailyBudgetMicros)}/dia`,
        `- Lances: ${bidding}`,
        ...(created.campaign ? [`- Campanha: ${created.campaign}`] : []),
        ...(withDefaultAdGroup
          ? [
            `- Grupo "${groupName}" (SHOPPING_PRODUCT_ADS, ativo), anúncio de produto (ativo) e grupo de produtos "todos os produtos"` +
              (adGroupCpcBidMicros !== undefined ? ` com CPC ${money(adGroupCpcBidMicros)}` : ""),
            ...(created.adGroup ? [`- Grupo: ${created.adGroup}`] : []),
          ]
          : ["- Sem grupo: para veicular, crie o grupo (create_ad_group), o anúncio (create_shopping_product_ad) e os grupos de produtos (set_shopping_product_groups)."]),
        ...(warnings.length ? ["", "Avisos:", ...warnings.map((w) => `- ${w}`)] : []),
        ...(dryRun ? [] : ["", "Ative com update_campaign (status ENABLED) quando estiver pronta."]),
      ];
      return ok(lines.join("\n"));
    }
  );

  mcp.registerTool(
    "create_shopping_product_ad",
    {
      description: [
        "Cria o anúncio de produto (shopping_product_ad) de um grupo SHOPPING_PRODUCT_ADS de campanha",
        "Shopping padrão. WRITE OPERATION. Sem ele o grupo não veicula. Um por grupo: se já existe,",
        "nada é criado. Nasce PAUSADO por padrão (status: ENABLED para ativar já).",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        adGroupId: z.string().describe("ID numérico do grupo de anúncios (SHOPPING_PRODUCT_ADS)."),
        status: z.enum(["ENABLED", "PAUSED"]).optional().describe("Status do anúncio. Default: PAUSED."),
      },
    },
    async ({ customerId, adGroupId, status }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = customerId.replace(/-/g, "");
      if (!isId(adGroupId)) return fail(`adGroupId inválido ("${adGroupId}") — use o ID numérico. Nada foi criado.`);
      const client = getClient();
      const groups = await client.searchStream(customerId,
        `SELECT ad_group.id, ad_group.name, ad_group.status, ad_group.type, campaign.id, campaign.name, campaign.status,
                campaign.advertising_channel_type
         FROM ad_group
         WHERE ad_group.id = ${adGroupId}`);
      const adGroup = obj(groups[0]?.adGroup);
      const campaign = obj(groups[0]?.campaign);
      if (!adGroup.id) return fail(`Grupo ${adGroupId} não encontrado na conta ${cid}. Nada foi criado.`);
      if (adGroup.status === "REMOVED") return fail(`Grupo ${adGroupId} ("${adGroup.name}") está removido. Nada foi criado.`);
      if (campaign.advertisingChannelType !== "SHOPPING" || adGroup.type !== "SHOPPING_PRODUCT_ADS") {
        return fail(
          `O grupo ${adGroupId} é ${adGroup.type} em campanha ${campaign.advertisingChannelType} — anúncio de produto só existe em grupo ` +
            "SHOPPING_PRODUCT_ADS de campanha Shopping padrão (PMax usa asset groups). Nada foi criado."
        );
      }
      const ads = await client.searchStream(customerId,
        `SELECT ad_group_ad.resource_name, ad_group_ad.status, ad_group_ad.ad.id, ad_group_ad.ad.type
         FROM ad_group_ad
         WHERE ad_group.id = ${adGroupId} AND ad_group_ad.ad.type = 'SHOPPING_PRODUCT_AD' AND ad_group_ad.status != 'REMOVED'`);
      const trees = await client.searchStream(customerId,
        `SELECT ad_group_criterion.resource_name
         FROM ad_group_criterion
         WHERE ad_group_criterion.type = 'LISTING_GROUP' AND ad_group_criterion.status != 'REMOVED' AND ad_group.id = ${adGroupId}`);
      const treeHint = trees.length === 0 ? "\nO grupo ainda não tem grupos de produtos: sem eles não veicula — use set_shopping_product_groups." : "";
      const state = `Campanha "${campaign.name}" ${campaign.status} · grupo "${adGroup.name}" ${adGroup.status}.`;
      if (ads.length > 0) {
        const existing = obj(ads[0].adGroupAd);
        return ok(
          `Nada a fazer: o grupo ${adGroupId} já tem anúncio de produto (${existing.resourceName}, ${existing.status}).` +
            (existing.status === "PAUSED" ? " Ele está PAUSADO — ative com update_ad_status se quiser veicular." : "") +
            `\n${state}${treeHint}`
        );
      }
      const adStatus = status ?? "PAUSED";
      let result: Row;
      try {
        result = await client.mutateAdGroupAds(customerId, [
          { create: { adGroup: `customers/${cid}/adGroups/${adGroupId}`, status: adStatus, ad: { shoppingProductAd: {} } } },
        ]);
      } catch (err) {
        return fail(`Nada foi criado. Erro: ${(err as Error).message}`);
      }
      const resource = String((result.results as Row[] | undefined)?.[0]?.resourceName ?? "");
      if (client.isDryRun) return ok(`DRY-RUN (validateOnly): anúncio de produto validado pela API — nada foi criado.\n${state}${treeHint}`);
      if (!resource) return fail(`A API não confirmou a criação — confira na conta antes de repetir.\n\n${formatJson(result)}`);
      return ok(
        `Anúncio de produto criado (${adStatus}): ${resource}\n${state}` +
          (adStatus === "PAUSED" ? "\nPara veicular: ative o anúncio (update_ad_status), o grupo e a campanha." : "") +
          treeHint
      );
    }
  );

  // ── Árvores de produtos ────────────────────────────────────────────

  /** Replace/no-op/atualização de lances comuns às duas tools de escrita de árvore. */
  const applyTree = async (params: {
    client: GoogleAdsClient;
    customerId: string;
    target: TreeTarget;
    existing?: LoadedTree;
    tree: LgNode;
    replace?: boolean;
    /** Filtros de outra fonte (WEBPAGE) que o usuário mandou remover (replaceOtherSources: true). */
    otherSourceRemovals?: OtherSourceFilter[];
    notes: string[];
    warnings: string[];
    ownerLabel: string;
  }): Promise<ToolResult> => {
    const { client, customerId, target, existing, tree, replace, notes, warnings, ownerLabel } = params;
    const otherRemovals = params.otherSourceRemovals ?? [];
    // Filtros de página são nós raiz (PAGE_FEED_FILTER_HAS_PARENT): a ordem entre eles não importa
    const otherRemoveOps: Row[] = otherRemovals.map((o) => ({ assetGroupListingGroupFilterOperation: { remove: o.resourceName } }));
    const current = existing && existing.raw.length ? assembleTree(existing.raw) : { tree: undefined, problems: [] as string[] };
    const before = current.tree ? renderTree(current.tree) : "(sem árvore)";
    const extra = (dryRun: boolean) => [
      ...(notes.length ? ["", "Notas:", ...notes.map((n) => `- ${n}`)] : []),
      ...(warnings.length ? ["", "Avisos:", ...warnings.map((w) => `- ${w}`)] : []),
      ...(otherRemovals.length
        ? ["", `Filtros de outras fontes ${dryRun ? "que seriam removidos" : "removidos"} (replaceOtherSources):`, ...otherRemovals.map((o) => `- ${describeOtherSource(o)}`)]
        : []),
    ];

    let operations: Row[];
    let mode: string;
    let after = renderTree(tree);
    const sameStructure = current.tree && !current.problems.length && structureSignature(current.tree) === structureSignature(tree);
    if (sameStructure && current.tree) {
      const index = indexByPath(current.tree);
      const updates: Row[] = [];
      const changes: string[] = [];
      const newBids = new Map<string, number>();
      walkTree(tree, (node, path) => {
        const match = index.get(pathKey(path));
        if (!match) return;
        const old = match.node;
        if (!node.unit || node.excluded || node.cpcBidMicros === undefined || !old.resourceName) return;
        if (old.cpcBidMicros === node.cpcBidMicros) return;
        updates.push({
          adGroupCriterionOperation: { update: { resourceName: old.resourceName, cpcBidMicros: String(node.cpcBidMicros) }, updateMask: "cpc_bid_micros" },
        });
        newBids.set(old.resourceName, node.cpcBidMicros);
        changes.push(`${pathLabel(match.path)}: ${old.cpcBidMicros !== undefined ? money(old.cpcBidMicros) : "sem lance"} → ${money(node.cpcBidMicros)}`);
      });
      if (updates.length === 0 && otherRemoveOps.length === 0) return ok(`Nada a fazer: a árvore de ${ownerLabel} já está exatamente assim.\n\n${before}`);
      operations = [...otherRemoveOps, ...updates];
      mode = updates.length
        ? `Só lances mudam (${updates.length}):\n- ${changes.join("\n- ")}`
        : "A árvore de produtos já está assim; só os filtros de outras fontes são removidos.";
      // O resultado é a árvore da conta (mesmos nós e valores) com os lances novos
      const updated = assembleTree(existing!.raw.map((n) => (newBids.has(n.resourceName) ? { ...n, cpcBidMicros: newBids.get(n.resourceName) } : n)));
      after = renderTree(updated.tree!);
    } else {
      const trivial = current.tree && !current.problems.length && current.tree.unit && !current.tree.excluded && current.tree.children.length === 0;
      if (current.tree && !trivial && replace !== true) {
        return fail(
          `Nada foi alterado: ${ownerLabel} já tem uma árvore de produtos e ela seria SUBSTITUÍDA inteira.\n\nAtual:\n${before}\n\n` +
            `Proposta:\n${after}\n\nEnvie replace: true para substituir (os nós são recriados; o histórico por nó fica nos nós antigos).` +
            (current.problems.length ? `\nProblemas na árvore atual: ${current.problems.join("; ")}` : "")
        );
      }
      // Remoções (árvore antiga e filtros de outra fonte) antes das criações, numa requisição atômica
      operations = [
        ...(existing?.raw.length ? removeOperations(existing.raw, target.engine) : []),
        ...otherRemoveOps,
        ...createOperations(tree, target),
      ];
      mode = current.tree ? "Substituição da árvore inteira (numa requisição atômica)." : "Criação da árvore.";
    }

    let result: Row;
    try {
      result = await client.batchMutate(customerId, operations);
    } catch (err) {
      return fail(`Nada foi alterado (operação atômica). Erro: ${explainTreeError((err as Error).message)}\n\nProposta:\n${after}`);
    }
    const dryRun = client.isDryRun;
    const confirmed = responsesOf(result).length;
    if (!dryRun && confirmed === 0) {
      return fail(`A API não confirmou a gravação — releia com get_listing_group_tree antes de repetir.\n\n${formatJson(result)}`);
    }
    return ok(
      [
        dryRun ? `DRY-RUN (validateOnly): a API validou ${operations.length} operação(ões) — nada foi gravado.` : `Árvore de ${ownerLabel} gravada (${confirmed} operação(ões)).`,
        mode,
        "",
        "Antes:",
        before,
        "",
        "Depois:",
        after,
        ...extra(dryRun),
      ].join("\n")
    );
  };

  /** Asset group PMax de varejo: existe, não removido, campanha PMax com Merchant Center. */
  const loadRetailAssetGroup = async (client: GoogleAdsClient, customerId: string, assetGroupId: string): Promise<{ error?: string; label: string }> => {
    const rows = await client.searchStream(customerId,
      `SELECT asset_group.id, asset_group.name, asset_group.status, campaign.id, campaign.name, campaign.status,
              campaign.advertising_channel_type, campaign.shopping_setting.merchant_id
       FROM asset_group
       WHERE asset_group.id = ${assetGroupId}`);
    const assetGroup = obj(rows[0]?.assetGroup);
    const campaign = obj(rows[0]?.campaign);
    const label = `asset group ${assetGroupId} ("${assetGroup.name ?? "?"}", campanha "${campaign.name ?? "?"}")`;
    if (!assetGroup.id) return { error: `Asset group ${assetGroupId} não encontrado na conta. Nada foi alterado.`, label };
    if (assetGroup.status === "REMOVED") return { error: `O ${label} está removido. Nada foi alterado.`, label };
    if (campaign.advertisingChannelType !== "PERFORMANCE_MAX") {
      return { error: `O ${label} é de campanha ${campaign.advertisingChannelType}, não PMax. Nada foi alterado.`, label };
    }
    if (!obj(campaign.shoppingSetting).merchantId) {
      return {
        error: `A campanha "${campaign.name}" não tem Merchant Center (shopping_setting.merchant_id): filtros de produto não se aplicam. Nada foi alterado.`,
        label,
      };
    }
    return { label };
  };

  /** Grupo Shopping padrão: existe, não removido, SHOPPING_PRODUCT_ADS. Devolve estratégia e CPC do grupo. */
  const loadShoppingAdGroup = async (
    client: GoogleAdsClient,
    customerId: string,
    adGroupId: string
  ): Promise<{ error?: string; label: string; strategy: string; adGroupBid?: number }> => {
    const rows = await client.searchStream(customerId,
      `SELECT ad_group.id, ad_group.name, ad_group.status, ad_group.type, ad_group.cpc_bid_micros, campaign.id, campaign.name,
              campaign.status, campaign.advertising_channel_type, campaign.bidding_strategy_type
       FROM ad_group
       WHERE ad_group.id = ${adGroupId}`);
    const adGroup = obj(rows[0]?.adGroup);
    const campaign = obj(rows[0]?.campaign);
    const label = `grupo ${adGroupId} ("${adGroup.name ?? "?"}", campanha "${campaign.name ?? "?"}")`;
    const strategy = String(campaign.biddingStrategyType ?? "");
    const adGroupBid = adGroup.cpcBidMicros !== undefined && adGroup.cpcBidMicros !== null ? Number(adGroup.cpcBidMicros) : undefined;
    if (!adGroup.id) return { error: `Grupo ${adGroupId} não encontrado na conta. Nada foi alterado.`, label, strategy };
    if (adGroup.status === "REMOVED") return { error: `O ${label} está removido. Nada foi alterado.`, label, strategy };
    if (campaign.advertisingChannelType !== "SHOPPING" || adGroup.type !== "SHOPPING_PRODUCT_ADS") {
      return {
        error: `O ${label} é ${adGroup.type} em campanha ${campaign.advertisingChannelType} — grupos de produtos só em SHOPPING_PRODUCT_ADS de Shopping padrão (PMax: set_listing_group_filter). Nada foi alterado.`,
        label,
        strategy,
      };
    }
    return { label, strategy, adGroupBid };
  };

  mcp.registerTool(
    "set_listing_group_filter",
    {
      description: [
        "Define os filtros de produto (listing groups) de um asset group PMax de varejo. WRITE OPERATION,",
        "numa requisição atômica. Aceita árvore de VÁRIOS níveis via units (cada folha pelo caminho desde",
        "a raiz) ou o formato antigo filters (um nível só). O nó \"outros\" de cada subdivisão é criado",
        "sozinho (othersPolicy). Se o asset group já tem árvore subdividida, mostra atual × proposta e só",
        "substitui com replace: true; árvore idêntica = nada é gravado.",
        "Um asset group aceita filtros de UMA fonte só: se ele tem filtros de página (WEBPAGE), a tool",
        "recusa e lista esses filtros; replaceOtherSources: true os remove na mesma requisição atômica.",
        "Leia a árvore atual com get_listing_group_tree (devolve units prontas para editar).",
        "",
        "Dimensões: PRODUCT_BRAND, PRODUCT_ITEM_ID, PRODUCT_CHANNEL (ONLINE/LOCAL), PRODUCT_CONDITION",
        "(NEW/USED/REFURBISHED), PRODUCT_CATEGORY_LEVEL1..5 (ID numérico), PRODUCT_TYPE_LEVEL1..5,",
        "PRODUCT_CUSTOM_ATTRIBUTE0..4 (rótulos personalizados).",
        "Ex.: marca e, dentro de \"outras marcas\", rótulo 0:",
        "units: [{path:[{dimension:'PRODUCT_BRAND',value:'Nike'}]},",
        "        {path:[{dimension:'PRODUCT_BRAND'},{dimension:'PRODUCT_CUSTOM_ATTRIBUTE0',value:'verao'}]}]",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        assetGroupId: z.string().describe("Asset group ID."),
        units: z.array(unitSchema).optional().describe("Folhas da árvore, cada uma pelo caminho desde a raiz. Use este OU filters."),
        filters: z
          .array(z.object({
            dimension: z.string().describe("Dimension key (e.g. 'PRODUCT_BRAND')."),
            value: z.string().describe("Dimension value."),
            included: z.boolean().optional().describe("True=include, False=exclude. Default: true."),
          }))
          .optional()
          .describe("Formato antigo: um nível, todos na mesma dimensão. Use este OU units."),
        othersPolicy: othersPolicySchema,
        replace: z.boolean().optional().describe("true = substitui uma árvore subdividida existente. Default: false."),
        replaceOtherSources: z
          .boolean()
          .optional()
          .describe("true = REMOVE os filtros de outra fonte (WEBPAGE) do asset group para gravar a árvore de produtos. Default: false (recusa)."),
      },
    },
    async ({ customerId, assetGroupId, units, filters, othersPolicy, replace, replaceOtherSources }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = customerId.replace(/-/g, "");
      // assetGroupId entra cru na GAQL e nos resource names
      if (!isId(assetGroupId)) return fail("assetGroupId inválido — use apenas o ID numérico do asset group. Nada foi alterado.");
      if ((units === undefined) === (filters === undefined)) return fail("Informe units OU filters (exatamente um). Nada foi alterado.");
      const spec: UnitSpec[] = units
        ?? (filters ?? []).map((f) => ({ path: [{ dimension: f.dimension, value: f.value }], excluded: f.included === false }));
      if (filters && filters.length === 0) return fail("filters vazio — informe ao menos um filtro. Nada foi alterado.");
      const built = buildTreeFromUnits(spec, "PMAX", othersPolicy ?? "AUTO");
      if (!built.tree) return fail(`Árvore inválida — nada foi alterado:\n- ${built.errors.join("\n- ")}`);

      const client = getClient();
      const assetGroup = await loadRetailAssetGroup(client, customerId, assetGroupId);
      if (assetGroup.error) return fail(assetGroup.error);
      const trees = await loadPmaxTrees(client, customerId, `asset_group.id = ${assetGroupId}`);
      const existing = trees.get(assetGroupId);
      const otherSources = existing?.otherSources ?? [];
      // MULTIPLE_LISTING_SOURCES: a API recusaria a árvore ao lado desses filtros — recusa aqui, sem chamada de escrita
      if (otherSources.length && replaceOtherSources !== true) {
        return fail(
          otherSourcesRefusal(
            assetGroup.label,
            otherSources,
            "Para trocá-los pela árvore de produtos, envie replaceOtherSources: true: eles são REMOVIDOS na mesma requisição atômica que grava a árvore."
          ) + `\n\nProposta (árvore de produtos):\n${renderTree(built.tree)}`
        );
      }
      return applyTree({
        client,
        customerId,
        target: { engine: "PMAX", cid, ownerId: assetGroupId },
        existing,
        tree: built.tree,
        replace,
        otherSourceRemovals: otherSources,
        notes: built.notes,
        warnings: [],
        ownerLabel: assetGroup.label,
      });
    }
  );

  mcp.registerTool(
    "set_shopping_product_groups",
    {
      description: [
        "Define os grupos de produtos (listing groups) de um grupo de anúncios Shopping padrão, com lance",
        "por grupo e exclusões. WRITE OPERATION, numa requisição atômica (árvore inteira de uma vez, com IDs",
        "temporários). Sem árvore o grupo não veicula. Mesmo formato de units de set_listing_group_filter",
        "(cada folha pelo caminho desde a raiz; o nó \"outros\" de cada subdivisão é criado sozinho).",
        "Em CPC manual toda folha incluída precisa de lance: cpcBidMicros na folha, defaultCpcBidMicros",
        "ou, na falta dos dois, o CPC do grupo. Se só os lances mudam, atualiza só os lances; se a",
        "estrutura muda, exige replace: true (mostra atual × proposta). Árvore idêntica = nada é gravado.",
        "units: [] não é aceito; para 'todos os produtos' use units: [{path: [], cpcBidMicros: ...}].",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        adGroupId: z.string().describe("ID do grupo SHOPPING_PRODUCT_ADS."),
        units: z.array(unitSchema).describe("Folhas da árvore, cada uma pelo caminho desde a raiz."),
        defaultCpcBidMicros: z.number().optional().describe("Lance em micros para folhas incluídas sem cpcBidMicros (inclusive o \"outros\" automático)."),
        othersPolicy: othersPolicySchema,
        replace: z.boolean().optional().describe("true = substitui uma árvore subdividida existente. Default: false."),
      },
    },
    async ({ customerId, adGroupId, units, defaultCpcBidMicros, othersPolicy, replace }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = customerId.replace(/-/g, "");
      if (!isId(adGroupId)) return fail("adGroupId inválido — use apenas o ID numérico do grupo. Nada foi alterado.");
      if (defaultCpcBidMicros !== undefined && !isPositiveMicros(defaultCpcBidMicros)) {
        return fail(`defaultCpcBidMicros deve ser inteiro positivo em micros (recebido ${defaultCpcBidMicros}). Nada foi alterado.`);
      }
      const built = buildTreeFromUnits(units ?? [], "SHOPPING", othersPolicy ?? "AUTO");
      if (!built.tree) return fail(`Árvore inválida — nada foi alterado:\n- ${built.errors.join("\n- ")}`);

      const client = getClient();
      const adGroup = await loadShoppingAdGroup(client, customerId, adGroupId);
      if (adGroup.error) return fail(adGroup.error);
      const trees = await loadShoppingTrees(client, customerId, `ad_group.id = ${adGroupId}`);
      const existing = trees.get(adGroupId);
      const warnings: string[] = [];
      const manual = MANUAL_BID_STRATEGIES.has(adGroup.strategy);
      const notes = [...built.notes];
      // Folha sem cpcBidMicros que já existe na conta com lance mantém o lance atual
      const current = existing?.raw.length ? assembleTree(existing.raw).tree : undefined;
      if (current) {
        const index = indexByPath(current);
        let kept = 0;
        walkTree(built.tree, (node, path) => {
          if (!node.unit || node.excluded || node.cpcBidMicros !== undefined) return;
          const old = index.get(pathKey(path))?.node;
          if (old?.unit && !old.excluded && old.cpcBidMicros !== undefined) {
            node.cpcBidMicros = old.cpcBidMicros;
            kept++;
          }
        });
        if (kept) notes.push(`${kept} folha(s) sem cpcBidMicros mantiveram o lance atual da conta.`);
      }
      if (manual) {
        const fallback = defaultCpcBidMicros ?? adGroup.adGroupBid;
        const { missing, filled } = fillDefaultBids(built.tree, fallback);
        if (missing.length) {
          return fail(
            `A campanha usa ${adGroup.strategy}: toda folha incluída precisa de lance, e o grupo não tem CPC para herdar. ` +
              `Informe cpcBidMicros nas folhas ou defaultCpcBidMicros. Sem lance:\n- ${missing.join("\n- ")}\nNada foi alterado.`
          );
        }
        if (filled) {
          notes.push(`${filled} folha(s) sem lance receberam ${money(fallback)} (${defaultCpcBidMicros !== undefined ? "defaultCpcBidMicros" : "CPC do grupo"}).`);
        }
      } else {
        let withBid = 0;
        walkTree(built.tree, (node) => {
          if (node.unit && node.cpcBidMicros !== undefined) withBid++;
        });
        if (withBid || defaultCpcBidMicros !== undefined) {
          warnings.push(`A campanha usa ${adGroup.strategy || "estratégia automática"}: o lance automático ignora os CPCs dos grupos de produtos.`);
        }
        if (defaultCpcBidMicros !== undefined) fillDefaultBids(built.tree, defaultCpcBidMicros);
      }
      walkTree(built.tree, (node, path) => {
        if (node.unit && !node.excluded && node.cpcBidMicros !== undefined && node.cpcBidMicros < LOW_BID_MICROS) {
          warnings.push(`Lance muito baixo em ${pathLabel(path)} (${money(node.cpcBidMicros)}): pode não ganhar leilões.`);
        }
      });
      return applyTree({
        client,
        customerId,
        target: { engine: "SHOPPING", cid, ownerId: adGroupId },
        existing,
        tree: built.tree,
        replace,
        notes,
        warnings,
        ownerLabel: adGroup.label,
      });
    }
  );

  mcp.registerTool(
    "exclude_products",
    {
      description: [
        "Exclui itens (por ID do item do Merchant Center) da árvore de produtos de um asset group PMax",
        "(assetGroupId) ou de um grupo Shopping padrão (adGroupId), PRESERVANDO o resto da árvore.",
        "WRITE OPERATION, atômica. Se a raiz já é dividida por ID do item, só acrescenta as exclusões.",
        "Se a raiz é 'todos os produtos', ela passa a ser dividida por ID do item. Se a árvore já é",
        "subdividida por outra dimensão, ela teria de ser REMOVIDA e RECRIADA inteira dentro de \"outros\"",
        "(IDs novos; o histórico por nó fica nos nós antigos): a tool mostra atual × proposta e só aplica",
        "com replace: true. Itens já excluídos são ignorados. Até 200 itens por chamada (limite do MCP).",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        assetGroupId: z.string().optional().describe("Asset group PMax. Use este OU adGroupId."),
        adGroupId: z.string().optional().describe("Grupo Shopping padrão. Use este OU assetGroupId."),
        itemIds: flexArray(z.string()).describe("IDs dos itens (offer id do Merchant Center)."),
        replace: z
          .boolean()
          .optional()
          .describe("true = autoriza recriar a árvore subdividida atual dentro de \"outros\" (só quando a raiz não é dividida por ID do item). Default: false."),
      },
    },
    async ({ customerId, assetGroupId, adGroupId, itemIds: rawItemIds, replace }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = customerId.replace(/-/g, "");
      if ((assetGroupId === undefined) === (adGroupId === undefined)) return fail("Informe assetGroupId OU adGroupId (exatamente um). Nada foi alterado.");
      const ownerId = String(assetGroupId ?? adGroupId);
      if (!isId(ownerId)) return fail(`${assetGroupId !== undefined ? "assetGroupId" : "adGroupId"} inválido — use o ID numérico. Nada foi alterado.`);
      const engine: Engine = assetGroupId !== undefined ? "PMAX" : "SHOPPING";
      const items: string[] = [];
      const itemErrors: string[] = [];
      for (const raw of ensureArray<unknown>(rawItemIds)) {
        const normalized = normalizeDimensionValue("PRODUCT_ITEM_ID", typeof raw === "string" ? raw : String(raw ?? ""));
        if ("error" in normalized) itemErrors.push(normalized.error);
        else if (normalized.value && !items.some((i) => i.toLowerCase() === normalized.value!.toLowerCase())) items.push(normalized.value);
      }
      if (itemErrors.length) return fail(`itemIds inválidos — nada foi alterado:\n- ${itemErrors.join("\n- ")}`);
      if (items.length === 0) return fail("itemIds vazio — informe ao menos um ID de item. Nada foi alterado.");
      if (items.length > 200) return fail(`${items.length} itens: o MCP aceita até 200 por chamada (a árvore cresce um nó por item). Nada foi alterado.`);

      const client = getClient();
      let ownerLabel: string;
      let existing: LoadedTree | undefined;
      if (engine === "PMAX") {
        const assetGroup = await loadRetailAssetGroup(client, customerId, ownerId);
        if (assetGroup.error) return fail(assetGroup.error);
        ownerLabel = assetGroup.label;
        existing = (await loadPmaxTrees(client, customerId, `asset_group.id = ${ownerId}`)).get(ownerId);
      } else {
        const adGroup = await loadShoppingAdGroup(client, customerId, ownerId);
        if (adGroup.error) return fail(adGroup.error);
        ownerLabel = adGroup.label;
        existing = (await loadShoppingTrees(client, customerId, `ad_group.id = ${ownerId}`)).get(ownerId);
      }
      // MULTIPLE_LISTING_SOURCES: filtros de página e árvore de produtos não convivem no asset group
      if (existing?.otherSources.length) {
        return fail(
          otherSourcesRefusal(
            ownerLabel,
            existing.otherSources,
            "exclude_products só trabalha com a árvore de produtos: para trocar esses filtros por uma árvore de produtos, use " +
              "set_listing_group_filter com replaceOtherSources: true e depois exclua os itens."
          )
        );
      }
      const current = existing && existing.raw.length ? assembleTree(existing.raw) : { tree: undefined, problems: [] as string[] };
      if (!current.tree) {
        return fail(`O ${ownerLabel} não tem árvore de produtos — crie com ${engine === "PMAX" ? "set_listing_group_filter" : "set_shopping_product_groups"}. Nada foi alterado.`);
      }
      if (current.problems.length) {
        return fail(`A árvore atual do ${ownerLabel} tem problemas (${current.problems.join("; ")}) — reconstrua com a tool de árvore. Nada foi alterado.`);
      }
      const tree = current.tree;
      const target: TreeTarget = { engine, cid, ownerId };
      const before = renderTree(tree);
      if (tree.unit && tree.excluded) {
        return ok(`Nada a fazer: a árvore do ${ownerLabel} já exclui todos os produtos (raiz excluída), inclusive ${items.join(", ")}.\n\n${before}`);
      }
      const rootByItem = !tree.unit && tree.children[0]?.dimension === "PRODUCT_ITEM_ID";
      const deeperItem = !rootByItem && usesDimension(tree, "PRODUCT_ITEM_ID");
      if (deeperItem) {
        return fail(
          `A árvore do ${ownerLabel} já usa ID do item abaixo da raiz — a exclusão automática poderia desfazer essa estrutura. ` +
            `Edite a árvore completa (get_listing_group_tree → units) com a tool de árvore.\n\nAtual:\n${before}\nNada foi alterado.`
        );
      }

      let operations: Row[];
      let newTree: LgNode;
      const already: string[] = [];
      if (rootByItem) {
        // Raiz já dividida por item: acrescenta irmãos excluídos; item listado como incluído vira excluído
        const removeNames = new Set<string>();
        const createUnits: LgNode[] = [];
        for (const item of items) {
          const sibling = tree.children.find((c) => c.value !== undefined && c.value.toLowerCase() === item.toLowerCase());
          if (sibling?.unit && sibling.excluded) {
            already.push(item);
            continue;
          }
          if (sibling) for (const name of subtreeNames(sibling)) removeNames.add(name);
          createUnits.push({ dimension: "PRODUCT_ITEM_ID", value: sibling?.value ?? item, unit: true, excluded: true, children: [] });
        }
        if (createUnits.length === 0) return ok(`Nada a fazer: ${already.join(", ")} já estão excluídos no ${ownerLabel}.\n\n${before}`);
        const counter = { n: 0 };
        operations = [
          ...removeOperations(existing!.raw, engine, removeNames),
          ...createUnits.flatMap((unit) => createOperations(unit, target, tree.resourceName, counter)),
        ];
        const keep = tree.children.filter((c) => !createUnits.some((u) => u.value === c.value));
        newTree = { ...tree, children: [...keep, ...createUnits] };
      } else {
        // Raiz vira subdivisão por item: exclusões + "outros" com a árvore atual inteira
        const others: LgNode = { ...tree, dimension: "PRODUCT_ITEM_ID", value: undefined };
        newTree = {
          unit: false,
          excluded: false,
          children: [...items.map((item) => ({ dimension: "PRODUCT_ITEM_ID", value: item, unit: true, excluded: true, children: [] })), others],
        };
        // Raiz "todos os produtos" (um nó só) é trocada sem gate; árvore subdividida seria recriada inteira
        // (IDs novos, histórico por nó perdido) — mesmo gate de replace das tools de árvore
        const trivial = tree.unit && !tree.excluded && tree.children.length === 0;
        if (!trivial && replace !== true) {
          return fail(
            `Nada foi alterado: a raiz da árvore do ${ownerLabel} não é dividida por ID do item. Para excluir os itens, a árvore ` +
              `atual seria REMOVIDA e RECRIADA inteira dentro de "outros" (ID do item).\n\nAtual:\n${before}\n\n` +
              `Proposta:\n${renderTree(newTree)}\n\n` +
              `Envie replace: true para aplicar (os nós são recriados com IDs novos; o histórico por nó fica nos nós antigos` +
              `${engine === "SHOPPING" ? "; os lances atuais são copiados" : ""}).`
          );
        }
        operations = [...removeOperations(existing!.raw, engine), ...createOperations(newTree, target)];
      }
      let result: Row;
      try {
        result = await client.batchMutate(customerId, operations);
      } catch (err) {
        return fail(`Nada foi alterado (operação atômica). Erro: ${explainTreeError((err as Error).message)}`);
      }
      const dryRun = client.isDryRun;
      if (!dryRun && responsesOf(result).length === 0) {
        return fail(`A API não confirmou a gravação — releia com get_listing_group_tree antes de repetir.\n\n${formatJson(result)}`);
      }
      const excludedNow = items.filter((i) => !already.includes(i));
      return ok(
        [
          dryRun ? `DRY-RUN (validateOnly): a API validou ${operations.length} operação(ões) — nada foi gravado.` : `Itens excluídos no ${ownerLabel}: ${excludedNow.join(", ")}.`,
          rootByItem ? "Exclusões acrescentadas à divisão por ID do item já existente." : "A raiz passou a ser dividida por ID do item; a árvore anterior foi recriada em \"outros\".",
          ...(already.length ? [`Já estavam excluídos: ${already.join(", ")}.`] : []),
          "",
          "Antes:",
          before,
          "",
          "Depois:",
          renderTree(newTree),
        ].join("\n")
      );
    }
  );

  mcp.registerTool(
    "get_listing_group_tree",
    {
      description: [
        "Lê a árvore de produtos atual: filtros de um asset group PMax (assetGroupId) ou grupos de",
        "produtos de um grupo Shopping padrão (adGroupId), ou de todos os grupos de uma campanha",
        "(campaignId, PMax ou Shopping). Devolve a árvore legível (dimensão, valor, incluído/excluído,",
        "lance) e as units no formato de set_listing_group_filter / set_shopping_product_groups, prontas",
        "para editar e regravar. includeMetrics = métricas por nó no período.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        assetGroupId: z.string().optional().describe("Asset group PMax. Use um de assetGroupId, adGroupId ou campaignId."),
        adGroupId: z.string().optional().describe("Grupo Shopping padrão."),
        campaignId: z.string().optional().describe("Campanha PMax ou Shopping (todas as árvores dela)."),
        includeMetrics: z.boolean().optional().describe("true = métricas por nó (impressões, cliques, custo, conversões, ROAS)."),
        dateRange: dateRangeSchema.describe(DATE_RANGE_DESC),
        days: z.number().optional().describe(DAYS_DESC),
      },
    },
    async ({ customerId, assetGroupId, adGroupId, campaignId, includeMetrics, dateRange, days }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const given = [assetGroupId, adGroupId, campaignId].filter((v) => v !== undefined);
      if (given.length !== 1) return fail("Informe exatamente um de assetGroupId, adGroupId ou campaignId.");
      const id = String(given[0]);
      if (!isId(id)) return fail(`ID inválido ("${id}") — use o ID numérico.`);
      let dateClause = "";
      if (includeMetrics) {
        try {
          dateClause = buildDateClause(dateRange, days);
        } catch (err) {
          return fail((err as Error).message);
        }
      }
      const client = getClient();
      let engine: Engine;
      let scope: string;
      if (assetGroupId !== undefined) {
        engine = "PMAX";
        scope = `asset_group.id = ${id}`;
      } else if (adGroupId !== undefined) {
        engine = "SHOPPING";
        scope = `ad_group.id = ${id}`;
      } else {
        const rows = await client.searchStream(customerId,
          `SELECT campaign.id, campaign.name, campaign.advertising_channel_type, campaign.status
           FROM campaign
           WHERE campaign.id = ${id}`);
        const campaign = obj(rows[0]?.campaign);
        if (!campaign.id) return fail(`Campanha ${id} não encontrada.`);
        if (campaign.advertisingChannelType === "PERFORMANCE_MAX") engine = "PMAX";
        else if (campaign.advertisingChannelType === "SHOPPING") engine = "SHOPPING";
        else return fail(`A campanha ${id} é ${campaign.advertisingChannelType}: árvore de produtos só existe em PMax e Shopping.`);
        scope = `campaign.id = ${id}`;
      }
      const trees = engine === "PMAX" ? await loadPmaxTrees(client, customerId, scope) : await loadShoppingTrees(client, customerId, scope);

      const metrics = new Map<string, MetricTotals>();
      if (includeMetrics && trees.size > 0) {
        const metricFields = "metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value";
        if (engine === "PMAX") {
          const rows = await client.searchStream(customerId,
            `SELECT asset_group_product_group_view.asset_group_listing_group_filter, ${metricFields}
             FROM asset_group_product_group_view
             WHERE ${scope} AND ${dateClause}`);
          for (const row of rows) {
            const key = String(obj(row.assetGroupProductGroupView).assetGroupListingGroupFilter ?? "");
            metrics.set(key, addMetrics(metrics.get(key) ?? emptyTotals(), obj(row.metrics)));
          }
        } else {
          const rows = await client.searchStream(customerId,
            `SELECT ad_group_criterion.resource_name, ${metricFields}
             FROM product_group_view
             WHERE ${scope} AND ${dateClause}`);
          for (const row of rows) {
            const key = String(obj(row.adGroupCriterion).resourceName ?? "");
            metrics.set(key, addMetrics(metrics.get(key) ?? emptyTotals(), obj(row.metrics)));
          }
        }
      }

      if (trees.size === 0) {
        return ok(`Nenhuma árvore de produtos encontrada (${scope}). ${engine === "PMAX" ? "Crie com set_listing_group_filter." : "Crie com set_shopping_product_groups."}`);
      }
      const blocks: string[] = [];
      const payload: Row[] = [];
      for (const loaded of trees.values()) {
        const { tree, problems } = assembleTree(loaded.raw);
        const owner = engine === "PMAX" ? `Asset group ${loaded.ownerId}` : `Grupo ${loaded.ownerId}`;
        const header = `${owner} "${loaded.ownerName}" (${loaded.ownerStatus}) · campanha "${loaded.campaignName}" (${loaded.campaignId})`;
        const rendered = tree ? renderTree(tree, includeMetrics ? metrics : undefined) : "(sem árvore de produtos)";
        blocks.push(
          [
            header,
            rendered,
            ...(problems.length ? [`Problemas: ${problems.join("; ")}`] : []),
            ...(loaded.otherSources.length
              ? [
                  `Outros filtros (não-produto): ${loaded.otherSources.map(describeOtherSource).join("; ")}`,
                  "Uma árvore de produtos não convive com esses filtros no mesmo asset group (MULTIPLE_LISTING_SOURCES).",
                ]
              : []),
          ].join("\n")
        );
        payload.push({
          [engine === "PMAX" ? "asset_group_id" : "ad_group_id"]: loaded.ownerId,
          name: loaded.ownerName,
          status: loaded.ownerStatus,
          campaign_id: loaded.campaignId,
          campaign_name: loaded.campaignName,
          nodes: tree ? countNodes(tree) : 0,
          problems,
          units: tree ? treeToUnits(tree) : [],
          ...(loaded.otherSources.length
            ? { other_sources: loaded.otherSources.map((o) => ({ listing_source: o.listingSource, type: o.type, conditions: o.detail, resource_name: o.resourceName })) }
            : {}),
        });
      }
      return ok(`${trees.size} árvore(s)${includeMetrics ? ` · métricas: ${dateClause}` : ""}\n\n${blocks.join("\n\n")}\n\n${formatJson(payload)}`);
    }
  );

  mcp.registerTool(
    "get_product_group_performance",
    {
      description: [
        "Desempenho por grupo de produtos de campanhas Shopping padrão (product_group_view): cada grupo",
        "com o caminho legível (ex.: Marca=Nike › Condição=(outros)), tipo, lance, impressões, cliques,",
        "custo, conversões, CPA e ROAS. Filtre por campaignId e/ou adGroupId. Para PMax use",
        "get_listing_group_tree com includeMetrics.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().optional().describe("Campanha Shopping (opcional)."),
        adGroupId: z.string().optional().describe("Grupo de anúncios (opcional)."),
        dateRange: dateRangeSchema.describe(DATE_RANGE_DESC),
        days: z.number().optional().describe(DAYS_DESC),
        onlyUnits: z.boolean().optional().describe("true (default) = só as folhas (onde fica o lance); false = inclui subdivisões."),
        limit: z.number().optional().describe("Máximo de linhas, por custo. Default: 200."),
        format: formatSchema,
      },
    },
    async ({ customerId, campaignId, adGroupId, dateRange, days, onlyUnits, limit, format }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      if (campaignId !== undefined && !isId(campaignId)) return fail(`campaignId inválido ("${campaignId}").`);
      if (adGroupId !== undefined && !isId(adGroupId)) return fail(`adGroupId inválido ("${adGroupId}").`);
      const max = limit ?? 200;
      if (!Number.isInteger(max) || max < 1) return fail(`limit inválido (${limit}) — use inteiro positivo.`);
      let dateClause: string;
      try {
        dateClause = buildDateClause(dateRange, days);
      } catch (err) {
        return fail((err as Error).message);
      }
      const filters = [
        ...(campaignId !== undefined ? [`campaign.id = ${campaignId}`] : []),
        ...(adGroupId !== undefined ? [`ad_group.id = ${adGroupId}`] : []),
      ];
      const client = getClient();
      const rows = await client.searchStream(customerId,
        `SELECT ad_group_criterion.resource_name, ad_group_criterion.listing_group.type, ad_group_criterion.negative,
                ad_group_criterion.cpc_bid_micros, ad_group.id, ad_group.name, campaign.id, campaign.name,
                metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value
         FROM product_group_view
         WHERE ${[dateClause, ...filters].join(" AND ")}`);
      const trees = await loadShoppingTrees(client, customerId, filters.length ? filters.join(" AND ") : undefined);
      const labels = new Map<string, string>();
      for (const loaded of trees.values()) {
        const { tree } = assembleTree(loaded.raw);
        if (tree) walkTree(tree, (node, path) => node.resourceName && labels.set(node.resourceName, pathLabel(path)));
      }
      const totals = new Map<string, { row: Row; totals: MetricTotals }>();
      for (const row of rows) {
        const criterion = obj(row.adGroupCriterion);
        const key = String(criterion.resourceName ?? "");
        const entry = totals.get(key) ?? { row, totals: emptyTotals() };
        addMetrics(entry.totals, obj(row.metrics));
        totals.set(key, entry);
      }
      const table = [...totals.entries()]
        .map(([key, { row, totals: t }]) => {
          const criterion = obj(row.adGroupCriterion);
          const type = String(obj(criterion.listingGroup).type ?? "");
          return {
            campaign: obj(row.campaign).name,
            ad_group: obj(row.adGroup).name,
            ad_group_id: String(obj(row.adGroup).id ?? ""),
            product_group: labels.get(key) ?? key,
            type: type === "SUBDIVISION" ? "SUBDIVISÃO" : criterion.negative === true ? "EXCLUÍDO" : "INCLUÍDO",
            cpc_bid: criterion.cpcBidMicros !== undefined ? Number(criterion.cpcBidMicros) / 1_000_000 : null,
            ...metricsView(t),
            criterion: key,
            _type: type,
          };
        })
        .filter((r) => (onlyUnits ?? true) ? r._type !== "SUBDIVISION" : true)
        .sort((a, b) => b.spend - a.spend)
        .slice(0, max)
        .map(({ _type, ...rest }) => rest);
      if (format === "table") return ok(formatAsTable(table));
      if (format === "csv") return ok(formatAsCsv(table));
      return ok(`${table.length} grupo(s) de produtos com dados (${dateClause}).\n\n${formatJson(table)}`);
    }
  );
}
