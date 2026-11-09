#!/usr/bin/env bash
# Rebuilds the local hackathon stack from nothing. Safe to re-run.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"

# Secrets live outside the repo: dash0.env is read from here. The app's .env also lives here and is
# maintained by hand (Elasticsearch runs on Elastic Cloud, so this script never writes it).
env_dir="${CNH_ENV_DIR:-/home/xd/hackathon-env}"

kind get clusters | grep -qx hackathon || kind create cluster --config kind.yaml --wait 180s
kubectl config use-context kind-hackathon

helm repo add open-telemetry https://open-telemetry.github.io/opentelemetry-helm-charts >/dev/null
helm repo update open-telemetry >/dev/null

# Load Dash0 settings from dash0.env when they aren't already in the environment.
if [[ -z "${DASH0_ENDPOINT:-}" || -z "${DASH0_AUTH_TOKEN:-}" ]] && [[ -f "$env_dir/dash0.env" ]]; then
  set -a; source "$env_dir/dash0.env"; set +a
fi
if [[ -n "${DASH0_ENDPOINT:-}" && -n "${DASH0_AUTH_TOKEN:-}" ]]; then
  kubectl create namespace otel --dry-run=client -o yaml | kubectl apply -f -
  kubectl -n otel create secret generic dash0-credentials \
    --from-literal=endpoint="$DASH0_ENDPOINT" --from-literal=token="$DASH0_AUTH_TOKEN" \
    --dry-run=client -o yaml | kubectl apply -f -
  helm upgrade --install otel open-telemetry/opentelemetry-collector --version 0.178.2 \
    -n otel -f otel-collector-values.yaml --wait --timeout 5m
  otel_status="deployed (OTLP localhost:4317 gRPC, localhost:4318 HTTP)"
else
  otel_status="SKIPPED: set DASH0_ENDPOINT and DASH0_AUTH_TOKEN or create $env_dir/dash0.env, then re-run"
fi

echo
kubectl get nodes
echo
echo "Elasticsearch: Elastic Cloud (connection settings in $env_dir/.env)"
echo "OTel Collector: $otel_status"
echo "Radar:         run 'kubectl radar', then open http://localhost:9280"

