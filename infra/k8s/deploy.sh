#!/usr/bin/env bash
# Builds the api and web images from the current checkout, loads them into the kind cluster and
# (re)deploys them in namespace `clash`. Safe to re-run: each run tags images with the git commit,
# so the Deployments roll to the new build. Run infra/up.sh first (kind + Collector).
set -euo pipefail
repo="$(cd "$(dirname "$(readlink -f "$0")")/../.." && pwd)"
cd "$repo"
env_dir="${CNH_ENV_DIR:-/home/xd/hackathon-env}"
cluster=hackathon

tag="$(git rev-parse --short HEAD)$(git diff --quiet HEAD -- api web contract || echo "-dirty$(date +%s)")"
docker build -q -f infra/k8s/Dockerfile.api -t "clash-api:$tag" .
docker build -q -f infra/k8s/Dockerfile.web -t "clash-web:$tag" .
kind load docker-image --name "$cluster" "clash-api:$tag" "clash-web:$tag"

kubectl config use-context "kind-$cluster" >/dev/null
kubectl create namespace clash --dry-run=client -o yaml | kubectl apply -f -

# Elasticsearch credentials: only ES_URL and ES_API_KEY, read from the env file outside the repo.
es_env="$(grep -E '^ES_(URL|API_KEY)=' "$env_dir/.env")"
kubectl -n clash create secret generic clash-es --from-env-file=<(printf '%s\n' "$es_env") \
  --dry-run=client -o yaml | kubectl apply -f -
es_hash="$(printf '%s' "$es_env" | sha256sum | cut -c1-12)"

sed -e "s/:TAG$/:$tag/" -e "s/ES_SECRET_HASH/\"$es_hash\"/" infra/k8s/app.yaml | kubectl apply -f -
kubectl -n clash rollout status deployment/api --timeout=120s
kubectl -n clash rollout status deployment/web --timeout=120s

echo
kubectl -n clash get pods -o wide
echo
echo "Deployed clash-api:$tag and clash-web:$tag."
echo "Open the app:  kubectl -n clash port-forward svc/web 8080:80   →  http://localhost:8080"
echo "Radar:         kubectl radar   →  http://localhost:9280 (namespace clash)"
