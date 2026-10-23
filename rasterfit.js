/* DAISO v0.3: in-browser raster-feedback fitting for Goodnotes ballpoint ink.
 * No server, no WASM, no external library. Keeps original v0.2 stroke topology.
 * Optimize union-mask F1 using Canvas 2D as a surrogate stroke rasterizer.
 * This is NOT the official Goodnotes rendering engine.
 */
const MIN_WIDTH_PT=0.35, MAX_WIDTH_PT=6, PAGE_WIDTH_PT=540;
const GLOBAL_GAINS=[.24,.42,.55,.70,.82,.94,1.02,1.10,1.18,1.28,1.40];
const sleepFrame=()=>new Promise(r=>setTimeout(r,0));
const clamp=(x,a,b)=>Math.min(b,Math.max(a,x));
const f1=(tp,fp,fn)=>2*tp/Math.max(1,2*tp+fp+fn);

function prepareItems(vector){
  const {width:w,height:h}=vector.page;
  if(!(w>=100&&h>=100))throw new Error('不正なページサイズです');
  if(!vector.strokes?.length)throw new Error('ベクター線がありません');
  return vector.strokes.filter(s=>s.points.length>=2).map(stroke=>{
    const pts=stroke.points;
    const path=new Path2D();path.moveTo(pts[0].x,pts[0].y);
    let minX=pts[0].x,minY=pts[0].y,maxX=pts[0].x,maxY=pts[0].y;
    for(let k=1;k<pts.length;k++){
      const p=pts[k];path.lineTo(p.x,p.y);
      minX=Math.min(minX,p.x);minY=Math.min(minY,p.y);
      maxX=Math.max(maxX,p.x);maxY=Math.max(maxY,p.y);
    }
    const pad=18;
    const left=clamp(Math.floor(minX)-pad,0,w),top=clamp(Math.floor(minY)-pad,0,h);
    const right=clamp(Math.ceil(maxX)+pad+1,0,w),bottom=clamp(Math.ceil(maxY)+pad+1,0,h);
    if(right<=left||bottom<=top)throw new Error('空のストロークが含まれています');
    return {stroke,path,rect:{left,top,right,bottom,width:right-left,height:bottom-top},
      width:Math.max(.1,Number(stroke.mean_width)||2)};
  });
}

class PatchRasterizer{
  constructor(supersample=2,pageWidth=1200){
    this.scale=Math.max(1,Math.min(3,supersample|0));
    this.minWidth=MIN_WIDTH_PT*pageWidth/PAGE_WIDTH_PT;
    this.maxWidth=MAX_WIDTH_PT*pageWidth/PAGE_WIDTH_PT;
    this.hi=document.createElement('canvas');
    this.low=document.createElement('canvas');
  }
  draw(item,width,dx=0,dy=0){
    const {left,top,width:rw,height:rh}=item.rect,scale=this.scale;
    const hi=this.hi,low=this.low;
    if(hi.width!==rw*scale||hi.height!==rh*scale){hi.width=rw*scale;hi.height=rh*scale;}
    if(low.width!==rw||low.height!==rh){low.width=rw;low.height=rh;}
    const ctx=hi.getContext('2d',{alpha:true});
    // Always clear: setting dimensions above only clears on resize.
    ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,hi.width,hi.height);
    ctx.setTransform(scale,0,0,scale,(dx-left)*scale,(dy-top)*scale);
    ctx.strokeStyle='#000';ctx.lineWidth=clamp(width,this.minWidth,this.maxWidth);ctx.lineCap='round';ctx.lineJoin='round';
    ctx.stroke(item.path);
    const down=low.getContext('2d',{willReadFrequently:true,alpha:true});
    down.setTransform(1,0,0,1,0,0);down.clearRect(0,0,rw,rh);
    down.imageSmoothingEnabled=true;down.imageSmoothingQuality='high';
    down.drawImage(hi,0,0,rw,rh);
    const rgba=down.getImageData(0,0,rw,rh).data;
    const out=new Uint8Array(rw*rh);
    for(let i=0,j=3;i<out.length;i++,j+=4)out[i]=rgba[j]>127?1:0;
    return out;
  }
}
function scoreCounts(counts,target){
  let tp=0,fp=0,fn=0;
  for(let i=0;i<counts.length;i++){
    if(counts[i]>0){if(target[i])tp++;else fp++;}
    else if(target[i])fn++;
  }
  return {tp,fp,fn,f1:f1(tp,fp,fn)};
}
function accumulate(counts,pageWidth,item,patch,sign){
  const {left,top,width:rw,height:rh}=item.rect;
  for(let y=0;y<rh;y++){
    let offset=(top+y)*pageWidth+left,src=y*rw;
    for(let x=0;x<rw;x++)if(patch[src+x])counts[offset+x]+=sign;
  }
}
function stateForGain(items,w,h,gain,raster){
  const counts=new Uint16Array(w*h),layers=[];
  for(const item of items){
    const layer=raster.draw(item,item.width*gain);
    layers.push(layer);accumulate(counts,w,item,layer,1);
  }
  return {counts,layers,gains:new Float32Array(items.length).fill(gain),
    shifts:new Float32Array(items.length*2)};
}
async function selectGain(items,target,w,h,raster,onProgress){
  let best=null;
  const scans=[];
  for(let i=0;i<GLOBAL_GAINS.length;i++){
    const gain=GLOBAL_GAINS[i];
    const counts=new Uint8Array(w*h);
    for(const item of items){
      const patch=raster.draw(item,item.width*gain),{left,top,width:rw,height:rh}=item.rect;
      for(let y=0;y<rh;y++){
        let off=(top+y)*w+left,j=y*rw;
        for(let x=0;x<rw;x++)if(patch[j+x])counts[off+x]=1;
      }
    }
    const m=scoreCounts(counts,target);scans.push({gain,f1:m.f1});
    if(!best||m.f1>best.f1)best={gain,f1:m.f1};
    onProgress?.({stage:'gain',done:i+1,total:GLOBAL_GAINS.length,detail:`線幅の自動調整 ${i+1}/${GLOBAL_GAINS.length}`});
    await sleepFrame();
  }
  return {gain:best.gain,scans};
}
const CANDIDATES=[
  {width:.86,dx:0,dy:0},{width:.93,dx:0,dy:0},
  {width:1.07,dx:0,dy:0},{width:1.14,dx:0,dy:0},
  {width:1.0,dx:.45,dy:0},{width:1.0,dx:-.45,dy:0},
  {width:1.0,dx:0,dy:.45},{width:1.0,dx:0,dy:-.45},
  {width:1.0,dx:.45,dy:.45},{width:1.0,dx:.45,dy:-.45},
  {width:1.0,dx:-.45,dy:.45},{width:1.0,dx:-.45,dy:-.45}
];
async function localFit(items,target,w,state,gain0,raster,passes,onProgress){
  let totals=scoreCounts(state.counts,target),n=items.length;
  const history=[];
  for(let pass=0;pass<passes;pass++){
    let changed=0;
    for(let i=0;i<n;i++){
      const item=items[i],rect=item.rect,{left,top,width:rw,height:rh}=rect;
      const previous=state.layers[i];
      let oldtp=0,oldfp=0,oldfn=0;
      // Compute old ROI contribution to global counts.
      for(let y=0;y<rh;y++){
        const off=(top+y)*w+left,row=y*rw;
        for(let x=0;x<rw;x++){
          const idx=off+x,truth=target[idx],present=state.counts[idx]>0;
          if(present){if(truth)oldtp++;else oldfp++;}
          else if(truth)oldfn++;
        }
      }
      let choice=null,best=totals.f1;
      const shiftX=state.shifts[i*2],shiftY=state.shifts[i*2+1];
      for(const proposal of CANDIDATES){
        const g=state.gains[i]*proposal.width;
        const dx=shiftX+proposal.dx,dy=shiftY+proposal.dy;
        if(g<gain0*.65||g>gain0*1.4||Math.max(Math.abs(dx),Math.abs(dy))>.8)continue;
        const patch=raster.draw(item,item.width*g,dx,dy);
        let tp=totals.tp-oldtp,fp=totals.fp-oldfp,fn=totals.fn-oldfn;
        for(let y=0;y<rh;y++){
          const off=(top+y)*w+left,row=y*rw;
          for(let x=0;x<rw;x++){
            const k=row+x,idx=off+x;
            const present=state.counts[idx]-previous[k]+patch[k]>0;
            if(present){if(target[idx])tp++;else fp++;}
            else if(target[idx])fn++;
          }
        }
        const value=f1(tp,fp,fn);
        if(value>best+0.000007){best=value;choice={patch,g,dx,dy,tp,fp,fn,f1:value};}
      }
      if(choice){
        accumulate(state.counts,w,item,previous,-1);
        accumulate(state.counts,w,item,choice.patch,1);
        state.layers[i]=choice.patch;state.gains[i]=choice.g;
        state.shifts[i*2]=choice.dx;state.shifts[i*2+1]=choice.dy;
        totals={tp:choice.tp,fp:choice.fp,fn:choice.fn,f1:choice.f1};
        changed++;
      }
      if(i%8===0||i===n-1){
        onProgress?.({stage:'fit',done:pass*n+i+1,total:passes*n,
          detail:`筆跡の微調整 ${pass+1}/${passes}周：${i+1}/${n}本`});
        await sleepFrame();
      }
    }
    history.push({pass:pass+1,changed,f1:totals.f1});
    if(!changed)break;
  }
  return {totals,history};
}
/**
 * @param ink The original ink mask from extractInk. Source of truth.
 * @param vector A traceStrokes() return value (same page coordinate frame).
 * @param onProgress Callback called on main thread, UI can update.
 */
export async function fitRasterInk(ink,vector,{onProgress,passes=2,supersample=2}={}){
  if(ink.width!==vector.page.width||ink.height!==vector.page.height)throw new Error('筆跡画像と座標の大きさが異なります');
  const items=prepareItems(vector),w=ink.width,h=ink.height,target=ink.mask;
  const raster=new PatchRasterizer(supersample,w);
  const start=performance.now();
  const {gain,scans}=await selectGain(items,target,w,h,raster,onProgress);
  const state=stateForGain(items,w,h,gain,raster);
  const initial=scoreCounts(state.counts,target);
  const {totals,history}=await localFit(items,target,w,state,gain,raster,passes,onProgress);
  const minSource=MIN_WIDTH_PT*w/PAGE_WIDTH_PT,maxSource=MAX_WIDTH_PT*w/PAGE_WIDTH_PT;
  const strokes=items.map((item,i)=>{
    const dx=state.shifts[2*i],dy=state.shifts[2*i+1];
    const width=clamp(item.width*state.gains[i],minSource,maxSource);
    return {mean_width:width,points:item.stroke.points.map(p=>({
      x:clamp(p.x+dx,0,w-1),y:clamp(p.y+dy,0,h-1),w:width}))};
  });
  const baselineGain=.24;
  const baselineState=stateForGain(items,w,h,baselineGain,raster);
  const baseline=scoreCounts(baselineState.counts,target);
  return {page:{width:w,height:h},strokes,summary:{...vector.summary,
    rasterFit:{before:baseline.f1,global:initial.f1,after:totals.f1,
      gain,history,scans,seconds:Math.round((performance.now()-start)/100)/10,
      surrogate:true}}};
}
