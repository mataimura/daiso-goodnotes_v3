import {detectScreen,rectify,extractInk,traceStrokes} from './pipeline.js';
import {exportGoodnotesPages} from './goodnotes.js';
import {fitRasterInk} from './rasterfit.js';

const el=id=>document.getElementById(id);
const photoCanvas=el('photo-canvas'),pc=photoCanvas.getContext('2d',{willReadFrequently:true});
const outCanvas=el('preview-canvas'),oc=outCanvas.getContext('2d');
const MAX_PHOTOS=20;
let entries=[],currentIndex=0,srcCanvas=null,srcImage=null,quad=null;
let editMode=false,dragIndex=-1,busy=false;
let createdFile=null,createdURL=null,resultPages=[],previewIndex=0,previewGain=.24;
const tick=()=>new Promise(resolve=>setTimeout(resolve,35));

function setStatus(where,message,kind=''){
  where.textContent=message;where.className=`status ${kind}`;
}
function setBusy(value){
  busy=value;
  for(const id of ['convert','auto-detect','edit-corners','previous','next','move-left','move-right','photo-input','fit-mode','line-style']){
    el(id).disabled=value;
  }
  if(!value)updateNavigation();
}
function updateNavigation(){
  const n=entries.length,i=currentIndex;
  el('previous').disabled=busy||i<=0;
  el('next').disabled=busy||i>=n-1;
  el('move-left').disabled=busy||i<=0;
  el('move-right').disabled=busy||i>=n-1;
  el('convert').disabled=busy||!srcImage||!entries.length;
  el('page-indicator').textContent=n?`${i+1} / ${n} 枚　${entries[i].file.name}`:'';
  el('filename').textContent=n?`${n}枚選択中。1冊のGoodnotes（${n}ページ）にまとめます。`:
    'DAISO 10.5インチの縦向き写真に対応';
}
function clearResult(){
  el('result-panel').hidden=true;resultPages=[];previewIndex=0;createdFile=null;
  if(createdURL){URL.revokeObjectURL(createdURL);createdURL=null;}
}
function validateQuad(points,w,h){
  if(points?.length!==4||points.some(p=>!Number.isFinite(p.x)||!Number.isFinite(p.y)||p.x<0||p.y<0||p.x>w||p.y>h))
    throw new Error('四隅が画像の外にあります');
  const area=points.reduce((s,p,i)=>s+p.x*points[(i+1)%4].y-points[(i+1)%4].x*p.y,0)/2;
  if(area<w*h*.09)throw new Error('囲んだ画面が小さすぎます');
}
function guessQuad(w,h){return [{x:.11*w,y:.11*h},{x:.80*w,y:.10*h},{x:.86*w,y:.84*h},{x:.09*w,y:.85*h}];}
function normalizeQuad(points,w,h){return points.map(p=>({x:p.x/w,y:p.y/h}));}
function denormalizeQuad(points,w,h){return points.map(p=>({x:p.x*w,y:p.y*h}));}
function rememberQuad(){
  if(!srcCanvas||!quad||!entries.length)return;
  entries[currentIndex].fractionQuad=normalizeQuad(quad,srcCanvas.width,srcCanvas.height);
}
function drawPhoto(){
  if(!srcCanvas)return;
  photoCanvas.width=srcCanvas.width;photoCanvas.height=srcCanvas.height;
  pc.drawImage(srcCanvas,0,0);
  if(!quad)return;
  pc.lineWidth=Math.max(4,photoCanvas.width/170);pc.strokeStyle='#24b7aa';
  pc.fillStyle='rgba(17,190,173,.08)';pc.beginPath();pc.moveTo(quad[0].x,quad[0].y);
  for(let i=1;i<4;i++)pc.lineTo(quad[i].x,quad[i].y);
  pc.closePath();pc.fill();pc.stroke();
  const radius=Math.max(9,photoCanvas.width/75);
  for(let i=0;i<4;i++){
    const p=quad[i];pc.beginPath();pc.arc(p.x,p.y,radius,0,Math.PI*2);
    pc.fillStyle=editMode?'#f5c76c':'#fff';pc.fill();pc.strokeStyle='#188579';pc.stroke();
    pc.fillStyle='#12453f';pc.font=`bold ${Math.round(radius*1.3)}px -apple-system,sans-serif`;
    pc.textAlign='center';pc.textBaseline='middle';pc.fillText(String(i+1),p.x,p.y);
  }
}
async function readFileImage(file){
  const url=URL.createObjectURL(file);
  try{
    const img=new Image();img.src=url;
    await img.decode();
    if(img.naturalWidth<50||img.naturalHeight<50)throw new Error('画像を読み込めません');
    const maxSide=2300,scale=Math.min(1,maxSide/Math.max(img.naturalWidth,img.naturalHeight));
    const canvas=document.createElement('canvas');
    canvas.width=Math.round(img.naturalWidth*scale);canvas.height=Math.round(img.naturalHeight*scale);
    const ctx=canvas.getContext('2d',{willReadFrequently:true});
    if(!ctx)throw new Error('Canvasの初期化に失敗しました');
    ctx.drawImage(img,0,0,canvas.width,canvas.height);
    return canvas;
  }finally{URL.revokeObjectURL(url);}
}
function detectForCanvas(canvas){
  const w=canvas.width,h=canvas.height;
  const scale=Math.min(1,970/h),det=document.createElement('canvas');
  det.width=Math.round(w*scale);det.height=Math.round(h*scale);
  const dc=det.getContext('2d',{willReadFrequently:true});
  dc.drawImage(canvas,0,0,det.width,det.height);
  const result=detectScreen(dc.getImageData(0,0,det.width,det.height));
  const sx=w/det.width,sy=h/det.height;
  const points=result.quad.map(p=>({x:p.x*sx,y:p.y*sy}));
  validateQuad(points,w,h);
  return points;
}
async function loadEntry(index){
  if(index<0||index>=entries.length)return;
  setBusy(true);
  currentIndex=index;editMode=false;dragIndex=-1;
  el('edit-corners').textContent='✎ 四隅を修正';
  photoCanvas.classList.remove('adjust');
  el('crop-panel').hidden=false;
  setStatus(el('crop-status'),`${index+1}枚目を読み込んでいます...`);
  try{
    srcCanvas=null;srcImage=null;quad=null;
    const entry=entries[index];
    srcCanvas=await readFileImage(entry.file);
    srcImage=srcCanvas.getContext('2d',{willReadFrequently:true}).getImageData(0,0,srcCanvas.width,srcCanvas.height);
    if(entry.fractionQuad){
      quad=denormalizeQuad(entry.fractionQuad,srcCanvas.width,srcCanvas.height);
      if(entry.needsManual){
        editMode=true;photoCanvas.classList.add('adjust');
        el('edit-corners').textContent='✓ 四隅の調整を終える';
        setStatus(el('crop-status'),'自動検出に失敗した写真です。黄色の四隅を調整し、「調整を終える」を押してください。','warning');
      }else{
        setStatus(el('crop-status'),'保存済みの四隅を表示しています。必要なら修正してください。');
      }
    }else{
      try{
        quad=detectForCanvas(srcCanvas);
        entry.fractionQuad=normalizeQuad(quad,srcCanvas.width,srcCanvas.height);
        entry.needsManual=false;
        setStatus(el('crop-status'),'自動検出しました。四隅が液晶の内側に沿っているか確認してください。');
      }catch(error){
        quad=guessQuad(srcCanvas.width,srcCanvas.height);
        entry.fractionQuad=normalizeQuad(quad,srcCanvas.width,srcCanvas.height);
        entry.needsManual=true;editMode=true;
        photoCanvas.classList.add('adjust');
        el('edit-corners').textContent='✓ 四隅の調整を終える';
        setStatus(el('crop-status'),`自動検出失敗：${error.message}。黄色の四隅を調整し、「調整を終える」を押してください。`,'warning');
      }
    }
    drawPhoto();
  }catch(error){
    srcCanvas=null;srcImage=null;quad=null;el('crop-panel').hidden=true;
    setStatus(el('crop-status'),`画像を開けませんでした：${error.message}`,'error');
    alert(`写真を読み込めません：${entries[index].file.name}\n${error.message}`);
  }finally{setBusy(false);}
}

el('photo-input').addEventListener('change',async event=>{
  if(busy)return;
  const selected=Array.from(event.target.files||[]);
  if(!selected.length)return;
  if(selected.length>MAX_PHOTOS){
    alert(`iPhoneの負荷を抑えるため、一度に最大${MAX_PHOTOS}枚まで選んでください。`);
    event.target.value='';return;
  }
  clearResult();
  entries=selected.map(file=>({file,fractionQuad:null,needsManual:false}));
  el('crop-panel').hidden=false;
  await loadEntry(0);
});
el('auto-detect').addEventListener('click',()=>{
  if(!srcCanvas||busy)return;
  try{
    quad=detectForCanvas(srcCanvas);
    entries[currentIndex].needsManual=false;rememberQuad();editMode=false;
    photoCanvas.classList.remove('adjust');el('edit-corners').textContent='✎ 四隅を修正';
    clearResult();drawPhoto();
    setStatus(el('crop-status'),'再検出しました。四隅の位置を確認してください。');
  }catch(error){setStatus(el('crop-status'),`${error.message}。「四隅を修正」で調整してください。`,'warning');}
});
el('edit-corners').addEventListener('click',()=>{
  if(!quad||busy)return;
  if(editMode){
    try{validateQuad(quad,srcCanvas.width,srcCanvas.height);}
    catch(error){setStatus(el('crop-status'),error.message,'error');return;}
    entries[currentIndex].needsManual=false;
    rememberQuad();
  }
  editMode=!editMode;photoCanvas.classList.toggle('adjust',editMode);
  el('edit-corners').textContent=editMode?'✓ 四隅の調整を終える':'✎ 四隅を修正';
  clearResult();
  setStatus(el('crop-status'),editMode?'四隅の丸印を指でドラッグしてください。':'位置を確定しました。まとめて変換できます。',editMode?'warning':'');
  drawPhoto();
});
function screenXY(event){
  const r=photoCanvas.getBoundingClientRect();
  return {x:(event.clientX-r.left)*photoCanvas.width/r.width,
    y:(event.clientY-r.top)*photoCanvas.height/r.height};
}
photoCanvas.addEventListener('pointerdown',event=>{
  if(!editMode||!quad||busy)return;
  const p=screenXY(event);let best=Infinity,bestIndex=-1;
  for(let i=0;i<4;i++){const d=Math.hypot(p.x-quad[i].x,p.y-quad[i].y);if(d<best){best=d;bestIndex=i;}}
  if(best<photoCanvas.width*.19){dragIndex=bestIndex;photoCanvas.setPointerCapture(event.pointerId);event.preventDefault();}
});
photoCanvas.addEventListener('pointermove',event=>{
  if(dragIndex<0||!editMode)return;
  const p=screenXY(event);
  quad[dragIndex]={x:Math.max(0,Math.min(srcCanvas.width,p.x)),y:Math.max(0,Math.min(srcCanvas.height,p.y))};
  rememberQuad();drawPhoto();event.preventDefault();
});
for(const name of ['pointerup','pointercancel','lostpointercapture']){
  photoCanvas.addEventListener(name,()=>{dragIndex=-1;});
}
el('previous').addEventListener('click',()=>{if(!busy)loadEntry(currentIndex-1);});
el('next').addEventListener('click',()=>{if(!busy)loadEntry(currentIndex+1);});
function moveEntry(delta){
  const j=currentIndex+delta;if(busy||j<0||j>=entries.length)return;
  [entries[currentIndex],entries[j]]=[entries[j],entries[currentIndex]];
  currentIndex=j;clearResult();updateNavigation();
  setStatus(el('crop-status'),`ページ順を変更しました。現在の写真は${currentIndex+1}ページ目です。`);
}
el('move-left').addEventListener('click',()=>moveEntry(-1));
el('move-right').addEventListener('click',()=>moveEntry(1));
el('fit-mode').addEventListener('change',()=>{
  const quick=el('fit-mode').value==='quick';
  el('line-style').disabled=quick;
  el('quality-detail').textContent=quick?
    '従来版と同じ高速変換です。線の太さは従来設定に固定されます。':
    '白黒画像に線を再描画して比較し、位置と太さを調整します。枚数が多いと処理時間がかかります。';
  clearResult();
});
el('line-style').addEventListener('change',clearResult);
el('sensitivity').addEventListener('input',()=>{
  const value=+el('sensitivity').value;
  el('sensitivity-label').textContent=(value===9?'標準':value<9?'高感度':'低感度')+`（${value}）`;
});
function renderInk(strokeData,gain=previewGain){
  const {page,strokes}=strokeData;
  outCanvas.width=page.width;outCanvas.height=page.height;
  oc.fillStyle='white';oc.fillRect(0,0,page.width,page.height);
  oc.strokeStyle='#141b1c';oc.fillStyle='#141b1c';oc.lineCap='round';oc.lineJoin='round';
  for(const stroke of strokes){
    if(stroke.points.length<2)continue;
    oc.lineWidth=Math.min(6*page.width/540,Math.max(.35*page.width/540,stroke.mean_width*gain));
    oc.beginPath();oc.moveTo(stroke.points[0].x,stroke.points[0].y);
    for(const point of stroke.points.slice(1))oc.lineTo(point.x,point.y);
    oc.stroke();
  }
}
function renderPreviewPage(index){
  if(index<0||index>=resultPages.length)return;
  previewIndex=index;renderInk(resultPages[index],previewGain);
  el('result-page-indicator').textContent=`プレビュー ${index+1} / ${resultPages.length} ページ　${entries[index].file.name}`;
  el('preview-previous').disabled=index===0;
  el('preview-next').disabled=index>=resultPages.length-1;
}
el('preview-previous').addEventListener('click',()=>renderPreviewPage(previewIndex-1));
el('preview-next').addEventListener('click',()=>renderPreviewPage(previewIndex+1));
const canvasBlob=(canvas,type,quality)=>new Promise((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(new Error('サムネイル保存失敗')),type,quality));

el('convert').addEventListener('click',async()=>{
  if(busy||!srcImage||!entries.length)return;
  if(editMode){
    setStatus(el('crop-status'),'「四隅の調整を終える」を押してから変換してください。','warning');return;
  }
  clearResult();setBusy(true);
  let failedIndex=-1,errorMessage='';
  try{
    const pages=[];
    const mode=el('fit-mode').value;
    const exportGain=mode==='v5'?(el('line-style').value==='light'?.65:1):.24;
    const low=+el('sensitivity').value;
    for(let i=0;i<entries.length;i++){
      try{
      const entry=entries[i];
      setStatus(el('crop-status'),`${i+1}/${entries.length}枚目：写真を読み込んでいます...`);await tick();
      const canvas=i===currentIndex&&srcCanvas?srcCanvas:await readFileImage(entry.file);
      let points;
      if(entry.fractionQuad){
        points=denormalizeQuad(entry.fractionQuad,canvas.width,canvas.height);
      }else{
        try{
          points=detectForCanvas(canvas);
          entry.fractionQuad=normalizeQuad(points,canvas.width,canvas.height);
          entry.needsManual=false;
        }catch(error){
          entry.fractionQuad=normalizeQuad(guessQuad(canvas.width,canvas.height),canvas.width,canvas.height);
          entry.needsManual=true;
          throw new Error(`自動検出に失敗しました。四隅を手動で確定してください。${error.message}`);
        }
      }
      if(entry.needsManual)throw new Error('四隅が未確定です。「四隅を修正」から確定してください。');
      validateQuad(points,canvas.width,canvas.height);
      const image=canvas.getContext('2d',{willReadFrequently:true}).getImageData(0,0,canvas.width,canvas.height);
      setStatus(el('crop-status'),`${i+1}/${entries.length}枚目：筆跡を抽出しています...`);await tick();
      const ink=extractInk(rectify(image,points),{low,high:Math.max(low+9,Math.round(low*2.67))});
      setStatus(el('crop-status'),`${i+1}/${entries.length}枚目：編集可能な線に変換しています...`);await tick();
      const vector=traceStrokes(ink);
      if(!vector.strokes?.length)throw new Error('筆跡を検出できませんでした。写真を確認してください。');
      if(mode==='v5'){
        setStatus(el('crop-status'),`${i+1}/${entries.length}枚目：白黒画像に合わせて線を最適化しています...`);await tick();
        pages.push(await fitRasterInk(ink,vector,{
          passes:2,supersample:2,
          onProgress:msg=>setStatus(el('crop-status'),`${i+1}/${entries.length}枚目：${msg.detail}`)
        }));
      }else pages.push(vector);
      }catch(error){
        throw new Error(`写真${i+1}: ${error.message}`);
      }
    }
    setStatus(el('crop-status'),`${pages.length}ページのGoodnotesノートを書き出しています...`);await tick();
    previewGain=exportGain;
    renderInk(pages[0],previewGain);
    const thumbnail=document.createElement('canvas');
    thumbnail.width=320;thumbnail.height=Math.round(320*pages[0].page.height/pages[0].page.width);
    thumbnail.getContext('2d').drawImage(outCanvas,0,0,thumbnail.width,thumbnail.height);
    const thumbBlob=await canvasBlob(thumbnail,'image/jpeg',.85);
    const res=await exportGoodnotesPages(pages,thumbBlob,{widthGain:exportGain,title:'DAISO 手書きメモ'});
    const now=new Date(),timeStamp=`${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}`;
    const filename=`DAISO_${timeStamp}_${res.pages}pages.goodnotes`;
    createdFile=new File([res.blob],filename,{type:'application/octet-stream'});
    createdURL=URL.createObjectURL(res.blob);resultPages=pages;
    el('result-panel').hidden=false;renderPreviewPage(0);
    const fitted=pages.map(p=>p.summary?.rasterFit).filter(Boolean);
    const qualityInfo=fitted.length?` 線幅調整後 → 個別最適化後の画像F1（内部描画による近似）：${(fitted.reduce((s,x)=>s+x.global,0)/fitted.length).toFixed(3)} → ${(fitted.reduce((s,x)=>s+x.after,0)/fitted.length).toFixed(3)}。`:'';
    setStatus(el('result-status'),`${res.pages}ページ・${res.strokes}ストローク（約${Math.round(res.blob.size/1024)}KB）を1冊にしました。${qualityInfo}Goodnotesで投げ縄・消しゴムを確認してください。`);
    setStatus(el('crop-status'),'完了。下にスクロールしてGoodnotesに共有できます。');
    el('result-panel').scrollIntoView({behavior:'smooth',block:'start'});
  }catch(error){
    console.error(error);
    // Failed page detection is marked in the processing loop below by the prefix.
    const marker=/^写真(\d+):/;
    const match=marker.exec(error.message);
    if(match){failedIndex=Number(match[1])-1;errorMessage=error.message.slice(match[0].length).trim();}
    else errorMessage=error.message;
    setStatus(el('crop-status'),`変換に失敗しました：${errorMessage}`,'error');
  }finally{
    setBusy(false);
  }
  if(failedIndex>=0){
    await loadEntry(failedIndex);
    setStatus(el('crop-status'),`${failedIndex+1}枚目（${entries[failedIndex].file.name}）を確認してください：${errorMessage}`,'error');
  }
});
el('share').addEventListener('click',async()=>{
  if(!createdFile)return;
  try{
    if(navigator.canShare?.({files:[createdFile]})&&navigator.share){
      await navigator.share({files:[createdFile],title:'DAISO 手書きメモ'});
    }else{
      downloadFile();
      setStatus(el('result-status'),'共有メニューが利用できないためファイルを保存しました。Goodnotesから「読み込む」を選んでください。','warning');
    }
  }catch(error){
    if(error.name!=='AbortError')setStatus(el('result-status'),`共有できませんでした。「ファイル保存」を試してください：${error.message}`,'warning');
  }
});
function downloadFile(){
  if(!createdFile||!createdURL)return;
  const a=document.createElement('a');a.href=createdURL;a.download=createdFile.name;
  document.body.appendChild(a);a.click();a.remove();
}
el('download').addEventListener('click',downloadFile);
if('serviceWorker'in navigator&&location.protocol.startsWith('http')){
  window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js').catch(()=>{}));
}
updateNavigation();
