// Isolated tests of the actual service-worker store, without browser policy changes.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const hashwasm = require(process.argv[2] || 'hash-wasm');
const entries = new Map();
const cache = {
  async match(k) { return entries.get(typeof k === 'string' ? k : k.url)?.clone(); },
  async put(k, v) { entries.set(k, v.clone()); },
  async delete(k) { return entries.delete(typeof k === 'string' ? k : k.url); },
  async keys() { return [...entries.keys()].map(url => ({url})); },
};
let upstream, downloads = 0;
const context = vm.createContext({ importScripts(){}, hashwasm, console, Request, Response, ReadableStream, URL, Uint8Array, Map,
  self:{location:{origin:'https://test.example',href:'https://test.example/repository-name/coi-serviceworker.js'},clients:{async matchAll(){return[];}}},
  caches:{async open(){return cache;}},
  async fetch(){downloads++;let i=0;return new Response(new ReadableStream({pull(c){if(i>=upstream.length){c.close();return;}const end=Math.min(upstream.length,i+703117);c.enqueue(upstream.subarray(i,end));i=end;}}));}
});
vm.runInContext(fs.readFileSync('dist/model-cache.js','utf8'), context);
async function run(code) { return vm.runInContext(code, context); }
(async()=>{
  // GitHub project Pages must stay within /repository-name/, including cache keys.
  assert.equal(await run("APP_BASE"), '/repository-name/');
  assert.equal(await run("isModelRequest(new Request(self.location.origin+MODEL_PREFIX+'config.json'))"), true);
  assert.equal(await run("isModelRequest(new Request('https://test.example/__models__/config.json'))"), false);
  assert.equal(await run("isModelRequest(new Request('https://test.example/another-repo/__models__/config.json'))"), false);
  assert.equal(await run("isModelRequest(new Request('https://other.example'+MODEL_PREFIX+'config.json'))"), false);
  assert.ok((await run("partKey('config.json',0)")).startsWith('https://test.example/repository-name/__model_parts__/'));
  // Exercise the production 50 MB boundary, not a reduced test constant.
  upstream = new Uint8Array(50_000_137); for(let i=0;i<upstream.length;i++)upstream[i]=i%251;
  const expected = await hashwasm.xxhash64(upstream);
  context.fixtureHash=expected;context.fixtureLength=upstream.length;
  await run("MODEL_FILES['onnx/vision_encoder.onnx']={bytes:fixtureLength,hash:fixtureHash}");
  const first = await run("modelResponse(new Request(self.location.origin+MODEL_PREFIX+'onnx/vision_encoder.onnx'))");
  assert.equal(first.status,200);assert.equal(await hashwasm.xxhash64(new Uint8Array(await first.arrayBuffer())),expected);
  const chunks=[...entries].filter(([k])=>!k.endsWith('/manifest'));
  assert.deepEqual(await Promise.all(chunks.map(async([,v])=>(await v.clone().arrayBuffer()).byteLength)),[50_000_000,137]);
  const second=await run("modelResponse(new Request(self.location.origin+MODEL_PREFIX+'onnx/vision_encoder.onnx'))");
  assert.equal(await hashwasm.xxhash64(new Uint8Array(await second.arrayBuffer())),expected);assert.equal(downloads,1);
  // A corrupt part must be detected, discarded and re-downloaded.
  const damaged=new Uint8Array(await entries.get(chunks[0][0]).clone().arrayBuffer());damaged[123]^=1;
  entries.set(chunks[0][0],new Response(damaged));
  const repaired=await run("modelResponse(new Request(self.location.origin+MODEL_PREFIX+'onnx/vision_encoder.onnx'))");
  assert.equal(repaired.status,200);assert.equal(await hashwasm.xxhash64(new Uint8Array(await repaired.arrayBuffer())),expected);assert.equal(downloads,2);
  // A bad upstream must never produce a completed manifest or a usable response.
  entries.clear();upstream[111]^=1;
  const bad=await run("modelResponse(new Request(self.location.origin+MODEL_PREFIX+'onnx/vision_encoder.onnx'))");
  assert.equal(bad.status,502);assert.equal(entries.size,0);
  console.log('PASS: GitHub Pages subpath; 50 MB split; byte-exact reconstruction; cache reuse; xxHash corruption repair; bad download rejected.');
})().catch(error=>{console.error(error);process.exitCode=1;});
