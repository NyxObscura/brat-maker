// src/imageWorker.js
// Dijalankan sebagai Worker Thread terpisah oleh WorkerPool di server.js.

import { parentPort } from 'worker_threads';
import { generateBratImage } from './imageGenerator.js';

parentPort.on('message', async (params) => {
  try {
    const buffer = await generateBratImage(params);

    // FIX: @napi-rs/canvas encode() return Node.js Buffer yang mungkin
    // punya byteOffset != 0 (sliced dari shared memory pool).
    // ArrayBuffer dari Buffer seperti itu TIDAK transferable → error
    // "Cannot transfer object of unsupported type".
    //
    // Solusi: copy ke ArrayBuffer baru yang bersih (owned, offset = 0).
    const arrayBuffer = buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength,
    );

    parentPort.postMessage(
      { ok: true, buffer: arrayBuffer },
      [arrayBuffer], // Transfer ownership (zero-copy ke main thread)
    );
  } catch (err) {
    parentPort.postMessage({
      ok:    false,
      error: err?.message || 'Unknown worker error',
    });
  }
});
