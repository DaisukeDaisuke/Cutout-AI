// IMG.LY ISNet takes RGB / 256 - 0.5 at 1024 x 1024, without aspect padding.
export function isnetInput(image, size=1024){
  const {data,width,height,channels}=image,n=size*size,out=new Float32Array(n*3);
  for(let y=0;y<size;y++){
    const sy=y*height/size,y0=Math.floor(sy),y1=Math.min(height-1,Math.ceil(sy)),fy=sy-y0;
    for(let x=0;x<size;x++){
      const sx=x*width/size,x0=Math.floor(sx),x1=Math.min(width-1,Math.ceil(sx)),fx=sx-x0;
      for(let c=0;c<3;c++){
        const v=data[(y0*width+x0)*channels+c]*(1-fx)*(1-fy)+data[(y0*width+x1)*channels+c]*fx*(1-fy)+data[(y1*width+x0)*channels+c]*(1-fx)*fy+data[(y1*width+x1)*channels+c]*fx*fy;
        out[c*n+y*size+x]=(Math.trunc(v)-128)/256;
      }
    }
  }
  return out;
}
export function resizeAlpha(data,sw,sh,width,height){
  const out=new Float32Array(width*height);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const sx=Math.min(sw-1,x*sw/width),sy=Math.min(sh-1,y*sh/height),x0=Math.floor(sx),y0=Math.floor(sy),x1=Math.min(sw-1,x0+1),y1=Math.min(sh-1,y0+1),fx=sx-x0,fy=sy-y0;
    out[y*width+x]=Math.max(0,Math.min(1,(data[y0*sw+x0]*(1-fx)+data[y0*sw+x1]*fx)*(1-fy)+(data[y1*sw+x0]*(1-fx)+data[y1*sw+x1]*fx)*fy));
  }
  return out;
}
export function alphaToMask(alpha){return alpha<=.01?-8:alpha>=.99?8:alpha*.8-.4;}
// Keep complete foreground components touched by a stroke, including soft edges.
export function selectForeground(alpha,width,height,points){
  const n=width*height,labels=new Int32Array(n),queue=new Int32Array(n);let count=0;
  for(let start=0;start<n;start++){
    if(labels[start]||alpha[start]<.03)continue;
    let head=0,tail=1;queue[0]=start;labels[start]=++count;
    while(head<tail){
      const i=queue[head++],x=i%width,y=Math.floor(i/width);
      for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
        if(x+dx<0||x+dx>=width||y+dy<0||y+dy>=height)continue;
        const j=(y+dy)*width+x+dx;
        if(!labels[j]&&alpha[j]>=.03){labels[j]=count;queue[tail++]=j;}
      }
    }
  }
  const positive=new Set(),negative=new Set();let expand=false;
  for(const p of points){
    const x=Math.min(width-1,Math.max(0,Math.floor(p.x*width))),y=Math.min(height-1,Math.max(0,Math.floor(p.y*height)));
    const id=labels[y*width+x];
    if(p.label){if(id)positive.add(id);if(!id||alpha[y*width+x]<.1)expand=true;}
    else if(id)negative.add(id);
  }
  const clip=new Set([...positive].filter(id=>negative.has(id))),selected=new Float32Array(n);
  for(let i=0;i<n;i++)if(positive.has(labels[i]))selected[i]=alpha[i];
  return {alpha:selected,labels,clip,needsRefinement:expand||clip.size>0};
}
export function combineForeground(selection,samMasks,scores,width,height,points,rankMasks){
  const n=width*height,out=new Float32Array(samMasks.length);
  for(let c=0;c<scores.length;c++)for(let i=0;i<n;i++){
    const sam=Math.max(0,Math.min(1,(samMasks[c*n+i]+.4)/.8));
    const alpha=selection.clip.has(selection.labels[i])?Math.min(selection.alpha[i],sam):Math.max(selection.alpha[i],sam);
    out[c*n+i]=alphaToMask(alpha);
  }
  return {masks:out,scores:rankMasks(out,scores,width,height,points)};
}
