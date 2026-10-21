const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const {createCanvas,Image}=require(process.argv[2] || '@napi-rs/canvas');
function el(tag='div'){
 const e=tag==='canvas'?createCanvas(1,1):{};
 Object.assign(e,{style:{},children:[],hidden:false,disabled:false,value:'0',clientWidth:500,clientHeight:360,attrs:{},listeners:{},capture:null,
 append(...v){this.children.push(...v);},replaceChildren(...v){this.children=[...v];},setAttribute(k,v){this.attrs[k]=v;},removeAttribute(k){delete this.attrs[k];},addEventListener(k,fn){this.listeners[k]=fn;},classList:{add(){},remove(){}},
 getBoundingClientRect(){return {left:10,top:20,width:400,height:300};},setPointerCapture(id){this.capture=id;},hasPointerCapture(id){return this.capture===id;},releasePointerCapture(){this.capture=null;},focus(){}});
 if(tag==='canvas')e.toBlob=fn=>fn(new Blob([e.toBuffer('image/png')],{type:'image/png'}));
 return e;
}
const html=fs.readFileSync(require('node:path').join(__dirname,'dist/index.html'),'utf8');
const nodes=Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map(m=>[m[1],el(['canvas','result','stroke-overlay'].includes(m[1])?'canvas':'div')]));
nodes.feather.value='1';nodes.threshold.value='0';
const sent=[],workers=[],timers=new Map();let timerId=0;
class MockWorker {constructor(){workers.push(this);}postMessage(job){sent.push(structuredClone(job));}terminate(){this.terminated=true;}}
const ctx=vm.createContext({console,Uint8Array,Float32Array,Map,Blob,URL,Request,Response,ReadableStream,
 document:{getElementById:id=>{assert.ok(nodes[id],'Missing DOM id: '+id);return nodes[id];},createElement:el,querySelectorAll:()=>[],addEventListener(){},body:el()},
 navigator:{},isSecureContext:false,devicePixelRatio:1,Image:class{constructor(){return el('img');}},Worker:MockWorker,ResizeObserver:class{observe(){}},
 window:el(),requestAnimationFrame:()=>1,setTimeout(fn){timers.set(++timerId,fn);return timerId;},clearTimeout(id){timers.delete(id);},sessionStorage:{getItem(){return null;}},location:{reload(){}}});
vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'dist/app.js'),'utf8'),ctx);
const run=code=>vm.runInContext(code,ctx);
ctx.fixture=createCanvas(8,8);const fx=ctx.fixture.getContext('2d');fx.fillStyle='#e05040';fx.fillRect(0,0,8,8);
run("images.push({id:'test',name:'test.png',url:'fixture',img:fixture,width:8,height:8,selected:true,objects:[],objectId:null,nextObject:1,history:[],feather:0,threshold:0,crop:false,mask:null,bounds:null,version:0});selectImage('test');bootReady=true;engineError='';");
function result(rect){
 const job=sent.at(-1),data=new Float32Array(8*8*3).fill(-8);
 for(let c=0;c<3;c++)for(let y=rect[1];y<rect[3];y++)for(let x=rect[0];x<rect[2];x++)data[c*64+y*8+x]=8;
 ctx.reply={type:'result',requestId:job.requestId,width:8,height:8,masks:data,scores:[.9,.5,.3]};
 run('worker.onmessage({data:reply})');
}
function pointer(type,x,y,extra={}){
 nodes.canvas.listeners[type]({clientX:10+400*x,clientY:20+300*y,pointerId:1,pointerType:'mouse',isPrimary:true,button:0,preventDefault(){},...extra});
}
(async()=>{
 run('addPoint(.2,.2)');assert.equal(run('active().objects.length'),1);assert.equal(nodes.export.disabled,true);
 result([1,1,3,3]);assert.equal(nodes.export.disabled,false);assert.equal(run('ready(active())'),true);
 run('addPoint(.7,.7)');assert.equal(run('active().objects.length'),2);assert.equal(nodes.export.disabled,true);
 result([5,5,7,7]);assert.equal(run('selectedObjects(active()).length'),2);assert.equal(nodes.export.disabled,false);
 let pixels=run("active().mask.getContext('2d').getImageData(0,0,8,8).data");
 assert.equal(pixels[(1*8+1)*4+3],255);assert.equal(pixels[(5*8+5)*4+3],255);assert.equal(pixels[3],0);
 const blob=await run('pngBlob(active())'),decoded=new Image();decoded.src=Buffer.from(await blob.arrayBuffer());await decoded.decode();
 assert.equal(decoded.width,8);assert.equal(decoded.height,8);
 const exported=createCanvas(8,8);exported.getContext('2d').drawImage(decoded,0,0);
 pixels=exported.getContext('2d').getImageData(0,0,8,8).data;assert.equal(pixels[3],0);assert.equal(pixels[(5*8+5)*4+3],255);
 run("active().objectId=active().objects[0].id;setTool('remove');addPoint(.4,.4)");
 assert.equal(run('active().objects.length'),2);assert.equal(sent.at(-1).points.at(-1).label,0);assert.equal(nodes.export.disabled,true);
 run("undo()");assert.equal(run('active().objects[0].points.length'),1);assert.equal(run('ready(active())'),true);
 // The response from the undone request cannot overwrite restored masks.
 result([0,0,8,8]);pixels=run("active().mask.getContext('2d').getImageData(0,0,8,8).data");assert.equal(pixels[3],0);
 run("active().objects[1].enabled=false;recompute(active());draw()");
 pixels=run("active().mask.getContext('2d').getImageData(0,0,8,8).data");assert.equal(pixels[(5*8+5)*4+3],0);
 run("active().crop=true");
 const cropped=await run('pngBlob(active())');decoded.src=Buffer.from(await cropped.arrayBuffer());await decoded.decode();assert.equal(decoded.width,5);assert.equal(decoded.height,5);
 run("$('reset').onclick()");assert.equal(run('active().objects.length'),0);assert.equal(nodes.export.disabled,true);
 run('undo()');assert.equal(run('active().objects.length'),2);
 // A complete drag is one selection and one inference, regardless of move count.
 run("$('reset').onclick()");const before=sent.length,history=run('active().history.length');
 pointer('pointerdown',.2,.25);assert.equal(nodes.canvas.capture,1);assert.equal(run('active().objects.length'),0);
 pointer('pointermove',.6,.25,{getCoalescedEvents:()=>[{clientX:170,clientY:95}]});
 assert.equal(sent.length,before);assert.equal(run('active().history.length'),history);
 pointer('pointerup',.8,.25);assert.equal(nodes.canvas.capture,null);
 assert.equal(sent.length,before+1);assert.equal(run('active().objects.length'),1);assert.equal(run('active().history.length'),history+1);
 const prompts=sent.at(-1).points;assert.ok(prompts.length>2&&prompts.length<=64);assert.ok(prompts.every(p=>p.label===1&&p.y===.25));
 assert.equal(prompts[0].x,.2);assert.equal(prompts.at(-1).x,.8);assert.ok(prompts.some(p=>p.x>.45&&p.x<.55));
 assert.equal(nodes.pins.children.length,1);result([1,1,7,7]);
 // Touch cancellation, secondary fingers, capture loss and image switches are atomic.
 const completedCount=sent.length;
 for(const ending of ['pointercancel','lostpointercapture']){
  pointer('pointerdown',.1,.1,{pointerType:'touch'});assert.equal(nodes.export.disabled,true);
  pointer('pointerdown',.9,.9,{pointerId:2,isPrimary:false});pointer('pointerup',.9,.9,{pointerId:2});
  assert.equal(run('stroke.path[0].x'),.1);pointer('pointermove',.4,.4);pointer(ending,.4,.4);
  assert.equal(sent.length,completedCount);assert.equal(run('active().objects.length'),1);assert.equal(nodes.export.disabled,false);
 }
 pointer('pointerdown',.1,.1);run("selectImage('test')");pointer('pointerup',.8,.8);assert.equal(sent.length,completedCount);
 // Refining with a touch stroke extends the same object; undo removes the whole stroke.
 run("setTool('remove')");pointer('pointerdown',.8,.8,{pointerType:'touch'});pointer('pointermove',.5,.8,{pointerType:'touch'});pointer('pointerup',.3,.8,{pointerType:'touch'});
 assert.equal(run('active().objects.length'),1);assert.equal(run('object().strokes.length'),2);assert.ok(sent.at(-1).points.slice(prompts.length).every(p=>p.label===0));
 run('undo()');assert.equal(run('object().points.length'),prompts.length);assert.equal(run('object().strokes.length'),1);
 result([0,0,8,8]);assert.equal(run("active().mask.getContext('2d').getImageData(0,0,1,1).data[3]"),0);
 // Cancelled drags do not consume earlier history. Long, out-of-bounds drags stay bounded.
 const restoredHistory=run('active().history.length');pointer('pointerdown',.2,.2);run('undo()');assert.equal(run('active().history.length'),restoredHistory);
 run("setTool('keep')");pointer('pointerdown',0,.2,{pointerType:'pen'});
 for(let i=0;i<2500;i++)pointer('pointermove',(i%2)*1.2,.2+(i%10)/20,{pointerType:'pen'});
 assert.ok(run('stroke.path.length')<=1024);pointer('pointerup',1.2,.5,{pointerType:'pen'});
 const extra=sent.at(-1).points.slice(prompts.length);assert.ok(extra.length<=64);assert.equal(extra.at(-1).x,1);assert.ok(extra.every(p=>p.x>=0&&p.x<=1&&p.y>=0&&p.y<=1));
 result([1,1,7,7]);run('undo();undo()');assert.equal(run('active().objects.length'),0);
 // An unresponsive worker is replaced, with finite backend fallbacks and retry.
 run("setTool('add');addPoint(.2,.2)");const hung=workers.at(-1),originalRequest=sent.at(-1);
 timers.get(run('watchdog'))();assert.equal(hung.terminated,true);assert.equal(sent.at(-1).mode,'wasm');
 assert.equal(run('active().objects.length'),1);assert.notEqual(sent.at(-1).requestId,originalRequest.requestId);
 hung.onmessage({data:{type:'error',requestId:sent.at(-1).requestId,message:'stale worker'}});assert.equal(sent.at(-1).mode,'wasm');
 timers.get(run('watchdog'))();assert.equal(sent.at(-1).mode,'single');
 timers.get(run('watchdog'))();assert.equal(run('busy'),false);assert.equal(nodes.retry.hidden,false);assert.equal(nodes.export.disabled,true);
 const attempts=sent.length;run("$('retry').onclick()");assert.equal(sent.length,attempts+1);result([1,1,3,3]);assert.equal(nodes.export.disabled,false);assert.equal(run('active().objects.length'),1);
 // A mask covering the entire stroke beats a higher IoU mask of just one piece.
 const path=require('node:path'),{pathToFileURL}=require('node:url');
 const selection=await import(pathToFileURL(path.join(__dirname,'dist/mask-selection.js')).href);
 const maskData=new Float32Array(3*64).fill(-8);
 for(let y=1;y<7;y++)for(let x=1;x<7;x++)maskData[64+y*8+x]=8;
 maskData[2*8+2]=8;maskData.fill(8,128);
 const checks=[{x:.3,y:.3,label:1},{x:.7,y:.7,label:1},{x:.95,y:.95,label:0}];
 const ranked=selection.rankMasks(maskData,[.99,.8,.98],8,8,checks);assert.equal(ranked.indexOf(Math.max(...ranked)),1);
 assert.equal(selection.nextCorrection(maskData,0,8,8,checks,[0]),1);
 const islands=new Float32Array(64).fill(-8);islands[2*8+2]=8;islands[7*8+7]=8;
 selection.retainTouchedComponents(islands,8,8,checks);assert.equal(islands[2*8+2],8);assert.equal(islands[7*8+7],-8);
 // Exercise the real worker loop: 64 stroke samples must not all enter the decoder.
 const foreground=await import(pathToFileURL(path.join(__dirname,'dist/foreground.js')).href);
 // ISNet preprocessing must match the published RGB normalization, without padding.
 const input=foreground.isnetInput({data:new Uint8Array([0,128,255,64,192,128]),width:2,height:1,channels:3},2);
 assert.deepEqual(Array.from(input),[-.5,-.25,-.5,-.25,0,.25,0,.25,127/256,0,127/256,0]);
 // A selected dish retains its interior and soft edge, without a separate glass.
 const alpha=new Float32Array(64);for(let y=1;y<4;y++)for(let x=1;x<4;x++)alpha[y*8+x]=1;
 alpha[1*8+4]=.5;alpha[6*8+6]=1;
 const dish=foreground.selectForeground(alpha,8,8,[{x:.3,y:.3,label:1}]);
 assert.equal(dish.needsRefinement,false);assert.equal(dish.alpha[2*8+2],1);assert.equal(dish.alpha[6*8+6],0);assert.equal(dish.alpha[1*8+4],.5);
 assert.equal(foreground.selectForeground(alpha,8,8,[{x:.3,y:.3,label:1},{x:.8,y:.8,label:1}]).alpha[6*8+6],1);
 assert.equal(foreground.selectForeground(alpha,8,8,[{x:.3,y:.3,label:1},{x:.5,y:.7,label:1}]).needsRefinement,true);
 const plate=new Float32Array(64).fill(-8);for(let y=1;y<6;y++)for(let x=1;x<6;x++)plate[y*8+x]=8;plate[2*8+2]=-8;
 const combined=foreground.combineForeground(dish,plate,[1],8,8,[{x:.3,y:.3,label:1}],selection.rankMasks);
 assert.equal(combined.masks[2*8+2],8);assert.equal(combined.masks[5*8+5],8);assert.equal(combined.masks[6*8+6],-8);assert.equal(combined.masks[0],-8);
 const messages=[],promptSizes=[];
 class Tensor {constructor(type,data,dims){Object.assign(this,{type,data,dims});}dispose(){}}
 const workerContext=vm.createContext({...selection,...foreground,console,Float32Array,Array,BigInt,Tensor,
   self:{postMessage:data=>messages.push(data)},navigator:{},
   fakeModel:async inputs=>{promptSizes.push(inputs.input_labels.data.length);return {pred_masks:new Tensor('float32',new Float32Array(3*64).fill(8),[1,1,3,8,8]),iou_scores:new Tensor('float32',[.9,.8,.7],[1,1,3])};},
 });
 vm.runInContext(fs.readFileSync(path.join(__dirname,'dist/inference-worker.js'),'utf8').replace(/^import .*;\n/gm,''),workerContext);
 vm.runInContext("lib={Tensor};foregroundModel={};foreground=new Float32Array(64);outputWidth=8;outputHeight=8;model=fakeModel;currentImage='fixture';embeddings={};processed={reshaped_input_sizes:[[1024,1024]],original_sizes:[[8,8]]};processor={image_processor:{pad_size:{width:1024,height:1024}},post_process_masks:async x=>[x]};",workerContext);
 workerContext.job={imageId:'fixture',requestId:123,points:Array.from({length:64},(_,i)=>({x:.2+i/128,y:.5,label:1}))};
 await vm.runInContext('segment(job)',workerContext);assert.deepEqual(promptSizes,[1]);assert.equal(messages.at(-1).type,'result');assert.ok(messages.every(m=>m.requestId===123));
 vm.runInContext('foreground.fill(1)',workerContext);await vm.runInContext('segment(job)',workerContext);
 assert.deepEqual(promptSizes,[1]);assert.equal(messages.at(-1).scores.length,1);
 console.log('PASS: separate clicks; mask union; PNG alpha/dimensions; crop; drag sampling and single release inference; touch/pen; capture/cancel; one-step stroke undo; stale reply protection; bounded prompts.');
 console.log('PASS: unresponsive worker recovery and finite fallback; fresh-worker retry; IMG.LY preprocessing, complete foreground selection, plate/food union, sparse correction only when needed.');
})().catch(e=>{console.error(e);process.exitCode=1;});


