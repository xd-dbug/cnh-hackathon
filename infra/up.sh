#!/usr/bin/env bash
# Rebuilds the local stack from nothing: kind, Postgres (CloudNativePG + pgvector), Grafana LGTM and
# the OTel Collector. Safe to re-run. Everything is self-hosted; no credentials leave the machine.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"
repo="$(cd .. && pwd)"

kind get clusters | grep -qx hackathon || kind create cluster --config kind.yaml --wait 180s
kubectl config use-context kind-hackathon

helm repo add cnpg https://cloudnative-pg.github.io/charts >/dev/null
helm repo add open-telemetry https://open-telemetry.github.io/opentelemetry-helm-charts >/dev/null
helm repo update cnpg open-telemetry >/dev/null

# Postgres: the operator, then the cluster, then the schema (contract/schema.sql is idempotent).
helm upgrade --install cnpg cnpg/cloudnative-pg --version 0.29.1 \
  -n cnpg-system --create-namespace --wait --timeout 5m
kubectl apply -f postgres.yaml
# The first run pulls a large Postgres image inside kind, hence the long wait.
until kubectl -n data get cluster clash-db >/dev/null 2>&1; do sleep 2; done
kubectl -n data wait cluster/clash-db --for=condition=Ready --timeout=10m
app_uri="$(kubectl -n data get secret clash-db-app -o jsonpath='{.data.uri}' | base64 -d)"
primary="$(kubectl -n data get cluster clash-db -o jsonpath='{.status.currentPrimary}')"
# Connect over the pod's loopback as the app user, so the schema is owned by `clash`, not postgres.
pod_uri="$(sed -E 's#@[^/]+/#@localhost:5432/#' <<<"$app_uri")"
kubectl -n data exec -i "$primary" -c postgres -- \
  psql "$pod_uri" -v ON_ERROR_STOP=1 -q -c 'SET client_min_messages = warning' -f - <"$repo/contract/schema.sql"

# Observability: LGTM first, so the Collector's exporter has somewhere to send.
kubectl apply -f lgtm.yaml
kubectl -n observability rollout status deployment/lgtm --timeout=5m
helm upgrade --install otel open-telemetry/opentelemetry-collector --version 0.178.2 \
  -n otel --create-namespace -f otel-collector-values.yaml --wait --timeout 5m

echo
kubectl get nodes
echo
echo "Postgres:       localhost:5433, database clash. Put this in your env file:"
echo "                DATABASE_URL=$(sed -E 's#@[^/]+/#@localhost:5433/#' <<<"$app_uri")"
echo "OTel Collector: localhost:4317 (gRPC), localhost:4318 (HTTP)"
echo "Grafana:        http://localhost:3000 (admin / admin)"
echo "Radar:          run 'kubectl radar', then open http://localhost:9280"
