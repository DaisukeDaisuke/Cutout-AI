const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const {createCanvas,Image}=require(process.argv[2] || '@napi-rs/canvas');
function el(tag='div'){
 const e=tag==='canvas'?createCanvas(1,1):{};
 Object.assign(e,{style:{},children:[],hidden:false,disabled:false,value:'0',clientWidth:500,clientHeight:360,attrs:{},
 append(...v){this.children.push(...v);},replaceChildren(...v){this.children=[...v];},setAttribute(k,v){this.attrs[k]=v;},removeAttribute(k){delete this.attrs[k];},addEventListener(){},classList:{add(){},remove(){}}});
 if(tag==='canvas')e.toBlob=fn=>fn(new Blob([e.toBuffer('image/png')],{type:'image/png'}));
 return e;
}
const html=fs.readFileSync(require('node:path').join(__dirname,'dist/index.html'),'utf8');
const nodes=Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map(m=>[m[1],el(m[1]==='canvas'||m[1]==='result'?'canvas':'div')]));
nodes.feather.value='1';nodes.threshold.value='0';
const sent=[];
class MockWorker {postMessage(job){sent.push(job);}terminate(){}}
const ctx=vm.createContext({console,Uint8Array,Float32Array,Map,Blob,URL,Request,Response,ReadableStream,
 document:{getElementById:id=>{assert.ok(nodes[id],'Missing DOM id: '+id);return nodes[id];},createElement:el,querySelectorAll:()=>[],addEventListener(){},body:el()},
 navigator:{},isSecureContext:false,devicePixelRatio:1,Image:class{constructor(){return el('img');}},Worker:MockWorker,ResizeObserver:class{observe(){}},
 setTimeout:()=>0,clearTimeout(){},sessionStorage:{getItem(){return null;}},location:{reload(){}}});
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
 console.log('PASS: click adds separate items; partial work cannot export; mask union; PNG alpha and dimensions; refinement; stale reply ignored after undo; exclude; crop; reset/undo.');
})().catch(e=>{console.error(e);process.exitCode=1;});


