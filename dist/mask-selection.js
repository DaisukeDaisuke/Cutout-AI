// All stroke samples check the result. Only missed samples become SAM prompts.
export function maskValue(data,offset,width,height,p){
  const x=Math.max(0,Math.min(width-1,p.x*width-.5)),y=Math.max(0,Math.min(height-1,p.y*height-.5));
  const x0=Math.floor(x),y0=Math.floor(y),x1=Math.min(width-1,x0+1),y1=Math.min(height-1,y0+1),fx=x-x0,fy=y-y0;
  return (data[offset+y0*width+x0]*(1-fx)+data[offset+y0*width+x1]*fx)*(1-fy)+(data[offset+y1*width+x0]*(1-fx)+data[offset+y1*width+x1]*fx)*fy;
}
export function rankMasks(data,scores,width,height,points){
  const counts=[points.filter(p=>p.label===0).length,points.filter(p=>p.label===1).length];
  return scores.map((score,c)=>{
    const misses=[0,0];
    for(const p of points)if((maskValue(data,c*width*height,width,height,p)>0)!==!!p.label)misses[p.label]++;
    const groups=counts.filter(Boolean).length;
    return score-4*(misses[0]/(counts[0]||1)+misses[1]/(counts[1]||1))/groups;
  });
}
export function nextCorrection(data,offset,width,height,points,used){
  let index=-1,worst=0;
  points.forEach((p,i)=>{
    if(used.includes(i))return;
    const value=maskValue(data,offset,width,height,p),violation=p.label?-value:value;
    if(violation>worst){worst=violation;index=i;}
  });
  return index;
}
// Drop disconnected predictions that no positive stroke touched.
export function retainTouchedComponents(data,width,height,points){
  const n=width*height,seen=new Uint8Array(n),queue=new Int32Array(n),anchors=new Uint8Array(n),kept=new Uint8Array(n);
  for(const p of points)if(p.label===1){
    const x=Math.min(width-1,Math.max(0,Math.round(p.x*width-.5))),y=Math.min(height-1,Math.max(0,Math.round(p.y*height-.5)));
    for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)if(x+dx>=0&&x+dx<width&&y+dy>=0&&y+dy<height)anchors[(y+dy)*width+x+dx]=1;
  }
  for(let start=0;start<n;start++){
    if(seen[start]||data[start]<=0)continue;
    let head=0,tail=1,touched=false;queue[0]=start;seen[start]=1;
    while(head<tail){
      const i=queue[head++],x=i%width,y=Math.floor(i/width);touched ||= !!anchors[i];
      for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
        if(x+dx<0||x+dx>=width||y+dy<0||y+dy>=height)continue;
        const j=(y+dy)*width+x+dx;
        if(!seen[j]&&data[j]>0){seen[j]=1;queue[tail++]=j;}
      }
    }
    for(let i=0;i<tail;i++)if(touched)kept[queue[i]]=1;else data[queue[i]]=-8;
  }
  // An unselected island's negative edge logits can still be translucent.
  // Preserve soft edges only immediately around a retained component.
  for(let i=0;i<n;i++)if(!kept[i]&&data[i]>-8){
    const x=i%width,y=Math.floor(i/width);let edge=false;
    for(let dy=-1;dy<=1&&!edge;dy++)for(let dx=-1;dx<=1;dx++){
      if(x+dx>=0&&x+dx<width&&y+dy>=0&&y+dy<height&&kept[(y+dy)*width+x+dx]){edge=true;break;}
    }
    if(!edge)data[i]=-8;
  }
  return data;
}
