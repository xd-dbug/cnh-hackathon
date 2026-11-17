// Query embeddings. Same model and settings as worker/src/embed.js (api/test/worker-parity.test.js
// checks the constants), so query vectors live in the same space as the stored talk vectors.

export const MODEL = 'Xenova/bge-small-en-v1.5';
export const POOLING = 'cls';
export const DTYPE = 'fp32';
// BGE's recommended prefix for short queries. Calibrated: with it, nonsense queries peak at 0.57 and real ones start at 0.69.
export const QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';

let extractor;

/** Load the model on first use, so the API starts fast and only pays for it when someone searches. */
function load() {
  extractor ??= import('@huggingface/transformers')
    .then(({ pipeline }) => pipeline('feature-extraction', MODEL, { dtype: DTYPE }))
    .catch((e) => {
      extractor = undefined;
      throw e;
    });
  return extractor;
}

/**
 * @param {string} text a search query
 * @returns {Promise<number[]>} a normalised 384-number vector
 */
export async function embedQuery(text) {
  const model = await load();
  const out = await model(QUERY_PREFIX + text, { pooling: POOLING, normalize: true });
  return out.tolist()[0];
}
