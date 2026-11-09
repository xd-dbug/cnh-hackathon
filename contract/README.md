Owned by D (human). Agents read `mapping.json` and `examples/*.json` but never edit them.
These are the rules the JSON can't express.

## Examples
Each example is the exact response shape for one request:

| File | Request |
|---|---|
| `talks.json` | `GET /talks?day=2026-11-10` (excerpt: the real response has 100 talks) |
| `clashes.json` | `POST /clashes` with `{"starred":["1233585","1246200"]}` |
| `alternatives.json` | `GET /alternatives?talk=1246200&starred=1246200,1233585` |
| `error.json` | The body of every 400 and 404 |

## Rules
- Times are always `YYYY-MM-DDTHH:mm:ss-07:00`, and day filters use `-07:00` boundaries.
- A talk ID is a string of digits (`^\d+$`).
- `day` is `YYYY-MM-DD`. Any other format returns 400.
- `/talks` has no pagination. Use `size: 400`, and cap searches with `q` at 50.
- Without `q`, sort by `start`, then `id`. With `q`, sort by relevance.
- Missing strings are omitted and missing arrays are `[]`. `level` may be absent (see `1335605`
  in `talks.json`); clients must handle that.
- Each clash pair appears once, with `a` starting first (`id` breaks ties). Sort pairs by
  `a.start`, then `a.id`, then `b.id`.
- An empty or missing `starred` returns `{"clashes": []}`.
- `/alternatives` returns at most 5 talks, sorted by `score` descending. No matches is
  `{"alternatives": []}`, not 404.
- A malformed ID returns 400, and an unknown `talk` returns 404. Ignore unknown IDs in `starred`
  so stale localStorage can't break the page.
- `score` is only for ranking, so don't display it as a percentage.
