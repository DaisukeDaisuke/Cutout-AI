const $ = id => document.getElementById(id);
const paths = {
  plus:'M12 5v14M5 12h14',close:'m6 6 12 12M18 6 6 18',download:'M12 3v12m-5-5 5 5 5-5M5 15v5h14v-5',
  image:'M4 4h16v16H4zM4 16l5-5 4 4 3-3 4 4M9 8h.01',trash:'M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7',
  undo:'M8 5 3 10l5 5M3 10h11a6 6 0 0 1 0 12','plus-circle':'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20M12 7v10M7 12h10',
  lock:'M6 10h12v11H6zM8 10V6a4 4 0 0 1 8 0v4M12 14v3',cutout:'M8 3H3v5m13-5h5v5M3 16v5h5m8 0h5v-5M8 13a4 4 0 1 1 8 0v4H8z'
};
function icon(name) { return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="'+(paths[name] || paths.image)+'"/></svg>'; }
document.querySelectorAll('[data-icon]').forEach(el => { el.innerHTML = icon(el.dataset.icon); });
const images = [];
let localId = 0;
const nextId = () => 'local-'+(++localId);
let activeId = null, tool = 'add', background = 'transparent', showOriginal = false;
let worker, busy = false, requestCounter = 0, activeRequest = null, bootReady = false, engineError = '';
let workerMode = 'auto', watchdog = 0, attemptDeadline = 0;
let saving = false, toastTimer, keyboardVisible = false;
let stroke = null, strokeFrame = 0;
const pending = new Map();
const keyboardPoint = { x:.5, y:.5 };
function active() { return images.find(im => im.id === activeId); }
function object(im = active()) { return im?.objects.find(o => o.id === im.objectId); }
function element(tag, className, text) { const el = document.createElement(tag); if(className)el.className=className;if(text!=null)el.textContent=text;return el; }
function toast(message) { $('toast').textContent=message;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,4500); }
function status(message) { $('status').textContent=message; }
function selectedObjects(im) { return im?.objects.filter(o => o.enabled && o.points.length) || []; }
function waiting(im) { return selectedObjects(im).some(o => !o.masks); }
function ready(im) { return !!im?.mask && !waiting(im) && stroke?.imageId!==im.id; }
function createObject(im) { const o={id:nextId(),number:im.nextObject++,enabled:true,points:[],strokes:[],masks:null,scores:[],choice:0,version:0,error:''};im.objects.push(o);im.objectId=o.id;return o; }
function saveHistory(im) { im.history.push({objects:im.objects.map(o=>({...o,points:o.points.map(p=>({...p})),strokes:[...o.strokes]})),objectId:im.objectId});if(im.history.length>20)im.history.shift(); }

async function addFiles(files) {
  let firstAdded;
  for(const file of files) {
    if(!file.type.startsWith('image/')) {toast(file.name+': 画像ファイルを選択してください');continue;}
    if(file.size>80_000_000){toast(file.name+': 80 MB以下の画像を選択してください');continue;}
    const url=URL.createObjectURL(file);
    try {
      const img=new Image();img.src=url;await img.decode();
      if(img.naturalWidth*img.naturalHeight>50_000_000)throw Error('5,000万画素以下の画像を選択してください');
      const im={id:nextId(),name:file.name,url,img,width:img.naturalWidth,height:img.naturalHeight,selected:true,objects:[],objectId:null,nextObject:1,history:[],feather:1,threshold:0,crop:false,mask:null,bounds:null,version:0,message:'',progress:null};
      images.push(im);firstAdded ||= im.id;
    } catch(error) {URL.revokeObjectURL(url);toast(file.name+': '+(error.message.includes('画素')?error.message:'画像を読み込めません'));}
  }
  selectImage(firstAdded || activeId);
}
function renderLibrary() {
  const list=$('image-list');list.replaceChildren();
  for(const im of images) {
    const item=element('div','image-item'+(im.id===activeId?' active':''));
    const open=element('button','image-open');open.setAttribute('aria-label',im.name+'を編集');open.setAttribute('aria-current',String(im.id===activeId));
    const img=new Image();img.src=im.url;img.alt='';
    const caption=element('div','image-caption');caption.append(element('strong','',im.name),element('span','',ready(im)?'完成':''));
    open.append(img,caption);open.onclick=()=>selectImage(im.id);item.append(open);
    if(ready(im)) {
      const label=element('label','image-check'), check=element('input');check.type='checkbox';check.checked=im.selected;
      check.setAttribute('aria-label',im.name+'をまとめて保存に含める');check.onchange=()=>{im.selected=check.checked;updateButtons();};label.append(check);item.append(label);
    }
    list.append(item);
  }
  $('image-count').textContent=images.length;updateButtons();
}
function selectImage(id) {
  cancelStroke();
  activeId=images.find(i=>i.id===id)?.id||null;const im=active();
  $('empty').hidden=!!im;$('editing').hidden=!im;showOriginal=false;tool='add';keyboardVisible=false;
  $('finishing').open=false;
  if(im){$('filename').textContent=im.name;$('dimensions').textContent=im.width.toLocaleString()+' × '+im.height.toLocaleString();$('feather').value=im.feather;$('threshold').value=im.threshold;$('crop').checked=im.crop;}
  updateAdjustmentLabels();renderLibrary();renderObjects();draw();status(im?'':'');
}
// A visual thumbnail of each chosen item; before inference, show its clicked area.
function thumbnail(im,o,choice=o.choice) {
  const out=element('canvas');out.width=160;out.height=112;const ctx=out.getContext('2d');
  if(!o.masks) {
    const p=o.points.find(p=>p.label===1);
    if(p){const side=Math.min(im.width,im.height)*.36;const x=Math.max(0,Math.min(im.width-side,p.x*im.width-side/2)), y=Math.max(0,Math.min(im.height-side,p.y*im.height-side/2));ctx.drawImage(im.img,x,y,side,side,24,0,112,112);}
    return out;
  }
  const key=choice+':'+im.threshold;
  o.thumbnails ||= {};
  if(o.thumbnails[key]){ctx.drawImage(o.thumbnails[key],0,0);return out;}
  const {width,height}=o,n=width*height,mask=element('canvas');mask.width=width;mask.height=height;
  const mx=mask.getContext('2d'), px=mx.createImageData(width,height);let l=width,t=height,r=-1,b=-1;
  for(let i=0;i<n;i++){const a=o.masks[choice*n+i]+im.threshold>0?255:0;px.data[i*4+3]=a;if(a){const x=i%width,y=Math.floor(i/width);l=Math.min(l,x);r=Math.max(r,x);t=Math.min(t,y);b=Math.max(b,y);}}
  mx.putImageData(px,0,0);mx.globalCompositeOperation='source-in';mx.drawImage(im.img,0,0,width,height);
  if(r>=l){const w=r-l+1,h=b-t+1,s=Math.min(144/w,96/h);ctx.drawImage(mask,l,t,w,h,(160-w*s)/2,(112-h*s)/2,w*s,h*s);}
  o.thumbnails[key]=out;return out;
}
function renderObjects() {
  const im=active(), list=$('object-list');list.replaceChildren();
  $('object-count').textContent=selectedObjects(im).length;
  if(!im?.objects.length)list.append(element('span','selection-empty','未選択'));
  for(const o of im?.objects||[]) {
    const row=element('div','object-item'+(im.objectId===o.id?' active':'')+(!o.enabled?' excluded':''));
    const open=element('button','object-open checker');open.append(thumbnail(im,o));open.setAttribute('aria-label','選択 '+o.number+' を調整');
    open.onclick=()=>{im.objectId=o.id;setTool('keep');renderObjects();draw();};
    const bottom=element('div','object-bottom'),label=element('label'),check=element('input');
    check.type='checkbox';check.checked=o.enabled;check.setAttribute('aria-label','選択 '+o.number+' を残す');
    check.onchange=()=>{saveHistory(im);o.enabled=check.checked;recompute(im);renderObjects();renderLibrary();draw();};
    label.append(check,element('span','',String(o.number)));
    const del=element('button','icon-button object-delete');del.innerHTML=icon('close');del.setAttribute('aria-label','選択 '+o.number+' を取り消す');
    del.onclick=()=>{saveHistory(im);im.objects=im.objects.filter(x=>x!==o);pending.delete(im.id+':'+o.id);if(im.objectId===o.id)im.objectId=im.objects.at(-1)?.id||null;if(!im.objects.length)tool='add';recompute(im);renderObjects();renderLibrary();draw();};
    bottom.append(label,del);row.append(open,bottom);list.append(row);
  }
  renderCandidates();updateButtons();
}
function renderCandidates() {
  const im=active(), o=object(im), list=$('mask-choices');list.replaceChildren();
  $('candidate-label').textContent=o?'選択 '+o.number+' の切り抜く範囲':'切り抜く範囲';
  if(!o?.masks){list.append(element('span','','切り抜き後に表示'));return;}
  if(!$('finishing').open)return;
  o.scores.forEach((_,i)=>{const b=element('button','checker');b.append(thumbnail(im,o,i),element('span','','範囲 '+(i+1)));b.setAttribute('aria-pressed',String(o.choice===i));b.onclick=()=>{saveHistory(im);o.choice=i;recompute(im);renderObjects();draw();};list.append(b);});
}
function updateButtons() {
  const im=active(),o=object(im);
  $('export').disabled=!ready(im)||saving;$('show-original').disabled=!im?.mask;
  $('show-original').setAttribute('aria-pressed',String(showOriginal));$('show-original').textContent=showOriginal?'切り抜きに戻る':'元の写真と見比べる';
  $('undo').disabled=!im?.history.length;$('reset').disabled=!im?.objects.length;$('refine').disabled=!o;
  $('refine').setAttribute('aria-expanded',String(tool!=='add'&&!!o));$('refine-tools').hidden=tool==='add'||!o;
  $('refine-label').textContent=o?'選択 '+o.number+' を調整':'';
  for(const name of ['add','keep','remove'])$('tool-'+name).setAttribute('aria-pressed',String(tool===name));
  $('action-label').textContent={add:'なぞって選ぶ',keep:'なぞって広げる',remove:'なぞって除く'}[tool];
  for(const id of ['feather','threshold','crop'])$(id).disabled=!im?.mask;
  const count=images.filter(im=>im.selected&&ready(im)).length;
  $('export-batch').disabled=!count||saving;$('batch-label').textContent=count?count+'枚をまとめて保存':'まとめて保存';
  $('batch-count').textContent=count?'選択した完成画像をZIPで保存':'完成した画像をZIPで保存';
}
function updateAdjustmentLabels() { $('feather-value').textContent=$('feather').value;const t=Number($('threshold').value);$('threshold-value').textContent=t===0?'標準':t>0?'広め':'狭め'; }
function setTool(value) {cancelStroke();tool=value;updateButtons();draw();}
function recompute(im) {
  const objects = im.objects.filter(o => o.enabled && o.masks);
  if (!objects.length) { im.mask = null; im.bounds = null; updateButtons(); return; }
  const { width, height } = objects[0];
  const c = document.createElement('canvas'); c.width = width; c.height = height; const ctx = c.getContext('2d'); const pixels = ctx.createImageData(width, height); const n = width * height;
  let left = width, top = height, right = -1, bottom = -1;
  for (let i = 0; i < n; i++) {
    let logit = -Infinity; for (const o of objects) logit = Math.max(logit, o.masks[o.choice * n + i]);
    const alpha = Math.max(0, Math.min(255, Math.round((logit + im.threshold + .4) / .8 * 255)));
    const k = i * 4; pixels.data[k] = 255; pixels.data[k+1] = 255; pixels.data[k+2] = 255; pixels.data[k+3] = alpha;
    if (alpha > 0) { const x = i % width, y = Math.floor(i / width); left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y); }
  }
  ctx.putImageData(pixels, 0, 0);
  if (im.feather > 0) { const smooth = document.createElement('canvas'); smooth.width = width; smooth.height = height; const sx = smooth.getContext('2d'); sx.filter = `blur(${im.feather * width / im.width}px)`; sx.drawImage(c, 0, 0); im.mask = smooth; } else im.mask = c;
  const pad = Math.ceil(im.feather * 3 + 2);
  im.bounds = right < left ? null : { x: Math.max(0, Math.floor(left / width * im.width) - pad), y: Math.max(0, Math.floor(top / height * im.height) - pad), right: Math.min(im.width, Math.ceil((right+1) / width * im.width) + pad), bottom: Math.min(im.height, Math.ceil((bottom+1) / height * im.height) + pad) };
  if (!im.bounds) im.mask = null; updateButtons();
}
function renderCut(im, width, height) { const c = document.createElement('canvas'); c.width = width; c.height = height; const ctx = c.getContext('2d'); if (!im.mask) return c; ctx.drawImage(im.img, 0, 0, width, height); ctx.globalCompositeOperation = 'destination-in'; ctx.drawImage(im.mask, 0, 0, width, height); ctx.globalCompositeOperation = 'source-over'; return c; }
function outputBounds(im) { return im.crop && im.bounds ? { x: im.bounds.x, y: im.bounds.y, width: im.bounds.right - im.bounds.x, height: im.bounds.bottom - im.bounds.y } : { x: 0, y: 0, width: im.width, height: im.height }; }

function draw() {
  const im=active();$('pins').replaceChildren();if(!im)return;
  const area=$('canvas-area'),ratio=Math.max(.01,Math.min((area.clientWidth-40)/im.width,(area.clientHeight-40)/im.height));
  const w=Math.max(1,Math.round(im.width*ratio)),h=Math.max(1,Math.round(im.height*ratio)),dpr=Math.min(2,devicePixelRatio||1);
  $('frame').style.width=w+'px';$('frame').style.height=h+'px';
  const canvas=$('canvas');canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);
  const ctx=canvas.getContext('2d'),cw=canvas.width,ch=canvas.height;ctx.drawImage(im.img,0,0,cw,ch);
  if(im.mask){
    // Leave selected food in full color and dim the surrounding photo.
    ctx.fillStyle='rgba(22,36,27,.36)';ctx.fillRect(0,0,cw,ch);ctx.drawImage(renderCut(im,cw,ch),0,0);
  }
  for(const o of im.objects)if(o.enabled)for(const s of o.strokes){
    const p={...s.path[0],label:s.label};
    const pin=element('span','pin'+(p.label===0?' negative':'')+(o.id===im.objectId?'':' inactive'),p.label===0?'−':String(o.number));
    pin.style.left=(p.x*100)+'%';pin.style.top=(p.y*100)+'%';$('pins').append(pin);
  }
  drawStrokes();
  if(keyboardVisible){const p=element('span','pin','+');p.style.left=(keyboardPoint.x*100)+'%';p.style.top=(keyboardPoint.y*100)+'%';$('pins').append(p);}
  const rc=$('result'),ra=$('result-area'),bounds=showOriginal?{x:0,y:0,width:im.width,height:im.height}:outputBounds(im);
  const rs=Math.max(.01,Math.min((ra.clientWidth-40)/bounds.width,(ra.clientHeight-40)/bounds.height));
  rc.width=Math.max(1,Math.round(bounds.width*rs*dpr));rc.height=Math.max(1,Math.round(bounds.height*rs*dpr));
  rc.style.width=Math.round(bounds.width*rs)+'px';rc.style.height=Math.round(bounds.height*rs)+'px';
  const rx=rc.getContext('2d');
  if(showOriginal)rx.drawImage(im.img,0,0,rc.width,rc.height);
  else if(im.mask){
    rx.drawImage(im.img,bounds.x,bounds.y,bounds.width,bounds.height,0,0,rc.width,rc.height);
    rx.globalCompositeOperation='destination-in';
    rx.drawImage(im.mask,bounds.x/im.width*im.mask.width,bounds.y/im.height*im.mask.height,bounds.width/im.width*im.mask.width,bounds.height/im.height*im.mask.height,0,0,rc.width,rc.height);
    rx.globalCompositeOperation='source-over';
  }
  ra.style.backgroundColor=background==='transparent'?'':background;ra.style.backgroundImage=background==='transparent'?'':'none';
  $('output-size').textContent=im.mask?outputBounds(im).width.toLocaleString()+' × '+outputBounds(im).height.toLocaleString()+' px · 背景は透明':'';
  $('result-count').textContent=showOriginal?'元の写真':ready(im)?selectedObjects(im).length+'個を残す · 背景は透明':'透明の背景';
  renderResultState();
}
function renderResultState(){
  const im=active();if(!im)return;const selected=selectedObjects(im);
  const error=selected.find(o=>o.error)?.error||(selected.length?engineError:'');
  const drawing=stroke?.imageId===im.id,processing=waiting(im)&&!error;
  const placeholder=$('result-placeholder');placeholder.hidden=ready(im)&&!error||showOriginal;
  placeholder.className='result-placeholder'+(error?' error':processing?' working':'');
  $('result').hidden=!im.mask&&!showOriginal;
  $('result-message').textContent=error?'切り抜きを実行できませんでした':drawing?'選択中':processing?(im.message||'切り抜きを準備しています'):selected.length?'残す範囲が見つかりませんでした':'まだ選ばれていません';
  $('retry').hidden=!error;$('error-details').hidden=!error;$('error-detail').textContent=error;
  $('progress').hidden=!processing;
  if(Number.isFinite(im.progress))$('progress').value=im.progress;else $('progress').removeAttribute('value');
  $('result-area').setAttribute('aria-busy',String(processing));
}
function reportProgress(message,progress){
  const im=images.find(i=>i.id===activeRequest?.imageId);
  if(im){im.message=message;im.progress=progress;if(im.id===activeId)renderResultState();}
}
function watchWorker(){
  clearTimeout(watchdog);
  if(!activeRequest)return;
  watchdog=setTimeout(()=>failWorker('処理から応答がありませんでした。もう一度試してください。'),Math.max(0,Math.min(60000,attemptDeadline-Date.now())));
}
function failWorker(message){
  const job=activeRequest,im=images.find(i=>i.id===job?.imageId),o=im?.objects.find(o=>o.id===job.objectId);
  clearTimeout(watchdog);worker?.terminate();worker=null;busy=false;activeRequest=null;
  if(o&&o.version===job.version&&im.version===job.imageVersion){
    if(workerMode!=='single'){
      workerMode=workerMode==='auto'?'wasm':'single';
      im.message='別の方法で切り抜きをやり直しています';im.progress=null;
      pending.set(im.id+':'+o.id,{im,o});
    }else{o.error=message;im.progress=null;}
  }
  updateButtons();draw();processQueue();
}
function ensureWorker(){
  if(worker)return;
  worker=new Worker('./inference-worker.js?v=imgly-v3',{type:'module'});
  const instance=worker;
  worker.onmessage=({data})=>{
    if(worker!==instance||!activeRequest||data.requestId!==activeRequest.requestId)return;
    if(data.type==='status'){watchWorker();reportProgress(data.message,data.progress);return;}
    if(data.type==='runtime'){$('runtime').textContent=data.runtime+' / クロスオリジン分離: '+(data.isolated?'有効':'無効');return;}
    if(data.type==='error'){failWorker(data.message||'処理に失敗しました');return;}
    if(data.type!=='result')return;
    if(!Number.isInteger(data.width)||!Number.isInteger(data.height)||data.width<1||data.height<1||!data.scores?.length||data.masks?.length!==data.width*data.height*data.scores.length){failWorker('切り抜き結果を読み込めませんでした');return;}
    const job=activeRequest,im=images.find(i=>i.id===job.imageId),o=im?.objects.find(o=>o.id===job.objectId);
    if(o&&o.version===job.version&&im.version===job.imageVersion){
      if(data.type==='result'){
        Object.assign(o,{masks:data.masks,scores:data.scores,width:data.width,height:data.height,thumbnails:{},error:''});
        o.choice=data.scores.indexOf(Math.max(...data.scores));im.message='';im.progress=null;
        recompute(im);if(im.id===activeId)status(im.mask?'切り抜きができました':'別の場所を選び直してください');
      }else if(data.type==='error'){o.error=data.message||'処理に失敗しました';}
    }
    clearTimeout(watchdog);busy=false;activeRequest=null;renderLibrary();if(im?.id===activeId){renderObjects();draw();}updateButtons();processQueue();
  };
  worker.onerror=event=>{
    if(worker===instance)failWorker(event.message||'処理を開始できませんでした');
  };
  worker.onmessageerror=()=>{if(worker===instance)failWorker('切り抜き結果を受信できませんでした');};
}
function queueObject(im,o){
  o.version++;o.masks=null;o.scores=[];o.thumbnails={};o.error='';
  im.message='切り抜きを準備しています';im.progress=null;
  recompute(im);pending.set(im.id+':'+o.id,{im,o});processQueue();if(im.id===activeId){renderObjects();draw();}
}
function processQueue(){
  if(busy||!bootReady||!pending.size)return;
  const [key,{im,o}]=pending.entries().next().value;pending.delete(key);
  if(!images.includes(im)||!im.objects.includes(o)||!o.points.some(p=>p.label===1)){processQueue();return;}
  try{ensureWorker();}catch(error){o.error=error.message;draw();return;}
  busy=true;activeRequest={requestId:++requestCounter,imageId:im.id,objectId:o.id,version:o.version,imageVersion:im.version};
  attemptDeadline=Date.now()+180000;watchWorker();
  try{worker.postMessage({type:'segment',...activeRequest,url:im.url,points:o.points,mode:workerMode});}catch(error){failWorker(error.message);}
  updateButtons();
}
const clamp = value => Math.max(0,Math.min(1,value));
// Arc-length sampling makes slow, fast and coalesced pointer events equivalent.
// Keep each gesture as one group, with at most 64 coverage samples.
function sampleStroke(path,im,label){
  const scale=Math.max(im.width,im.height);
  const distance=(a,b)=>Math.hypot((a.x-b.x)*im.width/scale,(a.y-b.y)*im.height/scale);
  const lengths=[0];
  for(let i=1;i<path.length;i++)lengths.push(lengths[i-1]+distance(path[i-1],path[i]));
  const length=lengths.at(-1);
  if(!length)return [{...path[0],label}];
  const count=Math.min(64,Math.max(2,Math.ceil(length/.025)+1)),points=[];
  let j=1;
  for(let i=0;i<count;i++){
    const target=length*i/(count-1);
    while(j<path.length-1&&lengths[j]<target)j++;
    const t=(target-lengths[j-1])/(lengths[j]-lengths[j-1]||1),a=path[j-1],b=path[j];
    points.push({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,label});
  }
  return points;
}
function commitStroke(path,label,mode=tool){
  const im=active();if(!im)return;
  let o=object(im);
  if(!label&&!o){toast('先に残すものを選んでください');return;}
  if(mode!=='add'&&!o)return;
  saveHistory(im);
  if(label&&mode==='add')o=createObject(im);
  if(!o)return;
  o.enabled=true;o.strokes.push({path,label});o.points.push(...sampleStroke(path,im,label));
  queueObject(im,o);status(selectedObjects(im).length+'個を選択');
}
function addPoint(x,y,negative=false){commitStroke([{x:clamp(x),y:clamp(y)}],negative||tool==='remove'?0:1);}
function drawStrokes(){
  const im=active(),overlay=$('stroke-overlay'),canvas=$('canvas');
  overlay.width=canvas.width;overlay.height=canvas.height;
  if(!im)return;
  const ctx=overlay.getContext('2d'),w=overlay.width,h=overlay.height,dpr=Math.min(2,devicePixelRatio||1);
  function line(s,selected=true){
    ctx.globalAlpha=selected ? .9 : .45;ctx.lineCap='round';ctx.lineJoin='round';ctx.beginPath();
    s.path.forEach((p,i)=>i?ctx.lineTo(p.x*w,p.y*h):ctx.moveTo(p.x*w,p.y*h));
    if(s.path.length===1)ctx.lineTo(s.path[0].x*w+.1,s.path[0].y*h);
    ctx.strokeStyle='#fff';ctx.lineWidth=7*dpr;ctx.stroke();
    ctx.strokeStyle=s.label?'#326343':'#ad3f37';ctx.lineWidth=4*dpr;ctx.stroke();
  }
  for(const o of im.objects)if(o.enabled)for(const s of o.strokes)line(s,o.id===im.objectId);
  if(stroke?.imageId===im.id)line(stroke);
}
function scheduleStrokeDraw(){if(!strokeFrame)strokeFrame=requestAnimationFrame(()=>{strokeFrame=0;drawStrokes();});}
function capturePoint(e){
  const r=stroke.rect,p={x:clamp((e.clientX-r.left)/r.width),y:clamp((e.clientY-r.top)/r.height)},last=stroke.path.at(-1);
  if(p.x!==last?.x||p.y!==last?.y)stroke.path.push(p);
  // Bound raw input storage during very long gestures without truncating the end.
  if(stroke.path.length>1024)stroke.path=stroke.path.filter((_,i)=>i%2===0||i===stroke.path.length-1);
}
function cancelStroke(){
  if(!stroke)return false;
  const id=stroke.pointerId;stroke=null;
  if($('canvas').hasPointerCapture(id))$('canvas').releasePointerCapture(id);
  drawStrokes();updateButtons();renderResultState();return true;
}
$('canvas').addEventListener('pointerdown',e=>{
  if(stroke||e.isPrimary===false||(e.button!==0&&e.button!==2)||!active())return;
  const label=e.button===2||tool==='remove'?0:1;
  if(!label&&!object()){toast('先に残すものを選んでください');return;}
  e.preventDefault();keyboardVisible=false;$('canvas').focus({preventScroll:true});
  stroke={imageId:activeId,pointerId:e.pointerId,label,mode:tool,rect:$('canvas').getBoundingClientRect(),path:[]};
  capturePoint(e);$('canvas').setPointerCapture(e.pointerId);draw();updateButtons();
});
$('canvas').addEventListener('pointermove',e=>{
  if(!stroke||e.pointerId!==stroke.pointerId)return;
  e.preventDefault();for(const p of e.getCoalescedEvents?.()||[])capturePoint(p);capturePoint(e);scheduleStrokeDraw();
});
$('canvas').addEventListener('pointerup',e=>{
  if(!stroke||e.pointerId!==stroke.pointerId)return;
  e.preventDefault();capturePoint(e);const finished=stroke;stroke=null;
  if($('canvas').hasPointerCapture(e.pointerId))$('canvas').releasePointerCapture(e.pointerId);
  if(finished.imageId===activeId)commitStroke(finished.path,finished.label,finished.mode);
});
for(const type of ['pointercancel','lostpointercapture'])$('canvas').addEventListener(type,e=>{if(e.pointerId===stroke?.pointerId)cancelStroke();});
window.addEventListener('blur',()=>cancelStroke());
$('canvas').addEventListener('contextmenu',e=>e.preventDefault());
$('canvas').addEventListener('keydown',e=>{
  const d=e.shiftKey?.05:.01;
  if(e.key.startsWith('Arrow')){
    e.preventDefault();keyboardVisible=true;
    if(e.key==='ArrowLeft')keyboardPoint.x-=d;if(e.key==='ArrowRight')keyboardPoint.x+=d;if(e.key==='ArrowUp')keyboardPoint.y-=d;if(e.key==='ArrowDown')keyboardPoint.y+=d;
    keyboardPoint.x=Math.max(0,Math.min(1,keyboardPoint.x));keyboardPoint.y=Math.max(0,Math.min(1,keyboardPoint.y));draw();
  }else if((e.key==='Enter'||e.key===' ')&&!stroke){e.preventDefault();addPoint(keyboardPoint.x,keyboardPoint.y);}
});
function undo(){
  if(cancelStroke())return;
  const im=active();if(!im?.history.length)return;
  const saved=im.history.pop();im.version++;im.objects=saved.objects;im.objectId=saved.objectId;
  for(const [key,item]of pending)if(item.im===im)pending.delete(key);
  if(!im.objects.length)tool='add';recompute(im);renderLibrary();renderObjects();draw();
  for(const o of im.objects)if(o.points.length&&!o.masks)queueObject(im,o);
}
$('undo').onclick=undo;
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&cancelStroke())e.preventDefault();if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'&&!['INPUT','TEXTAREA'].includes(document.activeElement?.tagName)){e.preventDefault();undo();}});
$('reset').onclick=()=>{cancelStroke();const im=active();if(!im)return;saveHistory(im);im.version++;im.objects=[];im.objectId=null;im.message='';tool='add';for(const [key,item]of pending)if(item.im===im)pending.delete(key);recompute(im);renderLibrary();renderObjects();draw();status('選択を取り消しました');};
for(const name of ['add','keep','remove'])$('tool-'+name).onclick=()=>setTool(name);
$('refine').onclick=()=>setTool(tool==='add'?'keep':'add');$('refine-done').onclick=()=>setTool('add');
$('finishing').ontoggle=renderCandidates;
$('show-original').onclick=()=>{showOriginal=!showOriginal;updateButtons();draw();};
document.querySelectorAll('[data-bg]').forEach(b=>b.onclick=()=>{background=b.dataset.bg;document.querySelectorAll('[data-bg]').forEach(x=>x.setAttribute('aria-pressed',String(x===b)));draw();});
for(const id of ['feather','threshold'])$(id).oninput=()=>{const im=active();if(!im)return;im[id]=Number($(id).value);updateAdjustmentLabels();recompute(im);draw();};
$('threshold').onchange=renderObjects;
$('crop').onchange=()=>{if(active())active().crop=$('crop').checked;draw();};
new ResizeObserver(()=>draw()).observe($('canvas-area'));
new ResizeObserver(()=>draw()).observe($('result-area'));
for(const id of ['add-images','empty-add'])$(id).onclick=()=>$('file-input').click();
$('file-input').onchange=async()=>{await addFiles(Array.from($('file-input').files));$('file-input').value='';};
document.addEventListener('dragover',e=>{e.preventDefault();document.body.classList.add('dragging');});
document.addEventListener('dragleave',e=>{if(!e.relatedTarget)document.body.classList.remove('dragging');});
document.addEventListener('drop',async e=>{e.preventDefault();document.body.classList.remove('dragging');await addFiles(Array.from(e.dataTransfer.files));});
document.addEventListener('paste',async e=>{const files=Array.from(e.clipboardData?.files||[]);if(files.length){e.preventDefault();await addFiles(files);}});
$('remove-image').onclick=()=>{const im=active();if(!im)return;for(const [key,item]of pending)if(item.im===im)pending.delete(key);images.splice(images.indexOf(im),1);URL.revokeObjectURL(im.url);selectImage(images[0]?.id);};
$('retry').onclick=()=>{if(!bootReady){location.reload();return;}const im=active();for(const o of selectedObjects(im))if(!o.masks)queueObject(im,o);};
function safeName(name) { return name.replace(/\.[^.]+$/,'').replace(/[\\/:*?"<>|\x00-\x1f]/g,'_') || 'image'; }
async function pngBlob(im) {
  if(!im.mask)throw Error('残す対象を選択してください'); const b=outputBounds(im), c=document.createElement('canvas');c.width=b.width;c.height=b.height;
  const ctx=c.getContext('2d');ctx.drawImage(im.img,-b.x,-b.y,im.width,im.height);ctx.globalCompositeOperation='destination-in';ctx.drawImage(im.mask,-b.x,-b.y,im.width,im.height);
  return new Promise((resolve,reject)=>c.toBlob(blob=>blob?resolve(blob):reject(Error('PNGを書き出せません')),'image/png'));
}
function saveBlob(blob,name){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);}

$('export').onclick=async()=>{
  const im=active();if(!ready(im))return;saving=true;updateButtons();
  try{saveBlob(await pngBlob(im),safeName(im.name)+'-cutout.png');toast('透過PNGを保存しました');}catch(e){toast(e.message);}finally{saving=false;updateButtons();}
};
$('export-batch').onclick=async()=>{
  const selected=images.filter(im=>im.selected&&ready(im));if(!selected.length)return;
  saving=true;updateButtons();
  try{
    const {zipSync}=await import('https://cdn.jsdelivr.net/npm/fflate@0.8.2/esm/browser.js');const files={};
    for(let i=0;i<selected.length;i++){const im=selected[i];files[String(i+1).padStart(2,'0')+'-'+safeName(im.name)+'-cutout.png']=new Uint8Array(await(await pngBlob(im)).arrayBuffer());}
    saveBlob(new Blob([zipSync(files,{level:0})],{type:'application/zip'}),'cutouts.zip');toast(selected.length+'枚を保存しました');
  }catch(e){toast(e.message);}finally{saving=false;updateButtons();}
};
navigator.serviceWorker?.addEventListener('message',({data})=>{
  if(data.type!=='model-cache'||!busy)return;
  if(data.phase==='download'||data.phase==='verified'||data.phase==='verify')watchWorker();
  if(data.phase==='download')reportProgress('初回の準備中 · '+(data.loaded/1e6).toFixed(1)+' / '+(data.total/1e6).toFixed(1)+' MB',data.total?data.loaded/data.total*100:undefined);
  if(data.phase==='verify')reportProgress('保存済みデータを確認しています');
  if(data.phase==='repair')reportProgress('処理に必要なデータを取り直しています');
});
async function boot(){
  if(!isSecureContext||!navigator.serviceWorker){
    engineError='HTTPSとService Workerに対応したブラウザで開いてください。';$('runtime').textContent='実行不可: '+engineError;draw();return;
  }
  let timer;
  try{
    await Promise.race([
      (async()=>{
        const registration=navigator.serviceWorker.register('./coi-serviceworker.js?v=imgly-v2',{updateViaCache:'none'});
        await registration;
        await navigator.serviceWorker.ready;
        if(!navigator.serviceWorker.controller)await new Promise(resolve=>navigator.serviceWorker.addEventListener('controllerchange',resolve,{once:true}));
        await new Promise(resolve=>{
          const sw=navigator.serviceWorker,token=String(Date.now());
          const check=()=>sw.controller?.postMessage({type:'model-store-version',token});
          const receive=({data})=>{
            if(data.type!=='model-store-version'||data.token!==token||data.version!=='imgly-v2')return;
            sw.removeEventListener('message',receive);sw.removeEventListener('controllerchange',check);resolve();
          };
          sw.addEventListener('message',receive);sw.addEventListener('controllerchange',check);check();
        });
      })(),
      new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Service Workerの準備がタイムアウトしました')),30000);})
    ]);
    if(!crossOriginIsolated&&!sessionStorage.getItem('kirinukiIsolationReload')){sessionStorage.setItem('kirinukiIsolationReload','1');location.reload();return;}
    if(crossOriginIsolated)sessionStorage.removeItem('kirinukiIsolationReload');
    bootReady=true;engineError='';$('runtime').textContent=crossOriginIsolated?'マルチスレッド対応':'シングルスレッド';processQueue();draw();
  }catch(e){engineError=e.message;$('runtime').textContent=e.message;draw();}finally{clearTimeout(timer);}
}
renderLibrary();renderObjects();boot();
