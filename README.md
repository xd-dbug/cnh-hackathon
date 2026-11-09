# Conference Clash Resolver

## What it does

## Demo

## How it's built
- **Elasticsearch:** the only datastore; talk abstracts in a `semantic_text` field power similar-talk search.
- **Gitar:** reviews every agent PR against the shared contract and project rules.
- **Dash0:** receives the API's OpenTelemetry traces and metrics.
- Runs on kind with ECK and an OpenTelemetry Collector.

## Run it locally
1. `infra/up.sh`
2. `npm run ingest`, then `npm run dev:api` and `npm run dev:web`

## AI use
Built with Claude Code subagents, directed and reviewed by Damian Swiney.
