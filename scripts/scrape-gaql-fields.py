"""
Extrai da field reference oficial (developers.google.com/google-ads/api/fields/<versão>/)
os metadados de GAQL que os testes usam para validar queries: recursos atribuídos e de
segmentação, segmentos e métricas compatíveis com cada FROM, e selectable/filterable/
sortable/repeated de cada campo. As páginas são renderizadas no servidor.

Uso: python3 scripts/scrape-gaql-fields.py tests/fixtures/google-ads-v25-fields.json [v25]
"""
import json, re, sys, urllib.request, concurrent.futures
VERSION = sys.argv[2] if len(sys.argv) > 2 else "v25"
BASE = f"https://developers.google.com/google-ads/api/fields/{VERSION}/"
def get(url):
    for attempt in range(4):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"}), timeout=90) as r:
                return r.read().decode("utf-8")
        except Exception as e:
            err = e
    raise err
overview = get(BASE + "overview")
names = sorted(n for n in set(re.findall(rf'href="/google-ads/api/fields/{VERSION}/([a-z_0-9]+)"', overview))
               if n not in {"overview", "query_validator", "segments", "metrics"} and not n.endswith("_query_builder"))
print("recursos na visão geral:", len(names), file=sys.stderr)

def links_after(h, header):
    i = h.find(f"<th>{header}</th>")
    if i < 0: return []
    j = h.find("</tbody>", i)
    return re.findall(rf'href="/google-ads/api/fields/{VERSION}/([a-z_0-9]+)"', h[i:j])

def parse(name):
    h = get(BASE + name)
    res = {"attributed": links_after(h, "Attributed resources"), "segmenting": links_after(h, "Segmenting resources")}
    m = h.find('select-el-container-id="main-resource"')
    section = h[m: h.find("</devsite-filter>", h.find("&nbsp;Metrics", m)) if m >= 0 else m]
    def listed(title):
        i = section.find(f"&nbsp;{title}")
        if i < 0: return []
        j = section.find("</tbody>", i)
        return re.findall(r'#((?:segments|metrics)\.[a-z_0-9.]+)"', section[i:j])
    res["segments"] = [s.split(".", 1)[1] for s in listed("Segments")]
    res["metrics"] = [s.split(".", 1)[1] for s in listed("Metrics")]
    fields = {}
    for fm in re.finditer(r'<h2 id="([a-z_0-9.]+)" data-text=.*?</table>', h, re.S):
        fid, block = fm.group(1), fm.group(0)
        def row(label):
            mm = re.search(rf"<td>{label}</td><td>(?:<code[^>]*>)?([^<]*)", block)
            return mm.group(1).strip() if mm else ""
        fields[fid] = {"cat": row("Category"), "type": row("Data Type"), "f": row("Filterable") == "True",
                       "s": row("Selectable") == "True", "o": row("Sortable") == "True", "r": row("Repeated") == "True"}
    return name, res, fields

resources, fields = {}, {}
with concurrent.futures.ThreadPoolExecutor(12) as ex:
    for name, res, fl in ex.map(parse, names):
        resources[name] = res
        for k, v in fl.items():
            if k.startswith(name + ".") or k.startswith("segments.") or k.startswith("metrics."):
                fields[k] = v
print("recursos:", len(resources), "campos:", len(fields), file=sys.stderr)
compact = {k: ("S" if v["s"] else "") + ("F" if v["f"] else "") + ("O" if v["o"] else "") + ("R" if v["r"] else "") for k, v in fields.items()}
json.dump({"version": VERSION, "source": BASE, "legend": "S=selectable F=filterable O=sortable R=repeated",
           "resources": resources, "fields": compact}, open(sys.argv[1], "w"), separators=(",", ":"))
