// Loaded with `node --import ./instrumentation.js` so it runs before server.js imports anything.
// Exports traces and metrics over OTLP/HTTP to OTEL_EXPORTER_OTLP_ENDPOINT (the Collector, which holds the Dash0 token).
import { register } from 'node:module';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { BatchSpanProcessor, SimpleSpanProcessor, ConsoleSpanExporter } from '@opentelemetry/sdk-trace';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';

// Lets OpenTelemetry patch ES-module imports as well as require().
register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);

process.env.OTEL_SERVICE_NAME ||= 'clash-resolver-api';

/**
 * Sets `alternatives.count` on the HTTP server span of GET /alternatives, from the JSON response body.
 * Done here (not in server.js): wrap res.end for that route so the body is seen before the span ends.
 * @param {import('@opentelemetry/api').Span} span
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:http').ServerResponse} response
 */
function countAlternatives(span, request, response) {
  if (request.method !== 'GET' || !request.url?.startsWith('/alternatives')) return;
  const end = response.end;
  response.end = function patchedEnd(chunk, ...args) {
    try {
      if (response.statusCode === 200 && chunk) {
        const body = JSON.parse(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
        if (Array.isArray(body.alternatives)) span.setAttribute('alternatives.count', body.alternatives.length);
      }
    } catch {
      // never let telemetry break a response
    }
    return end.call(this, chunk, ...args);
  };
}

const spanProcessors = [new BatchSpanProcessor({ exporter: new OTLPTraceExporter() })];
// Debug aid: OTEL_CONSOLE_SPANS=1 also prints spans to stdout.
if (process.env.OTEL_CONSOLE_SPANS) spanProcessors.push(new SimpleSpanProcessor({ exporter: new ConsoleSpanExporter() }));

const sdk = new NodeSDK({
  spanProcessors,
  metricReaders: [new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter() })],
  instrumentations: [
    getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-fs': { enabled: false },
      '@opentelemetry/instrumentation-http': {
        responseHook: (span, response) => {
          const request = response.req;
          if (request) countAlternatives(span, request, response);
        },
      },
    }),
  ],
});
sdk.start();

// Flush buffered spans/metrics on Ctrl+C (SIGINT) and SIGTERM.
for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => sdk.shutdown().finally(() => process.exit(0)));
