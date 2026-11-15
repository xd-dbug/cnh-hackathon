// bge-small-en-v1.5 embeddings (384 dimensions) via @huggingface/transformers, on CPU.
// The API must embed search queries the same way: same model, CLS pooling, normalised.

export const MODEL = 'Xenova/bge-small-en-v1.5';
export const DIMENSIONS = 384;
export const POOLING = 'cls'; // what BGE models are trained with
export const BATCH_SIZE = 16;

let extractor;

/** Load the model once. The first run downloads it from Hugging Face, which can take a while. */
async function load(log) {
  if (!extractor) {
    log(`Loading ${MODEL} (the first run downloads the model; this can take a minute)...`);
    const t = Date.now();
    const { pipeline } = await import('@huggingface/transformers');
    let lastPct = -10;
    extractor = await pipeline('feature-extraction', MODEL, {
      dtype: 'fp32',
      progress_callback: (p) => {
        if (p.status === 'progress' && p.progress >= lastPct + 10) {
          lastPct = Math.floor(p.progress / 10) * 10;
          log(`  downloading ${p.file}: ${lastPct}%`);
        } else if (p.status === 'done') {
          lastPct = -10;
        }
      },
    });
    log(`Model ready in ${((Date.now() - t) / 1000).toFixed(1)}s`);
  }
  return extractor;
}

/**
 * The text that gets embedded.
 * @param {{title: string, abstract?: string}} talk
 * @returns {string}
 */
export function embeddingText(talk) {
  return talk.abstract ? `${talk.title}\n\n${talk.abstract}` : talk.title;
}

/**
 * Embed texts in batches. Vectors are normalised, so cosine similarity is a dot product.
 * @param {string[]} texts
 * @param {{batchSize?: number, log?: (msg: string) => void}} [opts]
 * @returns {Promise<number[][]>} one 384-number vector per text, in order
 */
export async function embedTexts(texts, { batchSize = BATCH_SIZE, log = console.log } = {}) {
  const model = await load(log);
  const out = [];
  const t0 = Date.now();
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const tensor = await model(batch, { pooling: POOLING, normalize: true });
    out.push(...tensor.tolist());
    const done = Math.min(i + batchSize, texts.length);
    log(`Embedded ${done}/${texts.length} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  }
  return out;
}
