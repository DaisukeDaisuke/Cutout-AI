const REVISION = '5850ab45f587c112167512ffef949107115e26a0';
let lib, model, processor, loading;
let currentImage = null, embeddings = null, processed = null;
let runtime = '', threads = 1;
function report(message, progress) { self.postMessage({ type: 'status', message, progress }); }
async function initialize(forceCPU = false) {
  if (model) return;
  if (loading) return loading;
  loading = (async () => {
    report('切り抜きの準備中');
    lib = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.0');
    const { env, SamModel, AutoProcessor } = lib;
    env.allowLocalModels = false;
    env.useBrowserCache = false;
    env.useFSCache = false;
    env.remoteHost = new URL('./', self.location.href).href;
    env.remotePathTemplate = '__models__/{model}/resolve/{revision}/';
    // Use the exact ONNX Runtime build bundled with Transformers.js 3.5.0.
    env.backends.onnx.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.0/dist/';
    threads = self.crossOriginIsolated ? Math.max(1, Math.min(8, navigator.hardwareConcurrency || 2)) : 1;
    env.backends.onnx.wasm.numThreads = threads;
    env.backends.onnx.wasm.proxy = false;
    let gpu = false;
    if (!forceCPU && navigator.gpu) {
      try { gpu = !!(await navigator.gpu.requestAdapter()); } catch {}
    }
    const options = { revision: REVISION, dtype: 'fp32', device: gpu ? 'webgpu' : 'wasm', progress_callback: p => {
      if (p.status === 'progress') report('切り抜きの準備中', p.progress);
    } };
    processor = await AutoProcessor.from_pretrained('Xenova/slimsam-77-uniform', { revision: REVISION });
    try {
      model = await SamModel.from_pretrained('Xenova/slimsam-77-uniform', options);
      runtime = gpu ? 'WebGPU · FP32' : `CPU · ${threads} threads`;
    } catch (error) {
      if (!gpu) throw error;
      console.warn('WebGPU initialization failed; using threaded WASM.', error);
      report('別の方法で切り抜きを準備しています');
      model = await SamModel.from_pretrained('Xenova/slimsam-77-uniform', { ...options, device: 'wasm' });
      runtime = `CPU · ${threads} threads`;
    }
    self.postMessage({ type: 'runtime', runtime, isolated: self.crossOriginIsolated, threads });
  })();
  try { await loading; } finally { loading = null; }
}
async function clearEmbedding() {
  if (embeddings) for (const tensor of Object.values(embeddings)) tensor.dispose?.();
  embeddings = null; processed = null; currentImage = null;
}
async function segment(job) {
  await initialize();
  const { RawImage, Tensor } = lib;
  if (currentImage !== job.imageId) {
    await clearEmbedding();
    report('写真を切り抜いています');
    let raw = await RawImage.fromURL(job.url);
    if (Math.max(raw.width, raw.height) > 1024) {
      const scale = 1024 / Math.max(raw.width, raw.height);
      raw = await raw.resize(Math.round(raw.width * scale), Math.round(raw.height * scale));
    }
    processed = await processor(raw);
    try { embeddings = await model.get_image_embeddings(processed); }
    catch (error) {
      if (!runtime.startsWith('WebGPU')) throw error;
      console.warn('WebGPU execution failed; switching to WASM.', error);
      await model.dispose(); model = null;
      await initialize(true);
      embeddings = await model.get_image_embeddings(processed);
    }
    // Pixel tensor is no longer required after encoding.
    processed.pixel_values.dispose?.(); delete processed.pixel_values;
    currentImage = job.imageId;
  }
  report('仕上がりを更新しています');
  const shape = processed.reshaped_input_sizes[0];
  const coords = job.points.flatMap(p => [p.x * shape[1], p.y * shape[0]]);
  const labels = job.points.map(p => BigInt(p.label));
  const input_points = new Tensor('float32', coords, [1, 1, labels.length, 2]);
  const input_labels = new Tensor('int64', labels, [1, 1, labels.length]);
  let outputs;
  try { outputs = await model({ ...embeddings, input_points, input_labels }); }
  catch (error) {
    input_points.dispose?.(); input_labels.dispose?.();
    if (!runtime.startsWith('WebGPU')) throw error;
    console.warn('WebGPU mask decoding failed; switching to WASM.', error);
    await clearEmbedding(); await model.dispose(); model = null;
    await initialize(true);
    return segment(job);
  }
  const masks = await processor.post_process_masks(outputs.pred_masks, processed.original_sizes, processed.reshaped_input_sizes, { binarize: false });
  const tensor = masks[0];
  const height = tensor.dims.at(-2), width = tensor.dims.at(-1);
  const data = new Float32Array(tensor.data);
  const scores = Array.from(outputs.iou_scores.data);
  outputs.pred_masks.dispose?.(); outputs.iou_scores.dispose?.();
  input_points.dispose?.(); input_labels.dispose?.();
  self.postMessage({ type: 'result', requestId: job.requestId, width, height, masks: data, scores }, [data.buffer]);
}
// One queue prevents an encoder session from being overwritten by another image.
let queue = Promise.resolve();
self.onmessage = ({ data }) => {
  if (data.type !== 'segment') return;
  queue = queue.then(() => segment(data)).catch(error => {
    console.error(error);
    self.postMessage({ type: 'error', requestId: data.requestId, message: error.message || String(error) });
  });
};
