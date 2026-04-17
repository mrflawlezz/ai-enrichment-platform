import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

/**
 * Initialize OpenTelemetry SDK.
 *
 * IMPORTANT: This must be called BEFORE any other imports that use tracing.
 * In `index.ts`, import this module first:
 *   import './telemetry/otel';
 *
 * Exports:
 *   - Traces → OTLP endpoint (Jaeger, Grafana Tempo, Honeycomb, Datadog)
 *   - Metrics → Prometheus scrape endpoint on :9464
 */

const resource = resourceFromAttributes({
  [ATTR_SERVICE_NAME]: 'ai-enrichment-platform',
  [ATTR_SERVICE_VERSION]: '1.0.0',
  'deployment.environment': process.env.NODE_ENV ?? 'development',
});

// ─── Trace exporter → OTLP (configurable endpoint) ───────────────────────────
const traceExporter = new OTLPTraceExporter({
  url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318/v1/traces',
  headers: process.env.OTEL_EXPORTER_OTLP_HEADERS
    ? JSON.parse(process.env.OTEL_EXPORTER_OTLP_HEADERS)
    : {},
});

// ─── Metrics → Prometheus scrape endpoint ────────────────────────────────────
export const prometheusExporter = new PrometheusExporter(
  { port: 9464, endpoint: '/metrics' },
  () => {
    console.log(JSON.stringify({
      level: 'info',
      message: 'Prometheus metrics available at :9464/metrics',
      timestamp: new Date().toISOString(),
    }));
  }
);

// ─── SDK init ─────────────────────────────────────────────────────────────────
const sdk = new NodeSDK({
  resource,
  traceExporter,
  instrumentations: [
    getNodeAutoInstrumentations({
      // Auto-instruments: HTTP, Express, pg, ioredis
      '@opentelemetry/instrumentation-fs': { enabled: false }, // too noisy
    }),
  ],
});

sdk.start();

// Graceful shutdown
process.on('SIGTERM', () => {
  sdk.shutdown().catch(console.error);
});

export { sdk };
