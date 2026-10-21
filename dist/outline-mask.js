// Reconstruct one silhouette from the selected regions. Image pixels always
// come from the original photo; this module only computes its final alpha.
function boxPass(input,width,height,radius,horizontal,dilate){
  const out=new Uint8Array(input.length),lines=horizontal?height:width,length=horizontal?width:height;
  const step=horizontal?1:width,span=radius*2+1;
  for(let line=0;line<lines;line++){
    const start=horizontal?line*width:line;let sum=0;
    for(let p=0;p<=radius&&p<length;p++)sum+=input[start+p*step];
    for(let p=0;p<length;p++){
      out[start+p*step]=dilate?Number(sum>0):Number(sum===span);
      if(p-radius>=0)sum-=input[start+(p-radius)*step];
      if(p+radius+1<length)sum+=input[start+(p+radius+1)*step];
    }
  }
  return out;
}
function closeSeams(input,width,height,radius){
  // Padding preserves silhouettes that touch the image border during erosion.
  const pad=2*radius,w=width+2*pad,h=height+2*pad;let work=new Uint8Array(w*h);
  for(let y=0;y<height;y++)work.set(input.subarray(y*width,(y+1)*width),(y+pad)*w+pad);
  work=boxPass(work,w,h,radius,true,true);
  work=boxPass(work,w,h,radius,false,true);
  work=boxPass(work,w,h,radius,true,false);
  work=boxPass(work,w,h,radius,false,false);
  const out=new Uint8Array(input.length);
  for(let y=0;y<height;y++)out.set(work.subarray((y+pad)*w+pad,(y+pad)*w+pad+width),y*width);
  return out;
}
function floodBackground(solid,width,height,seeds,fromBorder=false){
  const visited=new Uint8Array(solid.length),queue=new Int32Array(solid.length);let head=0,tail=0;
  const visit=i=>{if(!solid[i]&&!visited[i]){visited[i]=1;queue[tail++]=i;}};
  if(fromBorder){
    for(let x=0;x<width;x++){visit(x);visit((height-1)*width+x);}
    for(let y=0;y<height;y++){visit(y*width);visit(y*width+width-1);}
  }
  for(const i of seeds)visit(i);
  while(head<tail){
    const i=queue[head++],x=i%width;
    if(x>0)visit(i-1);if(x+1<width)visit(i+1);
    if(i>=width)visit(i-width);if(i+width<solid.length)visit(i+width);
  }
  return visited;
}
function excludedSeeds(objects,width,height){
  const seeds=new Set(),pixel=p=>({x:Math.max(0,Math.min(width-1,Math.round(p.x*(width-1)))),y:Math.max(0,Math.min(height-1,Math.round(p.y*(height-1))))});
  for(const o of objects){
    for(const p of o.points||[])if(p.label===0){const q=pixel(p);seeds.add(q.y*width+q.x);}
    for(const stroke of o.strokes||[])if(stroke.label===0&&stroke.path.length){
      let a=pixel(stroke.path[0]);seeds.add(a.y*width+a.x);
      for(const point of stroke.path.slice(1)){
        const b=pixel(point),steps=Math.max(Math.abs(b.x-a.x),Math.abs(b.y-a.y));
        for(let t=1;t<=steps;t++)seeds.add(Math.round(a.y+(b.y-a.y)*t/steps)*width+Math.round(a.x+(b.x-a.x)*t/steps));
        a=b;
      }
    }
  }
  return seeds;
}
export function buildOutlineMask(objects,width,height,threshold=0){
  const n=width*height,raw=new Uint8Array(n),solid=new Uint8Array(n);
  for(let i=0;i<n;i++){
    let value=-Infinity;
    for(const o of objects)value=Math.max(value,o.masks[o.choice*n+i]);
    raw[i]=Math.max(0,Math.min(255,Math.round((value+threshold+.4)/.8*255)));
    solid[i]=Number(raw[i]>=128);
  }
  const seeds=excludedSeeds(objects,width,height);
  const protectedBackground=seeds.size?floodBackground(solid,width,height,seeds):null;
  const radius=Math.max(1,Math.round(Math.max(width,height)/256));
  const closed=closeSeams(solid,width,height,radius);
  if(protectedBackground)for(let i=0;i<n;i++)if(protectedBackground[i])closed[i]=0;
  // Everything unreachable from the outside or an explicit exclusion belongs
  // inside the reconstructed outer contour, including holes between masks.
  const outside=floodBackground(closed,width,height,seeds,true),alpha=new Uint8Array(n);
  for(let i=0;i<n;i++){
    const x=i%width,y=Math.floor(i/width);let boundary=false,nearInside=false;
    for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
      if(x+dx<0||x+dx>=width||y+dy<0||y+dy>=height){boundary=true;continue;}
      const bg=outside[(y+dy)*width+x+dx];boundary ||= !!bg;nearInside ||= !bg;
    }
    if(!outside[i])alpha[i]=boundary&&raw[i]>0?raw[i]:255;
    else if(nearInside)alpha[i]=raw[i];
  }
  return alpha;
}
