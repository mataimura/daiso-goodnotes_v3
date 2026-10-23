/* Browser-side photo -> extracted teal ink -> pseudo vector stroke paths.
 * No uploads, requests, external CV library, or remote processing.
 * Heuristics tuned for DAISO 10.5-inch portrait LCD memo pad.
 */
export const OUTPUT_W=1200, OUTPUT_H=1600;
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const lerp=(a,b,t)=>a+(b-a)*t;

function grayscale(image){
  const {width:w,height:h,data:d}=image;
  const g=new Float32Array(w*h);
  for(let i=0,j=0;i<g.length;i++,j+=4)g[i]=.299*d[j]+.587*d[j+1]+.114*d[j+2];
  return g;
}
function blur1D(v,r){
  // Symmetric moving-average, enough for robust device boundary estimates.
  const p=new Float32Array(v.length+1),a=new Float32Array(v.length);
  for(let i=0;i<v.length;i++)p[i+1]=p[i]+v[i];
  for(let i=0;i<v.length;i++){
    const lo=Math.max(0,i-r),hi=Math.min(v.length,i+r+1);
    a[i]=(p[hi]-p[lo])/(hi-lo);
  }
  return a;
}
function quantile(values,q=.5){
  if(!values.length)return 0;
  values.sort((a,b)=>a-b);return values[Math.floor(q*(values.length-1))];
}
function approxDevice(gray,w,h){
  const occ=new Float32Array(h), med=new Float32Array(h);
  const a=Math.round(.12*w),b=Math.round(.72*w),cx0=Math.round(.24*w),cx1=Math.round(.68*w);
  for(let y=0;y<h;y++){
    let dark=0,c=0;const samples=[];
    for(let x=a;x<b;x+=3){if(gray[y*w+x]<165)dark++;c++;}
    occ[y]=dark/c;
    for(let x=cx0;x<cx1;x+=7)samples.push(gray[y*w+x]);
    med[y]=quantile(samples);
  }
  const sm=blur1D(occ,3);let top=-1;
  for(let y=0;y<.5*h;y++)if(sm[y]>.40){top=y;break;}
  if(top<0) throw new Error('本体の位置を自動検出できません。四隅を手動で調整してください。');
  const rows=blur1D(med,4);
  let start=Math.max(Math.floor(.77*h),Math.floor(top+.55*h));
  let end=Math.min(h-10,Math.floor(.985*h));
  if(start>=end) throw new Error('写真全体に電子メモを入れて撮影してください。');
  let max=-1,bottom=start;
  for(let y=start;y<end;y++){
    const g=Math.abs(rows[Math.min(h-1,y+1)]-rows[Math.max(0,y-1)]);
    if(g>max){max=g;bottom=y;}
  }
  if(bottom-top<h*.50)throw new Error('電子メモの上下端を判定できませんでした。');
  return {top,bottom};
}
const pix=(gray,w,h,x,y)=>gray[clamp(Math.round(y),0,h-1)*w+clamp(Math.round(x),0,w-1)];

function candidateLine(gray,w,h,kind,prior,opts){
  const {range,slopeMin,slopeMax,slopeStep,posStep,samples,center,sign=0,offset=3,priorSigma=25}=opts;
  const matches=[];
  for(let p=prior-range;p<=prior+range;p+=posStep){
    for(let s=slopeMin;s<=slopeMax+1e-6;s+=slopeStep){
      const diffs=[];let inner=0;
      for(const q of samples){
        const loc=p+s*(q-center);
        if(kind==='vertical'){
          if(loc<offset+2||loc>=w-offset-2)continue;
          const e=pix(gray,w,h,loc+offset,q)-pix(gray,w,h,loc-offset,q);
          diffs.push(sign?e*sign:Math.abs(e));
        } else {
          if(loc<offset+2||loc>=h-offset-2)continue;
          const e=pix(gray,w,h,q,loc+offset)-pix(gray,w,h,q,loc-offset);
          diffs.push(sign?e*sign:Math.abs(e));
        }
      }
      if(diffs.length<samples.length*.78)continue;
      const med=quantile(diffs);
      const trim=quantile(diffs,.7);
      const signal=Math.max(0,med)*.75+Math.max(0,trim)*.25;
      // Priors encourage an actual LCD edge over an unrelated straight object.
      const penalty=Math.exp(-.08*((p-prior)/priorSigma)**2);
      const score=signal*penalty;
      if(score>0)matches.push({p,s,score,signal});
    }
  }
  matches.sort((a,b)=>b.score-a.score);
  if(!matches.length)throw new Error('液晶画面の輪郭を検出できません。');
  return matches[0];
}
function intersect(vLine,hLine,w,h){
  const sv=vLine.s,sh=hLine.s;
  const y=(hLine.p+sh*(vLine.p-w/2-sv*h/2))/(1-sh*sv);
  return {x:vLine.p+sv*(y-h/2),y};
}
function areaQuad(q){
  let a=0;for(let i=0;i<4;i++){const j=(i+1)%4;a+=q[i].x*q[j].y-q[j].x*q[i].y;}
  return Math.abs(a/2);
}
function distance(p,q){return Math.hypot(p.x-q.x,p.y-q.y);}

function localTexture(gray,w,h){
  const sq=new Float32Array(gray.length);
  for(let i=0;i<sq.length;i++)sq[i]=gray[i]*gray[i];
  const avg=boxBlur(gray,w,h,2),avg2=boxBlur(sq,w,h,2);
  const tex=new Float32Array(gray.length);
  for(let i=0;i<tex.length;i++)tex[i]=Math.min(24,Math.sqrt(Math.max(0,avg2[i]-avg[i]*avg[i])));
  return tex;
}
function lineByTexture(tex,w,h,side){
  const horizontal=side==='bottom';
  const samples=horizontal?
    Array.from({length:70},(_,i)=>w*(.18+.64*i/69)):
    Array.from({length:75},(_,i)=>h*(.19+.61*i/74));
  const signed=side==='left'||side==='bottom'?1:-1;
  const center=horizontal?w/2:h/2;
  const pMin=horizontal?.78*h:(side==='left'?.045*w:.77*w);
  const pMax=horizontal?.947*h:(side==='left'?.19*w:.97*w);
  const slopeMin=horizontal?-.105:-.135;
  const slopeMax=horizontal?.105:.135;
  const pStep=1.8,slopeStep=.009;
  const off=12;
  let best=null;
  for(let p=pMin;p<=pMax;p+=pStep){
    for(let s=slopeMin;s<=slopeMax+1e-6;s+=slopeStep){
      const diffs=[];
      for(const sample of samples){
        const pos=p+s*(sample-center);
        if(horizontal){
          if(pos<off+2||pos>h-off-2)continue;
          diffs.push(pix(tex,w,h,sample,pos+off)-pix(tex,w,h,sample,pos-off));
        }else{
          if(pos<off+2||pos>w-off-2)continue;
          const out=pix(tex,w,h,pos-off,sample),inside=pix(tex,w,h,pos+off,sample);
          diffs.push(signed*(out-inside));
        }
      }
      if(diffs.length<samples.length*.85)continue;
      const med=quantile(diffs,.5),q65=quantile(diffs,.65);
      const signal=.76*med+.24*q65;
      const sc=signal*Math.exp(-.06*(s/.085)**2);
      if(!best||sc>best.score)best={p,s,score:sc,signal};
    }
  }
  if(!best||best.signal<5)throw new Error('画像の液晶の縁が不鮮明です。四隅を修正してください。');
  return best;
}
function topCloseup(gray,w,h){
 const samples=Array.from({length:81},(_,i)=>w*(.14+.72*i/80));
 let best=null;
 for(let p=.055*h;p<=.115*h;p+=1.4){
  for(let s=-.08;s<=.08+1e-6;s+=.006){
   const ds=[];
   for(const x of samples){
    const y=p+s*(x-w/2);
    if(y<8||y>h-8)continue;
    const signed=pix(gray,w,h,x,y+3)-pix(gray,w,h,x,y-3);
    ds.push(signed);
   }
   const med=quantile(ds,.5),q65=quantile(ds,.65);
   const signal=Math.max(0,med)*.75+Math.max(0,q65)*.25;
   const sc=signal*Math.exp(-.02*(s/.04)**2)*Math.exp(-.03*((p-.075*h)/(.04*h))**2);
   if(!best||sc>best.score)best={p,s,score:sc,signal};
  }
 }
 if(!best||best.signal<2.2)throw new Error('画面上端を検出できません。四隅を修正してください。');
 return best;
}
function closeupScreen(image){
 const w=image.width,h=image.height,gray=grayscale(image),tex=localTexture(gray,w,h);
 const left=lineByTexture(tex,w,h,'left');
 const right=lineByTexture(tex,w,h,'right');
 const bottom=lineByTexture(tex,w,h,'bottom');
 const top=topCloseup(gray,w,h);
 const inner={
  left:{p:left.p-12,s:left.s},
  right:{p:right.p+4,s:right.s},
  bottom:{p:bottom.p+3,s:bottom.s},
  top:{p:top.p+2,s:top.s}
 };
 const q=[intersect(inner.left,inner.top,w,h),intersect(inner.right,inner.top,w,h),
   intersect(inner.right,inner.bottom,w,h),intersect(inner.left,inner.bottom,w,h)];
 const ratio=(distance(q[0],q[1])+distance(q[2],q[3]))/(distance(q[0],q[3])+distance(q[1],q[2]));
 if(!(ratio>.55&&ratio<.91)||areaQuad(q)<w*h*.38||q.some(p=>p.x<2||p.x>w-2||p.y<2||p.y>h-2))
   throw new Error('液晶の四辺を確実に検出できませんでした。四隅を修正してください。');
 return {quad:q,metrics:{mode:'closeup-v4',ratio,area:areaQuad(q),edges:{left,right,top,bottom}}};
}

// Inputs in detector-scale image coordinates; called on downscaled image.
export function detectScreen(image){
  const w=image.width,h=image.height,gray=grayscale(image);
  const {top,bottom}=approxDevice(gray,w,h);
  if(top <= 5) return closeupScreen(image);
  const dh=bottom-top;
  const outerSamples=Array.from({length:48},(_,i)=>top+dh*(.20+.59*i/47));
  const outerL=candidateLine(gray,w,h,'vertical',.055*w,{
    range:.060*w,posStep:3.5,slopeMin:-.20,slopeMax:.20,slopeStep:.025,
    samples:outerSamples,center:h/2,sign:-1,offset:8,priorSigma:.070*w
  });
  const outerR=candidateLine(gray,w,h,'vertical',.87*w,{
    range:.105*w,posStep:3.5,slopeMin:-.20,slopeMax:.20,slopeStep:.025,
    samples:outerSamples,center:h/2,sign:1,offset:8,priorSigma:.090*w
  });
  let ow=outerR.p-outerL.p;
  if(ow<.42*w||ow>.99*w)throw new Error('本体幅の検出に失敗しました。');
  const prior={
    left:outerL.p+.05*ow,right:outerR.p-.06*ow,
    top:top+.085*dh,bottom:bottom-.105*dh
  };
  const vertSamples=Array.from({length:65},(_,i)=>prior.top+dh*(.06+.72*i/64));
  const horizSamples=Array.from({length:55},(_,i)=>prior.left+ow*(.07+.74*i/54));
  const inner={};
  for(const side of ['left','right']){
    inner[side]=candidateLine(gray,w,h,'vertical',prior[side],{
      range:.070*ow,posStep:2,slopeMin:-.24,slopeMax:.24,slopeStep:.015,
      samples:vertSamples,center:h/2,offset:3,priorSigma:.055*ow
    });
  }
  for(const side of ['top','bottom']){
    inner[side]=candidateLine(gray,w,h,'horizontal',prior[side],{
      range:.05*dh,posStep:2,slopeMin:-.15,slopeMax:.15,slopeStep:.012,
      samples:horizSamples,center:w/2,offset:3,priorSigma:.035*dh
    });
  }
  const q=[intersect(inner.left,inner.top,w,h),intersect(inner.right,inner.top,w,h),
    intersect(inner.right,inner.bottom,w,h),intersect(inner.left,inner.bottom,w,h)];
  // In DAISO 10.5-inch photos the strongest edge is the *outer LCD bezel*.
  // The actual writable surface sits one border-width inside. The calibrated
  // inset below is based on two photographed samples of this exact model.
  // Users can correct the 4 corners interactively if their camera angle differs.
  for(let i=0;i<4;i++){
    q[i].x+=(i===0||i===3?1:-1)*.048*w;
    if(i<2)q[i].y+=.040*h;
  }
  const vw=(distance(q[0],q[1])+distance(q[3],q[2]))/2;
  const vh=(distance(q[0],q[3])+distance(q[1],q[2]))/2;
  const ratio=vw/vh;
  if(!(ratio>.50&&ratio<.96)&&!(areaQuad(q)>.20*w*h))
    throw new Error('画面の形状が不自然です。四隅を調整してください。');
  if(areaQuad(q)<w*h*.22||q.some(p=>p.x<3||p.x>w-3||p.y<3||p.y>h-3))
    throw new Error('画面全体が写真に入りきっていない可能性があります。');
  return {quad:q,metrics:{ratio,area:areaQuad(q),device:[top,bottom],edges:inner}};
}

// Homography: output (u,v) -> source (x,y). Gaussian elimination on 8x8 system.
function solveLinear(A,b){
  const n=b.length,a=A.map((r,i)=>r.concat(b[i]));
  for(let c=0;c<n;c++){
    let max=c;for(let r=c+1;r<n;r++)if(Math.abs(a[r][c])>Math.abs(a[max][c]))max=r;
    if(Math.abs(a[max][c])<1e-9)throw new Error('射影変換を計算できません');
    [a[c],a[max]]=[a[max],a[c]];
    const v=a[c][c];for(let k=c;k<=n;k++)a[c][k]/=v;
    for(let r=0;r<n;r++)if(r!==c){const f=a[r][c];for(let k=c;k<=n;k++)a[r][k]-=f*a[c][k];}
  }
  return a.map(row=>row[n]);
}
function homography(srcQuad,dw,dh){
  const a=[],b=[];
  const target=[[0,0],[dw-1,0],[dw-1,dh-1],[0,dh-1]];
  for(let i=0;i<4;i++){
    const [u,v]=target[i],{x,y}=srcQuad[i];
    a.push([u,v,1,0,0,0,-x*u,-x*v]);b.push(x);
    a.push([0,0,0,u,v,1,-y*u,-y*v]);b.push(y);
  }
  return solveLinear(a,b);
}
export function rectify(src,quad,{width=OUTPUT_W,height=OUTPUT_H,inset=10}={}){
  const M=homography(quad,width,height),s=src.data,sw=src.width,sh=src.height;
  const out=new Uint8ClampedArray(width*height*4);
  // Like Python's post-warp cropped inset then resize, but map directly.
  for(let y=0;y<height;y++){
    const v=inset+y*(height-1-2*inset)/(height-1);
    for(let x=0;x<width;x++){
      const u=inset+x*(width-1-2*inset)/(width-1);
      const den=M[6]*u+M[7]*v+1;
      const xx=(M[0]*u+M[1]*v+M[2])/den;
      const yy=(M[3]*u+M[4]*v+M[5])/den;
      const dx=clamp(xx,0,sw-1.001),dy=clamp(yy,0,sh-1.001);
      const x0=Math.floor(dx),y0=Math.floor(dy),tx=dx-x0,ty=dy-y0;
      const i0=(y0*sw+x0)*4,i1=i0+4,i2=i0+sw*4,i3=i2+4,o=(y*width+x)*4;
      for(let c=0;c<3;c++)out[o+c]=(1-ty)*((1-tx)*s[i0+c]+tx*s[i1+c])+ty*((1-tx)*s[i2+c]+tx*s[i3+c]);
      out[o+3]=255;
    }
  }
  return new ImageData(out,width,height);
}

function boxBlur(src,w,h,r){
  const tmp=new Float32Array(w*h),dst=new Float32Array(w*h);
  for(let y=0;y<h;y++){
    const row=y*w;let sum=0;
    for(let x=0;x<=r&&x<w;x++)sum+=src[row+x];
    for(let x=0;x<w;x++){
      if(x>0){const gain=x+r< w?src[row+x+r]:0;const loss=x-r-1>=0?src[row+x-r-1]:0;sum+=gain-loss;}
      tmp[row+x]=sum/(Math.min(w-1,x+r)-Math.max(0,x-r)+1);
    }
  }
  for(let x=0;x<w;x++){
    let sum=0;
    for(let y=0;y<=r&&y<h;y++)sum+=tmp[y*w+x];
    for(let y=0;y<h;y++){
      if(y>0){sum+=(y+r<h?tmp[(y+r)*w+x]:0)-(y-r-1>=0?tmp[(y-r-1)*w+x]:0);}
      dst[y*w+x]=sum/(Math.min(h-1,y+r)-Math.max(0,y-r)+1);
    }
  }
  return dst;
}
const NEIGHBOR8=[-1,1,0,0,-1,1,-1,1];
// 8-connected component classification in a single pass; note no blanket
// morphological opening because it damaged the 2-sigma denominator on Mac.
export function extractInk(image,{low=9,high=24}={}){
  const {width:w,height:h,data}=image,n=w*h;
  const chroma=new Float32Array(n);
  for(let i=0,p=0;i<n;i++,p+=4){const r=data[p],g=data[p+1],b=data[p+2];chroma[i]=Math.min(g-r,b-r);}
  const base=boxBlur(chroma,w,h,24);
  const score=new Float32Array(n),weak=new Uint8Array(n),strong=new Uint8Array(n);
  for(let i=0;i<n;i++)score[i]=chroma[i]-base[i];
  const smooth=boxBlur(score,w,h,1);
  for(let i=0;i<n;i++){
    const v=smooth[i];if(v>=low)weak[i]=1;if(v>=high)strong[i]=1;
  }
  const mask=new Uint8Array(n),visited=new Uint8Array(n),queue=new Int32Array(n);
  let minX=w,minY=h,maxX=0,maxY=0,ink=0;
  const offsets=[[-1,-1],[0,-1],[1,-1],[-1,0],[1,0],[-1,1],[0,1],[1,1]];
  for(let i=0;i<n;i++){
    if(!weak[i]||visited[i])continue;
    let head=0,tail=1,area=0,seed=false;
    let cx0=w,cy0=h,cx1=0,cy1=0;queue[0]=i;visited[i]=1;
    while(head<tail){
      const cur=queue[head++],x=cur%w,y=(cur-x)/w;
      area++;if(strong[cur])seed=true;
      cx0=Math.min(cx0,x);cy0=Math.min(cy0,y);cx1=Math.max(cx1,x);cy1=Math.max(cy1,y);
      for(const [dx,dy]of offsets){
        const nx=x+dx,ny=y+dy;if(nx<0||ny<0||nx>=w||ny>=h)continue;
        const j=ny*w+nx;if(!weak[j]||visited[j])continue;visited[j]=1;queue[tail++]=j;
      }
    }
    const bw=cx1-cx0+1,bh=cy1-cy0+1;
    const thin=area>=18&&Math.max(bw,bh)>=25&&Math.max(bw,bh)/Math.max(1,Math.min(bw,bh))>=2;
    if(area>=6&&(seed||thin)){
      for(let k=0;k<tail;k++)mask[queue[k]]=1;
      ink+=area;minX=Math.min(minX,cx0);minY=Math.min(minY,cy0);maxX=Math.max(maxX,cx1);maxY=Math.max(maxY,cy1);
    }
  }
  if(ink<35)throw new Error('筆跡を抽出できません。光の反射を避けて撮り直すか、感度を上げてください。');
  return {mask,width:w,height:h,inkPixels:ink,bbox:{minX,minY,maxX,maxY}};
}

function skeletonLUT(phase){
  const lut=new Uint8Array(256);
  for(let bits=0;bits<256;bits++){
    const a=Array.from({length:8},(_,k)=>(bits>>k)&1);
    const N=a.reduce((s,x)=>s+x,0);
    let transitions=0;for(let k=0;k<8;k++)if(a[k]===0&&a[(k+1)%8]===1)transitions++;
    const test=phase===0 ? (!a[0]||!a[2]||!a[4])&&(!a[2]||!a[4]||!a[6])
      :(!a[0]||!a[2]||!a[6])&&(!a[0]||!a[4]||!a[6]);
    if(N>=2&&N<=6&&transitions===1&&test)lut[bits]=1;
  }
  return lut;
}
const LUT=[skeletonLUT(0),skeletonLUT(1)];
export function skeletonize(maskObj){
  const {width:w,height:h,bbox}=maskObj,src=maskObj.mask;
  const s=new Uint8Array(src);
  const x0=Math.max(1,bbox.minX-2),x1=Math.min(w-2,bbox.maxX+2),y0=Math.max(1,bbox.minY-2),y1=Math.min(h-2,bbox.maxY+2);
  const shifts=[-w,-w+1,1,w+1,w,w-1,-1,-w-1];
  const deleted=new Int32Array((x1-x0+1)*(y1-y0+1));
  for(let loop=0;loop<45;loop++){
    let changed=0;
    for(let pass=0;pass<2;pass++){
      let count=0;
      for(let y=y0;y<=y1;y++){
        const row=y*w;
        for(let x=x0;x<=x1;x++){
          const i=row+x;if(!s[i])continue;
          let v=0;for(let k=0;k<8;k++)if(s[i+shifts[k]])v|=1<<k;
          if(LUT[pass][v])deleted[count++]=i;
        }
      }
      for(let k=0;k<count;k++)s[deleted[k]]=0;
      changed+=count;
    }
    if(!changed)break;
  }
  return s;
}

function tracePaths(s,w,h){
  const pixels=[];for(let i=0;i<s.length;i++)if(s[i])pixels.push(i);
  const ns=[[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];
  function neighbors(idx){
    const y=Math.floor(idx/w),x=idx%w,arr=[];
    for(const [dy,dx]of ns){
      const xx=x+dx,yy=y+dy;if(xx<0||xx>=w||yy<0||yy>=h)continue;
      const j=yy*w+xx;if(!s[j])continue;
      if(dx&&dy&&(s[y*w+xx]||s[yy*w+x]))continue;
      arr.push(j);
    }
    arr.sort((a,b)=>a-b);return arr;
  }
  const adj=new Map(),special=[];
  for(const i of pixels){const n=neighbors(i);adj.set(i,n);if(n.length!==2)special.push(i);}
  const seen=new Set(),paths=[],N=s.length;
  const edge=(a,b)=>Math.min(a,b)*N+Math.max(a,b);
  function trace(start,next){
    const path=[start,next];seen.add(edge(start,next));let prev=start,cur=next;
    while(cur!==start&&adj.get(cur).length===2){
      const ns=adj.get(cur).filter(p=>p!==prev);if(ns.length!==1)break;
      const q=ns[0],id=edge(cur,q);if(seen.has(id))break;
      seen.add(id);path.push(q);prev=cur;cur=q;
    }
    return path;
  }
  for(const i of special)for(const j of adj.get(i))if(!seen.has(edge(i,j)))paths.push(trace(i,j));
  for(const i of pixels)for(const j of adj.get(i))if(!seen.has(edge(i,j)))paths.push(trace(i,j));
  return paths;
}
function distanceTransform(mask,w,h){
  // 8-neighbor chamfer approximation to 2D Euclidean EDT.
  const d=new Float32Array(mask.length),root2=Math.SQRT2;
  for(let i=0;i<mask.length;i++)d[i]=mask[i]?1000:0;
  for(let y=1;y<h-1;y++)for(let x=1;x<w-1;x++){
    const i=y*w+x;if(!d[i])continue;
    d[i]=Math.min(d[i],d[i-1]+1,d[i-w]+1,d[i-w-1]+root2,d[i-w+1]+root2);
  }
  for(let y=h-2;y>0;y--)for(let x=w-2;x>0;x--){
    const i=y*w+x;if(!d[i])continue;
    d[i]=Math.min(d[i],d[i+1]+1,d[i+w]+1,d[i+w+1]+root2,d[i+w-1]+root2);
  }
  return d;
}
function smoothPath(pts,closed){
  let arr=pts;
  for(let rep=0;rep<2;rep++){
    const tmp=arr.map((p,i)=>{
      if(!closed&&(i<2||i>=arr.length-2))return p;
      const at=k=>arr[closed?(k+arr.length)%arr.length:clamp(k,0,arr.length-1)];
      const weights=[1,4,6,4,1],indexes=[i-2,i-1,i,i+1,i+2];
      const nx=indexes.reduce((acc,k,z)=>acc+at(k).x*weights[z],0)/16;
      const ny=indexes.reduce((acc,k,z)=>acc+at(k).y*weights[z],0)/16;
      const dx=nx-p.x,dy=ny-p.y,d=Math.hypot(dx,dy),c=Math.min(1,1.05/(d||1));
      return {x:p.x+dx*c,y:p.y+dy*c};
    });arr=tmp;
  }
  return arr;
}
function resample(pts,step=.85){
  if(pts.length<3)return pts;
  const s=[0];for(let i=1;i<pts.length;i++)s.push(s[i-1]+distance(pts[i],pts[i-1]));
  const total=s[s.length-1];if(total<1.1)return pts;
  const n=Math.min(12000,Math.max(2,Math.ceil(total/step)+1));
  const out=[];let j=1;
  for(let k=0;k<n;k++){
    const t=(total*k)/(n-1);
    while(j<s.length-1&&s[j]<t)j++;
    const alpha=(t-s[j-1])/(s[j]-s[j-1]||1);
    // Linear resampling after Gaussian centerline smoothing avoids over-shoot.
    out.push({x:lerp(pts[j-1].x,pts[j].x,alpha),y:lerp(pts[j-1].y,pts[j].y,alpha)});
  }
  return out;
}
export function traceStrokes(ink,{smooth=true,widthGain=1}={}){
  const w=ink.width,h=ink.height;
  const skel=skeletonize(ink),paths=tracePaths(skel,w,h),dist=distanceTransform(ink.mask,w,h);
  const widths=[];
  for(let i=0;i<skel.length;i+=4)if(skel[i])widths.push(Math.min(24,2*dist[i]));
  const typical=quantile(widths)||4;
  const strokes=[];
  for(const raw of paths){
    if(raw.length<2)continue;
    let pts=raw.map(i=>({x:i%w,y:Math.floor(i/w)}));
    let len=0;for(let i=1;i<pts.length;i++)len+=distance(pts[i],pts[i-1]);
    if(len<2.2)continue;
    const closed=raw.length>7&&raw[0]===raw[raw.length-1];
    const rawWidths=raw.map(i=>2*dist[i]);
    const local=clamp(quantile(rawWidths),.65*typical,1.5*typical);
    // Deduplicate final loop pixel while smoothing, then reconnect.
    if(closed)pts=pts.slice(0,-1);
    if(smooth&&pts.length>=5)pts=smoothPath(pts,closed);
    if(closed)pts.push({...pts[0]});
    pts=resample(pts,.85);
    const width=clamp(local,1,typical*1.55)*widthGain;
    strokes.push({mean_width:width,points:pts.map(p=>({x:p.x,y:p.y,w:width}))});
  }
  if(strokes.length<1)throw new Error('有効な筆跡ストロークを抽出できませんでした');
  return {page:{width:w,height:h},strokes,summary:{count:strokes.length,paths:paths.length,points:strokes.reduce((n,s)=>n+s.points.length,0),typicalWidth:typical}};
}
