/**
 * Imagens em campanhas de Pesquisa (AD_IMAGE): link_campaign_image_assets e
 * list_campaign_image_assets.
 *
 * O gap que originou estas tools: upload_image_asset punha a imagem na
 * biblioteca, mas nada a vinculava à campanha — o vínculo acabou feito por
 * chamada direta à API, fora das travas do MCP. Estes testes fixam que a tool
 * nova só cria vínculos AD_IMAGE, valida conta/campanha/imagem antes de gravar,
 * não duplica nem reativa vínculo, e respeita read-only e dry-run.
 *
 * Duas camadas: handlers com um client falso (valida a lógica sem rede) e o
 * GoogleAdsClient real com fetch interceptado (prova o corpo HTTP enviado).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { GoogleAdsClient } from "../src/google-ads-client.js";
import { createReadOnlyToolServer } from "../src/read-only.js";
import { registerGoogleAdsTools } from "../src/tools.js";

type Row = Record<string, unknown>;
type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text?: string }>; isError?: boolean }>;

const CID = "1234567890";
const CAMPAIGN_ID = "111";

// ── Regra de GAQL que a API aplica e um client falso esconderia ───────

/**
 * Em FROM campaign_asset, `campaign` é recurso de SEGMENTAÇÃO: um campo dele
 * usado no WHERE precisa estar no SELECT, senão a API recusa a query
 * (EXPECTED_REFERENCED_FIELD_IN_SELECT_CLAUSE). Um fake que aceita qualquer
 * query deixou passar exatamente esse bug — então toda query dos testes passa
 * por aqui.
 */
function assertGaqlSegmentRule(query: string) {
  if (!/FROM\s+campaign_asset\b/.test(query)) return;
  const select = query.slice(0, query.search(/\bFROM\b/));
  const where = query.split(/\bWHERE\b/)[1] ?? "";
  for (const [field] of where.matchAll(/\bcampaign\.[a-z_.]+/g)) {
    assert.ok(select.includes(field), `${field} no WHERE sem estar no SELECT — a API recusa: ${query}`);
  }
}

// ── Client falso ──────────────────────────────────────────────────────

interface FakeOptions {
  campaign?: Row | null;
  assets?: Row[];
  links?: Row[];
  listRows?: Row[];
  dryRun?: boolean;
  mutate?: (operations: Row[], links: Row[]) => Row | Promise<Row>;
  failQueriesAfterMutate?: boolean;
}

function fakeClient(opts: FakeOptions = {}) {
  const calls = {
    queries: [] as string[],
    mutations: [] as Array<{ customerId: string; operations: Row[]; options?: Row }>,
  };
  const campaign =
    opts.campaign === undefined
      ? { id: CAMPAIGN_ID, name: "Pesquisa Marca", status: "ENABLED", advertisingChannelType: "SEARCH" }
      : opts.campaign;
  const client = {
    isDryRun: opts.dryRun ?? false,
    async searchStream(_customerId: string, query: string): Promise<Row[]> {
      calls.queries.push(query);
      assertGaqlSegmentRule(query);
      if (opts.failQueriesAfterMutate && calls.mutations.length > 0) throw new Error("fetch failed");
      if (query.includes("FROM campaign_asset")) {
        if (opts.listRows) return opts.listRows;
        return (opts.links ?? []).map((link) => ({ campaignAsset: link }));
      }
      if (query.includes("FROM asset")) {
        const ids = (/asset\.id IN \(([^)]*)\)/.exec(query)?.[1] ?? "").split(",").map((id) => id.trim());
        return (opts.assets ?? []).filter((asset) => ids.includes(String(asset.id))).map((asset) => ({ asset }));
      }
      if (query.includes("FROM campaign")) return campaign ? [{ campaign }] : [];
      throw new Error(`query inesperada: ${query}`);
    },
    async mutateCampaignAssets(customerId: string, operations: Row[], options?: Row): Promise<Row> {
      calls.mutations.push({ customerId, operations, options });
      if (opts.mutate) return opts.mutate(operations, opts.links ?? (opts.links = []));
      return {
        results: operations.map((op) => {
          const create = op.create as Row;
          const assetId = String(create.asset).split("/").pop();
          return { resourceName: `customers/${CID}/campaignAssets/${CAMPAIGN_ID}~${assetId}~AD_IMAGE` };
        }),
      };
    },
  };
  return { client, calls };
}

function image(id: string, width = 1200, height = 1200, name = `img-${id}`): Row {
  return { id, name, type: "IMAGE", imageAsset: { fullSize: { widthPixels: String(width), heightPixels: String(height) } } };
}

function register(client: unknown, opts: { allowed?: string[]; hosted?: boolean; readOnly?: boolean } = {}) {
  const handlers = new Map<string, Handler>();
  const fakeMcp = {
    registerTool(name: string, _config: unknown, handler: Handler) {
      handlers.set(name, handler);
    },
  };
  const target = opts.readOnly ? createReadOnlyToolServer(fakeMcp, true) : fakeMcp;
  registerGoogleAdsTools(target as never, () => client as never, opts.allowed ?? [], opts.hosted ?? false);
  return handlers;
}

const textOf = (result: { content: Array<{ text?: string }> }) => result.content.map((c) => c.text ?? "").join("\n");

/** O bloco JSON da resposta (entre o cabeçalho e a linha de próximo passo). */
function payloadOf(result: { content: Array<{ text?: string }> }): Row {
  const body = textOf(result);
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  return JSON.parse(body.slice(start, end + 1)) as Row;
}

async function link(client: unknown, args: Row, registerOpts = {}) {
  const handler = register(client, registerOpts).get("link_campaign_image_assets")!;
  return handler({ customerId: CID, campaignId: CAMPAIGN_ID, ...args });
}

// ── link_campaign_image_assets ───────────────────────────────────────

test("sucesso: cria só vínculos AD_IMAGE ENABLED, sem tocar campanha/orçamento/lances", async () => {
  const { client, calls } = fakeClient({ assets: [image("501"), image("502", 1200, 628)] });
  const result = await link(client, { assetResourceNames: [`customers/${CID}/assets/501`, "502"] });

  assert.equal(result.isError, false);
  assert.equal(calls.mutations.length, 1);
  const { operations, options } = calls.mutations[0];
  assert.deepEqual(options, { partialFailure: true });
  assert.equal(operations.length, 2);
  for (const op of operations) {
    // só create — nenhum update/remove, e o create só carrega os 4 campos do vínculo
    assert.deepEqual(Object.keys(op), ["create"]);
    const create = op.create as Row;
    assert.deepEqual(Object.keys(create).sort(), ["asset", "campaign", "fieldType", "status"]);
    assert.equal(create.fieldType, "AD_IMAGE");
    assert.equal(create.status, "ENABLED");
    assert.equal(create.campaign, `customers/${CID}/campaigns/${CAMPAIGN_ID}`);
  }
  const payload = payloadOf(result);
  assert.equal((payload.created as Row[]).length, 2);
  assert.equal((payload.already_linked as Row[]).length, 0);
  assert.equal((payload.errors as Row[]).length, 0);
  assert.equal((payload.created as Row[])[1].aspect, "1.91:1 (paisagem)");
});

test("duplicado: vínculo existente não é recriado e vínculo PAUSADO não é reativado", async () => {
  const { client, calls } = fakeClient({
    assets: [image("501"), image("502"), image("503")],
    links: [
      { asset: `customers/${CID}/assets/501`, status: "ENABLED", resourceName: "l501" },
      { asset: `customers/${CID}/assets/502`, status: "PAUSED", resourceName: "l502" },
    ],
  });
  const result = await link(client, { assetResourceNames: ["501", "502", "503", "503"] });

  assert.equal(calls.mutations.length, 1);
  const created = calls.mutations[0].operations.map((op) => String((op.create as Row).asset));
  assert.deepEqual(created, [`customers/${CID}/assets/503`], "só a imagem nova (repetida na entrada vira uma só)");

  const payload = payloadOf(result);
  const already = payload.already_linked as Row[];
  assert.equal(already.length, 2);
  const paused = already.find((row) => row.asset_id === "502")!;
  assert.equal(paused.link_status, "PAUSED");
  assert.match(String(paused.note), /não foi reativado/);
});

test("a checagem de duplicados filtra pelo atributo campaign_asset.campaign", async () => {
  const { client, calls } = fakeClient({ assets: [image("501")] });
  await link(client, { assetResourceNames: ["501"] });
  const linkQuery = calls.queries.find((q) => q.includes("FROM campaign_asset"))!;
  assert.match(linkQuery, new RegExp(`campaign_asset\\.campaign = 'customers/${CID}/campaigns/${CAMPAIGN_ID}'`));
  assert.match(linkQuery, /campaign_asset\.field_type = 'AD_IMAGE'/);
  assert.doesNotMatch(linkQuery, /status != 'REMOVED'/, "precisa ver todos os status para não reativar pausado");
});

test("tudo já vinculado: nenhuma escrita é enviada", async () => {
  const { client, calls } = fakeClient({
    assets: [image("501")],
    links: [{ asset: `customers/${CID}/assets/501`, status: "ENABLED", resourceName: "l501" }],
  });
  const result = await link(client, { assetResourceNames: ["501"] });
  assert.equal(result.isError, undefined);
  assert.equal(calls.mutations.length, 0);
  assert.match(textOf(result), /Nenhuma escrita foi enviada/);
});

test("vínculo REMOVIDO é criado de novo e sinalizado", async () => {
  const { client, calls } = fakeClient({
    assets: [image("501")],
    links: [{ asset: `customers/${CID}/assets/501`, status: "REMOVED", resourceName: "l501" }],
  });
  const result = await link(client, { assetResourceNames: ["501"] });
  assert.equal(calls.mutations.length, 1);
  assert.match(String((payloadOf(result).created as Row[])[0].note), /vínculo removido/);
});

test("conta divergente: resource name de outra conta é recusado sem chamar a API", async () => {
  const { client, calls } = fakeClient({ assets: [image("501")] });
  const result = await link(client, { assetResourceNames: ["customers/9999999999/assets/501"] });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /pertence à conta 9999999999/);
  assert.equal(calls.queries.length, 0);
  assert.equal(calls.mutations.length, 0);
});

test("imagem inexistente nesta conta é recusada antes de gravar", async () => {
  const { client, calls } = fakeClient({ assets: [image("501")] });
  const result = await link(client, { assetResourceNames: ["501", "777"] });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /asset 777 não existe na conta/);
  assert.equal(calls.mutations.length, 0);
});

test("asset incompatível: só IMAGE é aceito", async () => {
  const { client, calls } = fakeClient({ assets: [{ id: "601", name: "Frete grátis", type: "TEXT" }] });
  const result = await link(client, { assetResourceNames: ["601"] });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /é do tipo TEXT, não IMAGE/);
  assert.equal(calls.mutations.length, 0);
});

test("campanha incompatível: só SEARCH é aceita; campanha ausente ou removida também é recusada", async () => {
  const pmax = fakeClient({
    campaign: { id: CAMPAIGN_ID, name: "PMax", status: "ENABLED", advertisingChannelType: "PERFORMANCE_MAX" },
    assets: [image("501")],
  });
  const pmaxResult = await link(pmax.client, { assetResourceNames: ["501"] });
  assert.equal(pmaxResult.isError, true);
  assert.match(textOf(pmaxResult), /PERFORMANCE_MAX, não SEARCH/);
  assert.equal(pmax.calls.mutations.length, 0);

  const missing = fakeClient({ campaign: null, assets: [image("501")] });
  const missingResult = await link(missing.client, { assetResourceNames: ["501"] });
  assert.equal(missingResult.isError, true);
  assert.match(textOf(missingResult), /não encontrada na conta/);

  const removed = fakeClient({
    campaign: { id: CAMPAIGN_ID, name: "Antiga", status: "REMOVED", advertisingChannelType: "SEARCH" },
    assets: [image("501")],
  });
  const removedResult = await link(removed.client, { assetResourceNames: ["501"] });
  assert.equal(removedResult.isError, true);
  assert.equal(removed.calls.mutations.length, 0);
});

test("entrada inválida: campaignId não numérico, lista vazia e mais de 20 imagens", async () => {
  const { client, calls } = fakeClient({ assets: [image("501")] });
  assert.equal((await link(client, { campaignId: "111 OR 1=1", assetResourceNames: ["501"] })).isError, true);
  assert.equal((await link(client, { assetResourceNames: [] })).isError, true);
  const many = Array.from({ length: 21 }, (_, i) => String(1000 + i));
  const tooMany = await link(client, { assetResourceNames: many });
  assert.equal(tooMany.isError, true);
  assert.match(textOf(tooMany), /No máximo 20/);
  assert.equal(calls.queries.length, 0, "nenhuma validação de entrada pode chegar à API");
});

test("erro da API por operação: o que passou é criado, o que falhou volta com a mensagem", async () => {
  const { client } = fakeClient({
    assets: [image("501"), image("502", 100, 100)],
    mutate: () => ({
      results: [{ resourceName: `customers/${CID}/campaignAssets/${CAMPAIGN_ID}~501~AD_IMAGE` }, {}],
      partialFailureError: {
        code: 3,
        message: "Multiple errors in 'details'.",
        details: [{
          errors: [{
            errorCode: { assetLinkError: "IMAGE_NOT_WITHIN_SPECIFIED_DIMENSION_RANGE" },
            message: "The image is not within the specified dimension range.",
            location: { fieldPathElements: [{ fieldName: "operations", index: 1 }] },
          }],
        }],
      },
    }),
  });
  const result = await link(client, { assetResourceNames: ["501", "502"] });
  assert.equal(result.isError, true);
  const payload = payloadOf(result);
  assert.deepEqual((payload.created as Row[]).map((row) => row.asset_id), ["501"]);
  const [error] = payload.errors as Row[];
  assert.equal(error.asset_id, "502");
  assert.match(String(error.error), /IMAGE_NOT_WITHIN_SPECIFIED_DIMENSION_RANGE/);
});

test("erro da API na requisição inteira: confere a conta e não dá nada como criado", async () => {
  const { client, calls } = fakeClient({
    assets: [image("501")],
    mutate: () => {
      throw new Error("Google Ads API: The caller does not have permission");
    },
  });
  const result = await link(client, { assetResourceNames: ["501"] });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /estado conferido na conta depois do erro/);
  const payload = payloadOf(result);
  assert.equal((payload.created as Row[]).length, 0);
  assert.match(String((payload.errors as Row[])[0].error), /permission/);
  const linkQueries = calls.queries.filter((q) => q.includes("FROM campaign_asset"));
  assert.equal(linkQueries.length, 2, "uma checagem antes e uma conferência depois do erro");
});

test("erro de transporte depois de gravar: o vínculo confirmado na conta aparece como criado", async () => {
  const { client } = fakeClient({
    assets: [image("501"), image("502")],
    mutate: (_operations, links) => {
      // a API gravou a 501 e a conexão caiu antes da resposta
      links.push({ asset: `customers/${CID}/assets/501`, status: "ENABLED", resourceName: "l501" });
      throw new Error("fetch failed");
    },
  });
  const result = await link(client, { assetResourceNames: ["501", "502"] });
  assert.equal(result.isError, true);
  const payload = payloadOf(result);
  const created = payload.created as Row[];
  assert.deepEqual(created.map((row) => row.asset_id), ["501"]);
  assert.match(String(created[0].note), /apesar do erro/);
  assert.deepEqual((payload.errors as Row[]).map((row) => row.asset_id), ["502"]);
});

test("erro de transporte e conta inacessível depois: resultado declarado incerto", async () => {
  const { client } = fakeClient({
    assets: [image("501")],
    failQueriesAfterMutate: true,
    mutate: () => {
      throw new Error("fetch failed");
    },
  });
  const result = await link(client, { assetResourceNames: ["501"] });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /INCERTO/);
  assert.doesNotMatch(textOf(result), /nenhum vínculo novo foi criado/);
});

test("dry-run: relata validação, não criação", async () => {
  const { client, calls } = fakeClient({
    dryRun: true,
    assets: [image("501")],
    mutate: () => ({}), // validateOnly não devolve results
  });
  const result = await link(client, { assetResourceNames: ["501"] });
  assert.equal(result.isError, false);
  assert.equal(calls.mutations.length, 1);
  assert.match(textOf(result), /DRY-RUN \(validateOnly\): nada foi gravado/);
  const payload = payloadOf(result);
  assert.equal(payload.dry_run, true);
  assert.equal((payload.validated as Row[]).length, 1);
  assert.equal(payload.created, undefined);
});

test("dry-run com vínculo removido: nada na resposta afirma gravação", async () => {
  const { client } = fakeClient({
    dryRun: true,
    assets: [image("501")],
    links: [{ asset: `customers/${CID}/assets/501`, status: "REMOVED", resourceName: "l501" }],
    mutate: () => ({}),
  });
  const result = await link(client, { assetResourceNames: ["501"] });
  const body = textOf(result);
  assert.doesNotMatch(body, /foi criado/);
  assert.match(body, /seria criado de novo \(nada gravado\)/);
  assert.match(body, /para gravar de verdade/);
  assert.doesNotMatch(body, /Confirme com list_campaign_image_assets/);
  const [validated] = payloadOf(result).validated as Row[];
  assert.equal(validated.link_resource_name, undefined, "dry-run não inventa resource name");
});

test("allowlist hospedada: conta fora da lista é negada antes de qualquer chamada", async () => {
  const { client, calls } = fakeClient({ assets: [image("501")] });
  const result = await link(client, { assetResourceNames: ["501"] }, { allowed: ["5555555555"], hosted: true });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /Access denied/);
  assert.equal(calls.queries.length, 0);
});

test("read-only: o catálogo publica a consulta e omite o vínculo", () => {
  const { client } = fakeClient();
  const handlers = register(client, { readOnly: true });
  assert.ok(handlers.has("list_campaign_image_assets"));
  assert.ok(!handlers.has("link_campaign_image_assets"));
});

// ── GoogleAdsClient real, fetch interceptado ─────────────────────────

const CREDENTIALS = {
  token: "test-token",
  refresh_token: "test-refresh",
  token_uri: "https://oauth2.googleapis.com/token",
  client_id: "test-client",
  client_secret: "test-secret",
  expiry: "2999-01-01T00:00:00.000Z",
};

function interceptFetch(respond: (url: string, body: Row) => unknown) {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; body: Row }> = [];
  globalThis.fetch = (async (input: unknown, init?: { body?: unknown }) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Row) : {};
    calls.push({ url, body });
    return new Response(JSON.stringify(respond(url, body)), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function realClient(flags: { readOnly?: boolean; dryRun?: boolean }) {
  return new GoogleAdsClient({
    credentials: CREDENTIALS,
    developerToken: "test-developer-token",
    loginCustomerId: CID,
    ...flags,
  });
}

test("read-only no client: a escrita é bloqueada antes de sair qualquer requisição", async () => {
  const net = interceptFetch(() => ({}));
  try {
    const client = realClient({ readOnly: true });
    await assert.rejects(
      client.mutateCampaignAssets(CID, [{ create: { campaign: "c", asset: "a", fieldType: "AD_IMAGE" } }], { partialFailure: true }),
      /read-only mode/
    );
    assert.equal(net.calls.length, 0);
  } finally {
    net.restore();
  }
});

test("dry-run de ponta a ponta: a tool com o client real envia validateOnly e relata que nada foi gravado", async () => {
  const net = interceptFetch((url, body) => {
    if (url.endsWith(":searchStream")) {
      const query = String(body.query);
      assertGaqlSegmentRule(query);
      if (query.includes("FROM campaign_asset")) return [{ results: [] }];
      if (query.includes("FROM asset")) return [{ results: [{ asset: image("501") }] }];
      return [{ results: [{ campaign: { id: CAMPAIGN_ID, name: "Pesquisa", status: "ENABLED", advertisingChannelType: "SEARCH" } }] }];
    }
    return {}; // validateOnly: sem results
  });
  try {
    const client = realClient({ dryRun: true });
    assert.equal(client.isDryRun, true);
    const result = await link(client, { assetResourceNames: ["501"] });

    const writes = net.calls.filter((call) => call.url.endsWith(":mutate"));
    assert.equal(writes.length, 1);
    assert.ok(writes[0].url.endsWith(`/customers/${CID}/campaignAssets:mutate`));
    assert.equal(writes[0].body.validateOnly, true);
    assert.equal(writes[0].body.partialFailure, true);
    const op = (writes[0].body.operations as Row[])[0].create as Row;
    assert.equal(op.fieldType, "AD_IMAGE");
    assert.equal(op.asset, `customers/${CID}/assets/501`);

    assert.equal(result.isError, false);
    assert.match(textOf(result), /nada foi gravado/);
  } finally {
    net.restore();
  }
});

test("sem dry-run o corpo não leva validateOnly", async () => {
  const net = interceptFetch(() => ({ results: [{ resourceName: "x" }] }));
  try {
    await realClient({}).mutateCampaignAssets(CID, [{ create: { campaign: "c", asset: "a", fieldType: "AD_IMAGE" } }], { partialFailure: true });
    assert.equal(net.calls.length, 1);
    assert.equal(net.calls[0].body.validateOnly, undefined);
  } finally {
    net.restore();
  }
});

// ── list_campaign_image_assets ───────────────────────────────────────

function listRow(opts: {
  campaignId?: string;
  assetId: string;
  width: number;
  height: number;
  linkStatus?: string;
  fieldPolicy?: Row;
  assetPolicy?: Row;
}): Row {
  return {
    campaign: { id: opts.campaignId ?? CAMPAIGN_ID, name: "Pesquisa Marca" },
    asset: {
      id: opts.assetId,
      name: `img-${opts.assetId}`,
      imageAsset: {
        fullSize: { url: `https://tpc.googlesyndication.com/${opts.assetId}`, widthPixels: String(opts.width), heightPixels: String(opts.height) },
        fileSize: "48213",
        mimeType: "IMAGE_JPEG",
      },
      policySummary: opts.assetPolicy ?? { reviewStatus: "REVIEWED", approvalStatus: "APPROVED" },
      ...(opts.fieldPolicy ? { fieldTypePolicySummaries: [{ assetFieldType: "AD_IMAGE", policySummaryInfo: opts.fieldPolicy }] } : {}),
    },
    campaignAsset: {
      resourceName: `customers/${CID}/campaignAssets/${CAMPAIGN_ID}~${opts.assetId}~AD_IMAGE`,
      status: opts.linkStatus ?? "ENABLED",
      source: "ADVERTISER",
      primaryStatus: "PENDING",
      primaryStatusReasons: ["ASSET_UNDER_REVIEW"],
    },
  };
}

test("consulta: dimensões, status do vínculo, motivos e análise específica de AD_IMAGE", async () => {
  const { client, calls } = fakeClient({
    listRows: [
      listRow({
        assetId: "501", width: 1200, height: 1200,
        fieldPolicy: {
          reviewStatus: "REVIEW_IN_PROGRESS",
          approvalStatus: "UNKNOWN",
          policyTopicEntries: [{ topic: "TRADEMARKS_IN_AD_TEXT", type: "LIMITED" }],
        },
      }),
      listRow({ assetId: "502", width: 1200, height: 628 }),
    ],
  });
  const handler = register(client).get("list_campaign_image_assets")!;
  const result = await handler({ customerId: CID, campaignId: CAMPAIGN_ID });

  const query = calls.queries[0];
  assert.match(query, /FROM campaign_asset/);
  assert.match(query, /campaign_asset\.field_type = 'AD_IMAGE'/);
  assert.match(query, /campaign_asset\.status != 'REMOVED'/);
  assert.match(query, new RegExp(`campaign\\.id = ${CAMPAIGN_ID}`));

  const body = textOf(result);
  const rows = JSON.parse(body.slice(body.indexOf("["))) as Row[];
  const square = rows.find((row) => row.asset_id === "501")!;
  assert.equal(square.dimensions, "1200x1200");
  assert.equal(square.aspect, "1:1 (quadrada)");
  assert.equal(square.link_status, "ENABLED");
  assert.equal(square.primary_status, "PENDING");
  assert.deepEqual(square.primary_status_reasons, ["ASSET_UNDER_REVIEW"]);
  assert.equal(square.review_status, "REVIEW_IN_PROGRESS", "a análise por tipo de campo vem antes da do asset");
  assert.equal(square.policy_scope, "AD_IMAGE");
  assert.deepEqual(square.policy_topics, ["TRADEMARKS_IN_AD_TEXT (LIMITED)"]);
  assert.equal(square.file_size, 48213);

  const landscape = rows.find((row) => row.asset_id === "502")!;
  assert.equal(landscape.aspect, "1.91:1 (paisagem)");
  assert.equal(landscape.policy_scope, "asset");
  assert.equal(landscape.review_status, "REVIEWED");
  assert.doesNotMatch(body, /ATENÇÃO/);
});

test("consulta: avisa quando a campanha não tem imagem quadrada habilitada", async () => {
  // a quadrada existe, mas está pausada — não conta
  const { client } = fakeClient({
    listRows: [
      listRow({ assetId: "501", width: 1200, height: 1200, linkStatus: "PAUSED" }),
      listRow({ assetId: "502", width: 1200, height: 628 }),
    ],
  });
  const result = await register(client).get("list_campaign_image_assets")!({ customerId: CID });
  assert.match(textOf(result), /nenhuma imagem quadrada 1:1 habilitada/);
});

test("consulta: includeRemoved tira o filtro de status e campaignId é validado", async () => {
  const { client, calls } = fakeClient({ listRows: [] });
  const handler = register(client).get("list_campaign_image_assets")!;
  await handler({ customerId: CID, includeRemoved: true });
  assert.doesNotMatch(calls.queries[0], /status != 'REMOVED'/);
  assert.doesNotMatch(calls.queries[0], /campaign\.id =/);

  const bad = await handler({ customerId: CID, campaignId: "1; DROP" });
  assert.equal(bad.isError, true);
  assert.equal(calls.queries.length, 1);
});

test("list_extensions: filtro por campanha passa pela regra de segmento e exige ID numérico", async () => {
  const { client, calls } = fakeClient({ listRows: [] });
  const handler = register(client).get("list_extensions")!;
  await handler({ customerId: CID, campaignId: CAMPAIGN_ID });
  assert.match(calls.queries[0], new RegExp(`campaign_asset\\.campaign = 'customers/${CID}/campaigns/${CAMPAIGN_ID}'`));
  const bad = await handler({ customerId: CID, campaignId: "1 OR 1=1" });
  assert.equal(bad.isError, true);
  assert.equal(calls.queries.length, 1);
});
