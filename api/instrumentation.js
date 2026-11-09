// Loaded with `node --import ./instrumentation.js` so it runs before server.js imports anything.
// Exports traces, metrics and logs over OTLP/HTTP to OTEL_EXPORTER_OTLP_ENDPOINT (the Collector, which holds the Dash0 token).
import { register } from 'node:module';
import { format } from 'node:util';
import { context, trace, logs, SeverityNumber } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { BatchSpanProcessor, SimpleSpanProcessor, ConsoleSpanExporter } from '@opentelemetry/sdk-trace';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { BatchLogRecordProcessor, SimpleLogRecordProcessor, ConsoleLogRecordExporter } from '@opentelemetry/sdk-logs';

// Lets OpenTelemetry patch ES-module imports as well as require().
register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);

process.env.OTEL_SERVICE_NAME ||= 'clash-resolver-api';

const logger = logs.getLogger('clash-resolver-api');

/** Parse the query string of a request url. @param {string} url */
const queryOf = (url) => new URL(url, 'http://localhost').searchParams;

/**
 * Product-level attributes for a request, derived from the request and the JSON response body.
 * @param {import('node:http').IncomingMessage & {body?: any}} request
 * @param {any} body parsed JSON response body (200 responses only)
 * @returns {Record<string, string | number | boolean>}
 */
function productAttributes(request, body) {
  const attrs = {};
  const path = (request.url || '').split('?')[0];
  const query = queryOf(request.url || '/');
  if (request.method === 'GET' && path === '/talks') {
    if (Array.isArray(body?.talks)) attrs['talks.count'] = body.talks.length;
    if (query.get('q')) attrs['search.query'] = query.get('q');
    if (query.get('day')) attrs['search.day'] = query.get('day');
  } else if (request.method === 'POST' && path === '/clashes') {
    if (Array.isArray(body?.clashes)) attrs['clashes.count'] = body.clashes.length;
    if (Array.isArray(request.body?.starred)) attrs['starred.count'] = request.body.starred.length;
  } else if (request.method === 'GET' && path === '/alternatives') {
    if (Array.isArray(body?.alternatives)) attrs['alternatives.count'] = body.alternatives.length;
    if (query.get('level')) attrs['alternatives.level'] = query.get('level');
    if (query.get('accessible')) attrs['alternatives.accessible'] = query.get('accessible') === 'true';
  }
  return attrs;
}

/**
 * Wraps res.end so that, once the response is complete, the HTTP server span gets the product attributes
 * and one structured access log record is emitted (correlated to the span). OPTIONS preflights are skipped.
 * Done here (not in server.js): the body is only visible at res.end, before the span ends.
 * @param {import('@opentelemetry/api').Span} span
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:http').ServerResponse} response
 */
function observeRequest(span, request, response) {
  if (request.method === 'OPTIONS') return;
  const startedAt = Date.now();
  const end = response.end;
  response.end = function patchedEnd(chunk, ...args) {
    try {
      let body;
      if (response.statusCode === 200 && chunk && typeof chunk !== 'function') {
        try {
          body = JSON.parse(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
        } catch {
          // not JSON
        }
      }
      const product = productAttributes(request, body);
      span.setAttributes(product);
      const status = response.statusCode;
      const durationMs = Date.now() - startedAt;
      const path = (request.url || '').split('?')[0];
      const route = request.route?.path; // low-cardinality template; absent for unmatched requests
      logger.emit({
        severityNumber: status >= 500 ? SeverityNumber.ERROR : status >= 400 ? SeverityNumber.WARN : SeverityNumber.INFO,
        severityText: status >= 500 ? 'ERROR' : status >= 400 ? 'WARN' : 'INFO',
        body: `${request.method} ${route ?? path} ${status} in ${durationMs} ms`,
        context: trace.setSpan(context.active(), span),
        attributes: {
          ...(route ? { 'http.route': route } : {}),
          'url.path': path,
          'http.request.method': request.method,
          'http.response.status_code': status,
          duration_ms: durationMs,
          ...product,
        },
      });
    } catch {
      // never let telemetry break a response
    }
    return end.call(this, chunk, ...args);
  };
}

const CONSOLE_LEVELS = {
  log: [SeverityNumber.INFO, 'INFO'],
  info: [SeverityNumber.INFO, 'INFO'],
  warn: [SeverityNumber.WARN, 'WARN'],
  error: [SeverityNumber.ERROR, 'ERROR'],
};

/** Bridge console.* to OTel logs: still prints to stdout/stderr, and also emits a log record. */
function bridgeConsole() {
  let emitting = false; // recursion guard
  for (const [method, [severityNumber, severityText]] of Object.entries(CONSOLE_LEVELS)) {
    const original = console[method].bind(console);
    console[method] = (...args) => {
      original(...args);
      if (emitting) return;
      emitting = true;
      try {
        const err = args.find((a) => a instanceof Error);
        logger.emit({
          severityNumber,
          severityText,
          body: format(...args),
          attributes: err ? { 'exception.type': err.name, 'exception.message': err.message, 'exception.stacktrace': err.stack } : {},
        });
      } catch {
        // never let telemetry break the app
      } finally {
        emitting = false;
      }
    };
  }
}

const spanProcessors = [new BatchSpanProcessor({ exporter: new OTLPTraceExporter() })];
// Debug aid: OTEL_CONSOLE_SPANS=1 also prints spans to stdout.
if (process.env.OTEL_CONSOLE_SPANS) spanProcessors.push(new SimpleSpanProcessor({ exporter: new ConsoleSpanExporter() }));

const logRecordProcessors = [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter() })];
// Debug aid: OTEL_CONSOLE_LOGS=1 also prints log records to stdout.
if (process.env.OTEL_CONSOLE_LOGS) logRecordProcessors.push(new SimpleLogRecordProcessor({ exporter: new ConsoleLogRecordExporter() }));

const sdk = new NodeSDK({
  spanProcessors,
  logRecordProcessors,
  metricReaders: [new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter() })],
  instrumentations: [
    getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-fs': { enabled: false },
      '@opentelemetry/instrumentation-http': {
        responseHook: (span, response) => {
          const request = response.req;
          if (request) observeRequest(span, request, response);
        },
      },
    }),
  ],
});
sdk.start();
bridgeConsole();

// Flush buffered spans/metrics on Ctrl+C (SIGINT) and SIGTERM.
for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => sdk.shutdown().finally(() => process.exit(0)));
