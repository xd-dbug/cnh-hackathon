// Dash0 dashboard "Clash Resolver: Site Health" for service clash-resolver-api, as code (Perses format).
// `node site-health.mjs` prints the dashboard JSON; `--queries` prints each PromQL query. Apply with ./apply.sh.
const svc = 'service_name="clash-resolver-api"';
const srv = `{otel_metric_name="http.server.request.duration",${svc},http_route!=""}`;
const srv5 = `{otel_metric_name="http.server.request.duration",${svc},http_route!="",http_response_status_code=~"5.."}`;
const srv4 = `{otel_metric_name="http.server.request.duration",${svc},http_route!="",http_response_status_code=~"4.."}`;
const es = `{otel_metric_name="http.client.request.duration",${svc},server_address=~".*elastic.cloud"}`;
const m = (name) => `{otel_metric_name="${name}",${svc}}`;

const panels = {
  rpm:      stat('Requests / min', 'All API routes, last 5 min', `sum(rate(${srv}[5m])) * 60`, 'decimal'),
  err:      stat('5xx error rate', 'Share of requests that failed on the server, last 5 min',
                 `(sum(rate(${srv5}[5m])) or vector(0)) / sum(rate(${srv}[5m]))`, 'percent-decimal'),
  p95:      stat('p95 latency', 'All API routes, last 5 min', `histogram_quantile(0.95, sum(rate(${srv}[5m])))`, 'seconds'),
  esp95:    stat('Elasticsearch p95', 'Calls from the API to Elastic Cloud, last 5 min',
                 `histogram_quantile(0.95, sum(rate(${es}[5m])))`, 'seconds'),
  loop:     stat('Event loop delay p99', 'Node.js; above ~100 ms the API is CPU-bound',
                 `max(${m('nodejs.eventloop.delay.p99')})`, 'seconds'),
  rate:     series('Requests / min by route', `sum by (http_route) (rate(${srv}[5m])) * 60`, 'decimal'),
  errors:   series('Errors / min by route and status', [
              [`sum by (http_route, http_response_status_code) (rate(${srv5}[5m])) * 60`],
              [`sum by (http_route, http_response_status_code) (rate(${srv4}[5m])) * 60`]], 'decimal',
              '5xx = API or Elasticsearch failure. 4xx = bad input (expected in small numbers).'),
  latency:  series('Latency by route (p50, p95)', [
              [`histogram_quantile(0.50, sum by (http_route) (rate(${srv}[5m])))`, 'p50 {{http_route}}'],
              [`histogram_quantile(0.95, sum by (http_route) (rate(${srv}[5m])))`, 'p95 {{http_route}}']], 'seconds'),
  es:       series('Elasticsearch calls (p95 latency)', `histogram_quantile(0.95, sum(rate(${es}[5m])))`, 'seconds',
              'Semantic search runs on Elastic Inference Service, so this dominates /alternatives latency.'),
  escalls:  series('Elasticsearch calls / min', `sum by (http_response_status_code) (rate(${es}[5m])) * 60`, 'decimal'),
  loopts:   series('Event loop delay (p50, p99)', [
              [`max(${m('nodejs.eventloop.delay.p50')})`, 'p50'], [`max(${m('nodejs.eventloop.delay.p99')})`, 'p99']], 'seconds'),
  util:     series('Event loop utilization', `max(${m('nodejs.eventloop.utilization')})`, 'percent-decimal'),
  heap:     series('Heap used', `sum(${m('v8js.memory.heap.used')})`, 'bytes'),
};

function q(query, seriesNameFormat) {
  return { kind: 'TimeSeriesQuery', spec: { plugin: { kind: 'PrometheusTimeSeriesQuery',
    spec: { query, ...(seriesNameFormat && { seriesNameFormat }) } } } };
}
function stat(name, description, query, unit) {
  return { kind: 'Panel', spec: { display: { name, description },
    plugin: { kind: 'StatChart', spec: { calculation: 'last-number', format: { unit } } }, queries: [q(query)] } };
}
function series(name, queries, unit, description) {
  const list = typeof queries === 'string' ? [[queries]] : queries;
  return { kind: 'Panel', spec: { display: { name, ...(description && { description }) },
    plugin: { kind: 'TimeSeriesChart', spec: { legend: { position: 'bottom' }, yAxis: { format: { unit } } } },
    queries: list.map(([qq, f]) => q(qq, f)) } };
}
const ref = (id) => ({ $ref: `#/spec/panels/${id}` });
function grid(title, rows) {
  const items = []; let y = 0;
  for (const row of rows) { const w = 24 / row.length; const h = row.h ?? 8;
    row.forEach((id, i) => items.push({ x: i * w, y, width: w, height: h, content: ref(id) })); y += h; }
  return { kind: 'Grid', spec: { display: { title, collapse: { open: true } }, items } };
}
const glance = ['rpm', 'err', 'p95', 'esp95', 'loop']; // 5 tiles don't divide 24 evenly; lay out by hand
const glanceGrid = { kind: 'Grid', spec: { display: { title: 'Health at a glance', collapse: { open: true } },
  items: glance.map((id, i) => ({ x: [0, 5, 10, 15, 20][i], y: 0, width: i < 4 ? 5 : 4, height: 4, content: ref(id) })) } };

const dashboard = {
  kind: 'Dashboard',
  metadata: { name: 'clash-resolver-site-health' },
  spec: {
    display: { name: 'Clash Resolver: Site Health',
      description: 'Is the Conference Clash Resolver API healthy? Traffic, errors, latency, Elasticsearch and Node runtime for service clash-resolver-api.' },
    duration: '1h', refreshInterval: '30s', variables: [], panels,
    layouts: [glanceGrid,
      grid('Traffic and errors', [['rate', 'errors']]),
      grid('Latency', [['latency', 'es'], ['escalls']]),
      grid('Node.js runtime', [['loopts', 'util', 'heap']])],
  },
};
if (process.argv.includes('--queries')) {
  for (const p of Object.values(panels)) for (const qq of p.spec.queries) console.log(qq.spec.plugin.spec.query);
} else console.log(JSON.stringify(dashboard, null, 2));
