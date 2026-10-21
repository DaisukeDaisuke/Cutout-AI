/* Service-worker model store. 50 MB means 50,000,000 bytes (decimal). */
importScripts('https://cdn.jsdelivr.net/npm/hash-wasm@4.12.0/dist/xxhash64.umd.min.js');
const MODEL_CACHE = 'kirinuki-model-parts-v2';
const MODEL_REVISION = '5850ab45f587c112167512ffef949107115e26a0';
const APP_BASE = new URL('./', self.location.href).pathname;
const MODEL_ROUTE = `${APP_BASE}__models__/`;
const MODEL_PREFIX = `${MODEL_ROUTE}Xenova/slimsam-77-uniform/resolve/${MODEL_REVISION}/`;
const PART_BYTES = 50_000_000;
const MODEL_FILES = {
  'onnx/vision_encoder.onnx': { bytes: 23276014, hash: '66ab8e4a5a44439c' },
  'onnx/prompt_encoder_mask_decoder.onnx': { bytes: 16557892, hash: 'cc11b9de008291cb' },
  'config.json': null,
  'preprocessor_config.json': null,
};
const MODEL_SOURCES = [
  {prefix:MODEL_PREFIX,files:MODEL_FILES},
  {prefix:`${MODEL_ROUTE}imgly/isnet-general-onnx/resolve/440dea96dd4a3b06bbbf5abec3e26569dd7ec49f/`,files:{
    'onnx/model.onnx':{bytes:176149806,hash:'5def2979ea4340f0'},
    'config.json':null,
  }},
];
const inFlight = new Map();
function isModelRequest(request) {
  const url = new URL(request.url);
  return url.origin === self.location.origin && url.pathname.startsWith(MODEL_ROUTE);
}
async function cacheNotice(phase, file, loaded = 0, total = 0) {
  const clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
  for (const client of clients) client.postMessage({ type: 'model-cache', phase, file, loaded, total });
}
function partKey(path, part) { return `${self.location.origin}${APP_BASE}__model_parts__/${encodeURIComponent(path)}/${part}`; }
async function removeModel(cache, path) {
  const prefix = partKey(path, '');
  for (const key of await cache.keys()) if (key.url.startsWith(prefix)) await cache.delete(key);
}
async function inspectCache(cache, path, spec) {
  const response = await cache.match(partKey(path, 'manifest'));
  if (!response) return null;
  try {
    const manifest = await response.json();
    if (!Number.isInteger(manifest.parts) || manifest.parts < 1 || manifest.parts > 100 || manifest.partBytes !== PART_BYTES) throw Error('Invalid manifest');
    if (spec && (manifest.total !== spec.bytes || manifest.hash !== spec.hash)) throw Error('Model version mismatch');
    const hasher = await hashwasm.createXXHash64();
    hasher.init();
    let total = 0;
    await cacheNotice('verify', path, 0, manifest.total);
    for (let i = 0; i < manifest.parts; i++) {
      const part = await cache.match(partKey(path, i));
      if (!part) throw Error('Missing model part');
      const data = new Uint8Array(await part.arrayBuffer());
      if (data.length > PART_BYTES || (i < manifest.parts - 1 && data.length !== PART_BYTES)) throw Error('Invalid model part size');
      hasher.update(data);
      total += data.length;
    }
    if (total !== manifest.total || hasher.digest() !== (spec?.hash ?? manifest.hash)) throw Error('xxHash64 mismatch');
    await cacheNotice('verified', path, total, total);
    return manifest;
  } catch (error) {
    console.warn('Invalid cached model; downloading a fresh copy:', path, error.message);
    await removeModel(cache, path);
    await cacheNotice('repair', path);
    return null;
  }
}
async function downloadModel(cache, path, spec) {
  await removeModel(cache, path);
  const upstream = `https://huggingface.co/${path}`;
  const abort=new AbortController();let timer;
  const renew=()=>{clearTimeout(timer);timer=setTimeout(()=>abort.abort(),45000);};
  renew();
  let response;
  try{response=await fetch(upstream,{mode:'cors',credentials:'omit',signal:abort.signal});}
  catch(error){clearTimeout(timer);throw error;}
  clearTimeout(timer);
  if (!response.ok || !response.body) throw Error(`モデルの取得に失敗しました (HTTP ${response.status})`);
  const hasher = await hashwasm.createXXHash64();
  hasher.init();
  const reader = response.body.getReader();
  const expected = spec?.bytes || Number(response.headers.get('content-length')) || 0;
  let buffer = new Uint8Array(Math.min(PART_BYTES, Math.max(expected || 65536, 65536)));
  let offset = 0, parts = 0, total = 0, lastNotice = 0;
  try {
    for (;;) {
      renew();
      const { done, value } = await reader.read();
      clearTimeout(timer);
      if (done) break;
      hasher.update(value);
      total += value.byteLength;
      if (spec && total > spec.bytes) throw Error('モデルのサイズが一致しません');
      let position = 0;
      while (position < value.length) {
        if (offset === buffer.length && buffer.length < PART_BYTES) {
          const larger = new Uint8Array(Math.min(PART_BYTES, Math.max(buffer.length * 2, offset + value.length - position)));
          larger.set(buffer); buffer = larger;
        }
        const count = Math.min(buffer.length - offset, value.length - position);
        buffer.set(value.subarray(position, position + count), offset);
        offset += count; position += count;
        if (offset === PART_BYTES) {
          await cache.put(partKey(path, parts++), new Response(buffer));
          buffer = new Uint8Array(PART_BYTES); offset = 0;
        }
      }
      if (Date.now() - lastNotice > 200) {
        await cacheNotice('download', path, total, expected); lastNotice = Date.now();
      }
    }
    if (offset) await cache.put(partKey(path, parts++), new Response(buffer.subarray(0, offset)));
    const hash = hasher.digest();
    if (!total || (spec && (total !== spec.bytes || hash !== spec.hash))) throw Error('モデルのxxHash64検証に失敗しました');
    const manifest = { parts, total, hash, partBytes: PART_BYTES };
    // Publish completion last; an interrupted download is never considered valid.
    await cache.put(partKey(path, 'manifest'), new Response(JSON.stringify(manifest), { headers: { 'Content-Type': 'application/json' } }));
    await cacheNotice('verified', path, total, total);
    return manifest;
  } catch (error) {
    await reader.cancel().catch(() => {});
    await removeModel(cache, path);
    throw error;
  } finally {clearTimeout(timer);}
}
async function modelResponse(request) {
  const pathname = new URL(request.url).pathname;
  const source=MODEL_SOURCES.find(s=>pathname.startsWith(s.prefix));
  const file=source&&pathname.slice(source.prefix.length);
  if (!source || !Object.hasOwn(source.files, file) || request.method !== 'GET') return new Response('Unknown model file', { status: 404 });
  const path=pathname.slice(MODEL_ROUTE.length),spec=source.files[file];
  const cache = await caches.open(MODEL_CACHE);
  if (!inFlight.has(path)) {
    const prepare = (async () => await inspectCache(cache, path, spec) || await downloadModel(cache, path, spec))();
    inFlight.set(path, prepare);
    prepare.finally(() => inFlight.delete(path)).catch(() => {});
  }
  try {
    const manifest = await inFlight.get(path);
    let index = 0;
    const stream = new ReadableStream({
      async pull(controller) {
        try {
          if (index === manifest.parts) { controller.close(); return; }
          const part = await cache.match(partKey(path, index++));
          if (!part) throw Error('キャッシュが失われました。再試行してください。');
          controller.enqueue(new Uint8Array(await part.arrayBuffer()));
        } catch (error) { controller.error(error); }
      }
    });
    return new Response(stream, { headers: { 'Content-Length': String(manifest.total), 'Content-Type': path.endsWith('.json') ? 'application/json' : 'application/octet-stream', 'X-Model-XXHash64': manifest.hash, 'Cache-Control': 'no-store' } });
  } catch (error) {
    await cacheNotice('error', error.message);
    return new Response(error.message, { status: 502 });
  }
}
