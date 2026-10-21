// Stroke coordinates and radii are in original-image pixels, independent of
// preview size, device pixel ratio and the current crop.
export function applyErasures(ctx,strokes,bounds,width,height){
  if(!strokes?.length)return;
  ctx.save();ctx.globalCompositeOperation='destination-out';
  ctx.scale(width/bounds.width,height/bounds.height);ctx.translate(-bounds.x,-bounds.y);
  ctx.fillStyle='#000';ctx.strokeStyle='#000';ctx.lineCap='round';ctx.lineJoin='round';
  for(const stroke of strokes){
    if(!stroke.path.length)continue;
    const first=stroke.path[0];
    ctx.beginPath();ctx.arc(first.x,first.y,stroke.radius,0,Math.PI*2);ctx.fill();
    if(stroke.path.length>1){
      ctx.lineWidth=stroke.radius*2;ctx.beginPath();ctx.moveTo(first.x,first.y);
      for(let i=1;i<stroke.path.length;i++)ctx.lineTo(stroke.path[i].x,stroke.path[i].y);
      ctx.stroke();
    }
  }
  ctx.restore();
}
