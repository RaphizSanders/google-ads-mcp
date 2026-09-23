/**
 * Lote extensions: Extensões (assets vinculados), WhatsApp e formulário de lead.
 *
 * Tudo aqui trabalha com os vínculos de asset da API v25 — CustomerAsset (conta),
 * CampaignAsset (campanha) e AdGroupAsset (grupo) — e com os assets "mutáveis"
 * (sitelink, frase de destaque, snippet, chamada, preço, promoção, mensagem, formulário).
 *
 * Fontes conferidas (v25): common/asset_types.proto, resources/{campaign,ad_group,customer}_asset.proto,
 * enums/asset_field_type.proto, resources/lead_form_submission_data.proto, resources/customer.proto
 * (CustomerAgreementSetting), resources/campaign.proto (=69) e ad_group.proto (=54)
 * excluded_parent_asset_field_types, services/google_ads_service.proto (nomes temporários), a
 * tabela de vínculo/mutabilidade de docs/assets/overview e docs/assets/automated-assets.
 *
 * As tools de criação gravam asset + vínculo numa ÚNICA chamada atômica (googleAds:mutate com
 * nome temporário customers/{cid}/assets/-1): ou os dois entram, ou nada entra — não sobra
 * asset órfão quando o vínculo é recusado.
 */
import { z } from "zod";
import type { GoogleAdsClient } from "../google-ads-client.js";
import {
  DATE_RANGE_DESC,
  DAYS_DESC,
  ISO_DATE,
  addMetrics,
  buildDateClause,
  checkCustomerAccess,
  dateRangeSchema,
  emptyTotals,
  ensureArray,
  flexArray,
  formatAsCsv,
  formatAsTable,
  formatJson,
  formatSchema,
  localIsoDate,
  metricsView,
  microsToMoney,
  num,
  parseImageAssetRef,
  partialFailureByOperation,
  round2,
  text,
} from "../tool-kit.js";
import type { MetricTotals, ToolContext } from "../tool-kit.js";

type Row = Record<string, unknown>;
type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const obj = (value: unknown): Row =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {};
const arr = <T = unknown>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);
const fail = (message: string): ToolResult => ({ content: [text(message)], isError: true });
const quote = (value: string) => `'${value}'`;
const isDigits = (value: unknown): value is string => typeof value === "string" && /^\d+$/.test(value);
const isUrl = (value: string) => /^https?:\/\/[^\s]+$/i.test(value.trim());
const LINK_SOURCES = ["ADVERTISER", "AUTOMATICALLY_CREATED"];
/** Enums que entram na GAQL são conferidos de novo aqui (quem chama o handler direto pula o zod). */
function checkScopeEnums(level: unknown, source: unknown): string | undefined {
  if (level !== undefined && !["account", "campaign", "ad_group", "all"].includes(String(level))) return `level inválido: "${level}".`;
  if (source !== undefined && !LINK_SOURCES.includes(String(source))) return `source inválido: "${source}" (${LINK_SOURCES.join(" ou ")}).`;
  return undefined;
}

// ── Níveis de vínculo ───────────────────────────────────────────────

export const LINK_LEVELS = ["account", "campaign", "ad_group"] as const;
export type LinkLevel = (typeof LINK_LEVELS)[number];

interface LinkSpec {
  resource: string; // recurso GAQL
  service: string; // caminho REST do :mutate
  operation: string; // chave no googleAds:mutate
  result: string; // chave da resposta do googleAds:mutate
  json: string; // chave da linha GAQL em JSON
  label: string;
}

const LINK: Record<LinkLevel, LinkSpec> = {
  account: { resource: "customer_asset", service: "customerAssets", operation: "customerAssetOperation", result: "customerAssetResult", json: "customerAsset", label: "conta" },
  campaign: { resource: "campaign_asset", service: "campaignAssets", operation: "campaignAssetOperation", result: "campaignAssetResult", json: "campaignAsset", label: "campanha" },
  ad_group: { resource: "ad_group_asset", service: "adGroupAssets", operation: "adGroupAssetOperation", result: "adGroupAssetResult", json: "adGroupAsset", label: "grupo de anúncios" },
};

// ── Enums da v25 (enums/*.proto) ─────────────────────────────────────

/** AssetFieldType da v25 (sem UNSPECIFIED/UNKNOWN). TEXT_DISCLAIMER entrou na v25.1. */
export const ASSET_FIELD_TYPES = [
  "HEADLINE", "DESCRIPTION", "MANDATORY_AD_TEXT", "MARKETING_IMAGE", "MEDIA_BUNDLE", "YOUTUBE_VIDEO",
  "BOOK_ON_GOOGLE", "LEAD_FORM", "PROMOTION", "CALLOUT", "STRUCTURED_SNIPPET", "SITELINK", "MOBILE_APP",
  "HOTEL_CALLOUT", "CALL", "PRICE", "LONG_HEADLINE", "BUSINESS_NAME", "SQUARE_MARKETING_IMAGE",
  "PORTRAIT_MARKETING_IMAGE", "LOGO", "LANDSCAPE_LOGO", "VIDEO", "CALL_TO_ACTION_SELECTION", "AD_IMAGE",
  "BUSINESS_LOGO", "HOTEL_PROPERTY", "DEMAND_GEN_CAROUSEL_CARD", "BUSINESS_MESSAGE",
  "TALL_PORTRAIT_MARKETING_IMAGE", "RELATED_YOUTUBE_VIDEOS", "LANDING_PAGE_PREVIEW", "LONG_DESCRIPTION",
  "CALL_TO_ACTION", "CLASSIC_DISPLAY_IMAGE", "TEXT_DISCLAIMER",
] as const;

const ALL_LEVELS: LinkLevel[] = ["account", "campaign", "ad_group"];

/**
 * Tipos vinculáveis a conta/campanha/grupo, pela tabela "Asset types linked to customers,
 * campaigns and ad groups" (docs/assets/overview). TEXT_DISCLAIMER (v25.1) ainda não está na
 * tabela: os níveis ficam abertos e a API decide.
 */
export const FIELD_TYPE_RULES: Record<string, { assetType: string; levels: LinkLevel[]; mutable: boolean; label: string; documented?: boolean }> = {
  SITELINK: { assetType: "SITELINK", levels: ALL_LEVELS, mutable: true, label: "sitelink" },
  CALLOUT: { assetType: "CALLOUT", levels: ALL_LEVELS, mutable: true, label: "frase de destaque" },
  STRUCTURED_SNIPPET: { assetType: "STRUCTURED_SNIPPET", levels: ALL_LEVELS, mutable: true, label: "snippet estruturado" },
  CALL: { assetType: "CALL", levels: ALL_LEVELS, mutable: true, label: "chamada" },
  PRICE: { assetType: "PRICE", levels: ALL_LEVELS, mutable: true, label: "preço" },
  PROMOTION: { assetType: "PROMOTION", levels: ALL_LEVELS, mutable: true, label: "promoção" },
  MOBILE_APP: { assetType: "MOBILE_APP", levels: ALL_LEVELS, mutable: true, label: "app" },
  HOTEL_CALLOUT: { assetType: "HOTEL_CALLOUT", levels: ALL_LEVELS, mutable: true, label: "destaque de hotel" },
  BUSINESS_MESSAGE: { assetType: "BUSINESS_MESSAGE", levels: ALL_LEVELS, mutable: true, label: "mensagem (WhatsApp)" },
  LEAD_FORM: { assetType: "LEAD_FORM", levels: ["campaign"], mutable: true, label: "formulário de lead" },
  BUSINESS_NAME: { assetType: "TEXT", levels: ["account", "campaign"], mutable: false, label: "nome da empresa" },
  BUSINESS_LOGO: { assetType: "IMAGE", levels: ["account", "campaign"], mutable: false, label: "logotipo da empresa" },
  TEXT_DISCLAIMER: { assetType: "TEXT", levels: ALL_LEVELS, mutable: false, label: "aviso legal em texto", documented: false },
};

/** Tipos vinculáveis (entrada de link_extension_assets). */
const LINKABLE_FIELD_TYPES = Object.keys(FIELD_TYPE_RULES) as [string, ...string[]];

/**
 * Padrão de list_extensions/get_extension_performance: só extensões e identidade da marca.
 * Desde a v23 campaign_asset também devolve HEADLINE/DESCRIPTION/AD_IMAGE — ficam de fora
 * a menos que pedidos em fieldTypes.
 */
export const DEFAULT_EXTENSION_FIELD_TYPES = [...LINKABLE_FIELD_TYPES];

/** Tipos que podem ser excluídos da herança (excluded_parent_asset_field_types). */
const EXCLUDABLE_FIELD_TYPES = [...LINKABLE_FIELD_TYPES, "AD_IMAGE"] as [string, ...string[]];

const DAYS_OF_WEEK = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"] as const;
const MINUTE_OF_HOUR: Record<number, string> = { 0: "ZERO", 15: "FIFTEEN", 30: "THIRTY", 45: "FORTY_FIVE" };
const MINUTE_FROM_ENUM: Record<string, number> = { ZERO: 0, FIFTEEN: 15, THIRTY: 30, FORTY_FIVE: 45 };

const PRICE_EXTENSION_TYPES = [
  "BRANDS", "EVENTS", "LOCATIONS", "NEIGHBORHOODS", "PRODUCT_CATEGORIES", "PRODUCT_TIERS", "SERVICES",
  "SERVICE_CATEGORIES", "SERVICE_TIERS",
] as const;
const PRICE_QUALIFIERS = ["FROM", "UP_TO", "AVERAGE"] as const;
const PRICE_UNITS = ["PER_HOUR", "PER_DAY", "PER_WEEK", "PER_MONTH", "PER_YEAR", "PER_NIGHT"] as const;

const PROMOTION_OCCASIONS = [
  "NEW_YEARS", "CHINESE_NEW_YEAR", "VALENTINES_DAY", "EASTER", "MOTHERS_DAY", "FATHERS_DAY", "LABOR_DAY",
  "BACK_TO_SCHOOL", "HALLOWEEN", "BLACK_FRIDAY", "CYBER_MONDAY", "CHRISTMAS", "BOXING_DAY",
  "INDEPENDENCE_DAY", "NATIONAL_DAY", "END_OF_SEASON", "WINTER_SALE", "SUMMER_SALE", "FALL_SALE",
  "SPRING_SALE", "RAMADAN", "EID_AL_FITR", "EID_AL_ADHA", "SINGLES_DAY", "WOMENS_DAY", "HOLI",
  "PARENTS_DAY", "ST_NICHOLAS_DAY", "CARNIVAL", "EPIPHANY", "ROSH_HASHANAH", "PASSOVER", "HANUKKAH",
  "DIWALI", "NAVRATRI", "SONGKRAN", "YEAR_END_GIFT",
] as const;

const CALL_CONVERSION_REPORTING_STATES = [
  "DISABLED", "USE_ACCOUNT_LEVEL_CALL_CONVERSION_ACTION", "USE_RESOURCE_LEVEL_CALL_CONVERSION_ACTION",
] as const;

const BUSINESS_MESSAGE_CTAS = [
  "APPLY_NOW", "BOOK_NOW", "CONTACT_US", "GET_INFO", "GET_OFFER", "GET_QUOTE", "GET_STARTED", "LEARN_MORE",
] as const;

const LEAD_FORM_CTAS = [
  "LEARN_MORE", "GET_QUOTE", "APPLY_NOW", "SIGN_UP", "CONTACT_US", "SUBSCRIBE", "DOWNLOAD", "BOOK_NOW",
  "GET_OFFER", "REGISTER", "GET_INFO", "REQUEST_DEMO", "JOIN_NOW", "GET_STARTED",
] as const;
const LEAD_FORM_POST_SUBMIT_CTAS = ["VISIT_SITE", "DOWNLOAD", "LEARN_MORE", "SHOP_NOW"] as const;
const LEAD_FORM_DESIRED_INTENTS = ["LOW_INTENT", "HIGH_INTENT"] as const;

/** LeadFormFieldUserInputType da v25 com o número do enum. >= 1000 = pergunta pré-aprovada. */
const LEAD_FORM_INPUT_TYPE_CODES: Record<string, number> = {
  FULL_NAME: 2, EMAIL: 3, PHONE_NUMBER: 4, POSTAL_CODE: 5, STREET_ADDRESS: 8, CITY: 9, REGION: 10,
  COUNTRY: 11, WORK_EMAIL: 12, COMPANY_NAME: 13, WORK_PHONE: 14, JOB_TITLE: 15,
  GOVERNMENT_ISSUED_ID_CPF_BR: 16, GOVERNMENT_ISSUED_ID_DNI_AR: 17, GOVERNMENT_ISSUED_ID_DNI_PE: 18,
  GOVERNMENT_ISSUED_ID_RUT_CL: 19, GOVERNMENT_ISSUED_ID_CC_CO: 20, GOVERNMENT_ISSUED_ID_CI_EC: 21,
  GOVERNMENT_ISSUED_ID_RFC_MX: 22, FIRST_NAME: 23, LAST_NAME: 24,
  VEHICLE_MODEL: 1001, VEHICLE_TYPE: 1002, PREFERRED_DEALERSHIP: 1003, VEHICLE_PURCHASE_TIMELINE: 1004,
  VEHICLE_OWNERSHIP: 1005, VEHICLE_PAYMENT_TYPE: 1009, VEHICLE_CONDITION: 1010, COMPANY_SIZE: 1006,
  ANNUAL_SALES: 1007, YEARS_IN_BUSINESS: 1008, JOB_DEPARTMENT: 1011, JOB_ROLE: 1012,
  ...Object.fromEntries(Array.from({ length: 48 }, (_, i) => [`OVER_${18 + i}_AGE`, 1078 + i])),
  EDUCATION_PROGRAM: 1013, EDUCATION_COURSE: 1014, PRODUCT: 1016, SERVICE: 1017, OFFER: 1018,
  CATEGORY: 1019, PREFERRED_CONTACT_METHOD: 1020, PREFERRED_LOCATION: 1021, PREFERRED_CONTACT_TIME: 1022,
  PURCHASE_TIMELINE: 1023, YEARS_OF_EXPERIENCE: 1048, JOB_INDUSTRY: 1049, LEVEL_OF_EDUCATION: 1050,
  PROPERTY_TYPE: 1024, REALTOR_HELP_GOAL: 1025, PROPERTY_COMMUNITY: 1026, PRICE_RANGE: 1027,
  NUMBER_OF_BEDROOMS: 1028, FURNISHED_PROPERTY: 1029, PETS_ALLOWED_PROPERTY: 1030,
  NEXT_PLANNED_PURCHASE: 1031, EVENT_SIGNUP_INTEREST: 1033, PREFERRED_SHOPPING_PLACES: 1034,
  FAVORITE_BRAND: 1035, TRANSPORTATION_COMMERCIAL_LICENSE_TYPE: 1036, EVENT_BOOKING_INTEREST: 1038,
  DESTINATION_COUNTRY: 1039, DESTINATION_CITY: 1040, DEPARTURE_COUNTRY: 1041, DEPARTURE_CITY: 1042,
  DEPARTURE_DATE: 1043, RETURN_DATE: 1044, NUMBER_OF_TRAVELERS: 1045, TRAVEL_BUDGET: 1046,
  TRAVEL_ACCOMMODATION: 1047,
};
const LEAD_FORM_INPUT_TYPES = Object.keys(LEAD_FORM_INPUT_TYPE_CODES) as [string, ...string[]];
const isPrevettedQuestion = (inputType: string) => (LEAD_FORM_INPUT_TYPE_CODES[inputType] ?? 0) >= 1000;

/**
 * Cabeçalhos aceitos em structured snippet — tabela oficial "Structured Snippet Header
 * Translations" (developers.google.com/google-ads/api/data/structured-snippet-headers, conferida
 * em 2026-09-23): a tabela base em inglês e as 44 localidades. O Google exige o texto EXATO de
 * uma das localidades ("must match one of the exact translated strings"). A linha base traz
 * "Services (Service catalog)": entram "Services" e o nome antigo "Service catalog". es (Espanha)
 * não tem tradução para Neighborhoods. Se a tabela mudar, a API continua sendo quem decide — o
 * erro INVALID_SNIPPETS_HEADER volta explicado.
 */
export const SNIPPET_HEADERS_BY_LOCALE: Record<string, string[]> = {
  en: ["Brands", "Amenities", "Styles", "Types", "Destinations", "Services", "Service catalog", "Courses", "Neighborhoods", "Shows", "Insurance coverage", "Degree programs", "Featured Hotels", "Models"],
  ar: ["العلامات التجارية", "وسائل الراحة", "الأنماط", "الأنواع", "الوجهات", "الخدمات", "الدورات التدريبية", "الأحياء", "العروض", "التغطية التأمينية", "برامج الشهادات", "الفنادق المميّزة", "النماذج"],
  bg: ["Марки", "Удобства", "Стилове", "Типове", "Дестинации", "Услуги", "Курсове", "Квартали", "Предавания", "Застраховка", "Специалности", "Представени хотели", "Модели"],
  ca: ["Marques", "Serveis addicionals", "Estils", "Tipus", "Destinacions", "Serveis", "Cursos", "Barris", "Programes", "Assegurança", "Titulacions", "Hotels destacats", "Models"],
  "zh-HK": ["品牌", "設施", "款式", "類型", "目的地", "服務", "課程", "社區", "節目", "保障範圍", "學位課程", "特色酒店", "型號"],
  "zh-CN": ["品牌", "设施", "款式", "类型", "目的地", "服务", "课程", "社区", "节目", "险种", "学位课程", "精选酒店", "型号"],
  "zh-TW": ["品牌", "設施", "款式", "類型", "目的地", "服務", "課程", "社區", "節目", "承保範圍", "學位課程", "精選飯店", "型號"],
  hr: ["Robne marke", "Sadržaji", "Stilovi", "Vrste", "Odredišta", "Usluge", "Tečajevi", "Četvrti", "Emisije", "Osiguranje", "Studijski programi", "Istaknuti hoteli", "Modeli"],
  cs: ["Značky", "Vybavení", "Styly", "Typy", "Cíle", "Služby", "Kurzy", "Známé oblasti", "Pořady", "Pojištění", "Studijní programy", "Vybrané hotely", "Modely"],
  da: ["Brands", "Faciliteter", "Design", "Typer", "Destinationer", "Tjenester", "Kurser", "Nabolag", "Serier", "Forsikringsdækning", "Uddannelser", "Udvalgte hoteller", "Modeller"],
  nl: ["Merken", "Voorzieningen", "Stijlen", "Typen", "Bestemmingen", "Services", "Cursussen", "Buurten", "Shows", "Dekking", "Studieprogramma's", "Aanbevolen hotels", "Modellen"],
  "en-AU": ["Brands", "Amenities", "Styles", "Types", "Destinations", "Services", "Courses", "Neighbourhoods", "Shows", "Insurance coverage", "Degree programmes", "Featured hotels", "Models"],
  "en-GB": ["Brands", "Amenities", "Styles", "Types", "Destinations", "Services", "Courses", "Neighbourhoods", "Shows", "Insurance coverage", "Degree programmes", "Featured hotels", "Models"],
  et: ["Brändid", "Mugavusteenused", "Stiilid", "Tüübid", "Sihtkohad", "Teenused", "Kursused", "Ümbruskonnad", "Saated ja etendused", "Kindlustuskaitse", "Kraadiõppeprogrammid", "Soovitatud hotellid", "Mudelid"],
  fil: ["Mga Brand", "Mga Amenity", "Mga Istilo", "Mga Uri", "Mga Destinasyon", "Mga Serbisyo", "Mga Kurso", "Mga Komunidad", "Mga Palabas", "Sakop ng insurance", "Mga degree program", "Itinatampok na hotel", "Mga Modelo"],
  fi: ["Brändit", "Lisäpalvelut", "Tyylit", "Tyypit", "Kohteet", "Palvelut", "Kurssit", "Kaupunginosat", "Show't", "Vakuutukset", "Oppiaineet", "Suositellut hotellit", "Automerkit"],
  fr: ["Marques", "Équipements", "Styles", "Types", "Destinations", "Services", "Cours", "Quartiers", "Émissions", "Couverture d'assurance", "Programmes d'études", "Sélection d'hôtels", "Modèles"],
  de: ["Marken", "Ausstattung", "Stile", "Typen", "Ziele", "Dienstleistungen", "Kurse", "Viertel", "Serien", "Versicherungsleistung", "Studiengänge", "Vorgestellte Hotels", "Modelle"],
  el: ["Επωνυμίες", "Παροχές", "Στυλ", "Τύποι", "Προορισμοί", "Υπηρεσίες", "Μαθήματα", "Γειτονιές", "Εκπομπές", "Ασφαλιστική κάλυψη", "Προγράμματα πτυχίων", "Ξενοδοχεία", "Μοντέλα"],
  iw: ["מותגים", "שירותי המקום", "סגנונות", "סוגים", "יעדים גיאוגרפיים", "שירותים", "קורסים", "שכונות", "הופעות ותוכניות", "כיסוי ביטוחי", "תוכניות ללימודי תואר", "מלונות מומלצים", "דגמים"],
  hi: ["ब्रांड", "सुविधाएं", "शैलियां", "प्रकार", "गंतव्य", "सेवाएं", "पाठ्‍यक्रम", "आस-पड़ोस", "शो", "बीमा कवरेज", "डिग्री कार्यक्रम", "प्रदर्शित होटल", "मॉडल"],
  hu: ["Márkák", "Szolgáltatások", "Stílusok", "Típusok", "Úti célok", "Szolgáltatások", "Tanfolyamok", "Városrészek", "Műsorok", "Biztosítási módozat", "Diplomaprogramok", "Kiemelt szállodák", "Modellek"],
  id: ["Merek", "Fasilitas", "Gaya", "Jenis", "Destinasi", "Layanan", "Mata pelajaran", "Kawasan", "Acara", "Cakupan asuransi", "Program sarjana", "Hotel pilihan", "Model"],
  it: ["Brand", "Servizi", "Stili", "Tipi", "Destinazioni", "Servizi", "Corsi", "Quartieri", "Programmi", "Coperture assicurativa", "Corsi di laurea", "Hotel consigliati", "Modelli"],
  ja: ["ブランド", "設備", "スタイル", "タイプ", "到着地", "サービス", "コース", "周辺地域", "番組", "保険の保障", "学位プログラム", "おすすめのホテル", "モデル"],
  ko: ["브랜드", "편의 시설", "스타일", "유형", "목적지", "서비스", "과정", "인근 지역", "프로그램", "보험 보상 범위", "학위 취득 프로그램", "추천 호텔", "모델"],
  lv: ["Zīmoli", "Ērtības", "Stili", "Veidi", "Galamērķi", "Pakalpojumi", "Kursi", "Apkaimes", "Pārraides", "Apdrošināšana", "Studiju programmas", "Piedāvātās viesnīcas", "Modeļi"],
  lt: ["Prekių ženklai", "Patogumai", "Stiliai", "Tipai", "Paskirties vietos", "Paslaugos", "Kursai", "Namų apylinkės", "Laidos", "Draudimo aprėptis", "Moksliniai laipsniai", "Siūlomi viešbučiai", "Modeliai"],
  ms: ["Jenama", "Kemudahan", "Gaya", "Jenis", "Destinasi", "Perkhidmatan", "Kursus", "Kejiranan", "Rancangan", "Liputan insurans", "Program ijazah", "Hotel ditampilkan", "Model"],
  no: ["Merkevarer", "Fasiliteter", "Stiler", "Typer", "Destinasjoner", "Tjenester", "Kurs", "Lokalområder", "Programmer", "Forsikringsdekning", "Utdanningsprogrammer", "Utvalgte hoteller", "Modeller"],
  pl: ["Marki", "Udogodnienia", "Style", "Typy", "Miejsca", "Usługi", "Kursy", "Dzielnice", "Programy", "Ubezpieczenia", "Kierunki studiów", "Polecane hotele", "Modele"],
  "pt-BR": ["Marcas", "Comodidades", "Estilos", "Tipos", "Destinos", "Serviços", "Cursos", "Bairros", "Programas", "Cobertura do seguro", "Programas de graduação", "Hotéis em destaque", "Modelos"],
  "pt-PT": ["Marcas", "Comodidades", "Estilos", "Tipos", "Destinos", "Serviços", "Cursos", "Arredores", "Programas", "Cobertura do seguro", "Licenciaturas", "Hotéis em destaque", "Modelos"],
  ro: ["Mărci", "Dotări", "Stiluri", "Tipuri", "Destinații", "Servicii", "Cursuri", "Cartiere", "Emisiuni", "Asigurare", "Programe de studiu", "Hoteluri prezentate", "Modele"],
  ru: ["Бренды", "Удобства", "Стили", "Типы", "Места", "Услуги", "Курсы", "Районы", "Шоу", "Страховая защита", "Программы высшего образования", "Рекомендуемые отели", "Модели"],
  sr: ["брендови", "садржаји", "стилови", "типови", "дестинације", "услуге", "курсеви", "делови града", "емисије", "осигурање", "дипломе", "истакнути хотели", "модели"],
  sk: ["Značky", "Vybavenie", "Štýly", "Typy", "Destinácie", "Služby", "Kurzy", "Štvrte", "Relácie", "Poistenie", "Vzdelávacie programy", "Odporúčané hotely", "Modely"],
  sl: ["Blagovne znamke", "Ponudba", "Slogi", "Vrste", "Cilji", "Storitve", "Tečaji", "Soseske", "Oddaje", "Kritje zavarovanj", "Študijski programi", "Predstavljeni hoteli", "Modeli"],
  "es-419": ["Marcas", "Servicios adicionales", "Estilos", "Tipos", "Destinos", "Servicios", "Cursos", "Barrios", "Programas", "Cobertura de seguro", "Carreras universitarias", "Hoteles destacados", "Modelos"],
  es: ["Marcas", "Servicios adicionales", "Estilos", "Tipos", "Destinos", "Servicios", "Cursos", "Espectáculos", "Cobertura de seguro", "Carreras universitarias", "Hoteles destacados", "Modelos"],
  sv: ["Varumärken", "Faciliteter", "Stilar", "Typer", "Resmål", "Tjänster", "Kurser", "Barrios", "Program", "Försäkringstyper", "Utbildningsprogram", "Utvalda hotell", "Modeller"],
  th: ["แบรนด์", "สิ่งอำนวยความสะดวก", "สไตล์", "ประเภท", "ปลายทาง", "บริการ", "หลักสูตร", "ย่านใกล้เคียง", "โชว์", "ความคุ้มครองในประกัน", "หลักสูตรปริญญา", "โรงแรมเด่น", "รุ่น"],
  tr: ["Markalar", "Sunulan olanaklar", "Stiller", "Türler", "destinasyonlar", "Hizmetler", "Kurslar", "Mahalleler", "Programlar", "Sigorta kapsamı", "Lisans programları", "Öne çıkan oteller", "Modeller"],
  uk: ["Бренди", "Зручності", "Стилі", "Типи", "Місця", "Послуги", "Курси", "Квартали", "Шоу", "Страховий захист", "Освітні програми", "Рекомендовані готелі", "Моделі"],
  vi: ["Thương hiệu", "Tiện nghi", "Kiểu", "Loại", "Điểm đến", "Dịch vụ", "Khóa học", "Vùng lân cận", "Chương trình", "Phạm vi bảo hiểm", "Cấp bằng", "Khách sạn nổi bật", "Model"],
};
const SNIPPET_HEADERS = new Set(Object.values(SNIPPET_HEADERS_BY_LOCALE).flat().map((h) => h.normalize("NFC")));

/** Cabeçalho normalizado (trim + NFC) ou o erro com sugestão de grafia / lista pt-BR. */
export function checkSnippetHeader(label: string, value: unknown): { header: string } | { error: string } {
  const header = String(value ?? "").trim().normalize("NFC");
  if (SNIPPET_HEADERS.has(header)) return { header };
  const lower = header.toLocaleLowerCase("pt-BR");
  const suggestion = [...SNIPPET_HEADERS].find((h) => h.toLocaleLowerCase("pt-BR") === lower);
  return {
    error: suggestion
      ? `${label} "${value}" não está na lista oficial com essa grafia — o Google exige o texto exato: use "${suggestion}".`
      : `${label} "${value}" não está na lista oficial de cabeçalhos. pt-BR: ${SNIPPET_HEADERS_BY_LOCALE["pt-BR"].join(", ")}. ` +
        "Vale o texto exato de qualquer idioma da tabela oficial (ex.: es-419 \"Barrios\", en-GB \"Neighbourhoods\", en \"Featured Hotels\").",
  };
}

// ── Campos GAQL do conteúdo de cada tipo de asset ────────────────────

const ASSET_CONTENT_FIELDS = [
  "asset.id", "asset.name", "asset.type", "asset.source", "asset.final_urls",
  "asset.sitelink_asset.link_text", "asset.sitelink_asset.description1", "asset.sitelink_asset.description2",
  "asset.sitelink_asset.start_date", "asset.sitelink_asset.end_date", "asset.sitelink_asset.ad_schedule_targets",
  "asset.callout_asset.callout_text", "asset.callout_asset.start_date", "asset.callout_asset.end_date",
  "asset.callout_asset.ad_schedule_targets",
  "asset.structured_snippet_asset.header", "asset.structured_snippet_asset.values",
  "asset.call_asset.country_code", "asset.call_asset.phone_number", "asset.call_asset.ad_schedule_targets",
  "asset.call_asset.call_conversion_reporting_state", "asset.call_asset.call_conversion_action",
  "asset.price_asset.type", "asset.price_asset.price_qualifier", "asset.price_asset.language_code",
  "asset.price_asset.price_offerings",
  "asset.promotion_asset.promotion_target", "asset.promotion_asset.percent_off",
  "asset.promotion_asset.money_amount_off.amount_micros", "asset.promotion_asset.money_amount_off.currency_code",
  "asset.promotion_asset.promotion_code", "asset.promotion_asset.orders_over_amount.amount_micros",
  "asset.promotion_asset.orders_over_amount.currency_code", "asset.promotion_asset.occasion",
  "asset.promotion_asset.discount_modifier", "asset.promotion_asset.language_code",
  "asset.promotion_asset.start_date", "asset.promotion_asset.end_date",
  "asset.promotion_asset.redemption_start_date", "asset.promotion_asset.redemption_end_date",
  "asset.promotion_asset.ad_schedule_targets", "asset.promotion_asset.terms_and_conditions_text",
  "asset.promotion_asset.terms_and_conditions_uri", "asset.promotion_asset.promotion_barcode_info.type",
  "asset.promotion_asset.promotion_barcode_info.barcode_content", "asset.promotion_asset.promotion_qr_code_info.qr_code_content",
  "asset.business_message_asset.message_provider", "asset.business_message_asset.starter_message",
  "asset.business_message_asset.whatsapp_info.country_code", "asset.business_message_asset.whatsapp_info.phone_number",
  "asset.business_message_asset.call_to_action.call_to_action_selection",
  "asset.business_message_asset.call_to_action.call_to_action_description",
  "asset.lead_form_asset.business_name", "asset.lead_form_asset.headline",
  "asset.mobile_app_asset.app_id", "asset.mobile_app_asset.link_text",
  "asset.hotel_callout_asset.text",
  "asset.text_asset.text", "asset.image_asset.full_size.url",
  "asset.policy_summary.approval_status", "asset.policy_summary.review_status",
];

/** Resumo de uma linha do conteúdo do asset, por tipo. */
export function describeAsset(asset: Row): string {
  const urls = arr<string>(asset.finalUrls);
  switch (String(asset.type ?? "")) {
    case "SITELINK": {
      const sl = obj(asset.sitelinkAsset);
      const desc = sl.description1 ? ` | ${sl.description1} / ${sl.description2 ?? ""}` : "";
      return `${sl.linkText ?? ""}${urls[0] ? ` → ${urls[0]}` : ""}${desc}`;
    }
    case "CALLOUT":
      return String(obj(asset.calloutAsset).calloutText ?? "");
    case "STRUCTURED_SNIPPET": {
      const ss = obj(asset.structuredSnippetAsset);
      return `${ss.header ?? ""}: ${arr<string>(ss.values).join(", ")}`;
    }
    case "CALL": {
      const call = obj(asset.callAsset);
      return `${call.countryCode ?? ""} ${call.phoneNumber ?? ""}`.trim();
    }
    case "PRICE": {
      const price = obj(asset.priceAsset);
      return `${price.type ?? ""} (${arr(price.priceOfferings).length} itens)`;
    }
    case "PROMOTION": {
      const promo = obj(asset.promotionAsset);
      const money = obj(promo.moneyAmountOff);
      const off = promo.percentOff !== undefined
        ? `${round2(num(promo.percentOff) / 10_000)}% off`
        : money.amountMicros !== undefined ? `${round2(microsToMoney(money.amountMicros))} ${money.currencyCode ?? ""} off` : "";
      const trigger = promo.promotionCode
        ? ` (código ${promo.promotionCode})`
        : obj(promo.ordersOverAmount).amountMicros !== undefined
          ? ` (pedidos acima de ${round2(microsToMoney(obj(promo.ordersOverAmount).amountMicros))})`
          : "";
      return `${promo.promotionTarget ?? ""} ${off}${trigger}`.trim();
    }
    case "BUSINESS_MESSAGE": {
      const msg = obj(asset.businessMessageAsset);
      const wa = obj(msg.whatsappInfo);
      return `${msg.messageProvider ?? ""} ${wa.countryCode ?? ""} ${wa.phoneNumber ?? ""} — "${msg.starterMessage ?? ""}"`.replace(/\s+/g, " ").trim();
    }
    case "LEAD_FORM": {
      const form = obj(asset.leadFormAsset);
      return `${form.headline ?? ""} — ${form.businessName ?? ""}`;
    }
    case "MOBILE_APP": {
      const app = obj(asset.mobileAppAsset);
      return `${app.linkText ?? ""} (${app.appId ?? ""})`;
    }
    case "HOTEL_CALLOUT":
      return String(obj(asset.hotelCalloutAsset).text ?? "");
    case "TEXT":
      return String(obj(asset.textAsset).text ?? "");
    case "IMAGE":
      return String(obj(obj(asset.imageAsset).fullSize).url ?? asset.name ?? "");
    default:
      return String(asset.name ?? asset.id ?? "");
  }
}

/** Datas e agenda de veiculação do asset (sitelink, frase de destaque, promoção, chamada). */
function servingOf(asset: Row): { start_date?: string; end_date?: string; schedules: string[] } {
  const typed = obj(asset.sitelinkAsset ?? asset.calloutAsset ?? asset.promotionAsset ?? asset.callAsset);
  return {
    ...(typed.startDate ? { start_date: String(typed.startDate) } : {}),
    ...(typed.endDate ? { end_date: String(typed.endDate) } : {}),
    schedules: arr<Row>(typed.adScheduleTargets).map(scheduleLabel),
  };
}

function scheduleLabel(entry: Row): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const startMinute = MINUTE_FROM_ENUM[String(entry.startMinute ?? "ZERO")] ?? 0;
  const endMinute = MINUTE_FROM_ENUM[String(entry.endMinute ?? "ZERO")] ?? 0;
  return `${entry.dayOfWeek} ${pad(num(entry.startHour))}:${pad(startMinute)}-${pad(num(entry.endHour))}:${pad(endMinute)}`;
}

// ── Conteúdo comparável (duplicado exato x parecido) ─────────────────

const textValue = (value: unknown) => String(value ?? "").trim();
const enumValue = (value: unknown) => {
  const v = textValue(value);
  return v === "UNSPECIFIED" || v === "UNKNOWN" ? "" : v;
};
const digitsValue = (value: unknown) => String(value ?? "").replace(/\D/g, "");
const microsValue = (value: unknown) => (value === undefined || value === null || value === "" ? "" : String(Number(value) / 1_000_000));
const moneyValue = (value: unknown) => {
  const money = obj(value);
  return money.amountMicros === undefined ? "" : `${microsValue(money.amountMicros)} ${textValue(money.currencyCode)}`.trim();
};
const scheduleValue = (value: unknown) => arr<Row>(value).map(scheduleLabel).sort().join("; ");
const urlsValue = (value: unknown) => arr<string>(value).map(textValue).join(" ");

/**
 * Conteúdo de um asset de extensão como campo → valor normalizado. Vale igual para o payload de
 * criação e para a linha da GAQL (mesmo JSON camelCase), então dá para comparar o pedido com o que
 * já está vinculado campo a campo. Ausente ≡ "" ≡ UNSPECIFIED; dinheiro em unidades da moeda;
 * percentual em %; telefone só dígitos; idioma sem diferença de maiúsculas; texto só com trim.
 * Cobre todo o conteúdo que as tools de criação gravam (e, em preço/promoção, também o que elas
 * não gravam — URL mobile, termos, código de barras/QR — para um asset com isso não passar por igual).
 */
export function assetContentFields(asset: Row): Record<string, string> {
  const finalUrl = urlsValue(asset.finalUrls);
  switch (String(asset.type ?? "")) {
    case "SITELINK": {
      const sl = obj(asset.sitelinkAsset);
      return {
        linkText: textValue(sl.linkText), finalUrl, description1: textValue(sl.description1), description2: textValue(sl.description2),
        startDate: textValue(sl.startDate), endDate: textValue(sl.endDate), adSchedule: scheduleValue(sl.adScheduleTargets),
      };
    }
    case "CALLOUT": {
      const co = obj(asset.calloutAsset);
      return { calloutText: textValue(co.calloutText), startDate: textValue(co.startDate), endDate: textValue(co.endDate), adSchedule: scheduleValue(co.adScheduleTargets) };
    }
    case "STRUCTURED_SNIPPET": {
      const ss = obj(asset.structuredSnippetAsset);
      return { header: textValue(ss.header).normalize("NFC"), values: JSON.stringify(arr(ss.values).map(textValue)) };
    }
    case "CALL": {
      const call = obj(asset.callAsset);
      return {
        countryCode: textValue(call.countryCode).toUpperCase(), phoneNumber: digitsValue(call.phoneNumber),
        callConversionReportingState: enumValue(call.callConversionReportingState), callConversionAction: textValue(call.callConversionAction),
        adSchedule: scheduleValue(call.adScheduleTargets),
      };
    }
    case "PRICE": {
      const price = obj(asset.priceAsset);
      const offerings = arr<Row>(price.priceOfferings);
      const fields: Record<string, string> = {
        priceType: enumValue(price.type), priceQualifier: enumValue(price.priceQualifier),
        languageCode: textValue(price.languageCode).toLowerCase(), items: String(offerings.length),
      };
      offerings.forEach((offering, i) => {
        const at = `items[${i}]`;
        const amount = obj(offering.price);
        fields[`${at}.header`] = textValue(offering.header);
        fields[`${at}.description`] = textValue(offering.description);
        fields[`${at}.price`] = microsValue(amount.amountMicros);
        fields[`${at}.currencyCode`] = textValue(amount.currencyCode);
        fields[`${at}.unit`] = enumValue(offering.unit);
        fields[`${at}.finalUrl`] = textValue(offering.finalUrl);
        fields[`${at}.finalMobileUrl`] = textValue(offering.finalMobileUrl);
      });
      return fields;
    }
    case "PROMOTION": {
      const promo = obj(asset.promotionAsset);
      const barcode = obj(promo.promotionBarcodeInfo);
      return {
        promotionTarget: textValue(promo.promotionTarget),
        percentOff: promo.percentOff === undefined || promo.percentOff === null ? "" : String(Number(promo.percentOff) / 10_000),
        moneyAmountOff: moneyValue(promo.moneyAmountOff),
        discountModifier: enumValue(promo.discountModifier),
        promotionCode: textValue(promo.promotionCode),
        ordersOverAmount: moneyValue(promo.ordersOverAmount),
        promotionBarcode: `${enumValue(barcode.type)} ${textValue(barcode.barcodeContent)}`.trim(),
        promotionQrCode: textValue(obj(promo.promotionQrCodeInfo).qrCodeContent),
        occasion: enumValue(promo.occasion),
        languageCode: textValue(promo.languageCode).toLowerCase(),
        redemptionStartDate: textValue(promo.redemptionStartDate),
        redemptionEndDate: textValue(promo.redemptionEndDate),
        startDate: textValue(promo.startDate),
        endDate: textValue(promo.endDate),
        adSchedule: scheduleValue(promo.adScheduleTargets),
        termsAndConditionsText: textValue(promo.termsAndConditionsText),
        termsAndConditionsUri: textValue(promo.termsAndConditionsUri),
        finalUrl,
      };
    }
    case "BUSINESS_MESSAGE": {
      const msg = obj(asset.businessMessageAsset);
      const wa = obj(msg.whatsappInfo);
      const cta = obj(msg.callToAction);
      return {
        messageProvider: enumValue(msg.messageProvider), starterMessage: textValue(msg.starterMessage),
        whatsappCountryCode: textValue(wa.countryCode).toUpperCase(), whatsappPhoneNumber: digitsValue(wa.phoneNumber),
        callToActionSelection: enumValue(cta.callToActionSelection), callToActionDescription: textValue(cta.callToActionDescription),
      };
    }
    case "TEXT":
      return { text: textValue(obj(asset.textAsset).text) };
    default:
      return { type: String(asset.type ?? ""), id: String(asset.id ?? "") };
  }
}

export interface ContentDiff { field: string; existing: string; requested: string }

/**
 * Campos em que o asset existente difere do pedido. `defaultable`: campos que, quando o pedido
 * não os informa, ficam com o padrão da API — não entram na comparação (ex.: conversão de chamada).
 */
export function diffAssetContent(requested: Row, existing: Row, defaultable: string[] = []): ContentDiff[] {
  const want = assetContentFields(requested);
  const have = String(requested.type ?? "") === String(existing.type ?? "") ? assetContentFields(existing) : { type: String(existing.type ?? "") };
  const keys = [...new Set([...Object.keys(want), ...Object.keys(have)])];
  return keys
    .filter((key) => !(defaultable.includes(key) && (want[key] ?? "") === ""))
    .filter((key) => (want[key] ?? "") !== (have[key] ?? ""))
    .map((key) => ({ field: key, existing: have[key] ?? "", requested: want[key] ?? "" }));
}

// ── Mensagens de erro da API em PT-BR ────────────────────────────────

const ERROR_HINTS: Array<[RegExp, string]> = [
  [/CUSTOMER_NOT_ON_ALLOWLIST_FOR_(WHATSAPP_)?MESSAGE_ASSETS|allow-?list for (whatsapp|business) message/i,
    "A conta não está liberada (allowlist) para recursos de mensagem/WhatsApp. O Google só libera pelo gerente de contas do Google Ads; até lá a API recusa criar ou vincular esse recurso."],
  [/LEAD_FORM_MISSING_AGREEMENT|Terms of Service have been agreed/i,
    "Os termos de formulário de lead não foram aceitos nesta conta. Aceite-os uma vez na interface do Google Ads (Recursos > Formulário de lead); a API não aceita os termos por você."],
  [/LEAD_FORM_LEGACY_QUALIFYING_QUESTIONS_DISALLOWED|Legacy qualifying questions/i,
    "Perguntas pré-aprovadas antigas (ex.: VEHICLE_MODEL) não podem ficar no mesmo formulário que perguntas personalizadas."],
  [/LEAD_FORM_INVALID_FIELDS_COMBINATION/i, "Combinação de campos do formulário inválida para o Google."],
  [/CANNOT_LINK_TO_AUTOMATICALLY_CREATED_ASSET|CANNOT_CREATE_AUTOMATICALLY_CREATED_LINKS/i,
    "Assets automáticos (criados pelo Google) não podem ser vinculados pela API — só pausados ou removidos."],
  [/CANNOT_MODIFY_AUTOMATICALLY_CREATED_ASSET/i, "Assets automáticos (criados pelo Google) não podem ser editados."],
  [/EXCLUDED_PARENT_FIELD_TYPE/i,
    "Esse tipo está excluído da herança nesse nível (excluded_parent_asset_field_types). Veja com list_extension_exclusions e ajuste com set_excluded_parent_extension_types."],
  [/FIELD_TYPE_INCOMPATIBLE_WITH_CAMPAIGN_TYPE|INCOMPATIBLE_ADVERTISING_CHANNEL_TYPE/i,
    "Esse tipo de recurso não é aceito nesse tipo de campanha."],
  [/FIELD_TYPE_INCOMPATIBLE_WITH_ASSET_TYPE|UNSUPPORTED_FIELD_TYPE/i,
    "O tipo do asset não serve para esse uso (fieldType) ou o nível não aceita esse tipo."],
  [/SCHEDULES_CANNOT_OVERLAP/i, "Os horários (adSchedule) se sobrepõem."],
  [/DUPLICATE_ASSET/i, "Já existe um asset igual nesta conta — reutilize-o com link_extension_assets."],
  [/PROMOTION_CANNOT_SET_PERCENT_OFF_AND_MONEY_AMOUNT_OFF/i, "Promoção: use percentOff OU moneyAmountOff, não os dois."],
  [/PROMOTION_CANNOT_SET_PROMOTION_CODE_AND_ORDERS_OVER_AMOUNT/i, "Promoção: use promotionCode OU ordersOverAmount, não os dois."],
  [/CALL_(INVALID_PHONE_NUMBER|INVALID_DOMESTIC_PHONE_NUMBER_FORMAT|PHONE_NUMBER_NOT_SUPPORTED_FOR_COUNTRY|INVALID_COUNTRY_CODE)/i,
    "Telefone recusado: confira o número (só dígitos, com DDD) e o countryCode de 2 letras."],
  [/CALL_(PREMIUM_RATE|VANITY|DISALLOWED_NUMBER_TYPE|CARRIER_SPECIFIC_SHORT_NUMBER)/i,
    "O Google não aceita esse tipo de número (tarifado, curto de operadora ou 'vanity')."],
  [/PRICE_HEADER_SAME_AS_DESCRIPTION/i, "Preço: o título de cada item não pode ser igual à descrição."],
  [/INVALID_SNIPPETS_HEADER/i,
    "Cabeçalho do snippet recusado: use o texto exato de um dos cabeçalhos oficiais (developers.google.com/google-ads/api/data/structured-snippet-headers), no idioma do anúncio."],
  [/CUSTOMER_NOT_VERIFIED/i, "A conta precisa concluir a verificação do anunciante para esse recurso."],
];

export function explainAssetError(message: string): string {
  const hints = ERROR_HINTS.filter(([pattern]) => pattern.test(message)).map(([, hint]) => hint);
  return hints.length ? `${message}\n→ ${hints.join("\n→ ")}` : message;
}

// ── Validação de entrada ─────────────────────────────────────────────

function validDate(value: string): boolean {
  return ISO_DATE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
    new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);
}

function checkDates(errors: string[], start: string | undefined, end: string | undefined, labels = ["startDate", "endDate"]): void {
  if (start !== undefined && !validDate(start)) errors.push(`${labels[0]} inválido: "${start}" (use YYYY-MM-DD).`);
  if (end !== undefined && !validDate(end)) errors.push(`${labels[1]} inválido: "${end}" (use YYYY-MM-DD).`);
  if (start && end && validDate(start) && validDate(end) && end < start) {
    errors.push(`${labels[1]} (${end}) é anterior a ${labels[0]} (${start}).`);
  }
}

function checkLength(errors: string[], label: string, value: string | undefined, min: number, max: number): void {
  if (value === undefined) return;
  const length = [...value.trim()].length;
  if (length < min || length > max) errors.push(`${label} precisa ter de ${min} a ${max} caracteres (tem ${length}).`);
}

interface ScheduleInput { dayOfWeek?: unknown; startHour?: unknown; startMinute?: unknown; endHour?: unknown; endMinute?: unknown }

/**
 * AdScheduleInfo (common/criteria.proto): até 6 faixas por dia e 42 no total, sem sobreposição
 * (asset_types.proto). Horas 0–23 no início e 0–24 no fim; minutos 0/15/30/45.
 */
export function buildAdSchedule(input: unknown): { targets: Row[] } | { error: string } {
  const entries = ensureArray<ScheduleInput>(input);
  const errors: string[] = [];
  const byDay = new Map<string, Array<[number, number]>>();
  const targets: Row[] = [];
  entries.forEach((entry, index) => {
    const at = `adSchedule[${index}]`;
    if (!entry || typeof entry !== "object") {
      errors.push(`${at}: esperado {dayOfWeek, startHour, endHour, startMinute?, endMinute?}.`);
      return;
    }
    const day = String(entry.dayOfWeek ?? "").toUpperCase();
    const startHour = Number(entry.startHour);
    const endHour = Number(entry.endHour);
    const startMinute = entry.startMinute === undefined ? 0 : Number(entry.startMinute);
    const endMinute = entry.endMinute === undefined ? 0 : Number(entry.endMinute);
    if (!(DAYS_OF_WEEK as readonly string[]).includes(day)) errors.push(`${at}: dayOfWeek "${entry.dayOfWeek}" inválido (${DAYS_OF_WEEK.join(", ")}).`);
    if (!Number.isInteger(startHour) || startHour < 0 || startHour > 23) errors.push(`${at}: startHour precisa ser inteiro de 0 a 23.`);
    if (!Number.isInteger(endHour) || endHour < 0 || endHour > 24) errors.push(`${at}: endHour precisa ser inteiro de 0 a 24.`);
    if (!(startMinute in MINUTE_OF_HOUR) || !(endMinute in MINUTE_OF_HOUR)) errors.push(`${at}: minutos aceitos são 0, 15, 30 ou 45.`);
    if (endHour === 24 && endMinute !== 0) errors.push(`${at}: endHour 24 só com endMinute 0.`);
    const from = startHour * 60 + startMinute;
    const to = endHour * 60 + endMinute;
    if (to <= from) errors.push(`${at}: o fim precisa ser depois do início.`);
    byDay.set(day, [...(byDay.get(day) ?? []), [from, to]]);
    targets.push({
      dayOfWeek: day,
      startHour,
      startMinute: MINUTE_OF_HOUR[startMinute] ?? "ZERO",
      endHour,
      endMinute: MINUTE_OF_HOUR[endMinute] ?? "ZERO",
    });
  });
  if (targets.length > 42) errors.push(`adSchedule: no máximo 42 faixas no total (recebidas ${targets.length}).`);
  for (const [day, ranges] of byDay) {
    if (ranges.length > 6) errors.push(`adSchedule: no máximo 6 faixas por dia (${day} tem ${ranges.length}).`);
    const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i][0] < sorted[i - 1][1]) errors.push(`adSchedule: faixas de ${day} se sobrepõem.`);
    }
  }
  return errors.length ? { error: [...new Set(errors)].join("\n") } : { targets };
}

const adScheduleSchema = flexArray(z.object({
  dayOfWeek: z.enum(DAYS_OF_WEEK).describe("Dia da semana."),
  startHour: z.number().describe("Hora inicial 0–23."),
  startMinute: z.number().optional().describe("0, 15, 30 ou 45. Default 0."),
  endHour: z.number().describe("Hora final 0–24 (24 = fim do dia)."),
  endMinute: z.number().optional().describe("0, 15, 30 ou 45. Default 0."),
})).optional().describe("Horários em que o recurso pode aparecer (fuso da conta). Até 6 faixas por dia, 42 no total, sem sobreposição. Sem isto, veicula o dia todo.");

// ── Alvo do vínculo (conta, campanha ou grupo) ──────────────────────

interface Target {
  level: LinkLevel;
  entityId?: string;
  entityResource?: string;
  name?: string;
  channel?: string;
  campaignId?: string;
  label: string;
}

/** Decide o nível pelo que veio: level explícito, adGroupId → grupo, campaignId → campanha. */
function pickLevel(level: string | undefined, campaignId: string | undefined, adGroupId: string | undefined): { level: LinkLevel } | { error: string } {
  const chosen = (level ?? (adGroupId ? "ad_group" : campaignId ? "campaign" : undefined)) as LinkLevel | undefined;
  if (!chosen) return { error: "Informe campaignId (vincula na campanha), adGroupId (no grupo) ou level='account' (na conta inteira). Nada foi gravado." };
  if (!(LINK_LEVELS as readonly string[]).includes(chosen)) return { error: `level inválido: "${level}" (account, campaign ou ad_group).` };
  if (chosen === "account" && (campaignId || adGroupId)) {
    return { error: "level='account' vincula na conta inteira — não informe campaignId/adGroupId. Nada foi gravado." };
  }
  if (chosen === "campaign") {
    if (!campaignId) return { error: "level='campaign' exige campaignId. Nada foi gravado." };
    if (adGroupId) return { error: "Informe campaignId OU adGroupId, não os dois (o nível do vínculo fica ambíguo). Nada foi gravado." };
    if (!isDigits(campaignId)) return { error: `campaignId deve ser numérico, recebido "${campaignId}". Nada foi gravado.` };
  }
  if (chosen === "ad_group") {
    if (!adGroupId) return { error: "level='ad_group' exige adGroupId. Nada foi gravado." };
    if (!isDigits(adGroupId)) return { error: `adGroupId deve ser numérico, recebido "${adGroupId}". Nada foi gravado.` };
  }
  return { level: chosen };
}

/** Confere que a campanha/grupo existe nesta conta e não está removido. */
async function resolveTarget(client: GoogleAdsClient, cid: string, level: LinkLevel, campaignId?: string, adGroupId?: string): Promise<Target | { error: string }> {
  if (level === "account") return { level, label: `conta ${cid}` };
  if (level === "campaign") {
    const rows = await client.searchStream(cid,
      `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type
       FROM campaign
       WHERE campaign.id = ${campaignId}`);
    const campaign = obj(rows[0]?.campaign);
    if (!rows.length) return { error: `Campanha ${campaignId} não encontrada na conta ${cid}. Nada foi gravado.` };
    if (campaign.status === "REMOVED") return { error: `Campanha ${campaignId} ("${campaign.name}") está removida. Nada foi gravado.` };
    return {
      level,
      entityId: campaignId,
      entityResource: `customers/${cid}/campaigns/${campaignId}`,
      name: String(campaign.name ?? ""),
      channel: String(campaign.advertisingChannelType ?? ""),
      campaignId,
      label: `campanha ${campaignId} ("${campaign.name ?? ""}")`,
    };
  }
  const rows = await client.searchStream(cid,
    `SELECT ad_group.id, ad_group.name, ad_group.status, campaign.id, campaign.name, campaign.advertising_channel_type
     FROM ad_group
     WHERE ad_group.id = ${adGroupId}`);
  const adGroup = obj(rows[0]?.adGroup);
  const campaign = obj(rows[0]?.campaign);
  if (!rows.length) return { error: `Grupo de anúncios ${adGroupId} não encontrado na conta ${cid}. Nada foi gravado.` };
  if (adGroup.status === "REMOVED") return { error: `Grupo ${adGroupId} ("${adGroup.name}") está removido. Nada foi gravado.` };
  return {
    level,
    entityId: adGroupId,
    entityResource: `customers/${cid}/adGroups/${adGroupId}`,
    name: String(adGroup.name ?? ""),
    channel: String(campaign.advertisingChannelType ?? ""),
    campaignId: campaign.id !== undefined ? String(campaign.id) : undefined,
    label: `grupo ${adGroupId} ("${adGroup.name ?? ""}", campanha "${campaign.name ?? ""}")`,
  };
}

function linkPayload(target: Pick<Target, "level" | "entityResource">, assetResource: string, fieldType: string): Row {
  return {
    ...(target.level === "campaign" ? { campaign: target.entityResource } : {}),
    ...(target.level === "ad_group" ? { adGroup: target.entityResource } : {}),
    asset: assetResource,
    fieldType,
    status: "ENABLED",
  };
}

/** Filtro do vínculo pela entidade — pelo atributo do vínculo (segmento no WHERE exigiria SELECT). */
function entityFilter(level: LinkLevel, entityResource?: string): string[] {
  if (!entityResource) return [];
  if (level === "campaign") return [`campaign_asset.campaign = '${entityResource}'`];
  if (level === "ad_group") return [`ad_group_asset.ad_group = '${entityResource}'`];
  return [];
}

interface ExistingLink {
  resourceName: string;
  status: string;
  fieldType: string;
  source: string;
  asset: Row;
}

/** Vínculos ativos (não removidos) de certos tipos numa entidade. */
async function linksAtTarget(client: GoogleAdsClient, cid: string, target: Target, fieldTypes: string[]): Promise<ExistingLink[]> {
  const link = LINK[target.level].resource;
  const where = [
    `${link}.field_type IN (${fieldTypes.map(quote).join(", ")})`,
    `${link}.status != 'REMOVED'`,
    ...entityFilter(target.level, target.entityResource),
  ];
  const rows = await client.searchStream(cid,
    `SELECT ${link}.resource_name, ${link}.status, ${link}.field_type, ${link}.source, ${ASSET_CONTENT_FIELDS.join(", ")}
     FROM ${link}
     WHERE ${where.join(" AND ")}`);
  return rows.map((row) => {
    const l = obj(row[LINK[target.level].json]);
    return {
      resourceName: String(l.resourceName ?? ""),
      status: String(l.status ?? ""),
      fieldType: String(l.fieldType ?? ""),
      source: String(l.source ?? ""),
      asset: obj(row.asset),
    };
  });
}

async function accountCurrency(client: GoogleAdsClient, cid: string): Promise<string> {
  const rows = await client.searchStream(cid, "SELECT customer.id, customer.currency_code FROM customer LIMIT 1");
  const code = obj(rows[0]?.customer).currencyCode;
  return typeof code === "string" && /^[A-Z]{3}$/.test(code) ? code : "BRL";
}

/**
 * Cria o asset e o vínculo numa chamada atômica (googleAds:mutate). O asset usa nome
 * temporário (-1) e o vínculo aponta para ele; se o vínculo for recusado, o asset também não fica.
 */
async function createAndLink(client: GoogleAdsClient, cid: string, assetCreate: Row, fieldType: string, target: Target) {
  const tmp = `customers/${cid}/assets/-1`;
  const spec = LINK[target.level];
  const response = await client.batchMutate(cid, [
    { assetOperation: { create: { resourceName: tmp, ...assetCreate } } },
    { [spec.operation]: { create: linkPayload(target, tmp, fieldType) } },
  ]);
  const responses = arr<Row>(response.mutateOperationResponses);
  return {
    assetResource: obj(responses[0]?.assetResult).resourceName as string | undefined,
    linkResource: obj(responses[1]?.[spec.result]).resourceName as string | undefined,
  };
}

interface CreationOutcome {
  what: string;
  target: Target;
  fieldType: string;
  summary: string;
  dryRun: boolean;
  assetResource?: string;
  linkResource?: string;
  warnings: string[];
  details?: Row;
}

function creationResult(o: CreationOutcome): ToolResult {
  const payload = {
    field_type: o.fieldType,
    level: o.target.level,
    target: o.target.label,
    content: o.summary,
    dry_run: o.dryRun,
    ...(o.assetResource ? { asset_resource_name: o.assetResource } : {}),
    ...(o.linkResource ? { link_resource_name: o.linkResource } : {}),
    ...(o.details ? { details: o.details } : {}),
    ...(o.warnings.length ? { warnings: o.warnings } : {}),
  };
  if (o.dryRun) {
    return { content: [text(`DRY-RUN (validateOnly): ${o.what} + vínculo validados pela API na ${LINK[o.target.level].label} — nada foi gravado.\n\n${formatJson(payload)}`)] };
  }
  if (!o.assetResource || !o.linkResource) {
    return fail(`A API não confirmou a criação de ${o.what} — confira com list_extensions antes de repetir.\n\n${formatJson(payload)}`);
  }
  return {
    content: [text(
      `${o.what} criado(a) e vinculado(a) à ${o.target.label} (asset + vínculo na mesma operação atômica).\n\n` +
      `${formatJson(payload)}\n\nConfira status e análise com list_extensions; desempenho com get_extension_performance.`
    )],
  };
}

async function runCreation(
  client: GoogleAdsClient,
  cid: string,
  target: Target,
  fieldType: string,
  what: string,
  assetCreate: Row,
  summary: string,
  warnings: string[],
  details?: Row
): Promise<ToolResult> {
  try {
    const { assetResource, linkResource } = await createAndLink(client, cid, assetCreate, fieldType, target);
    return creationResult({ what, target, fieldType, summary, dryRun: client.isDryRun, assetResource, linkResource, warnings, details });
  } catch (err) {
    return fail(
      `Nada foi criado (asset e vínculo vão na mesma operação atômica).\nErro: ${explainAssetError((err as Error).message)}`
    );
  }
}

interface SimilarLink { link: ExistingLink; differs: ContentDiff[] }

/**
 * Separa, entre os vínculos da entidade, o idêntico ao pedido (todo o conteúdo comparável igual —
 * `same`, preferindo o ENABLED) dos parecidos: mesma "identidade" (ex.: mesmo texto e URL) e
 * conteúdo diferente (`similar`, com os campos que diferem).
 */
function findSameOrSimilar(
  links: ExistingLink[],
  requested: Row,
  identity: (asset: Row) => string,
  defaultable: string[] = []
): { same?: ExistingLink; similar: SimilarLink[] } {
  const key = identity(requested);
  const same: ExistingLink[] = [];
  const similar: SimilarLink[] = [];
  for (const link of links) {
    const differs = diffAssetContent(requested, link.asset, defaultable);
    if (differs.length === 0) same.push(link);
    else if (identity(link.asset) === key) similar.push({ link, differs });
  }
  return { same: same.find((l) => l.status === "ENABLED") ?? same[0], similar };
}

const similarPayload = ({ link, differs }: SimilarLink): Row => ({
  asset_id: String(link.asset.id ?? ""),
  content: describeAsset(link.asset),
  link_status: link.status,
  link_resource_name: link.resourceName,
  differs,
});

const differsLabel = (differs: ContentDiff[], max = 8) =>
  differs.slice(0, max).map((d) => d.field).join(", ") + (differs.length > max ? ` e mais ${differs.length - max}` : "");

/**
 * Parecido (mesma identidade), mas não igual: não cria outro nem diz que "já está", porque o
 * conteúdo pedido não está no ar. Aponta a edição do existente.
 */
function similarRefusal(what: string, identityLabel: string, target: Target, similar: SimilarLink[], extraHints: string[] = []): ToolResult {
  const first = similar[0];
  return fail(
    `Nada foi gravado: já existe ${what} com ${identityLabel} vinculado(a) à ${target.label} (asset ${first.link.asset.id}, vínculo ${first.link.status}), ` +
    `mas o conteúdo é diferente do pedido — difere em: ${differsLabel(first.differs)}. Para não duplicar, não criei outro.\n` +
    `→ Para mudar o existente: update_extension_asset com assetId ${first.link.asset.id} (a mudança vale em todos os vínculos dele).\n` +
    "→ Para criar outro mesmo assim: remova antes o vínculo antigo com update_extension_link_status (status REMOVED, confirm: true)." +
    extraHints.map((hint) => `\n→ ${hint}`).join("") +
    `\n\n${formatJson(similar.map(similarPayload))}`
  );
}

/** Parecido em preço/promoção: cria o novo, mas avisa que o existente continua lá. */
function similarWarning(what: string, similar: SimilarLink[]): string {
  const enabled = similar.filter((s) => s.link.status === "ENABLED").length;
  return (
    `Já há ${similar.length} ${what} parecido(s) vinculado(s) aqui com conteúdo diferente ` +
    `(${similar.map((s) => `asset ${s.link.asset.id}, vínculo ${s.link.status}: difere em ${differsLabel(s.differs, 6)}`).join("; ")}). ` +
    `Criar este não substitui o existente${enabled ? ": os ENABLED continuam veiculando junto com o novo" : ""}. ` +
    "Para trocar em vez de somar: update_extension_asset no asset existente, ou pause/remova o vínculo antigo com " +
    "update_extension_link_status (detalhes em details.similar_existing)."
  );
}

/** Idêntico ao pedido já vinculado na entidade? Então não cria de novo (e não reativa pausado). */
function duplicateResult(what: string, target: Target, existing: ExistingLink): ToolResult {
  return {
    content: [text(
      `Nada a fazer: ${what} com o mesmo conteúdo pedido já está vinculado(a) à ${target.label} ` +
      `(vínculo ${existing.status}${existing.status === "PAUSED" ? " — continua pausado, não foi reativado" : ""}). Nenhuma escrita foi enviada.\n\n` +
      formatJson({
        content: describeAsset(existing.asset),
        asset_id: String(existing.asset.id ?? ""),
        link_status: existing.status,
        link_resource_name: existing.resourceName,
      }) +
      (existing.status === "PAUSED" ? "\n\nPara reativar de propósito: update_extension_link_status com status ENABLED." : "")
    )],
  };
}

const levelSchema = z.enum(LINK_LEVELS).optional().describe(
  "Onde vincular: account (conta inteira — vale para todas as campanhas que aceitam), campaign ou ad_group. " +
  "Default: ad_group se vier adGroupId, campaign se vier campaignId."
);

// ── Registro das tools ───────────────────────────────────────────────

export function registerExtensionsTools(ctx: ToolContext): void {
  const { mcp, getClient, allowedCustomerIds, hosted } = ctx;

  /** Guarda de conta + customerId numérico. */
  const guard = (customerId: string): { cid: string } | { error: ToolResult } => {
    const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
    if (blocked) return { error: { content: [blocked], isError: true } };
    const cid = String(customerId ?? "").replace(/-/g, "");
    if (!/^\d+$/.test(cid)) return { error: fail(`customerId inválido: "${customerId}".`) };
    return { cid };
  };

  /** Valida os fieldTypes pedidos (ou o padrão de extensões). */
  const pickFieldTypes = (input: unknown): { types: string[] } | { error: string } => {
    const raw = input === undefined ? [] : ensureArray<string>(input).map((t) => String(t).trim().toUpperCase()).filter(Boolean);
    if (raw.length === 0) return { types: DEFAULT_EXTENSION_FIELD_TYPES };
    const invalid = raw.filter((t) => !(ASSET_FIELD_TYPES as readonly string[]).includes(t));
    if (invalid.length) return { error: `fieldTypes inválido(s): ${invalid.join(", ")}. Válidos: ${ASSET_FIELD_TYPES.join(", ")}.` };
    return { types: [...new Set(raw)] };
  };

  // ── list_extensions (existente, reescrita) ─────────────────────────

  mcp.registerTool(
    "list_extensions",
    {
      description: [
        "Lista os recursos (extensões) vinculados: sitelinks, frases de destaque, snippets, chamada, preço,",
        "promoção, app, mensagem/WhatsApp, formulário de lead, nome/logo da empresa e aviso legal.",
        "READ OPERATION.",
        "",
        "Níveis: account (CustomerAsset), campaign (CampaignAsset), ad_group (AdGroupAsset) ou all.",
        "Default: ad_group se vier adGroupId, campaign se vier campaignId, senão all.",
        "Por vínculo: conteúdo, datas/horários de veiculação, status do vínculo, primary_status com motivos,",
        "origem (ADVERTISER ou AUTOMATICALLY_CREATED = criado pelo Google) e o link_resource_name usado em",
        "update_extension_link_status. HEADLINE/DESCRIPTION/AD_IMAGE só aparecem se pedidos em fieldTypes.",
        "Métricas: get_extension_performance.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().optional().describe("Filtra por campanha (vínculos da campanha; no nível ad_group, os grupos dela)."),
        adGroupId: z.string().optional().describe("Filtra por grupo de anúncios (nível ad_group)."),
        level: z.enum(["account", "campaign", "ad_group", "all"]).optional().describe("Nível dos vínculos. Default: pelo filtro informado, senão all."),
        fieldTypes: flexArray(z.enum(ASSET_FIELD_TYPES)).optional().describe(
          "Tipos de uso (AssetFieldType). Default: extensões + nome/logo/aviso legal (sem HEADLINE, DESCRIPTION e AD_IMAGE)."
        ),
        source: z.enum(["ADVERTISER", "AUTOMATICALLY_CREATED"]).optional().describe("Só os criados pelo anunciante ou só os automáticos do Google."),
        includeRemoved: z.boolean().optional().describe("Inclui vínculos removidos. Default: false."),
        limit: z.number().optional().describe("Máximo de linhas por nível. Default: 500."),
        format: formatSchema,
      },
    },
    async ({ customerId, campaignId, adGroupId, level, fieldTypes, source, includeRemoved, limit, format }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = customerId.replace(/-/g, "");
      if (campaignId !== undefined && !isDigits(campaignId)) return fail(`campaignId deve ser numérico, recebido "${campaignId}".`);
      if (adGroupId !== undefined && !isDigits(adGroupId)) return fail(`adGroupId deve ser numérico, recebido "${adGroupId}".`);
      const enumError = checkScopeEnums(level, source);
      if (enumError) return fail(enumError);
      const max = limit ?? 500;
      if (!Number.isInteger(max) || max < 1 || max > 10_000) return fail(`limit precisa ser inteiro de 1 a 10000, recebido ${limit}.`);
      const picked = pickFieldTypes(fieldTypes);
      if ("error" in picked) return fail(picked.error);

      const chosen = level ?? (adGroupId ? "ad_group" : campaignId ? "campaign" : "all");
      const levels: LinkLevel[] = chosen === "all" ? [...LINK_LEVELS] : [chosen];
      const client = getClient();
      const notes: string[] = [];
      if ((campaignId || adGroupId) && levels.includes("account")) {
        notes.push("Vínculos da conta (account) valem para todas as campanhas; o filtro de campanha/grupo não se aplica a eles.");
      }

      const rows: Row[] = [];
      for (const lvl of levels) {
        const link = LINK[lvl].resource;
        const where = [`${link}.field_type IN (${picked.types.map(quote).join(", ")})`];
        if (!includeRemoved) where.push(`${link}.status != 'REMOVED'`);
        if (source) where.push(`${link}.source = '${source}'`);
        let entitySelect = "";
        if (lvl === "campaign") {
          entitySelect = "campaign_asset.campaign, campaign.id, campaign.name, ";
          if (campaignId) where.push(`campaign_asset.campaign = 'customers/${cid}/campaigns/${campaignId}'`);
          else if (adGroupId) {
            notes.push("Vínculos de campanha ficaram de fora: com só adGroupId, informe também campaignId (ou use level=ad_group).");
            continue;
          }
        } else if (lvl === "ad_group") {
          entitySelect = "ad_group_asset.ad_group, ad_group.id, ad_group.name, campaign.id, campaign.name, ";
          if (adGroupId) where.push(`ad_group_asset.ad_group = 'customers/${cid}/adGroups/${adGroupId}'`);
          else if (campaignId) where.push(`campaign.id = ${campaignId}`);
        }
        const results = await client.searchStream(cid,
          `SELECT ${link}.resource_name, ${link}.field_type, ${link}.status, ${link}.source,
                  ${link}.primary_status, ${link}.primary_status_reasons,
                  ${entitySelect}${ASSET_CONTENT_FIELDS.join(", ")}
           FROM ${link}
           WHERE ${where.join(" AND ")}
           LIMIT ${max}`);
        if (results.length >= max) notes.push(`Nível ${lvl}: atingiu o limit (${max}) — pode haver mais vínculos.`);
        for (const r of results) {
          const l = obj(r[LINK[lvl].json]);
          const asset = obj(r.asset);
          const camp = obj(r.campaign);
          const group = obj(r.adGroup);
          const serving = servingOf(asset);
          const policy = obj(asset.policySummary);
          rows.push({
            level: lvl,
            campaign_id: camp.id !== undefined ? String(camp.id) : undefined,
            campaign_name: camp.name,
            ad_group_id: group.id !== undefined ? String(group.id) : undefined,
            ad_group_name: group.name,
            field_type: l.fieldType,
            asset_id: asset.id !== undefined ? String(asset.id) : undefined,
            asset_type: asset.type,
            content: describeAsset(asset),
            start_date: serving.start_date,
            end_date: serving.end_date,
            schedules: serving.schedules.length ? serving.schedules.join("; ") : undefined,
            link_status: l.status,
            primary_status: l.primaryStatus,
            primary_status_reasons: arr<string>(l.primaryStatusReasons).join(", ") || undefined,
            source: l.source,
            approval_status: policy.approvalStatus,
            review_status: policy.reviewStatus,
            link_resource_name: l.resourceName,
          });
        }
      }

      if (format === "table") return { content: [text(formatAsTable(rows))] };
      if (format === "csv") return { content: [text(formatAsCsv(rows))] };

      const counts = new Map<string, number>();
      for (const row of rows) {
        const key = `${row.level}/${row.field_type}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      const summary = [...counts.entries()].sort().map(([k, v]) => `${k}: ${v}`).join(" | ");
      return {
        content: [text(
          `${rows.length} vínculo(s) de extensão/asset${summary ? ` — ${summary}` : ""}.` +
          (notes.length ? `\n${notes.map((n) => `Nota: ${n}`).join("\n")}` : "") +
          `\n\n${formatJson(rows)}`
        )],
      };
    }
  );

  // ── get_extension_performance (item 67) ────────────────────────────

  mcp.registerTool(
    "get_extension_performance",
    {
      description: [
        "Desempenho e status de veiculação das extensões (sitelinks, frases de destaque, snippets, chamada,",
        "preço, promoção, mensagem, formulário...) por vínculo e totais por tipo.",
        "READ OPERATION.",
        "",
        "Por vínculo (conta/campanha/grupo): impressões, cliques, CTR, custo, conversões, status do vínculo,",
        "primary_status com motivos e detalhes (ex.: ASSET_DISAPPROVED) e sinais para poda (sem impressões,",
        "reprovado, limitado). clickScope=asset_only (default) conta só cliques/conversões NO PRÓPRIO asset",
        "(segments.asset_interaction_target.interaction_on_this_asset); all conta a interação em qualquer",
        "parte do anúncio servido junto. Impressões são sempre as do anúncio com o asset.",
        "",
        "Totais por tipo vêm de asset_field_type_view (agregado por tipo, inclui os automáticos do Google) — não",
        "são a soma dos vínculos, que se sobrepõem quando vários assets do mesmo tipo aparecem no mesmo anúncio.",
        "Com campaignId/adGroupId, os vínculos de conta (e de campanha, no caso do grupo) mostram as",
        "métricas só dentro daquela campanha/grupo — é a visão do que efetivamente serviu ali.",
        "Vínculos sem impressão no período aparecem com zero (inventário vem de uma consulta sem métricas).",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        level: z.enum(["account", "campaign", "ad_group", "all"]).optional().describe("Nível dos vínculos. Default: all."),
        campaignId: z.string().optional().describe("Escopo: uma campanha."),
        adGroupId: z.string().optional().describe("Escopo: um grupo de anúncios (se vier campaignId junto, precisa ser dessa campanha)."),
        fieldTypes: flexArray(z.enum(ASSET_FIELD_TYPES)).optional().describe("Tipos (AssetFieldType). Default: extensões + nome/logo/aviso legal."),
        clickScope: z.enum(["asset_only", "all"]).optional().describe("asset_only (default): cliques/conversões no próprio asset. all: em qualquer parte do anúncio."),
        source: z.enum(["ADVERTISER", "AUTOMATICALLY_CREATED"]).optional().describe("Só do anunciante ou só automáticos."),
        includeRemoved: z.boolean().optional().describe("Inclui vínculos removidos. Default: false."),
        dateRange: dateRangeSchema.describe(DATE_RANGE_DESC),
        days: z.number().optional().describe(DAYS_DESC),
        format: formatSchema,
      },
    },
    async ({ customerId, level, campaignId, adGroupId, fieldTypes, clickScope, source, includeRemoved, dateRange, days, format }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = customerId.replace(/-/g, "");
      if (campaignId !== undefined && !isDigits(campaignId)) return fail(`campaignId deve ser numérico, recebido "${campaignId}".`);
      if (adGroupId !== undefined && !isDigits(adGroupId)) return fail(`adGroupId deve ser numérico, recebido "${adGroupId}".`);
      const enumError = checkScopeEnums(level, source);
      if (enumError) return fail(enumError);
      if (clickScope !== undefined && !["asset_only", "all"].includes(clickScope)) return fail(`clickScope inválido: "${clickScope}".`);
      const picked = pickFieldTypes(fieldTypes);
      if ("error" in picked) return fail(picked.error);
      let dateClause: string;
      try {
        dateClause = buildDateClause(dateRange, days);
      } catch (err) {
        return fail((err as Error).message);
      }
      const scope = clickScope ?? "asset_only";
      const levels: LinkLevel[] = !level || level === "all" ? [...LINK_LEVELS] : [level];
      const client = getClient();

      // Grupo → campanha dele (para os vínculos de campanha que o grupo herda)
      let scopeCampaignId = campaignId;
      let scopeLabel = campaignId ? `campanha ${campaignId}` : `conta ${cid}`;
      if (adGroupId) {
        const groupRows = await client.searchStream(cid,
          `SELECT ad_group.id, ad_group.name, campaign.id, campaign.name
           FROM ad_group
           WHERE ad_group.id = ${adGroupId}`);
        if (!groupRows.length) return fail(`Grupo de anúncios ${adGroupId} não encontrado na conta ${cid}.`);
        scopeCampaignId = String(obj(groupRows[0].campaign).id ?? "");
        if (campaignId && campaignId !== scopeCampaignId) {
          return fail(`O grupo ${adGroupId} pertence à campanha ${scopeCampaignId}, não à ${campaignId}.`);
        }
        scopeLabel = `grupo ${adGroupId} ("${obj(groupRows[0].adGroup).name ?? ""}")`;
      }
      const typeList = picked.types.map(quote).join(", ");

      interface LinkAcc { row: Row; all: MetricTotals; onAsset: MetricTotals }
      const byLink = new Map<string, LinkAcc>();

      for (const lvl of levels) {
        const link = LINK[lvl].resource;
        const json = LINK[lvl].json;
        // Inventário (sem métricas): garante que vínculos sem impressão também apareçam
        const inventoryWhere = [`${link}.field_type IN (${typeList})`];
        if (!includeRemoved) inventoryWhere.push(`${link}.status != 'REMOVED'`);
        if (source) inventoryWhere.push(`${link}.source = '${source}'`);
        // Filtros das métricas: segmentos (campaign/ad_group) entram no SELECT, como a API exige
        const metricWhere = [`${link}.field_type IN (${typeList})`, dateClause];
        if (source) metricWhere.push(`${link}.source = '${source}'`);
        const metricSelect: string[] = [];
        let entitySelect = "";
        if (lvl === "account") {
          if (adGroupId) { metricWhere.push(`ad_group.id = ${adGroupId}`); metricSelect.push("ad_group.id"); }
          else if (campaignId) { metricWhere.push(`campaign.id = ${campaignId}`); metricSelect.push("campaign.id"); }
        } else if (lvl === "campaign") {
          entitySelect = "campaign_asset.campaign, campaign.id, campaign.name, ";
          if (scopeCampaignId) {
            const filter = `campaign_asset.campaign = 'customers/${cid}/campaigns/${scopeCampaignId}'`;
            inventoryWhere.push(filter);
            metricWhere.push(filter);
          }
          if (adGroupId) { metricWhere.push(`ad_group.id = ${adGroupId}`); metricSelect.push("ad_group.id"); }
        } else {
          entitySelect = "ad_group_asset.ad_group, ad_group.id, ad_group.name, campaign.id, campaign.name, ";
          if (adGroupId) {
            const filter = `ad_group_asset.ad_group = 'customers/${cid}/adGroups/${adGroupId}'`;
            inventoryWhere.push(filter);
            metricWhere.push(filter);
          } else if (campaignId) {
            inventoryWhere.push(`campaign.id = ${campaignId}`);
            metricWhere.push(`campaign.id = ${campaignId}`);
            metricSelect.push("campaign.id");
          }
        }

        const inventory = await client.searchStream(cid,
          `SELECT ${link}.resource_name, ${link}.field_type, ${link}.status, ${link}.source,
                  ${link}.primary_status, ${link}.primary_status_reasons, ${link}.primary_status_details,
                  ${entitySelect}${ASSET_CONTENT_FIELDS.join(", ")}
           FROM ${link}
           WHERE ${inventoryWhere.join(" AND ")}`);
        for (const r of inventory) {
          const l = obj(r[json]);
          const asset = obj(r.asset);
          const camp = obj(r.campaign);
          const group = obj(r.adGroup);
          const details = arr<Row>(l.primaryStatusDetails)
            .map((d) => {
              const reasons = arr<string>(obj(d.assetDisapproved).offlineEvaluationErrorReasons);
              return `${d.status ?? "?"}/${d.reason ?? "?"}${reasons.length ? ` (${reasons.join(", ")})` : ""}`;
            });
          byLink.set(String(l.resourceName), {
            row: {
              level: lvl,
              campaign_id: camp.id !== undefined ? String(camp.id) : undefined,
              campaign_name: camp.name,
              ad_group_id: group.id !== undefined ? String(group.id) : undefined,
              ad_group_name: group.name,
              field_type: l.fieldType,
              asset_id: asset.id !== undefined ? String(asset.id) : undefined,
              content: describeAsset(asset),
              link_status: l.status,
              primary_status: l.primaryStatus,
              primary_status_reasons: arr<string>(l.primaryStatusReasons),
              primary_status_details: details,
              source: l.source,
              link_resource_name: l.resourceName,
            },
            all: emptyTotals(),
            onAsset: emptyTotals(),
          });
        }

        const metricFields = "metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value";
        const extra = metricSelect.length ? `${metricSelect.join(", ")}, ` : "";
        const allRows = await client.searchStream(cid,
          `SELECT ${link}.resource_name, ${extra}${metricFields}
           FROM ${link}
           WHERE ${metricWhere.join(" AND ")}`);
        for (const r of allRows) {
          const acc = byLink.get(String(obj(r[json]).resourceName));
          if (acc) addMetrics(acc.all, obj(r.metrics));
        }
        if (scope === "asset_only") {
          const onAssetRows = await client.searchStream(cid,
            `SELECT ${link}.resource_name, ${extra}segments.asset_interaction_target.interaction_on_this_asset, ${metricFields}
             FROM ${link}
             WHERE ${[...metricWhere, "segments.asset_interaction_target.interaction_on_this_asset = TRUE"].join(" AND ")}`);
          for (const r of onAssetRows) {
            const acc = byLink.get(String(obj(r[json]).resourceName));
            if (acc) addMetrics(acc.onAsset, obj(r.metrics));
          }
        }
      }

      // Totais por tipo sem dupla contagem (inclui automáticos)
      const viewWhere = [`asset_field_type_view.field_type IN (${typeList})`, dateClause];
      const viewSelect = ["asset_field_type_view.field_type"];
      if (adGroupId) { viewWhere.push(`ad_group.id = ${adGroupId}`); viewSelect.push("ad_group.id"); }
      else if (campaignId) { viewWhere.push(`campaign.id = ${campaignId}`); viewSelect.push("campaign.id"); }
      const viewRows = await client.searchStream(cid,
        `SELECT ${viewSelect.join(", ")}, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value
         FROM asset_field_type_view
         WHERE ${viewWhere.join(" AND ")}`);
      const typeTotals = new Map<string, MetricTotals>();
      for (const r of viewRows) {
        const type = String(obj(r.assetFieldTypeView).fieldType ?? "?");
        typeTotals.set(type, addMetrics(typeTotals.get(type) ?? emptyTotals(), obj(r.metrics)));
      }

      const rows: Row[] = [...byLink.values()].map(({ row, all, onAsset }): Row => {
        const primary = scope === "asset_only" ? { ...onAsset, impressions: all.impressions } : all;
        const view = metricsView(primary);
        const flags: string[] = [];
        if (row.link_status === "ENABLED" && all.impressions === 0) flags.push("sem impressões no período");
        if (row.primary_status === "NOT_ELIGIBLE" || row.primary_status === "LIMITED") {
          flags.push(`${row.primary_status}${arr(row.primary_status_reasons).length ? `: ${arr(row.primary_status_reasons).join(", ")}` : ""}`);
        }
        if (arr<string>(row.primary_status_reasons).includes("ASSET_DISAPPROVED")) flags.push("reprovado");
        if (scope === "asset_only" && all.impressions >= 1000 && onAsset.clicks === 0) flags.push("1000+ impressões sem clique no próprio asset");
        return {
          ...row,
          primary_status_reasons: arr<string>(row.primary_status_reasons).join(", ") || undefined,
          primary_status_details: arr<string>(row.primary_status_details).join("; ") || undefined,
          impressions: view.impressions,
          clicks: view.clicks,
          ctr_pct: view.ctr_pct,
          cost: view.spend,
          avg_cpc: view.cpc,
          conversions: view.conversions,
          conversions_value: view.conversions_value,
          cpa: view.cpa,
          ...(scope === "asset_only" ? { clicks_any_part_of_ad: all.clicks } : {}),
          flags: flags.join("; ") || undefined,
        };
      }).sort((a, b) => String(a.field_type).localeCompare(String(b.field_type)) || num(b.impressions) - num(a.impressions));

      if (format === "table") return { content: [text(formatAsTable(rows))] };
      if (format === "csv") return { content: [text(formatAsCsv(rows))] };

      const types = [...new Set([...rows.map((r) => String(r.field_type)), ...typeTotals.keys()])].sort();
      const byType = types.map((type) => {
        const links = rows.filter((r) => r.field_type === type);
        return {
          field_type: type,
          links: links.length,
          links_enabled: links.filter((r) => r.link_status === "ENABLED").length,
          links_paused: links.filter((r) => r.link_status === "PAUSED").length,
          links_with_flags: links.filter((r) => r.flags).length,
          type_totals: metricsView(typeTotals.get(type) ?? emptyTotals()),
        };
      });
      const period = dateRange?.since ? `${dateRange.since} a ${dateRange.until}` : `últimos ${days ?? 30} dias`;
      return {
        content: [text(
          `Extensões — ${scopeLabel}, ${period}, cliques: ${scope === "asset_only" ? "só no próprio asset" : "em qualquer parte do anúncio"}.\n` +
          `${rows.length} vínculo(s); ${rows.filter((r) => r.flags).length} com sinal de atenção.\n` +
          "Totais por tipo vêm de asset_field_type_view (agregado por tipo, inclui automáticos) — não são a soma dos vínculos, que se sobrepõem quando vários assets do mesmo tipo aparecem juntos.\n\n" +
          formatJson({ scope: scopeLabel, period, click_scope: scope, by_type: byType, links: rows })
        )],
      };
    }
  );

  // ── link_extension_assets ──────────────────────────────────────────

  mcp.registerTool(
    "link_extension_assets",
    {
      description: [
        "Vincula assets JÁ EXISTENTES como extensão/identidade na conta, em campanhas ou em grupos.",
        "WRITE OPERATION — só cria vínculos; não altera o asset, lances, orçamento nem segmentação.",
        "",
        "Reaproveita um sitelink/frase/snippet/chamada/preço/promoção/mensagem em outras campanhas,",
        "vincula no nível da conta (CustomerAsset) ou do grupo (AdGroupAsset), e liga nome da empresa",
        "(BUSINESS_NAME, asset TEXT), logotipo (BUSINESS_LOGO, asset IMAGE) e aviso legal (TEXT_DISCLAIMER).",
        "Níveis aceitos por tipo (tabela oficial): LEAD_FORM só campanha; BUSINESS_NAME/BUSINESS_LOGO conta ou",
        "campanha; os demais conta, campanha ou grupo. TEXT_DISCLAIMER é novo (v25.1) e o Google ainda não",
        "documenta os níveis — a API decide (teste antes com validateOnly: true).",
        "",
        "Antes de gravar: confere que cada asset existe nesta conta, tem o tipo certo e não é automático; que",
        "cada campanha/grupo existe e não está removido. Vínculo existente não é recriado; PAUSADO continua",
        "pausado. Mais de 20 vínculos numa chamada exige confirm: true. Relatório por item (partial failure).",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        fieldType: z.enum(LINKABLE_FIELD_TYPES).describe("Uso do asset no vínculo."),
        assetIds: flexArray(z.string()).describe("Assets: IDs numéricos ou customers/{cid}/assets/{id}. Máx. 20."),
        level: z.enum(LINK_LEVELS).describe("account, campaign ou ad_group."),
        campaignIds: flexArray(z.string()).optional().describe("Campanhas (level=campaign). Máx. 50."),
        adGroupIds: flexArray(z.string()).optional().describe("Grupos (level=ad_group). Máx. 50."),
        confirm: z.boolean().optional().describe("Obrigatório (true) quando a chamada criaria mais de 20 vínculos."),
      },
    },
    async ({ customerId, fieldType, assetIds, level, campaignIds, adGroupIds, confirm }) => {
      const g = guard(customerId);
      if ("error" in g) return g.error;
      const { cid } = g;
      const rule = FIELD_TYPE_RULES[fieldType];
      if (!rule) return fail(`fieldType inválido: ${fieldType}.`);
      if (!rule.levels.includes(level)) {
        return fail(`${fieldType} (${rule.label}) só pode ser vinculado em: ${rule.levels.join(", ")}. Nada foi gravado.`);
      }

      const refs = ensureArray<string>(assetIds).map(String).filter((r) => r.trim());
      if (refs.length === 0) return fail("Informe ao menos um asset em assetIds. Nada foi gravado.");
      const wanted = new Map<string, string>();
      const invalid: string[] = [];
      for (const ref of refs) {
        const parsed = parseImageAssetRef(ref, cid);
        if ("error" in parsed) invalid.push(parsed.error);
        else wanted.set(parsed.assetId, parsed.resourceName);
      }
      if (invalid.length) return fail(`Nada foi gravado — referência(s) inválida(s):\n- ${invalid.join("\n- ")}`);
      if (wanted.size > 20) return fail(`No máximo 20 assets por chamada (recebidos ${wanted.size}). Nada foi gravado.`);
      if (fieldType === "BUSINESS_MESSAGE" && wanted.size > 1) {
        return fail("Só pode haver UM recurso de mensagem ativo por entidade — vincule um asset BUSINESS_MESSAGE por vez. Nada foi gravado.");
      }

      let entityIds: string[] = [];
      if (level === "campaign" || level === "ad_group") {
        const input = level === "campaign" ? campaignIds : adGroupIds;
        const label = level === "campaign" ? "campaignIds" : "adGroupIds";
        entityIds = [...new Set(ensureArray<string>(input).map((id) => String(id).trim()).filter(Boolean))];
        if (entityIds.length === 0) return fail(`level=${level} exige ${label}. Nada foi gravado.`);
        const bad = entityIds.filter((id) => !/^\d+$/.test(id));
        if (bad.length) return fail(`${label} deve ter só IDs numéricos (inválidos: ${bad.join(", ")}). Nada foi gravado.`);
        if (entityIds.length > 50) return fail(`No máximo 50 entidades por chamada (recebidas ${entityIds.length}). Nada foi gravado.`);
        const other = level === "campaign" ? adGroupIds : campaignIds;
        if (ensureArray(other).length) return fail(`level=${level}: informe só ${label}. Nada foi gravado.`);
      } else if (ensureArray(campaignIds).length || ensureArray(adGroupIds).length) {
        return fail("level=account vincula na conta inteira — não informe campaignIds/adGroupIds. Nada foi gravado.");
      }
      const totalLinks = wanted.size * Math.max(entityIds.length, 1);
      if (totalLinks > 20 && confirm !== true) {
        return fail(`Esta chamada criaria até ${totalLinks} vínculos. Confira a lista e repita com confirm: true. Nada foi gravado.`);
      }

      const client = getClient();

      // 1. Assets: existem, tipo certo, não automáticos
      const assetIdList = [...wanted.keys()];
      const assetRows = await client.searchStream(cid,
        `SELECT ${ASSET_CONTENT_FIELDS.join(", ")}
         FROM asset
         WHERE asset.id IN (${assetIdList.join(", ")})`);
      const assets = new Map<string, Row>();
      for (const row of assetRows) {
        const asset = obj(row.asset);
        assets.set(String(asset.id), asset);
      }
      const rejected: string[] = [];
      for (const id of assetIdList) {
        const asset = assets.get(id);
        if (!asset) rejected.push(`asset ${id} não existe na conta ${cid}`);
        else if (asset.type !== rule.assetType) rejected.push(`asset ${id} é do tipo ${asset.type}; ${fieldType} exige ${rule.assetType}`);
        else if (asset.source === "AUTOMATICALLY_CREATED") rejected.push(`asset ${id} foi criado automaticamente pelo Google — a API não permite vinculá-lo`);
      }

      // 2. Entidades: existem e não estão removidas
      const entities = new Map<string, { name: string; resource: string }>();
      const foundEntityIds = new Set<string>();
      if (level === "campaign") {
        const rows = await client.searchStream(cid,
          `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type
           FROM campaign
           WHERE campaign.id IN (${entityIds.join(", ")})`);
        for (const row of rows) {
          const c = obj(row.campaign);
          foundEntityIds.add(String(c.id));
          if (c.status === "REMOVED") rejected.push(`campanha ${c.id} ("${c.name}") está removida`);
          else entities.set(String(c.id), { name: String(c.name ?? ""), resource: `customers/${cid}/campaigns/${c.id}` });
        }
      } else if (level === "ad_group") {
        const rows = await client.searchStream(cid,
          `SELECT ad_group.id, ad_group.name, ad_group.status, campaign.id
           FROM ad_group
           WHERE ad_group.id IN (${entityIds.join(", ")})`);
        for (const row of rows) {
          const a = obj(row.adGroup);
          foundEntityIds.add(String(a.id));
          if (a.status === "REMOVED") rejected.push(`grupo ${a.id} ("${a.name}") está removido`);
          else entities.set(String(a.id), { name: String(a.name ?? ""), resource: `customers/${cid}/adGroups/${a.id}` });
        }
      }
      for (const id of entityIds) {
        if (!foundEntityIds.has(id)) {
          rejected.push(`${level === "campaign" ? "campanha" : "grupo"} ${id} não existe na conta ${cid}`);
        }
      }
      if (rejected.length) return fail(`Nada foi gravado:\n- ${rejected.join("\n- ")}`);

      // 3. Vínculos existentes (qualquer status) — nada é recriado nem reativado
      const spec = LINK[level];
      const assetResources = assetIdList.map((id) => wanted.get(id)!);
      const existingWhere = [`${spec.resource}.field_type = '${fieldType}'`];
      if (fieldType !== "BUSINESS_MESSAGE") existingWhere.push(`${spec.resource}.asset IN (${assetResources.map(quote).join(", ")})`);
      if (level === "campaign") existingWhere.push(`campaign_asset.campaign IN (${[...entities.values()].map((e) => quote(e.resource)).join(", ")})`);
      if (level === "ad_group") existingWhere.push(`ad_group_asset.ad_group IN (${[...entities.values()].map((e) => quote(e.resource)).join(", ")})`);
      const entityAttr = level === "campaign" ? "campaign_asset.campaign, " : level === "ad_group" ? "ad_group_asset.ad_group, " : "";
      const existingRows = await client.searchStream(cid,
        `SELECT ${spec.resource}.resource_name, ${spec.resource}.status, ${spec.resource}.asset, ${entityAttr}asset.business_message_asset.message_provider
         FROM ${spec.resource}
         WHERE ${existingWhere.join(" AND ")}`);
      const existing = new Map<string, { status: string; resourceName: string }>();
      const activeMessageByEntity = new Map<string, string>();
      for (const row of existingRows) {
        const l = obj(row[spec.json]);
        const entityKey = level === "campaign" ? String(l.campaign) : level === "ad_group" ? String(l.adGroup) : "account";
        const assetId = String(l.asset ?? "").split("/").pop() ?? "";
        existing.set(`${entityKey}|${assetId}`, { status: String(l.status ?? ""), resourceName: String(l.resourceName ?? "") });
        if (fieldType === "BUSINESS_MESSAGE" && l.status === "ENABLED") activeMessageByEntity.set(entityKey, assetId);
      }

      const created: Row[] = [];
      const already: Row[] = [];
      const errors: Row[] = [];
      const toCreate: Array<{ entityKey: string; entityLabel: string; entity?: { resource: string }; assetId: string }> = [];
      const entityList = level === "account" ? [{ key: "account", label: `conta ${cid}`, resource: undefined as string | undefined }] :
        [...entities.entries()].map(([id, e]) => ({ key: e.resource, label: `${level === "campaign" ? "campanha" : "grupo"} ${id} ("${e.name}")`, resource: e.resource }));
      for (const entity of entityList) {
        for (const assetId of assetIdList) {
          const describe = { target: entity.label, asset_id: assetId, content: describeAsset(assets.get(assetId) ?? {}) };
          const link = existing.get(`${entity.key}|${assetId}`);
          if (link && link.status !== "REMOVED") {
            already.push({ ...describe, link_status: link.status, link_resource_name: link.resourceName, note: link.status === "PAUSED" ? "vínculo pausado — mantido pausado, não foi reativado" : "já vinculado" });
            continue;
          }
          const activeMessage = activeMessageByEntity.get(entity.key);
          if (fieldType === "BUSINESS_MESSAGE" && activeMessage && activeMessage !== assetId) {
            errors.push({ ...describe, error: `já existe um recurso de mensagem ativo aqui (asset ${activeMessage}); o Google aceita só um — pause-o antes com update_extension_link_status` });
            continue;
          }
          toCreate.push({ entityKey: entity.key, entityLabel: entity.label, entity: entity.resource ? { resource: entity.resource } : undefined, assetId });
        }
      }

      const dryRun = client.isDryRun;
      const warnings = rule.documented === false
        ? ["TEXT_DISCLAIMER é novo (v25.1) e o Google ainda não publicou em quais níveis ele é aceito; a API valida."]
        : [];
      const report = () => formatJson({
        field_type: fieldType,
        level,
        dry_run: dryRun,
        [dryRun ? "validated" : "created"]: created,
        already_linked: already,
        errors,
        ...(warnings.length ? { warnings } : {}),
      });
      if (toCreate.length === 0) {
        return {
          content: [text(`Nada a gravar — ${already.length} vínculo(s) já existiam${errors.length ? `, ${errors.length} recusado(s)` : ""}. Nenhuma escrita foi enviada.\n\n${report()}`)],
          ...(errors.length ? { isError: true } : {}),
        };
      }

      const operations = toCreate.map((item) => ({
        create: linkPayload({ level, entityResource: item.entity?.resource }, wanted.get(item.assetId)!, fieldType),
      }));
      let response: Row;
      try {
        response = await client.mutate(cid, spec.service, operations, { partialFailure: true });
      } catch (err) {
        const message = explainAssetError((err as Error).message);
        for (const item of toCreate) errors.push({ target: item.entityLabel, asset_id: item.assetId, error: message });
        return fail(
          `A requisição falhou${dryRun ? " (dry-run, nada gravado)" : ""}. Se foi erro de rede, confira com list_extensions antes de repetir.\n\n${report()}`
        );
      }
      const results = arr<Row>(response.results);
      const { byIndex, unattributed } = partialFailureByOperation(response.partialFailureError, toCreate.length);
      toCreate.forEach((item, index) => {
        const describe = { target: item.entityLabel, asset_id: item.assetId, content: describeAsset(assets.get(item.assetId) ?? {}) };
        const opErrors = byIndex.get(index);
        if (opErrors) {
          errors.push({ ...describe, error: explainAssetError(opErrors.join("; ")) });
          return;
        }
        const resourceName = results[index]?.resourceName as string | undefined;
        if (dryRun ? unattributed.length > 0 : !resourceName) {
          errors.push({ ...describe, error: dryRun ? "validação não confirmada (erro sem operação indicada)" : "a API não confirmou o vínculo" });
          return;
        }
        created.push({ ...describe, ...(resourceName ? { link_resource_name: resourceName } : {}) });
      });
      for (const message of unattributed) errors.push({ error: explainAssetError(message) });

      const head = dryRun
        ? `DRY-RUN (validateOnly): nada foi gravado. Validados: ${created.length}`
        : `Vínculos criados: ${created.length}`;
      return {
        content: [text(`${head} | Já existentes: ${already.length} | Com erro: ${errors.length}\n\n${report()}`)],
        ...(errors.length ? { isError: true } : {}),
      };
    }
  );

  // ── update_extension_link_status ───────────────────────────────────

  mcp.registerTool(
    "update_extension_link_status",
    {
      description: [
        "Pausa, reativa ou remove vínculos de extensão (conta, campanha ou grupo) — inclusive os",
        "AUTOMÁTICOS criados pelo Google (sitelinks/frases dinâmicos etc.).",
        "WRITE OPERATION.",
        "",
        "Entrada: link_resource_name de list_extensions / get_extension_performance, ex.:",
        "customers/{cid}/customerAssets/{assetId}~{fieldType}, .../campaignAssets/{campaignId}~{assetId}~{fieldType},",
        ".../adGroupAssets/{adGroupId}~{assetId}~{fieldType}.",
        "",
        "Lê cada vínculo antes: inexistente vira erro, já no status pedido não gera escrita, vínculo removido",
        "não volta (crie outro). REMOVED exige confirm: true — é definitivo. Pausar um automático o mantém fora",
        "até ser reativado; ligar/desligar o recurso automático da conta só pela interface do Google Ads.",
        "O asset em si não muda (o mesmo sitelink continua valendo em outros vínculos).",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        linkResourceNames: flexArray(z.string()).describe("Resource names dos vínculos. Máx. 50."),
        status: z.enum(["ENABLED", "PAUSED", "REMOVED"]).describe("Novo status do vínculo."),
        confirm: z.boolean().optional().describe("Obrigatório (true) para REMOVED."),
      },
    },
    async ({ customerId, linkResourceNames, status, confirm }) => {
      const g = guard(customerId);
      if ("error" in g) return g.error;
      const { cid } = g;
      if (!["ENABLED", "PAUSED", "REMOVED"].includes(status)) return fail(`status inválido: "${status}" (ENABLED, PAUSED ou REMOVED). Nada foi gravado.`);
      const names = [...new Set(ensureArray<string>(linkResourceNames).map((n) => String(n).trim()).filter(Boolean))];
      if (names.length === 0) return fail("Informe ao menos um vínculo em linkResourceNames. Nada foi gravado.");
      if (names.length > 50) return fail(`No máximo 50 vínculos por chamada (recebidos ${names.length}). Nada foi gravado.`);
      if (status === "REMOVED" && confirm !== true) {
        return fail(`Remover ${names.length} vínculo(s) é definitivo (não dá para reativar um vínculo removido). Repita com confirm: true. Nada foi gravado.`);
      }
      const parsed = new Map<LinkLevel, string[]>();
      const invalid: string[] = [];
      const pattern = /^customers\/(\d+)\/(customerAssets\/\d+~[A-Z_]+|campaignAssets\/\d+~\d+~[A-Z_]+|adGroupAssets\/\d+~\d+~[A-Z_]+)$/;
      for (const name of names) {
        const match = pattern.exec(name);
        if (!match) { invalid.push(`"${name}" não é um vínculo de asset (customerAssets/campaignAssets/adGroupAssets)`); continue; }
        if (match[1] !== cid) { invalid.push(`${name} pertence à conta ${match[1]}, não à ${cid}`); continue; }
        const lvl: LinkLevel = match[2].startsWith("customerAssets") ? "account" : match[2].startsWith("campaignAssets") ? "campaign" : "ad_group";
        parsed.set(lvl, [...(parsed.get(lvl) ?? []), name]);
      }
      if (invalid.length) return fail(`Nada foi gravado:\n- ${invalid.join("\n- ")}`);

      const client = getClient();
      const dryRun = client.isDryRun;
      const changed: Row[] = [];
      const unchanged: Row[] = [];
      const errors: Row[] = [];

      for (const [lvl, list] of parsed) {
        const spec = LINK[lvl];
        const entityAttr = lvl === "campaign" ? "campaign_asset.campaign, " : lvl === "ad_group" ? "ad_group_asset.ad_group, " : "";
        const rows = await client.searchStream(cid,
          `SELECT ${spec.resource}.resource_name, ${spec.resource}.status, ${spec.resource}.source, ${spec.resource}.field_type,
                  ${entityAttr}${ASSET_CONTENT_FIELDS.join(", ")}
           FROM ${spec.resource}
           WHERE ${spec.resource}.resource_name IN (${list.map(quote).join(", ")})`);
        const current = new Map<string, Row>();
        for (const row of rows) current.set(String(obj(row[spec.json]).resourceName), row);

        const ops: Array<{ name: string; describe: Row }> = [];
        for (const name of list) {
          const row = current.get(name);
          if (!row) { errors.push({ link_resource_name: name, error: `vínculo não encontrado na conta ${cid}` }); continue; }
          const link = obj(row[spec.json]);
          const describe = {
            level: lvl,
            link_resource_name: name,
            field_type: link.fieldType,
            source: link.source,
            content: describeAsset(obj(row.asset)),
            before: link.status,
          };
          if (link.status === "REMOVED") {
            errors.push({ ...describe, error: "vínculo já removido — não pode ser reativado; crie um novo com link_extension_assets" });
          } else if (link.status === status) {
            unchanged.push({ ...describe, note: `já está ${status}` });
          } else {
            ops.push({ name, describe });
          }
        }
        if (ops.length === 0) continue;
        const operations = ops.map(({ name }) =>
          status === "REMOVED" ? { remove: name } : { update: { resourceName: name, status }, updateMask: "status" }
        );
        let response: Row;
        try {
          response = await client.mutate(cid, spec.service, operations, { partialFailure: true });
        } catch (err) {
          const message = explainAssetError((err as Error).message);
          for (const op of ops) errors.push({ ...op.describe, error: message });
          continue;
        }
        const results = arr<Row>(response.results);
        const { byIndex, unattributed } = partialFailureByOperation(response.partialFailureError, ops.length);
        ops.forEach((op, index) => {
          const opErrors = byIndex.get(index);
          if (opErrors) { errors.push({ ...op.describe, error: explainAssetError(opErrors.join("; ")) }); return; }
          if (dryRun ? unattributed.length > 0 : !results[index]?.resourceName) {
            errors.push({ ...op.describe, error: dryRun ? "validação não confirmada" : "a API não confirmou a mudança" });
            return;
          }
          changed.push({ ...op.describe, after: status });
        });
        for (const message of unattributed) errors.push({ level: lvl, error: explainAssetError(message) });
      }

      const head = dryRun
        ? `DRY-RUN (validateOnly): nada foi gravado. Validados para ${status}: ${changed.length}`
        : `Vínculos alterados para ${status}: ${changed.length}`;
      return {
        content: [text(
          `${head} | Sem mudança: ${unchanged.length} | Com erro: ${errors.length}` +
          (changed.length === 0 && errors.length === 0 ? "\nNenhuma escrita foi enviada." : "") +
          `\n\n${formatJson({ status, dry_run: dryRun, [dryRun ? "validated" : "changed"]: changed, unchanged, errors })}`
        )],
        ...(errors.length ? { isError: true } : {}),
      };
    }
  );

  // ── update_extension_asset ─────────────────────────────────────────

  mcp.registerTool(
    "update_extension_asset",
    {
      description: [
        "Edita um asset de extensão existente: sitelink, frase de destaque, snippet estruturado, chamada,",
        "promoção, preço ou mensagem (WhatsApp). Também muda datas de veiculação e horários.",
        "WRITE OPERATION — a mudança vale em TODOS os vínculos desse asset (conta, campanhas, grupos);",
        "a resposta lista onde ele está vinculado. O texto novo passa por análise de política.",
        "",
        "Lê o asset antes: só manda os campos que mudaram (updateMask só das folhas alteradas); se nada",
        "muda, não grava. Parâmetro que não se aplica ao tipo do asset é recusado. Assets automáticos do",
        "Google e formulário de lead não são editados aqui (formulário: edite na interface — a edição pode",
        "pausar as campanhas até nova aprovação). Para pausar/remover o vínculo: update_extension_link_status.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        assetId: z.string().describe("ID do asset (list_extensions → asset_id)."),
        linkText: z.string().optional().describe("SITELINK: texto do link (1–25)."),
        description1: z.string().optional().describe("SITELINK: linha 1 (1–35). Vai junto com description2."),
        description2: z.string().optional().describe("SITELINK: linha 2 (1–35). Vai junto com description1."),
        clearDescriptions: z.boolean().optional().describe("SITELINK: apaga as duas descrições."),
        finalUrl: z.string().optional().describe("SITELINK/PROMOTION: URL final."),
        calloutText: z.string().optional().describe("CALLOUT: texto (1–25)."),
        snippetHeader: z.string().optional().describe("STRUCTURED_SNIPPET: cabeçalho oficial, texto exato de qualquer idioma da tabela do Google (ex.: Marcas, Serviços, Tipos; es-419 Barrios)."),
        snippetValues: flexArray(z.string()).optional().describe("STRUCTURED_SNIPPET: 3 a 10 valores (1–25 cada). Substitui a lista."),
        phoneNumber: z.string().optional().describe("CALL: telefone."),
        countryCode: z.string().optional().describe("CALL: país (2 letras)."),
        promotionTarget: z.string().optional().describe("PROMOTION: o que está em promoção."),
        percentOff: z.number().optional().describe("PROMOTION: % de desconto (0–100)."),
        moneyAmountOff: z.number().optional().describe("PROMOTION: desconto em valor."),
        currencyCode: z.string().optional().describe("PROMOTION/PRICE: moeda (default: a da conta)."),
        promotionCode: z.string().optional().describe("PROMOTION: cupom (substitui ordersOverAmount)."),
        ordersOverAmount: z.number().optional().describe("PROMOTION: pedido mínimo (substitui promotionCode)."),
        clearPromotionTrigger: z.boolean().optional().describe("PROMOTION: remove cupom/pedido mínimo."),
        occasion: z.enum(PROMOTION_OCCASIONS).optional().describe("PROMOTION: ocasião."),
        redemptionStartDate: z.string().optional().describe("PROMOTION: início do resgate YYYY-MM-DD."),
        redemptionEndDate: z.string().optional().describe("PROMOTION: fim do resgate YYYY-MM-DD."),
        languageCode: z.string().optional().describe("PROMOTION/PRICE: idioma BCP-47 (ex.: pt-BR)."),
        priceQualifier: z.enum(PRICE_QUALIFIERS).optional().describe("PRICE: FROM (a partir de), UP_TO, AVERAGE."),
        priceItems: flexArray(z.object({
          header: z.string(), description: z.string(), priceAmount: z.number(),
          finalUrl: z.string(), unit: z.enum(PRICE_UNITS).optional(),
        })).optional().describe("PRICE: 3 a 8 itens — substitui a lista inteira."),
        starterMessage: z.string().optional().describe("BUSINESS_MESSAGE: mensagem inicial."),
        callToActionType: z.enum(BUSINESS_MESSAGE_CTAS).optional().describe("BUSINESS_MESSAGE: chamada para ação."),
        callToActionDescription: z.string().optional().describe("BUSINESS_MESSAGE: texto da chamada para ação."),
        whatsappPhoneNumber: z.string().optional().describe("BUSINESS_MESSAGE: número do WhatsApp."),
        whatsappCountryCode: z.string().optional().describe("BUSINESS_MESSAGE: país do número (2 letras)."),
        startDate: z.string().optional().describe("SITELINK/CALLOUT/PROMOTION: começa a veicular em YYYY-MM-DD."),
        endDate: z.string().optional().describe("SITELINK/CALLOUT/PROMOTION: para de veicular em YYYY-MM-DD."),
        clearDates: z.boolean().optional().describe("Remove as datas de veiculação."),
        adSchedule: adScheduleSchema,
        clearAdSchedule: z.boolean().optional().describe("Remove os horários (volta a veicular o dia todo)."),
      },
    },
    async (args) => {
      const g = guard(args.customerId);
      if ("error" in g) return g.error;
      const { cid } = g;
      const assetId = String(args.assetId ?? "").trim();
      if (!/^\d+$/.test(assetId)) return fail(`assetId deve ser numérico, recebido "${args.assetId}". Nada foi gravado.`);

      // Formato de entrada — antes de qualquer chamada
      const errors: string[] = [];
      checkLength(errors, "linkText", args.linkText, 1, 25);
      checkLength(errors, "description1", args.description1, 1, 35);
      checkLength(errors, "description2", args.description2, 1, 35);
      checkLength(errors, "calloutText", args.calloutText, 1, 25);
      if (args.finalUrl !== undefined && !isUrl(args.finalUrl)) errors.push(`finalUrl inválida: "${args.finalUrl}".`);
      checkDates(errors, args.startDate, args.endDate);
      checkDates(errors, args.redemptionStartDate, args.redemptionEndDate, ["redemptionStartDate", "redemptionEndDate"]);
      if (args.clearDates && (args.startDate || args.endDate)) errors.push("clearDates não combina com startDate/endDate.");
      if (args.clearAdSchedule && args.adSchedule !== undefined) errors.push("clearAdSchedule não combina com adSchedule.");
      if (args.clearDescriptions && (args.description1 !== undefined || args.description2 !== undefined)) errors.push("clearDescriptions não combina com description1/description2.");
      if (args.percentOff !== undefined && args.moneyAmountOff !== undefined) errors.push("Use percentOff OU moneyAmountOff, não os dois.");
      if (args.percentOff !== undefined && !(args.percentOff > 0 && args.percentOff <= 100)) errors.push("percentOff precisa ser > 0 e <= 100.");
      if (args.moneyAmountOff !== undefined && !(args.moneyAmountOff > 0)) errors.push("moneyAmountOff precisa ser > 0.");
      if ([args.promotionCode !== undefined, args.ordersOverAmount !== undefined, args.clearPromotionTrigger === true].filter(Boolean).length > 1) {
        errors.push("Use só um entre promotionCode, ordersOverAmount e clearPromotionTrigger.");
      }
      if (args.ordersOverAmount !== undefined && !(args.ordersOverAmount > 0)) errors.push("ordersOverAmount precisa ser > 0.");
      if (args.currencyCode !== undefined && !/^[A-Z]{3}$/.test(args.currencyCode)) errors.push(`currencyCode inválido: "${args.currencyCode}" (ex.: BRL).`);
      if (args.countryCode !== undefined && !/^[A-Za-z]{2}$/.test(args.countryCode)) errors.push("countryCode precisa ter 2 letras (ex.: BR).");
      if (args.whatsappCountryCode !== undefined && !/^[A-Za-z]{2}$/.test(args.whatsappCountryCode)) errors.push("whatsappCountryCode precisa ter 2 letras (ex.: BR).");
      if (args.snippetValues !== undefined) validateSnippetValues(errors, ensureArray<string>(args.snippetValues));
      let snippetHeader: string | undefined;
      if (args.snippetHeader !== undefined) {
        const checked = checkSnippetHeader("snippetHeader", args.snippetHeader);
        if ("error" in checked) errors.push(checked.error);
        else snippetHeader = checked.header;
      }
      if (args.priceItems !== undefined) validatePriceItems(errors, args.priceItems);
      let schedule: Row[] | undefined;
      if (args.adSchedule !== undefined) {
        const built = buildAdSchedule(args.adSchedule);
        if ("error" in built) errors.push(built.error);
        else schedule = built.targets;
      }
      if (errors.length) return fail(`Nada foi gravado:\n- ${errors.join("\n- ")}`);

      const client = getClient();
      const rows = await client.searchStream(cid,
        `SELECT asset.resource_name, ${ASSET_CONTENT_FIELDS.join(", ")}
         FROM asset
         WHERE asset.id = ${assetId}`);
      const asset = obj(rows[0]?.asset);
      if (!rows.length) return fail(`Asset ${assetId} não encontrado na conta ${cid}. Nada foi gravado.`);
      const type = String(asset.type ?? "");
      if (asset.source === "AUTOMATICALLY_CREATED") {
        return fail(`Asset ${assetId} foi criado automaticamente pelo Google — a API não permite editá-lo (só pausar/remover o vínculo com update_extension_link_status). Nada foi gravado.`);
      }
      const editable = ["SITELINK", "CALLOUT", "STRUCTURED_SNIPPET", "CALL", "PROMOTION", "PRICE", "BUSINESS_MESSAGE"];
      if (!editable.includes(type)) {
        return fail(`Asset ${assetId} é do tipo ${type}; esta tool edita ${editable.join(", ")}. ` +
          (type === "LEAD_FORM" ? "Formulário de lead: edite na interface (a edição pode pausar campanhas até nova aprovação). " : "") + "Nada foi gravado.");
      }

      // Parâmetros por tipo
      const allowedByType: Record<string, string[]> = {
        SITELINK: ["linkText", "description1", "description2", "clearDescriptions", "finalUrl", "startDate", "endDate", "clearDates", "adSchedule", "clearAdSchedule"],
        CALLOUT: ["calloutText", "startDate", "endDate", "clearDates", "adSchedule", "clearAdSchedule"],
        STRUCTURED_SNIPPET: ["snippetHeader", "snippetValues"],
        CALL: ["phoneNumber", "countryCode", "adSchedule", "clearAdSchedule"],
        PROMOTION: ["promotionTarget", "percentOff", "moneyAmountOff", "currencyCode", "promotionCode", "ordersOverAmount", "clearPromotionTrigger", "occasion", "redemptionStartDate", "redemptionEndDate", "languageCode", "finalUrl", "startDate", "endDate", "clearDates", "adSchedule", "clearAdSchedule"],
        PRICE: ["priceQualifier", "priceItems", "languageCode", "currencyCode"],
        BUSINESS_MESSAGE: ["starterMessage", "callToActionType", "callToActionDescription", "whatsappPhoneNumber", "whatsappCountryCode"],
      };
      const given = Object.entries(args)
        .filter(([key, value]) => value !== undefined && !["customerId", "assetId", "validateOnly"].includes(key) && value !== false)
        .map(([key]) => key);
      const notApplicable = given.filter((key) => !allowedByType[type].includes(key));
      if (notApplicable.length) {
        return fail(`Asset ${assetId} é ${type}: parâmetro(s) que não se aplicam: ${notApplicable.join(", ")}. Aceitos: ${allowedByType[type].join(", ")}. Nada foi gravado.`);
      }
      if (given.length === 0) return fail("Informe ao menos um campo para mudar. Nada foi gravado.");

      const update: Row = { resourceName: `customers/${cid}/assets/${assetId}` };
      const mask: string[] = [];
      const diff: Row[] = [];
      const change = (label: string, paths: string[], jsonPath: string[], after: unknown, before: unknown) => {
        if (normalizeForCompare(after) === normalizeForCompare(before)) return;
        setIn(update, jsonPath, after);
        mask.push(...paths);
        diff.push({ field: label, before: before ?? null, after });
      };
      const typed = (key: string) => obj(asset[key]);
      const prefixByType: Record<string, [string, string]> = {
        SITELINK: ["sitelink_asset", "sitelinkAsset"],
        CALLOUT: ["callout_asset", "calloutAsset"],
        PROMOTION: ["promotion_asset", "promotionAsset"],
        CALL: ["call_asset", "callAsset"],
      };
      const warnings: string[] = [];

      if (type === "SITELINK") {
        const sl = typed("sitelinkAsset");
        if (args.linkText !== undefined) change("linkText", ["sitelink_asset.link_text"], ["sitelinkAsset", "linkText"], args.linkText.trim(), sl.linkText);
        if (args.clearDescriptions) {
          change("description1", ["sitelink_asset.description1"], ["sitelinkAsset", "description1"], "", sl.description1);
          change("description2", ["sitelink_asset.description2"], ["sitelinkAsset", "description2"], "", sl.description2);
        } else if (args.description1 !== undefined || args.description2 !== undefined) {
          const d1 = args.description1 ?? String(sl.description1 ?? "");
          const d2 = args.description2 ?? String(sl.description2 ?? "");
          if (!d1 || !d2) return fail("Sitelink: description1 e description2 vão juntas (o asset atual não tem a outra). Informe as duas. Nada foi gravado.");
          change("description1", ["sitelink_asset.description1"], ["sitelinkAsset", "description1"], d1, sl.description1);
          change("description2", ["sitelink_asset.description2"], ["sitelinkAsset", "description2"], d2, sl.description2);
        }
      }
      if (type === "CALLOUT" && args.calloutText !== undefined) {
        change("calloutText", ["callout_asset.callout_text"], ["calloutAsset", "calloutText"], args.calloutText.trim(), typed("calloutAsset").calloutText);
      }
      if (type === "STRUCTURED_SNIPPET") {
        const ss = typed("structuredSnippetAsset");
        if (snippetHeader !== undefined) change("snippetHeader", ["structured_snippet_asset.header"], ["structuredSnippetAsset", "header"], snippetHeader, ss.header);
        if (args.snippetValues !== undefined) change("snippetValues", ["structured_snippet_asset.values"], ["structuredSnippetAsset", "values"], ensureArray<string>(args.snippetValues).map((v) => String(v).trim()), arr(ss.values));
      }
      if (type === "CALL") {
        const call = typed("callAsset");
        if (args.phoneNumber !== undefined) change("phoneNumber", ["call_asset.phone_number"], ["callAsset", "phoneNumber"], args.phoneNumber.trim(), call.phoneNumber);
        if (args.countryCode !== undefined) change("countryCode", ["call_asset.country_code"], ["callAsset", "countryCode"], args.countryCode.toUpperCase(), call.countryCode);
      }
      let currency: string | undefined = args.currencyCode;
      if ((type === "PROMOTION" && (args.moneyAmountOff !== undefined || args.ordersOverAmount !== undefined) && !currency) ||
          (type === "PRICE" && args.priceItems !== undefined && !currency)) {
        currency = await accountCurrency(client, cid);
      }
      if (type === "PROMOTION") {
        const promo = typed("promotionAsset");
        if (args.promotionTarget !== undefined) change("promotionTarget", ["promotion_asset.promotion_target"], ["promotionAsset", "promotionTarget"], args.promotionTarget.trim(), promo.promotionTarget);
        if (args.percentOff !== undefined) {
          if (promo.moneyAmountOff) warnings.push("O desconto passa de valor para percentual (o valor anterior deixa de valer).");
          change("percentOff", ["promotion_asset.percent_off"], ["promotionAsset", "percentOff"], String(Math.round(args.percentOff * 10_000)), promo.percentOff);
        }
        if (args.moneyAmountOff !== undefined) {
          if (promo.percentOff !== undefined) warnings.push("O desconto passa de percentual para valor (o percentual anterior deixa de valer).");
          const before = obj(promo.moneyAmountOff);
          change("moneyAmountOff",
            ["promotion_asset.money_amount_off.amount_micros", "promotion_asset.money_amount_off.currency_code"],
            ["promotionAsset", "moneyAmountOff"],
            { amountMicros: String(Math.round(args.moneyAmountOff * 1_000_000)), currencyCode: currency },
            before.amountMicros !== undefined ? { amountMicros: String(before.amountMicros), currencyCode: before.currencyCode } : undefined);
        }
        if (args.promotionCode !== undefined) {
          if (obj(promo.ordersOverAmount).amountMicros !== undefined) warnings.push("O pedido mínimo deixa de valer (cupom e pedido mínimo são exclusivos).");
          change("promotionCode", ["promotion_asset.promotion_code"], ["promotionAsset", "promotionCode"], args.promotionCode.trim(), promo.promotionCode);
        }
        if (args.ordersOverAmount !== undefined) {
          if (promo.promotionCode) warnings.push("O cupom deixa de valer (cupom e pedido mínimo são exclusivos).");
          const before = obj(promo.ordersOverAmount);
          change("ordersOverAmount",
            ["promotion_asset.orders_over_amount.amount_micros", "promotion_asset.orders_over_amount.currency_code"],
            ["promotionAsset", "ordersOverAmount"],
            { amountMicros: String(Math.round(args.ordersOverAmount * 1_000_000)), currencyCode: currency },
            before.amountMicros !== undefined ? { amountMicros: String(before.amountMicros), currencyCode: before.currencyCode } : undefined);
        }
        if (args.clearPromotionTrigger) {
          // Limpar uma mensagem com subcampos pelo nome é permitido (só atualizar é que exige folha)
          if (promo.promotionCode) { mask.push("promotion_asset.promotion_code"); diff.push({ field: "promotionCode", before: promo.promotionCode, after: null }); }
          else if (obj(promo.ordersOverAmount).amountMicros !== undefined) { mask.push("promotion_asset.orders_over_amount"); diff.push({ field: "ordersOverAmount", before: obj(promo.ordersOverAmount).amountMicros, after: null }); }
        }
        if (args.occasion !== undefined) change("occasion", ["promotion_asset.occasion"], ["promotionAsset", "occasion"], args.occasion, promo.occasion);
        if (args.redemptionStartDate !== undefined) change("redemptionStartDate", ["promotion_asset.redemption_start_date"], ["promotionAsset", "redemptionStartDate"], args.redemptionStartDate, promo.redemptionStartDate);
        if (args.redemptionEndDate !== undefined) change("redemptionEndDate", ["promotion_asset.redemption_end_date"], ["promotionAsset", "redemptionEndDate"], args.redemptionEndDate, promo.redemptionEndDate);
        if (args.languageCode !== undefined) change("languageCode", ["promotion_asset.language_code"], ["promotionAsset", "languageCode"], args.languageCode, promo.languageCode);
      }
      if (type === "PRICE") {
        const price = typed("priceAsset");
        if (args.priceQualifier !== undefined) change("priceQualifier", ["price_asset.price_qualifier"], ["priceAsset", "priceQualifier"], args.priceQualifier, price.priceQualifier);
        if (args.languageCode !== undefined) change("languageCode", ["price_asset.language_code"], ["priceAsset", "languageCode"], args.languageCode, price.languageCode);
        if (args.priceItems !== undefined) {
          change("priceItems", ["price_asset.price_offerings"], ["priceAsset", "priceOfferings"], buildPriceOfferings(args.priceItems, currency ?? "BRL"), arr(price.priceOfferings));
        }
      }
      if (type === "BUSINESS_MESSAGE") {
        const msg = typed("businessMessageAsset");
        const cta = obj(msg.callToAction);
        if (args.starterMessage !== undefined) change("starterMessage", ["business_message_asset.starter_message"], ["businessMessageAsset", "starterMessage"], args.starterMessage.trim(), msg.starterMessage);
        if (args.callToActionType !== undefined) change("callToActionType", ["business_message_asset.call_to_action.call_to_action_selection"], ["businessMessageAsset", "callToAction", "callToActionSelection"], args.callToActionType, cta.callToActionSelection);
        if (args.callToActionDescription !== undefined) change("callToActionDescription", ["business_message_asset.call_to_action.call_to_action_description"], ["businessMessageAsset", "callToAction", "callToActionDescription"], args.callToActionDescription.trim(), cta.callToActionDescription);
        if (args.whatsappPhoneNumber !== undefined || args.whatsappCountryCode !== undefined) {
          if (msg.messageProvider !== "WHATSAPP") return fail(`Asset ${assetId} é de ${msg.messageProvider}, não WHATSAPP. Nada foi gravado.`);
          const wa = obj(msg.whatsappInfo);
          if (args.whatsappPhoneNumber !== undefined) change("whatsappPhoneNumber", ["business_message_asset.whatsapp_info.phone_number"], ["businessMessageAsset", "whatsappInfo", "phoneNumber"], args.whatsappPhoneNumber.trim(), wa.phoneNumber);
          if (args.whatsappCountryCode !== undefined) change("whatsappCountryCode", ["business_message_asset.whatsapp_info.country_code"], ["businessMessageAsset", "whatsappInfo", "countryCode"], args.whatsappCountryCode.toUpperCase(), wa.countryCode);
        }
      }
      if (args.finalUrl !== undefined) change("finalUrl", ["final_urls"], ["finalUrls"], [args.finalUrl.trim()], arr(asset.finalUrls));
      const prefix = prefixByType[type];
      if (prefix) {
        const [maskPrefix, jsonKey] = prefix;
        const current = typed(jsonKey);
        if (type !== "CALL") {
          const start = args.clearDates ? "" : args.startDate;
          const end = args.clearDates ? "" : args.endDate;
          const finalStart = start ?? String(current.startDate ?? "");
          const finalEnd = end ?? String(current.endDate ?? "");
          if (finalStart && finalEnd && finalEnd < finalStart) return fail(`endDate (${finalEnd}) fica antes de startDate (${finalStart}). Nada foi gravado.`);
          if (start !== undefined) change("startDate", [`${maskPrefix}.start_date`], [jsonKey, "startDate"], start, current.startDate);
          if (end !== undefined) change("endDate", [`${maskPrefix}.end_date`], [jsonKey, "endDate"], end, current.endDate);
        }
        if (schedule || args.clearAdSchedule) {
          change("adSchedule", [`${maskPrefix}.ad_schedule_targets`], [jsonKey, "adScheduleTargets"], schedule ?? [], arr(current.adScheduleTargets));
        }
      }

      if (mask.length === 0) {
        return { content: [text(`Nada a fazer: o asset ${assetId} (${type}) já tem esses valores. Nenhuma escrita foi enviada.\n\n${formatJson({ asset_id: assetId, type, content: describeAsset(asset) })}`)] };
      }

      // Onde o asset está vinculado (a edição vale para todos)
      const assetResource = `customers/${cid}/assets/${assetId}`;
      const usedIn: string[] = [];
      for (const lvl of LINK_LEVELS) {
        const spec = LINK[lvl];
        const attr = lvl === "campaign" ? ", campaign_asset.campaign" : lvl === "ad_group" ? ", ad_group_asset.ad_group" : "";
        const linkRows = await client.searchStream(cid,
          `SELECT ${spec.resource}.resource_name, ${spec.resource}.status${attr}
           FROM ${spec.resource}
           WHERE ${spec.resource}.asset = '${assetResource}' AND ${spec.resource}.status != 'REMOVED'`);
        for (const row of linkRows) usedIn.push(`${lvl}: ${obj(row[spec.json]).resourceName} (${obj(row[spec.json]).status})`);
      }
      if (usedIn.length > 1) warnings.push(`A mudança vale para os ${usedIn.length} vínculos deste asset.`);

      const dryRun = client.isDryRun;
      const updateMask = [...new Set(mask)].join(",");
      try {
        await client.mutate(cid, "assets", [{ update, updateMask }]);
      } catch (err) {
        return fail(`Nada foi alterado. Erro: ${explainAssetError((err as Error).message)}\n\n${formatJson({ asset_id: assetId, type, changes: diff, update_mask: updateMask })}`);
      }
      return {
        content: [text(
          (dryRun ? `DRY-RUN (validateOnly): alteração do asset ${assetId} validada — nada foi gravado.` : `Asset ${assetId} (${type}) atualizado.`) +
          `\n\n${formatJson({ asset_id: assetId, type, dry_run: dryRun, changes: diff, update_mask: updateMask, linked_in: usedIn, ...(warnings.length ? { warnings } : {}) })}` +
          (dryRun ? "" : "\n\nO conteúdo novo passa por análise de política; acompanhe com list_extensions.")
        )],
      };
    }
  );

  // ── Herança: excluded_parent_asset_field_types ─────────────────────

  mcp.registerTool(
    "list_extension_exclusions",
    {
      description: [
        "Mostra campanhas e grupos que bloqueiam a herança de extensões do nível acima",
        "(excluded_parent_asset_field_types): ex. uma campanha que não usa os sitelinks da conta.",
        "READ OPERATION. Só lista quem tem alguma exclusão. Ajuste com set_excluded_parent_extension_types.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().optional().describe("Só esta campanha (e os grupos dela)."),
        includeAdGroups: z.boolean().optional().describe("Inclui grupos de anúncios. Default: true."),
      },
    },
    async ({ customerId, campaignId, includeAdGroups }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = customerId.replace(/-/g, "");
      if (campaignId !== undefined && !isDigits(campaignId)) return fail(`campaignId deve ser numérico, recebido "${campaignId}".`);
      const client = getClient();
      const campaignFilter = campaignId ? ` AND campaign.id = ${campaignId}` : "";
      const campaigns = await client.searchStream(cid,
        `SELECT campaign.id, campaign.name, campaign.status, campaign.excluded_parent_asset_field_types
         FROM campaign
         WHERE campaign.status != 'REMOVED'${campaignFilter}`);
      const rows: Row[] = [];
      for (const r of campaigns) {
        const c = obj(r.campaign);
        const excluded = arr<string>(c.excludedParentAssetFieldTypes);
        if (excluded.length) rows.push({ level: "campaign", campaign_id: String(c.id), campaign_name: c.name, status: c.status, excluded_from_account: excluded });
      }
      if (includeAdGroups !== false) {
        const groups = await client.searchStream(cid,
          `SELECT ad_group.id, ad_group.name, ad_group.status, ad_group.excluded_parent_asset_field_types, campaign.id, campaign.name
           FROM ad_group
           WHERE ad_group.status != 'REMOVED'${campaignFilter}`);
        for (const r of groups) {
          const a = obj(r.adGroup);
          const excluded = arr<string>(a.excludedParentAssetFieldTypes);
          if (excluded.length) {
            rows.push({ level: "ad_group", ad_group_id: String(a.id), ad_group_name: a.name, status: a.status, campaign_id: String(obj(r.campaign).id ?? ""), campaign_name: obj(r.campaign).name, excluded_from_parents: excluded });
          }
        }
      }
      return {
        content: [text(
          rows.length
            ? `${rows.length} entidade(s) com exclusão de herança.\n\n${formatJson(rows)}`
            : "Nenhuma campanha/grupo exclui extensões herdadas — tudo o que está vinculado na conta vale nas campanhas (e o da campanha, nos grupos)."
        )],
      };
    }
  );

  mcp.registerTool(
    "set_excluded_parent_extension_types",
    {
      description: [
        "Define quais tipos de extensão uma campanha (ou grupo) NÃO herda do nível acima —",
        "campaign.excluded_parent_asset_field_types / ad_group.excluded_parent_asset_field_types.",
        "WRITE OPERATION. Ex.: fazer uma campanha ignorar os sitelinks da conta e usar só os próprios.",
        "",
        "mode: add (acrescenta), remove (tira) ou replace (substitui a lista; replace com lista vazia volta a herdar tudo).",
        "Lê a lista atual, mostra antes/depois e não grava se nada muda. Não mexe em lances, orçamento nem segmentação.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        level: z.enum(["campaign", "ad_group"]).describe("campaign (herda da conta) ou ad_group (herda da conta e da campanha)."),
        campaignId: z.string().optional().describe("Campanha (level=campaign)."),
        adGroupId: z.string().optional().describe("Grupo (level=ad_group)."),
        mode: z.enum(["add", "remove", "replace"]).describe("Como aplicar fieldTypes."),
        fieldTypes: flexArray(z.enum(EXCLUDABLE_FIELD_TYPES)).describe("Tipos a excluir da herança (ex.: SITELINK, CALLOUT)."),
      },
    },
    async ({ customerId, level, campaignId, adGroupId, mode, fieldTypes }) => {
      const g = guard(customerId);
      if ("error" in g) return g.error;
      const { cid } = g;
      if (!["campaign", "ad_group"].includes(level)) return fail(`level inválido: "${level}" (campaign ou ad_group). Nada foi gravado.`);
      if (!["add", "remove", "replace"].includes(mode)) return fail(`mode inválido: "${mode}" (add, remove ou replace). Nada foi gravado.`);
      const id = level === "campaign" ? campaignId : adGroupId;
      if (!id) return fail(`level=${level} exige ${level === "campaign" ? "campaignId" : "adGroupId"}. Nada foi gravado.`);
      if (!isDigits(id)) return fail(`ID deve ser numérico, recebido "${id}". Nada foi gravado.`);
      const types = [...new Set(ensureArray<string>(fieldTypes).map((t) => String(t).trim().toUpperCase()).filter(Boolean))];
      const invalid = types.filter((t) => !EXCLUDABLE_FIELD_TYPES.includes(t));
      if (invalid.length) return fail(`fieldTypes inválido(s): ${invalid.join(", ")}. Aceitos: ${EXCLUDABLE_FIELD_TYPES.join(", ")}. Nada foi gravado.`);
      if (types.length === 0 && mode !== "replace") return fail("Informe ao menos um tipo em fieldTypes (ou mode=replace com lista vazia para limpar). Nada foi gravado.");

      const client = getClient();
      const rows = level === "campaign"
        ? await client.searchStream(cid,
          `SELECT campaign.id, campaign.name, campaign.status, campaign.excluded_parent_asset_field_types
           FROM campaign
           WHERE campaign.id = ${id}`)
        : await client.searchStream(cid,
          `SELECT ad_group.id, ad_group.name, ad_group.status, ad_group.excluded_parent_asset_field_types
           FROM ad_group
           WHERE ad_group.id = ${id}`);
      const entity = obj(level === "campaign" ? rows[0]?.campaign : rows[0]?.adGroup);
      const label = level === "campaign" ? "Campanha" : "Grupo";
      if (!rows.length) return fail(`${label} ${id} não encontrado(a) na conta ${cid}. Nada foi gravado.`);
      if (entity.status === "REMOVED") return fail(`${label} ${id} está removido(a). Nada foi gravado.`);
      const before = arr<string>(entity.excludedParentAssetFieldTypes);
      let after: string[];
      if (mode === "replace") after = types;
      else if (mode === "add") after = [...before, ...types.filter((t) => !before.includes(t))];
      else after = before.filter((t) => !types.includes(t));
      const same = before.length === after.length && [...before].sort().join() === [...after].sort().join();
      const payload = { level, id, name: entity.name, before, after };
      if (same) return { content: [text(`Nada a fazer: ${label.toLowerCase()} ${id} ("${entity.name}") já está assim. Nenhuma escrita foi enviada.\n\n${formatJson(payload)}`)] };

      const resourceName = level === "campaign" ? `customers/${cid}/campaigns/${id}` : `customers/${cid}/adGroups/${id}`;
      try {
        await client.mutate(cid, level === "campaign" ? "campaigns" : "adGroups", [
          { update: { resourceName, excludedParentAssetFieldTypes: after }, updateMask: "excluded_parent_asset_field_types" },
        ]);
      } catch (err) {
        return fail(`Nada foi alterado. Erro: ${explainAssetError((err as Error).message)}\n\n${formatJson(payload)}`);
      }
      const dryRun = client.isDryRun;
      return {
        content: [text(
          (dryRun ? `DRY-RUN (validateOnly): exclusão de herança validada — nada foi gravado.` : `${label} ${id} ("${entity.name}"): herança atualizada.`) +
          `\n${after.length ? `Não herda: ${after.join(", ")}.` : "Volta a herdar todos os tipos."}\n\n${formatJson({ ...payload, dry_run: dryRun })}`
        )],
      };
    }
  );

  // ── create_brand_text_asset (BUSINESS_NAME / TEXT_DISCLAIMER) ──────

  mcp.registerTool(
    "create_brand_text_asset",
    {
      description: [
        "Cria um asset de texto de identidade e vincula na mesma operação atômica:",
        "BUSINESS_NAME (nome da empresa nos anúncios de Pesquisa — conta ou campanha) ou",
        "TEXT_DISCLAIMER (aviso legal em texto, novo na v25.1 — o Google ainda não documenta os níveis aceitos).",
        "WRITE OPERATION. Logotipo (BUSINESS_LOGO): suba a imagem com upload_image_asset e vincule com",
        "link_extension_assets. Se o mesmo texto já está vinculado ali, não grava de novo.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        fieldType: z.enum(["BUSINESS_NAME", "TEXT_DISCLAIMER"]).describe("Uso do texto."),
        text: z.string().describe("O texto (nome da empresa ou aviso). O Google aplica o limite de caracteres do formato."),
        level: levelSchema,
        campaignId: z.string().optional().describe("Campanha (level=campaign)."),
        adGroupId: z.string().optional().describe("Grupo (level=ad_group; só TEXT_DISCLAIMER)."),
      },
    },
    async ({ customerId, fieldType, text: value, level, campaignId, adGroupId }) => {
      const g = guard(customerId);
      if ("error" in g) return g.error;
      const { cid } = g;
      const content = String(value ?? "").trim();
      if (!content) return fail("text não pode ser vazio. Nada foi gravado.");
      const picked = pickLevel(level, campaignId, adGroupId);
      if ("error" in picked) return fail(picked.error);
      const rule = FIELD_TYPE_RULES[fieldType];
      if (!rule.levels.includes(picked.level)) return fail(`${fieldType} só pode ser vinculado em: ${rule.levels.join(", ")}. Nada foi gravado.`);

      const client = getClient();
      const target = await resolveTarget(client, cid, picked.level, campaignId, adGroupId);
      if ("error" in target) return fail(target.error);
      const existing = await linksAtTarget(client, cid, target, [fieldType]);
      const same = existing.find((link) => String(obj(link.asset.textAsset).text ?? "").trim() === content);
      if (same) return duplicateResult(rule.label, target, same);
      const warnings: string[] = [];
      const others = existing.filter((link) => link.status === "ENABLED");
      if (others.length) {
        warnings.push(`Já há ${others.length} ${rule.label} ativo(s) aqui (${others.map((o) => `"${describeAsset(o.asset)}"`).join(", ")}). Pause o antigo com update_extension_link_status se quiser só o novo.`);
      }
      if (rule.documented === false) warnings.push("TEXT_DISCLAIMER é novo (v25.1); os níveis aceitos não estão documentados — a API valida.");
      return runCreation(client, cid, target, fieldType, rule.label, { type: "TEXT", textAsset: { text: content } }, content, warnings);
    }
  );

  // ── create_whatsapp_message_asset ──────────────────────────────────

  mcp.registerTool(
    "create_whatsapp_message_asset",
    {
      description: [
        "Cria o recurso de mensagem pelo WhatsApp (click-to-message, BusinessMessageAsset) e vincula na",
        "conta, campanha ou grupo — asset + vínculo numa operação atômica.",
        "WRITE OPERATION.",
        "",
        "ATENÇÃO: recurso liberado só por allowlist do Google (peça ao gerente de contas). Sem a liberação, a",
        "API recusa e a tool devolve o motivo em PT-BR — nada fica gravado.",
        "Regras do Google: uma conta pode ter só UM recurso de mensagem ativo no nível da conta; em campanha e",
        "grupo, um por provedor. A tool confere isso antes de gravar. Em anúncios responsivos, vale o recurso do",
        "nível mais baixo (grupo > campanha > conta).",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        phoneNumber: z.string().describe("Número do WhatsApp da empresa (ex.: 11999998888)."),
        countryCode: z.string().optional().describe("País do número, 2 letras. Default: BR."),
        starterMessage: z.string().describe("Mensagem de boas-vindas que abre a conversa."),
        callToActionType: z.enum(BUSINESS_MESSAGE_CTAS).describe("Chamada para ação."),
        callToActionDescription: z.string().describe("Texto da chamada (ex.: 'Fale com um consultor')."),
        level: levelSchema,
        campaignId: z.string().optional().describe("Campanha (level=campaign)."),
        adGroupId: z.string().optional().describe("Grupo (level=ad_group)."),
        name: z.string().optional().describe("Nome interno do asset."),
      },
    },
    async ({ customerId, phoneNumber, countryCode, starterMessage, callToActionType, callToActionDescription, level, campaignId, adGroupId, name }) => {
      const g = guard(customerId);
      if ("error" in g) return g.error;
      const { cid } = g;
      const errors: string[] = [];
      const phone = String(phoneNumber ?? "").trim();
      const country = String(countryCode ?? "BR").trim().toUpperCase();
      if (!/^[\d()+\-\s]{6,20}$/.test(phone) || phone.replace(/\D/g, "").length < 6) errors.push(`phoneNumber inválido: "${phoneNumber}" (só dígitos, com DDD).`);
      if (!/^[A-Z]{2}$/.test(country)) errors.push("countryCode precisa ter 2 letras (ex.: BR).");
      if (!String(starterMessage ?? "").trim()) errors.push("starterMessage é obrigatória.");
      if (!String(callToActionDescription ?? "").trim()) errors.push("callToActionDescription é obrigatória.");
      const picked = pickLevel(level, campaignId, adGroupId);
      if ("error" in picked) errors.push(picked.error);
      if (errors.length || "error" in picked) return fail(`Nada foi gravado:\n- ${errors.join("\n- ")}`);

      const client = getClient();
      const target = await resolveTarget(client, cid, picked.level, campaignId, adGroupId);
      if ("error" in target) return fail(target.error);
      const asset: Row = {
        type: "BUSINESS_MESSAGE",
        ...(name ? { name } : {}),
        businessMessageAsset: {
          messageProvider: "WHATSAPP",
          starterMessage: starterMessage.trim(),
          callToAction: { callToActionSelection: callToActionType, callToActionDescription: callToActionDescription.trim() },
          whatsappInfo: { countryCode: country, phoneNumber: phone },
        },
      };
      const existing = (await linksAtTarget(client, cid, target, ["BUSINESS_MESSAGE"])).filter((link) => link.status === "ENABLED");
      // "Mesmo conteúdo" só quando número, país, mensagem inicial e CTA batem; mesmo número com outro texto cai na regra de um ativo.
      const { same } = findSameOrSimilar(existing, asset, () => "");
      if (same) return duplicateResult("recurso de WhatsApp", target, same);
      const blocking = target.level === "account"
        ? existing
        : existing.filter((link) => obj(link.asset.businessMessageAsset).messageProvider === "WHATSAPP");
      if (blocking.length) {
        const differs = blocking.map((b) => similarPayload({ link: b, differs: diffAssetContent(asset, b.asset) }));
        return fail(
          `Já existe um recurso de mensagem ativo na ${target.label} (${blocking.map((b) => `${describeAsset(b.asset)} — ${b.resourceName}`).join("; ")}). ` +
          "O Google aceita só um ativo " + (target.level === "account" ? "por conta" : "por provedor nesse nível") +
          ". Nada foi gravado.\n" +
          `→ Para mudar o texto/CTA/número do existente: update_extension_asset com assetId ${blocking[0].asset.id}.\n` +
          "→ Para usar outro asset: pause o vínculo atual com update_extension_link_status e repita." +
          `\n\n${formatJson(differs)}`
        );
      }
      return runCreation(client, cid, target, "BUSINESS_MESSAGE", "Recurso de WhatsApp", asset,
        `WhatsApp ${country} ${phone} — "${starterMessage.trim()}"`,
        ["Recurso liberado só por allowlist do Google; em conta sem liberação a API recusa."]);
    }
  );

  // ── Formulário de lead ─────────────────────────────────────────────

  mcp.registerTool(
    "create_lead_form_asset",
    {
      description: [
        "Cria um formulário de lead (LeadFormAsset) e vincula à campanha (LEAD_FORM só existe no nível",
        "de campanha) — asset + vínculo numa operação atômica.",
        "WRITE OPERATION.",
        "",
        "Pré-requisito: os termos de formulário de lead aceitos na conta",
        "(customer.customer_agreement_setting.accepted_lead_form_terms) — a API não aceita os termos; se",
        "não estiverem aceitos, a tool para antes de gravar e explica como aceitar na interface.",
        "Campos: ao menos 1 (ex.: FULL_NAME, EMAIL, PHONE_NUMBER); até 5 perguntas personalizadas com",
        "2–12 respostas de múltipla escolha ou texto livre; perguntas pré-aprovadas antigas (VEHICLE_*, etc.)",
        "não podem ir junto com perguntas personalizadas. Entrega por webhook opcional (uma só).",
        "Imagem de fundo: asset IMAGE de exatamente 1200x628. Serve em Pesquisa e Performance Max, com",
        "estratégia de conversão e meta de conversão de formulário (regras do Google).",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().describe("Campanha."),
        businessName: z.string().describe("Nome da empresa."),
        headline: z.string().describe("Título do formulário."),
        description: z.string().describe("Descrição do formulário."),
        callToActionType: z.enum(LEAD_FORM_CTAS).describe("Chamada que abre o formulário."),
        callToActionDescription: z.string().describe("Texto que acompanha a chamada."),
        privacyPolicyUrl: z.string().describe("URL da política de privacidade."),
        fields: flexArray(z.object({
          inputType: z.enum(LEAD_FORM_INPUT_TYPES).describe("Campo (ex.: FULL_NAME, EMAIL, PHONE_NUMBER, GOVERNMENT_ISSUED_ID_CPF_BR)."),
          singleChoiceAnswers: z.array(z.string()).optional().describe("Só em pergunta pré-aprovada: 2 a 12 opções."),
        })).describe("Campos do formulário, na ordem."),
        customQuestions: flexArray(z.object({
          text: z.string().describe("Texto da pergunta."),
          singleChoiceAnswers: z.array(z.string()).optional().describe("2 a 12 opções. Sem isto, resposta livre."),
        })).optional().describe("Até 5 perguntas personalizadas."),
        postSubmitHeadline: z.string().optional().describe("Título depois do envio."),
        postSubmitDescription: z.string().optional().describe("Texto depois do envio."),
        postSubmitCallToActionType: z.enum(LEAD_FORM_POST_SUBMIT_CTAS).optional().describe("Botão depois do envio."),
        desiredIntent: z.enum(LEAD_FORM_DESIRED_INTENTS).optional().describe("LOW_INTENT (mais volume) ou HIGH_INTENT (mais qualificado)."),
        backgroundImageAssetId: z.string().optional().describe("Asset IMAGE 1200x628 para o fundo."),
        webhookUrl: z.string().optional().describe("URL https do webhook do CRM."),
        webhookSecret: z.string().optional().describe("Chave secreta (google_secret) que o Google manda no webhook para o CRM validar a origem. Obrigatória com webhookUrl."),
        webhookSchemaVersion: z.number().optional().describe("Versão do payload do webhook (payload_schema_version)."),
        name: z.string().optional().describe("Nome interno do asset."),
      },
    },
    async (args) => {
      const g = guard(args.customerId);
      if ("error" in g) return g.error;
      const { cid } = g;
      const errors: string[] = [];
      if (!isDigits(args.campaignId)) errors.push(`campaignId deve ser numérico, recebido "${args.campaignId}".`);
      for (const [label, value] of [["businessName", args.businessName], ["headline", args.headline], ["description", args.description], ["callToActionDescription", args.callToActionDescription]] as const) {
        if (!String(value ?? "").trim()) errors.push(`${label} é obrigatório.`);
      }
      if (!isUrl(String(args.privacyPolicyUrl ?? ""))) errors.push(`privacyPolicyUrl inválida: "${args.privacyPolicyUrl}".`);

      const fieldList = ensureArray<{ inputType?: string; singleChoiceAnswers?: unknown }>(args.fields);
      if (fieldList.length === 0) errors.push("Informe ao menos um campo em fields (ex.: FULL_NAME, EMAIL, PHONE_NUMBER).");
      const seen = new Set<string>();
      const fields: Row[] = [];
      for (const [index, field] of fieldList.entries()) {
        const inputType = String(field?.inputType ?? "").toUpperCase();
        if (!(inputType in LEAD_FORM_INPUT_TYPE_CODES)) { errors.push(`fields[${index}]: inputType "${field?.inputType}" inválido.`); continue; }
        if (seen.has(inputType)) errors.push(`fields[${index}]: ${inputType} repetido.`);
        seen.add(inputType);
        const answers = field.singleChoiceAnswers === undefined ? undefined : ensureArray<string>(field.singleChoiceAnswers).map((a) => String(a).trim()).filter(Boolean);
        if (answers !== undefined) {
          if (!isPrevettedQuestion(inputType)) errors.push(`fields[${index}]: ${inputType} não aceita opções (só perguntas pré-aprovadas).`);
          if (answers.length < 2 || answers.length > 12) errors.push(`fields[${index}]: de 2 a 12 opções (recebidas ${answers.length}).`);
        }
        fields.push({ inputType, ...(answers ? { singleChoiceAnswers: { answers } } : {}) });
      }
      const questions = ensureArray<{ text?: string; singleChoiceAnswers?: unknown }>(args.customQuestions);
      if (questions.length > 5) errors.push(`No máximo 5 perguntas personalizadas (recebidas ${questions.length}).`);
      const customQuestionFields: Row[] = [];
      for (const [index, question] of questions.entries()) {
        const questionText = String(question?.text ?? "").trim();
        if (!questionText) { errors.push(`customQuestions[${index}]: text vazio.`); continue; }
        const answers = question.singleChoiceAnswers === undefined ? undefined : ensureArray<string>(question.singleChoiceAnswers).map((a) => String(a).trim()).filter(Boolean);
        if (answers !== undefined && (answers.length < 2 || answers.length > 12)) errors.push(`customQuestions[${index}]: de 2 a 12 opções (recebidas ${answers.length}).`);
        customQuestionFields.push({ customQuestionText: questionText, ...(answers ? { singleChoiceAnswers: { answers } } : {}) });
      }
      if (customQuestionFields.length && fields.some((f) => isPrevettedQuestion(String(f.inputType)))) {
        errors.push("Perguntas pré-aprovadas antigas (ex.: VEHICLE_MODEL, OVER_18_AGE) não podem ir junto com perguntas personalizadas (LEAD_FORM_LEGACY_QUALIFYING_QUESTIONS_DISALLOWED).");
      }
      if (args.webhookUrl !== undefined) {
        if (!/^https:\/\/\S+$/i.test(args.webhookUrl)) errors.push("webhookUrl precisa ser https.");
        if (!String(args.webhookSecret ?? "").trim()) errors.push("webhookSecret é obrigatória com webhookUrl (o Google a envia para o CRM validar a origem).");
      } else if (args.webhookSecret !== undefined || args.webhookSchemaVersion !== undefined) {
        errors.push("webhookSecret/webhookSchemaVersion só fazem sentido com webhookUrl.");
      }
      if (args.webhookSchemaVersion !== undefined && !(Number.isInteger(args.webhookSchemaVersion) && args.webhookSchemaVersion > 0)) {
        errors.push("webhookSchemaVersion precisa ser inteiro positivo.");
      }
      if (args.backgroundImageAssetId !== undefined && !isDigits(args.backgroundImageAssetId)) errors.push("backgroundImageAssetId deve ser numérico.");
      if (errors.length) return fail(`Nada foi gravado:\n- ${errors.join("\n- ")}`);

      const client = getClient();
      // Termos de formulário de lead: sem eles a API recusa qualquer mutate de lead form
      const customerRows = await client.searchStream(cid,
        "SELECT customer.id, customer.customer_agreement_setting.accepted_lead_form_terms FROM customer LIMIT 1");
      if (!customerRows.length) return fail(`Não foi possível ler a conta ${cid} para conferir os termos de formulário de lead. Nada foi gravado.`);
      const accepted = obj(obj(obj(customerRows[0]).customer).customerAgreementSetting).acceptedLeadFormTerms === true;
      if (!accepted) {
        return fail(
          `A conta ${cid} ainda não aceitou os termos de formulário de lead (customer_agreement_setting.accepted_lead_form_terms = false). ` +
          "A API não aceita os termos: abra o Google Ads > Recursos > Formulário de lead, aceite uma vez e rode de novo. Nada foi gravado."
        );
      }
      const target = await resolveTarget(client, cid, "campaign", args.campaignId);
      if ("error" in target) return fail(target.error);
      const warnings: string[] = [];
      if (target.channel && !["SEARCH", "PERFORMANCE_MAX"].includes(target.channel)) {
        warnings.push(`Campanha ${target.channel}: o Google documenta formulário de lead em Pesquisa e Performance Max; em outros tipos a API pode recusar ou não veicular.`);
      }
      if (args.backgroundImageAssetId) {
        const imageRows = await client.searchStream(cid,
          `SELECT asset.id, asset.type, asset.image_asset.full_size.width_pixels, asset.image_asset.full_size.height_pixels
           FROM asset
           WHERE asset.id = ${args.backgroundImageAssetId}`);
        const image = obj(imageRows[0]?.asset);
        if (!imageRows.length) return fail(`Imagem ${args.backgroundImageAssetId} não existe na conta ${cid}. Nada foi gravado.`);
        if (image.type !== "IMAGE") return fail(`Asset ${args.backgroundImageAssetId} é ${image.type}, não IMAGE. Nada foi gravado.`);
        const full = obj(obj(image.imageAsset).fullSize);
        if (full.widthPixels !== undefined && (num(full.widthPixels) !== 1200 || num(full.heightPixels) !== 628)) {
          return fail(`A imagem de fundo precisa ter exatamente 1200x628 (esta tem ${num(full.widthPixels)}x${num(full.heightPixels)}). Nada foi gravado.`);
        }
      }
      const existing = await linksAtTarget(client, cid, target, ["LEAD_FORM"]);
      if (existing.some((link) => link.status === "ENABLED")) {
        warnings.push(`A campanha já tem ${existing.filter((l) => l.status === "ENABLED").length} formulário(s) ativo(s): ${existing.map((l) => `"${describeAsset(l.asset)}"`).join(", ")}.`);
      }

      const leadFormAsset: Row = {
        businessName: args.businessName.trim(),
        callToActionType: args.callToActionType,
        callToActionDescription: args.callToActionDescription.trim(),
        headline: args.headline.trim(),
        description: args.description.trim(),
        privacyPolicyUrl: args.privacyPolicyUrl.trim(),
        fields,
        ...(customQuestionFields.length ? { customQuestionFields } : {}),
        ...(args.postSubmitHeadline ? { postSubmitHeadline: args.postSubmitHeadline.trim() } : {}),
        ...(args.postSubmitDescription ? { postSubmitDescription: args.postSubmitDescription.trim() } : {}),
        ...(args.postSubmitCallToActionType ? { postSubmitCallToActionType: args.postSubmitCallToActionType } : {}),
        ...(args.desiredIntent ? { desiredIntent: args.desiredIntent } : {}),
        ...(args.backgroundImageAssetId ? { backgroundImageAsset: `customers/${cid}/assets/${args.backgroundImageAssetId}` } : {}),
        ...(args.webhookUrl
          ? {
              deliveryMethods: [{
                webhook: {
                  advertiserWebhookUrl: args.webhookUrl.trim(),
                  googleSecret: String(args.webhookSecret).trim(),
                  ...(args.webhookSchemaVersion ? { payloadSchemaVersion: String(args.webhookSchemaVersion) } : {}),
                },
              }],
            }
          : {}),
      };
      const details = {
        fields: fields.map((f) => f.inputType),
        custom_questions: customQuestionFields.map((q) => q.customQuestionText),
        webhook: args.webhookUrl ? { url: args.webhookUrl.trim(), secret: "***" } : null,
      };
      return runCreation(client, cid, target, "LEAD_FORM", "Formulário de lead",
        { type: "LEAD_FORM", ...(args.name ? { name: args.name } : {}), leadFormAsset },
        `${args.headline.trim()} — ${args.businessName.trim()}`, warnings, details);
    }
  );

  mcp.registerTool(
    "list_lead_form_assets",
    {
      description: [
        "Lista os formulários de lead da conta: textos, campos, perguntas personalizadas, entrega por",
        "webhook (a chave é mascarada), análise de política e em quais campanhas cada um está vinculado",
        "(status e primary_status). Mostra também se a conta aceitou os termos de formulário de lead.",
        "READ OPERATION. Leads recebidos: list_lead_form_submissions.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        includeRemoved: z.boolean().optional().describe("Inclui vínculos removidos. Default: false."),
      },
    },
    async ({ customerId, includeRemoved }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = customerId.replace(/-/g, "");
      const client = getClient();
      const customerRows = await client.searchStream(cid,
        "SELECT customer.id, customer.customer_agreement_setting.accepted_lead_form_terms FROM customer LIMIT 1");
      const accepted = obj(obj(obj(customerRows[0]).customer).customerAgreementSetting).acceptedLeadFormTerms === true;
      const assetRows = await client.searchStream(cid,
        `SELECT asset.id, asset.name, asset.lead_form_asset.business_name, asset.lead_form_asset.headline,
                asset.lead_form_asset.description, asset.lead_form_asset.call_to_action_type,
                asset.lead_form_asset.call_to_action_description, asset.lead_form_asset.privacy_policy_url,
                asset.lead_form_asset.post_submit_headline, asset.lead_form_asset.post_submit_description,
                asset.lead_form_asset.post_submit_call_to_action_type, asset.lead_form_asset.fields,
                asset.lead_form_asset.custom_question_fields, asset.lead_form_asset.delivery_methods,
                asset.lead_form_asset.desired_intent, asset.lead_form_asset.background_image_asset,
                asset.policy_summary.approval_status, asset.policy_summary.review_status
         FROM asset
         WHERE asset.type = 'LEAD_FORM'`);
      const linkWhere = ["campaign_asset.field_type = 'LEAD_FORM'"];
      if (!includeRemoved) linkWhere.push("campaign_asset.status != 'REMOVED'");
      const linkRows = await client.searchStream(cid,
        `SELECT campaign_asset.asset, campaign_asset.resource_name, campaign_asset.status,
                campaign_asset.primary_status, campaign_asset.primary_status_reasons,
                campaign.id, campaign.name, campaign.status
         FROM campaign_asset
         WHERE ${linkWhere.join(" AND ")}`);
      const linksByAsset = new Map<string, Row[]>();
      for (const row of linkRows) {
        const link = obj(row.campaignAsset);
        const id = String(link.asset ?? "").split("/").pop() ?? "";
        linksByAsset.set(id, [...(linksByAsset.get(id) ?? []), {
          campaign_id: String(obj(row.campaign).id ?? ""),
          campaign_name: obj(row.campaign).name,
          campaign_status: obj(row.campaign).status,
          link_status: link.status,
          primary_status: link.primaryStatus,
          primary_status_reasons: arr(link.primaryStatusReasons),
          link_resource_name: link.resourceName,
        }]);
      }
      const forms = assetRows.map((row) => {
        const asset = obj(row.asset);
        const form = obj(asset.leadFormAsset);
        const policy = obj(asset.policySummary);
        const delivery = arr<Row>(form.deliveryMethods).map((method) => {
          const hook = obj(method.webhook);
          return { webhook_url: hook.advertiserWebhookUrl, secret: hook.googleSecret ? "***" : undefined, payload_schema_version: hook.payloadSchemaVersion };
        });
        return {
          asset_id: String(asset.id ?? ""),
          name: asset.name,
          business_name: form.businessName,
          headline: form.headline,
          description: form.description,
          call_to_action: `${form.callToActionType ?? ""} — ${form.callToActionDescription ?? ""}`,
          privacy_policy_url: form.privacyPolicyUrl,
          post_submit: form.postSubmitHeadline ? { headline: form.postSubmitHeadline, description: form.postSubmitDescription, call_to_action: form.postSubmitCallToActionType } : undefined,
          fields: arr<Row>(form.fields).map((f) => `${f.inputType}${obj(f.singleChoiceAnswers).answers ? ` [${arr(obj(f.singleChoiceAnswers).answers).join(" | ")}]` : ""}`),
          custom_questions: arr<Row>(form.customQuestionFields).map((q) => `${q.customQuestionText}${obj(q.singleChoiceAnswers).answers ? ` [${arr(obj(q.singleChoiceAnswers).answers).join(" | ")}]` : ""}`),
          delivery,
          desired_intent: form.desiredIntent,
          background_image_asset: form.backgroundImageAsset,
          approval_status: policy.approvalStatus,
          review_status: policy.reviewStatus,
          campaigns: linksByAsset.get(String(asset.id)) ?? [],
        };
      });
      const header = `Termos de formulário de lead: ${accepted ? "aceitos" : "NÃO aceitos — aceite na interface do Google Ads antes de criar formulários"}.\n` +
        `${forms.length} formulário(s); ${forms.filter((f) => f.campaigns.length).length} vinculado(s) a campanha.`;
      return { content: [text(`${header}\n\n${formatJson({ accepted_lead_form_terms: accepted, forms })}`)] };
    }
  );

  mcp.registerTool(
    "list_lead_form_submissions",
    {
      description: [
        "Leads recebidos pelos formulários de lead (lead_form_submission_data): data/hora, campanha, grupo,",
        "formulário, gclid, respostas dos campos (nome, e-mail, telefone...) e das perguntas personalizadas.",
        "READ OPERATION — contém dados pessoais dos leads; use redact: true para mascarar.",
        "",
        "O Google guarda os leads por tempo limitado (a ajuda do Google Ads fala em 60 dias); baixe com",
        "frequência. Filtros: período, campanha, grupo ou formulário (asset). Formatos json/table/csv.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().optional().describe("Só desta campanha."),
        adGroupId: z.string().optional().describe("Só deste grupo."),
        assetId: z.string().optional().describe("Só deste formulário."),
        dateRange: dateRangeSchema.describe(DATE_RANGE_DESC),
        days: z.number().optional().describe("Dias para trás (inclui hoje). Default: 30."),
        limit: z.number().optional().describe("Máximo de leads. Default: 1000."),
        redact: z.boolean().optional().describe("Mascara nome, e-mail, telefone e demais respostas. Default: false."),
        format: formatSchema,
      },
    },
    async ({ customerId, campaignId, adGroupId, assetId, dateRange, days, limit, redact, format }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = customerId.replace(/-/g, "");
      for (const [label, value] of [["campaignId", campaignId], ["adGroupId", adGroupId], ["assetId", assetId]] as const) {
        if (value !== undefined && !isDigits(value)) return fail(`${label} deve ser numérico, recebido "${value}".`);
      }
      const max = limit ?? 1000;
      if (!Number.isInteger(max) || max < 1 || max > 10_000) return fail(`limit precisa ser inteiro de 1 a 10000, recebido ${limit}.`);
      let since: string;
      let until: string;
      if (dateRange?.since || dateRange?.until) {
        const errors: string[] = [];
        if (!dateRange?.since || !dateRange?.until) errors.push("dateRange precisa de since e until.");
        else checkDates(errors, dateRange.since, dateRange.until, ["dateRange.since", "dateRange.until"]);
        if (errors.length) return fail(errors.join(" "));
        since = dateRange!.since;
        until = dateRange!.until;
      } else {
        const n = days ?? 30;
        if (!Number.isInteger(n) || n < 1) return fail(`days inválido: ${days}. Use um inteiro positivo.`);
        const start = new Date();
        start.setDate(start.getDate() - n);
        since = localIsoDate(start);
        until = localIsoDate(new Date());
      }
      const where = [
        `lead_form_submission_data.submission_date_time >= '${since} 00:00:00'`,
        `lead_form_submission_data.submission_date_time <= '${until} 23:59:59'`,
      ];
      if (campaignId) where.push(`lead_form_submission_data.campaign = 'customers/${cid}/campaigns/${campaignId}'`);
      if (adGroupId) where.push(`lead_form_submission_data.ad_group = 'customers/${cid}/adGroups/${adGroupId}'`);
      if (assetId) where.push(`lead_form_submission_data.asset = 'customers/${cid}/assets/${assetId}'`);

      const client = getClient();
      const results = await client.searchStream(cid,
        `SELECT lead_form_submission_data.id, lead_form_submission_data.submission_date_time,
                lead_form_submission_data.gclid, lead_form_submission_data.campaign,
                lead_form_submission_data.ad_group, lead_form_submission_data.ad_group_ad,
                lead_form_submission_data.asset, lead_form_submission_data.lead_form_submission_fields,
                lead_form_submission_data.custom_lead_form_submission_fields,
                campaign.name, ad_group.name, asset.name
         FROM lead_form_submission_data
         WHERE ${where.join(" AND ")}
         ORDER BY lead_form_submission_data.submission_date_time DESC
         LIMIT ${max}`);
      const mask = (value: unknown) => {
        const s = String(value ?? "");
        return redact ? (s.length <= 1 ? "*" : `${s[0]}***`) : s;
      };
      const leads = results.map((row) => {
        const data = obj(row.leadFormSubmissionData);
        const fields: Row = {};
        for (const f of arr<Row>(data.leadFormSubmissionFields)) fields[String(f.fieldType ?? "?")] = mask(f.fieldValue);
        return {
          submission_id: data.id,
          submitted_at: data.submissionDateTime,
          campaign_id: String(data.campaign ?? "").split("/").pop(),
          campaign_name: obj(row.campaign).name,
          ad_group_id: data.adGroup ? String(data.adGroup).split("/").pop() : undefined,
          ad_group_name: obj(row.adGroup).name,
          form_asset_id: String(data.asset ?? "").split("/").pop(),
          form_name: obj(row.asset).name,
          gclid: redact && data.gclid ? "***" : data.gclid,
          fields,
          custom_answers: arr<Row>(data.customLeadFormSubmissionFields).map((c) => ({ question: c.questionText, answer: mask(c.fieldValue) })),
        };
      });
      if (format === "table" || format === "csv") {
        const flat = leads.map((lead) => {
          const { fields, custom_answers, ...rest } = lead;
          const row: Row = { ...rest };
          for (const [key, value] of Object.entries(fields)) row[`field_${key}`] = value;
          custom_answers.forEach((answer, i) => { row[`custom_${i + 1}_question`] = answer.question; row[`custom_${i + 1}_answer`] = answer.answer; });
          return row;
        });
        return { content: [text(format === "table" ? formatAsTable(flat) : formatAsCsv(flat))] };
      }
      return {
        content: [text(
          `${leads.length} lead(s) de ${since} a ${until}${leads.length >= max ? ` (atingiu o limit ${max} — pode haver mais)` : ""}.` +
          `${redact ? " Dados mascarados." : " Contém dados pessoais — trate conforme a LGPD."}\n\n${formatJson(leads)}`
        )],
      };
    }
  );

  // ── Criação de extensões (tools existentes, reescritas) ────────────

  const creationTarget = async (client: GoogleAdsClient, cid: string, level: string | undefined, campaignId?: string, adGroupId?: string) => {
    const picked = pickLevel(level, campaignId, adGroupId);
    if ("error" in picked) return picked;
    return resolveTarget(client, cid, picked.level, campaignId, adGroupId);
  };

  const commonCreateFields = {
    customerId: z.string().describe("Customer ID."),
    campaignId: z.string().optional().describe("Campanha (vínculo de campanha)."),
    adGroupId: z.string().optional().describe("Grupo de anúncios (vínculo de grupo)."),
    level: levelSchema,
  };

  mcp.registerTool(
    "create_sitelink_extension",
    {
      description: [
        "Cria um sitelink e vincula na campanha, no grupo ou na conta (asset + vínculo numa operação atômica).",
        "WRITE OPERATION.",
        "",
        "Texto do link 1–25 caracteres; descrições 1–35 e sempre as duas juntas. Datas de veiculação",
        "(startDate/endDate) e horários (adSchedule) opcionais. Duplicado: sitelink idêntico (texto, URL,",
        "descrições, datas e horários) já vinculado ali → não grava nada; mesmo texto e URL com outro conteúdo →",
        "recusa, mostra o que difere e aponta update_extension_asset. Reaproveitar um existente: link_extension_assets.",
      ].join("\n"),
      inputSchema: {
        ...commonCreateFields,
        linkText: z.string().describe("Texto do sitelink (1–25)."),
        finalUrl: z.string().describe("URL do sitelink."),
        description1: z.string().optional().describe("Descrição linha 1 (1–35). Exige description2."),
        description2: z.string().optional().describe("Descrição linha 2 (1–35). Exige description1."),
        startDate: z.string().optional().describe("Começa a veicular em YYYY-MM-DD."),
        endDate: z.string().optional().describe("Para de veicular em YYYY-MM-DD."),
        adSchedule: adScheduleSchema,
      },
    },
    async (args) => {
      const g = guard(args.customerId);
      if ("error" in g) return g.error;
      const { cid } = g;
      const errors: string[] = [];
      checkLength(errors, "linkText", args.linkText, 1, 25);
      checkLength(errors, "description1", args.description1, 1, 35);
      checkLength(errors, "description2", args.description2, 1, 35);
      if ((args.description1 === undefined) !== (args.description2 === undefined)) errors.push("description1 e description2 vão juntas: informe as duas ou nenhuma.");
      if (!isUrl(String(args.finalUrl ?? ""))) errors.push(`finalUrl inválida: "${args.finalUrl}".`);
      checkDates(errors, args.startDate, args.endDate);
      const schedule = args.adSchedule !== undefined ? buildAdSchedule(args.adSchedule) : { targets: [] as Row[] };
      if ("error" in schedule) errors.push(schedule.error);
      const picked = pickLevel(args.level, args.campaignId, args.adGroupId);
      if ("error" in picked) errors.push(picked.error);
      if (errors.length) return fail(`Nada foi gravado:\n- ${errors.join("\n- ")}`);

      const client = getClient();
      const target = await creationTarget(client, cid, args.level, args.campaignId, args.adGroupId);
      if ("error" in target) return fail(target.error);
      const linkText = args.linkText.trim();
      const finalUrl = args.finalUrl.trim();
      const sitelinkAsset: Row = {
        linkText,
        ...(args.description1 !== undefined ? { description1: args.description1.trim(), description2: String(args.description2).trim() } : {}),
        ...(args.startDate ? { startDate: args.startDate } : {}),
        ...(args.endDate ? { endDate: args.endDate } : {}),
        ...("targets" in schedule && schedule.targets.length ? { adScheduleTargets: schedule.targets } : {}),
      };
      const assetCreate: Row = { type: "SITELINK", finalUrls: [finalUrl], sitelinkAsset };
      const { same, similar } = findSameOrSimilar(await linksAtTarget(client, cid, target, ["SITELINK"]), assetCreate,
        (asset) => `${textValue(obj(asset.sitelinkAsset).linkText).toLowerCase()}|${textValue(arr(asset.finalUrls)[0])}`);
      if (same) return duplicateResult("sitelink", target, same);
      if (similar.length) return similarRefusal("um sitelink", "o mesmo texto e URL", target, similar);
      return runCreation(client, cid, target, "SITELINK", "Sitelink", assetCreate, `${linkText} → ${finalUrl}`, []);
    }
  );

  mcp.registerTool(
    "create_callout_extension",
    {
      description: [
        "Cria uma frase de destaque (callout — ex.: 'Frete Grátis', 'Parcelamos em 12x') e vincula na",
        "campanha, no grupo ou na conta (asset + vínculo numa operação atômica).",
        "WRITE OPERATION. Texto 1–25 caracteres; datas e horários de veiculação opcionais. Duplicado: frase",
        "idêntica (texto, datas e horários) já vinculada ali → não grava nada; mesma frase com outras datas/horários",
        "ou outra grafia → recusa, mostra o que difere e aponta update_extension_asset.",
      ].join("\n"),
      inputSchema: {
        ...commonCreateFields,
        calloutText: z.string().describe("Texto (1–25)."),
        startDate: z.string().optional().describe("Começa a veicular em YYYY-MM-DD."),
        endDate: z.string().optional().describe("Para de veicular em YYYY-MM-DD."),
        adSchedule: adScheduleSchema,
      },
    },
    async (args) => {
      const g = guard(args.customerId);
      if ("error" in g) return g.error;
      const { cid } = g;
      const errors: string[] = [];
      checkLength(errors, "calloutText", String(args.calloutText ?? ""), 1, 25);
      checkDates(errors, args.startDate, args.endDate);
      const schedule = args.adSchedule !== undefined ? buildAdSchedule(args.adSchedule) : { targets: [] as Row[] };
      if ("error" in schedule) errors.push(schedule.error);
      const picked = pickLevel(args.level, args.campaignId, args.adGroupId);
      if ("error" in picked) errors.push(picked.error);
      if (errors.length) return fail(`Nada foi gravado:\n- ${errors.join("\n- ")}`);

      const client = getClient();
      const target = await creationTarget(client, cid, args.level, args.campaignId, args.adGroupId);
      if ("error" in target) return fail(target.error);
      const calloutText = args.calloutText.trim();
      const calloutAsset: Row = {
        calloutText,
        ...(args.startDate ? { startDate: args.startDate } : {}),
        ...(args.endDate ? { endDate: args.endDate } : {}),
        ...("targets" in schedule && schedule.targets.length ? { adScheduleTargets: schedule.targets } : {}),
      };
      const assetCreate: Row = { type: "CALLOUT", calloutAsset };
      const { same, similar } = findSameOrSimilar(await linksAtTarget(client, cid, target, ["CALLOUT"]), assetCreate,
        (asset) => textValue(obj(asset.calloutAsset).calloutText).toLowerCase());
      if (same) return duplicateResult("frase de destaque", target, same);
      if (similar.length) return similarRefusal("uma frase de destaque", "o mesmo texto", target, similar);
      return runCreation(client, cid, target, "CALLOUT", "Frase de destaque", assetCreate, calloutText, []);
    }
  );

  mcp.registerTool(
    "create_structured_snippet",
    {
      description: [
        "Cria um snippet estruturado e vincula na campanha, no grupo ou na conta (operação atômica).",
        "WRITE OPERATION. O cabeçalho precisa ser o texto EXATO de um dos valores oficiais, na língua do anúncio",
        "— pt-BR: Marcas, Comodidades, Estilos, Tipos, Destinos, Serviços, Cursos, Bairros, Programas, Cobertura",
        "do seguro, Programas de graduação, Hotéis em destaque, Modelos. Qualquer idioma da tabela oficial do",
        "Google é aceito (ex.: es-419 'Barrios', en-GB 'Neighbourhoods'). 3 a 10 valores de 1–25 caracteres.",
        "Duplicado: snippet idêntico já vinculado ali → não grava nada; mesmo cabeçalho e valores com outra",
        "grafia → recusa e aponta update_extension_asset.",
      ].join("\n"),
      inputSchema: {
        ...commonCreateFields,
        header: z.string().describe("Cabeçalho oficial, texto exato (ex.: 'Marcas', 'Serviços', 'Tipos'; ou de outro idioma da tabela oficial)."),
        values: flexArray(z.string()).describe("3 a 10 valores (1–25 cada)."),
      },
    },
    async (args) => {
      const g = guard(args.customerId);
      if ("error" in g) return g.error;
      const { cid } = g;
      const errors: string[] = [];
      const checkedHeader = checkSnippetHeader("header", args.header);
      if ("error" in checkedHeader) errors.push(checkedHeader.error);
      const header = "header" in checkedHeader ? checkedHeader.header : "";
      const values = ensureArray<string>(args.values).map((v) => String(v).trim());
      validateSnippetValues(errors, values);
      const picked = pickLevel(args.level, args.campaignId, args.adGroupId);
      if ("error" in picked) errors.push(picked.error);
      if (errors.length) return fail(`Nada foi gravado:\n- ${errors.join("\n- ")}`);

      const client = getClient();
      const target = await creationTarget(client, cid, args.level, args.campaignId, args.adGroupId);
      if ("error" in target) return fail(target.error);
      const assetCreate: Row = { type: "STRUCTURED_SNIPPET", structuredSnippetAsset: { header, values } };
      const { same, similar } = findSameOrSimilar(await linksAtTarget(client, cid, target, ["STRUCTURED_SNIPPET"]), assetCreate, (asset) => {
        const ss = obj(asset.structuredSnippetAsset);
        return `${textValue(ss.header)}|${arr(ss.values).map(textValue).join("|")}`.normalize("NFC").toLowerCase();
      });
      if (same) return duplicateResult("snippet estruturado", target, same);
      if (similar.length) return similarRefusal("um snippet estruturado", "o mesmo cabeçalho e valores (outra grafia)", target, similar);
      return runCreation(client, cid, target, "STRUCTURED_SNIPPET", "Snippet estruturado", assetCreate, `${header}: ${values.join(", ")}`, []);
    }
  );

  mcp.registerTool(
    "create_call_extension",
    {
      description: [
        "Cria o recurso de chamada (telefone) e vincula na campanha, no grupo ou na conta (operação atômica).",
        "WRITE OPERATION. Horários opcionais (adSchedule) — útil para mostrar o telefone só no horário de",
        "atendimento. Conversão de chamada: callConversionReportingState (e conversionActionId quando",
        "USE_RESOURCE_LEVEL_CALL_CONVERSION_ACTION). Duplicado: mesmo número com o mesmo país, horários e conversão",
        "pedida já vinculado ali → não grava nada; mesmo número com outro conteúdo → recusa, mostra o que difere e",
        "aponta update_extension_asset (conversão de chamada não é editável lá: remova o vínculo antigo e crie de novo).",
      ].join("\n"),
      inputSchema: {
        ...commonCreateFields,
        phoneNumber: z.string().describe("Telefone (ex.: '11999999999' ou '+5511999999999')."),
        countryCode: z.string().optional().describe("País do número, 2 letras. Default: BR."),
        callConversionReportingState: z.enum(CALL_CONVERSION_REPORTING_STATES).optional().describe("Como contar conversões de chamada."),
        conversionActionId: z.string().optional().describe("Ação de conversão (com USE_RESOURCE_LEVEL_CALL_CONVERSION_ACTION)."),
        adSchedule: adScheduleSchema,
      },
    },
    async (args) => {
      const g = guard(args.customerId);
      if ("error" in g) return g.error;
      const { cid } = g;
      const errors: string[] = [];
      const phone = String(args.phoneNumber ?? "").trim();
      const country = String(args.countryCode ?? "BR").trim().toUpperCase();
      if (!/^[\d()+\-\s]{6,20}$/.test(phone) || phone.replace(/\D/g, "").length < 6) errors.push(`phoneNumber inválido: "${args.phoneNumber}".`);
      if (!/^[A-Z]{2}$/.test(country)) errors.push("countryCode precisa ter 2 letras (ex.: BR).");
      if (args.conversionActionId !== undefined) {
        if (!isDigits(args.conversionActionId)) errors.push("conversionActionId deve ser numérico.");
        if (args.callConversionReportingState !== "USE_RESOURCE_LEVEL_CALL_CONVERSION_ACTION") {
          errors.push("conversionActionId só vale com callConversionReportingState = USE_RESOURCE_LEVEL_CALL_CONVERSION_ACTION.");
        }
      } else if (args.callConversionReportingState === "USE_RESOURCE_LEVEL_CALL_CONVERSION_ACTION") {
        errors.push("USE_RESOURCE_LEVEL_CALL_CONVERSION_ACTION exige conversionActionId.");
      }
      const schedule = args.adSchedule !== undefined ? buildAdSchedule(args.adSchedule) : { targets: [] as Row[] };
      if ("error" in schedule) errors.push(schedule.error);
      const picked = pickLevel(args.level, args.campaignId, args.adGroupId);
      if ("error" in picked) errors.push(picked.error);
      if (errors.length) return fail(`Nada foi gravado:\n- ${errors.join("\n- ")}`);

      const client = getClient();
      const target = await creationTarget(client, cid, args.level, args.campaignId, args.adGroupId);
      if ("error" in target) return fail(target.error);
      const callAsset: Row = {
        phoneNumber: phone,
        countryCode: country,
        ...(args.callConversionReportingState ? { callConversionReportingState: args.callConversionReportingState } : {}),
        ...(args.conversionActionId ? { callConversionAction: `customers/${cid}/conversionActions/${args.conversionActionId}` } : {}),
        ...("targets" in schedule && schedule.targets.length ? { adScheduleTargets: schedule.targets } : {}),
      };
      const assetCreate: Row = { type: "CALL", callAsset };
      // Conversão não informada = padrão da API (que a leitura devolve preenchido): fica fora da comparação.
      const { same, similar } = findSameOrSimilar(await linksAtTarget(client, cid, target, ["CALL"]), assetCreate,
        (asset) => digitsValue(obj(asset.callAsset).phoneNumber), ["callConversionReportingState", "callConversionAction"]);
      if (same) return duplicateResult("recurso de chamada", target, same);
      if (similar.length) {
        const conversionDiffers = similar[0].differs.some((d) => d.field.startsWith("callConversion"));
        return similarRefusal("um recurso de chamada", "o mesmo número", target, similar, conversionDiffers
          ? ["A conversão de chamada (callConversionReportingState/conversionActionId) não é editável em update_extension_asset: para mudá-la, remova o vínculo antigo e crie de novo."]
          : []);
      }
      return runCreation(client, cid, target, "CALL", "Recurso de chamada", assetCreate, `${country} ${phone}`, []);
    }
  );

  mcp.registerTool(
    "create_price_extension",
    {
      description: [
        "Cria o recurso de preço e vincula na campanha, no grupo ou na conta (operação atômica).",
        "WRITE OPERATION. priceType: BRANDS, EVENTS, LOCATIONS, NEIGHBORHOODS, PRODUCT_CATEGORIES,",
        "PRODUCT_TIERS, SERVICES, SERVICE_CATEGORIES, SERVICE_TIERS. 3 a 8 itens; título e descrição de 1–25",
        "caracteres e diferentes entre si. Moeda default: a da conta. Idioma default pt-BR.",
        "",
        "Duplicado: só deixa de gravar quando já há um recurso de preço IDÊNTICO vinculado ali (tipo, qualificador,",
        "idioma e, item a item, título, descrição, valor, moeda, unidade e URL). Se já há outro do mesmo tipo com",
        "conteúdo diferente (ex.: preços ou URLs novos), cria o novo e avisa — os dois ficam vinculados. Para TROCAR",
        "os preços do existente em vez de somar: update_extension_asset (priceItems) no asset existente.",
      ].join("\n"),
      inputSchema: {
        ...commonCreateFields,
        priceType: z.enum(PRICE_EXTENSION_TYPES).describe("Tipo do recurso de preço."),
        priceQualifier: z.enum(PRICE_QUALIFIERS).optional().describe("FROM (a partir de), UP_TO (até), AVERAGE (média)."),
        languageCode: z.string().optional().describe("Idioma BCP-47. Default: pt-BR."),
        currencyCode: z.string().optional().describe("Moeda ISO 4217 para todos os itens. Default: a da conta."),
        items: flexArray(z.object({
          header: z.string(), description: z.string(), priceAmount: z.number(),
          currencyCode: z.string().optional(), finalUrl: z.string(), unit: z.enum(PRICE_UNITS).optional(),
        })).describe("3 a 8 itens: header, description, priceAmount (ex.: 99.9), finalUrl, unit opcional (PER_MONTH...)."),
      },
    },
    async (args) => {
      const g = guard(args.customerId);
      if ("error" in g) return g.error;
      const { cid } = g;
      const errors: string[] = [];
      validatePriceItems(errors, args.items);
      if (args.currencyCode !== undefined && !/^[A-Z]{3}$/.test(args.currencyCode)) errors.push(`currencyCode inválido: "${args.currencyCode}".`);
      const picked = pickLevel(args.level, args.campaignId, args.adGroupId);
      if ("error" in picked) errors.push(picked.error);
      if (errors.length) return fail(`Nada foi gravado:\n- ${errors.join("\n- ")}`);

      const client = getClient();
      const target = await creationTarget(client, cid, args.level, args.campaignId, args.adGroupId);
      if ("error" in target) return fail(target.error);
      const currency = args.currencyCode ?? await accountCurrency(client, cid);
      const priceOfferings = buildPriceOfferings(args.items, currency);
      const priceAsset: Row = {
        type: args.priceType,
        languageCode: args.languageCode ?? "pt-BR",
        ...(args.priceQualifier ? { priceQualifier: args.priceQualifier } : {}),
        priceOfferings,
      };
      const assetCreate: Row = { type: "PRICE", priceAsset };
      // Idêntico em todo o conteúdo → no-op; outro do mesmo tipo → cria e avisa (não é "o mesmo").
      const { same, similar } = findSameOrSimilar(await linksAtTarget(client, cid, target, ["PRICE"]), assetCreate,
        (asset) => enumValue(obj(asset.priceAsset).type));
      if (same) return duplicateResult("recurso de preço", target, same);
      const warnings = similar.length ? [similarWarning("recurso(s) de preço do mesmo tipo", similar)] : [];
      return runCreation(client, cid, target, "PRICE", "Recurso de preço", assetCreate,
        `${args.priceType} (${priceOfferings.length} itens, ${currency})`, warnings,
        similar.length ? { similar_existing: similar.map(similarPayload) } : undefined);
    }
  );

  mcp.registerTool(
    "create_promotion_extension",
    {
      description: [
        "Cria o recurso de promoção e vincula na campanha, no grupo ou na conta (operação atômica).",
        "WRITE OPERATION.",
        "",
        "Desconto: percentOff (ex.: 20) OU moneyAmountOff (valor). Gatilho opcional: promotionCode (cupom) OU",
        "ordersOverAmount (pedido mínimo). upTo=true mostra 'até X%'. Ocasião opcional (BLACK_FRIDAY, CHRISTMAS,",
        "CARNIVAL...; NONE não existe na API). Janela de resgate (redemptionStartDate/EndDate) só se informada",
        "— com ocasião, ela precisa cair no período da ocasião. Datas de veiculação (startDate/endDate) e",
        "horários opcionais. Moeda default: a da conta.",
        "",
        "Duplicado: só deixa de gravar quando já há uma promoção IDÊNTICA vinculada ali (alvo, desconto, 'até',",
        "cupom ou pedido mínimo, ocasião, janela de resgate, datas de veiculação, horários, idioma e URL). Promoção",
        "com o mesmo alvo e termos diferentes (ex.: Black Friday com pedido mínimo ao lado de uma permanente) é",
        "criada, com aviso sobre a existente. Para ALTERAR a existente em vez de somar: update_extension_asset.",
      ].join("\n"),
      inputSchema: {
        ...commonCreateFields,
        promotionTarget: z.string().describe("O que está em promoção (ex.: 'Tênis de corrida')."),
        percentOff: z.number().optional().describe("Percentual de desconto (ex.: 20 = 20%)."),
        moneyAmountOff: z.number().optional().describe("Desconto em valor (ex.: 50 = R$ 50)."),
        upTo: z.boolean().optional().describe("true = 'até' X (discount_modifier UP_TO)."),
        promotionCode: z.string().optional().describe("Cupom."),
        ordersOverAmount: z.number().optional().describe("Pedido mínimo para a promoção."),
        currencyCode: z.string().optional().describe("Moeda (default: a da conta)."),
        occasion: z.string().optional().describe("PromotionExtensionOccasion (ex.: BLACK_FRIDAY, CHRISTMAS, CARNIVAL). Omita para nenhuma."),
        languageCode: z.string().optional().describe("Idioma BCP-47 regional (ex.: 'pt-BR'). Default: 'pt-BR'. A API rejeita 'pt' sem região."),
        finalUrl: z.string().describe("Página da promoção."),
        redemptionStartDate: z.string().optional().describe("Início do resgate YYYY-MM-DD."),
        redemptionEndDate: z.string().optional().describe("Fim do resgate YYYY-MM-DD."),
        startDate: z.string().optional().describe("Começa a veicular em YYYY-MM-DD."),
        endDate: z.string().optional().describe("Para de veicular em YYYY-MM-DD."),
        adSchedule: adScheduleSchema,
      },
    },
    async (args) => {
      const g = guard(args.customerId);
      if ("error" in g) return g.error;
      const { cid } = g;
      const errors: string[] = [];
      if (!String(args.promotionTarget ?? "").trim()) errors.push("promotionTarget é obrigatório.");
      if ((args.percentOff === undefined) === (args.moneyAmountOff === undefined)) errors.push("Informe percentOff OU moneyAmountOff (um dos dois, obrigatório).");
      if (args.percentOff !== undefined && !(args.percentOff > 0 && args.percentOff <= 100)) errors.push("percentOff precisa ser > 0 e <= 100.");
      if (args.moneyAmountOff !== undefined && !(args.moneyAmountOff > 0)) errors.push("moneyAmountOff precisa ser > 0.");
      if (args.promotionCode !== undefined && args.ordersOverAmount !== undefined) errors.push("Use promotionCode OU ordersOverAmount, não os dois.");
      if (args.promotionCode !== undefined && !args.promotionCode.trim()) errors.push("promotionCode vazio.");
      if (args.ordersOverAmount !== undefined && !(args.ordersOverAmount > 0)) errors.push("ordersOverAmount precisa ser > 0.");
      if (args.currencyCode !== undefined && !/^[A-Z]{3}$/.test(args.currencyCode)) errors.push(`currencyCode inválido: "${args.currencyCode}".`);
      const occasion = args.occasion?.trim().toUpperCase();
      const occasionCode = occasion && !["NONE", "UNSPECIFIED", "UNKNOWN"].includes(occasion) ? occasion : undefined;
      if (occasionCode && !(PROMOTION_OCCASIONS as readonly string[]).includes(occasionCode)) {
        errors.push(`occasion "${args.occasion}" inválida. Válidas: ${PROMOTION_OCCASIONS.join(", ")}.`);
      }
      if (!isUrl(String(args.finalUrl ?? ""))) errors.push(`finalUrl inválida: "${args.finalUrl}".`);
      checkDates(errors, args.redemptionStartDate, args.redemptionEndDate, ["redemptionStartDate", "redemptionEndDate"]);
      checkDates(errors, args.startDate, args.endDate);
      const schedule = args.adSchedule !== undefined ? buildAdSchedule(args.adSchedule) : { targets: [] as Row[] };
      if ("error" in schedule) errors.push(schedule.error);
      const picked = pickLevel(args.level, args.campaignId, args.adGroupId);
      if ("error" in picked) errors.push(picked.error);
      if (errors.length) return fail(`Nada foi gravado:\n- ${errors.join("\n- ")}`);

      const client = getClient();
      const target = await creationTarget(client, cid, args.level, args.campaignId, args.adGroupId);
      if ("error" in target) return fail(target.error);
      const promotionTarget = args.promotionTarget.trim();
      const needsCurrency = args.moneyAmountOff !== undefined || args.ordersOverAmount !== undefined;
      const currency = args.currencyCode ?? (needsCurrency ? await accountCurrency(client, cid) : "BRL");
      // v25: discountModifier só aceita UP_TO e occasion não tem NONE — omitidos quando não informados.
      // percent_off: 1.000.000 = 100%, logo 1% = 10.000 (int64; Math.round evita 700.0000000000001).
      const promotionAsset: Row = {
        promotionTarget,
        languageCode: args.languageCode ?? "pt-BR",
        ...(args.percentOff !== undefined ? { percentOff: String(Math.round(args.percentOff * 10_000)) } : {}),
        ...(args.moneyAmountOff !== undefined ? { moneyAmountOff: { amountMicros: String(Math.round(args.moneyAmountOff * 1_000_000)), currencyCode: currency } } : {}),
        ...(args.upTo ? { discountModifier: "UP_TO" } : {}),
        ...(args.promotionCode ? { promotionCode: args.promotionCode.trim() } : {}),
        ...(args.ordersOverAmount !== undefined ? { ordersOverAmount: { amountMicros: String(Math.round(args.ordersOverAmount * 1_000_000)), currencyCode: currency } } : {}),
        ...(occasionCode ? { occasion: occasionCode } : {}),
        ...(args.redemptionStartDate ? { redemptionStartDate: args.redemptionStartDate } : {}),
        ...(args.redemptionEndDate ? { redemptionEndDate: args.redemptionEndDate } : {}),
        ...(args.startDate ? { startDate: args.startDate } : {}),
        ...(args.endDate ? { endDate: args.endDate } : {}),
        ...("targets" in schedule && schedule.targets.length ? { adScheduleTargets: schedule.targets } : {}),
      };
      const assetCreate: Row = { type: "PROMOTION", finalUrls: [args.finalUrl.trim()], promotionAsset };
      // Idêntica em todo o conteúdo → no-op; mesmo alvo com outros termos → cria e avisa.
      const { same, similar } = findSameOrSimilar(await linksAtTarget(client, cid, target, ["PROMOTION"]), assetCreate,
        (asset) => textValue(obj(asset.promotionAsset).promotionTarget).toLowerCase());
      if (same) return duplicateResult("promoção", target, same);
      const warnings = similar.length ? [similarWarning("promoção(ões) com o mesmo alvo", similar)] : [];
      const off = args.percentOff !== undefined ? `${args.percentOff}% off` : `${args.moneyAmountOff} ${currency} off`;
      return runCreation(client, cid, target, "PROMOTION", "Promoção", assetCreate,
        `${promotionTarget} — ${args.upTo ? "até " : ""}${off}`, warnings,
        similar.length ? { similar_existing: similar.map(similarPayload) } : undefined);
    }
  );
}

// ── Helpers de validação/conversão (preço, snippet, comparação) ──────

interface PriceItemInput { header?: unknown; description?: unknown; priceAmount?: unknown; currencyCode?: unknown; finalUrl?: unknown; unit?: unknown }

function validatePriceItems(errors: string[], input: unknown): void {
  const items = ensureArray<PriceItemInput>(input);
  if (items.length < 3 || items.length > 8) errors.push(`Preço: de 3 a 8 itens (recebidos ${items.length}).`);
  items.forEach((item, index) => {
    const at = `items[${index}]`;
    if (!item || typeof item !== "object") { errors.push(`${at}: esperado {header, description, priceAmount, finalUrl, unit?}.`); return; }
    const header = String(item.header ?? "").trim();
    const description = String(item.description ?? "").trim();
    checkLength(errors, `${at}.header`, header, 1, 25);
    checkLength(errors, `${at}.description`, description, 1, 25);
    if (header && header.toLowerCase() === description.toLowerCase()) errors.push(`${at}: header e description não podem ser iguais.`);
    if (typeof item.priceAmount !== "number" || !Number.isFinite(item.priceAmount) || item.priceAmount <= 0) errors.push(`${at}.priceAmount precisa ser número > 0.`);
    if (!isUrl(String(item.finalUrl ?? ""))) errors.push(`${at}.finalUrl inválida.`);
    if (item.currencyCode !== undefined && !/^[A-Z]{3}$/.test(String(item.currencyCode))) errors.push(`${at}.currencyCode inválido.`);
    if (item.unit !== undefined && !(PRICE_UNITS as readonly string[]).includes(String(item.unit))) errors.push(`${at}.unit inválida (${PRICE_UNITS.join(", ")}).`);
  });
}

function buildPriceOfferings(input: unknown, currency: string): Row[] {
  return ensureArray<PriceItemInput>(input).map((item) => ({
    header: String(item.header).trim(),
    description: String(item.description).trim(),
    price: { amountMicros: String(Math.round(Number(item.priceAmount) * 1_000_000)), currencyCode: String(item.currencyCode ?? currency) },
    finalUrl: String(item.finalUrl).trim(),
    ...(item.unit ? { unit: String(item.unit) } : {}),
  }));
}

function validateSnippetValues(errors: string[], values: string[]): void {
  if (values.length < 3 || values.length > 10) errors.push(`Snippet: de 3 a 10 valores (recebidos ${values.length}).`);
  values.forEach((value, index) => checkLength(errors, `values[${index}]`, String(value), 1, 25));
  const lower = values.map((v) => String(v).trim().toLowerCase());
  if (new Set(lower).size !== lower.length) errors.push("Snippet: valores repetidos.");
}

function setIn(target: Row, path: string[], value: unknown): void {
  let current = target;
  for (const key of path.slice(0, -1)) {
    if (!current[key] || typeof current[key] !== "object") current[key] = {};
    current = current[key] as Row;
  }
  current[path[path.length - 1]] = value;
}

/** Normaliza para comparar antes/depois: undefined ≡ "", int64 como string, agenda como rótulo. */
function normalizeForCompare(value: unknown): string {
  if (value === undefined || value === null) return JSON.stringify("");
  if (Array.isArray(value)) {
    if (value.length && typeof value[0] === "object" && value[0] !== null && "dayOfWeek" in (value[0] as Row)) {
      return JSON.stringify((value as Row[]).map(scheduleLabel).sort());
    }
    if (value.length && typeof value[0] === "object" && value[0] !== null && "header" in (value[0] as Row)) {
      return JSON.stringify((value as Row[]).map((o) => ({
        header: o.header, description: o.description, price: String(obj(o.price).amountMicros ?? ""),
        currency: obj(o.price).currencyCode, finalUrl: o.finalUrl, unit: o.unit ?? "",
      })));
    }
    return JSON.stringify(value.map((v) => String(v)));
  }
  if (typeof value === "object") {
    const o = value as Row;
    return JSON.stringify(Object.keys(o).sort().map((k) => [k, String(o[k] ?? "")]));
  }
  return JSON.stringify(String(value));
}
