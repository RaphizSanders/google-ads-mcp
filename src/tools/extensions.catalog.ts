/**
 * Catálogo do lote extensions (Extensões (assets vinculados), WhatsApp e formulário de lead): toda tool nova do módulo precisa estar em read
 * (só leitura) ou write (grava na conta). Em chained, as de escrita que gravam em passos
 * encadeados (o segundo usa o ID criado no primeiro) — nelas o validateOnly é recusado.
 *
 * As tools existentes que passaram para o módulo (list_extensions e as create_*_extension /
 * create_structured_snippet) continuam classificadas nas listas do núcleo em src/read-only.ts.
 * Nenhuma tool nova é encadeada: criação de asset + vínculo vai numa chamada atômica
 * (googleAds:mutate com nome temporário), então o validateOnly funciona nelas.
 */
export const catalog = {
  read: [
    "get_extension_performance",
    "list_extension_exclusions",
    "list_lead_form_assets",
    "list_lead_form_submissions",
  ] as string[],
  write: [
    "link_extension_assets",
    "update_extension_link_status",
    "update_extension_asset",
    "set_excluded_parent_extension_types",
    "create_brand_text_asset",
    "create_whatsapp_message_asset",
    "create_lead_form_asset",
  ] as string[],
  chained: [] as string[],
};
