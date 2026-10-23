/*
 * Experimental Goodnotes schema-24 ink writer for DAISO Memo.
 * Based on the interoperability structure independently implemented in the
 * prior local daiso_goodnotes.py, inspired by Natural Ink (MIT).
 * Not an official Goodnotes API; keep the original photo.
 */
const te = new TextEncoder();
const SCHEMA = 24;
const DESCRIPTOR = te.encode('vuA(v)A(S(uu))A(S(uuuu))vA(f)\0');

function cat(...arrays) {
  const len = arrays.reduce((n, a) => n + a.length, 0);
  const dst = new Uint8Array(len); let off=0;
  for (const a of arrays) { dst.set(a,off); off+=a.length; }
  return dst;
}
function varint(n) {
  if (!Number.isSafeInteger(n) || n<0) throw new Error('Invalid protobuf varint');
  const arr=[];
  while(n>=128){arr.push((n%128)|128); n=Math.floor(n/128);}
  arr.push(n); return Uint8Array.from(arr);
}
function pb(tag,val) {
  if (typeof val==='number') return cat(varint(tag*8),varint(val));
  const b=typeof val==='string' ? te.encode(val) : val;
  return cat(varint(tag*8+2),varint(b.length),b);
}
function f32(tag,val) {return cat(varint(tag*8+5),fl32(val));}
function fl32(x) {const b=new Uint8Array(4);new DataView(b.buffer).setFloat32(0,x,true);return b;}
function u16(x){const b=new Uint8Array(2);new DataView(b.buffer).setUint16(0,x,true);return b;}
function u32(x){const b=new Uint8Array(4);new DataView(b.buffer).setUint32(0,x,true);return b;}
function record(data){return cat(varint(data.length),data);}
function clock(n=1){return cat(pb(1,1),pb(2,n));}
function wrapped(s){return cat(pb(1,s),pb(2,clock()));}
function uuid(){
  if(typeof crypto!=='undefined' && crypto.randomUUID) return crypto.randomUUID().toUpperCase();
  const a=new Uint8Array(16);
  if(typeof crypto!=='undefined'&& crypto.getRandomValues) crypto.getRandomValues(a);
  else for(let i=0;i<16;i++)a[i]=Math.floor(Math.random()*256);
  a[6]=(a[6]&15)|64;a[8]=(a[8]&63)|128;
  const s=Array.from(a,b=>b.toString(16).padStart(2,'0')).join('').toUpperCase();
  return `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20)}`;
}
function pairedUUIDs(){
  const id=uuid();const hex=id.replace(/-/g,'');const v=parseInt(hex.slice(-2),16);
  const even=(v&254).toString(16).padStart(2,'0').toUpperCase();
  const odd=(v|1).toString(16).padStart(2,'0').toUpperCase();
  const s=hex.slice(0,-2);return [formatUUID(s+even),formatUUID(s+odd)];
}
function formatUUID(s){return `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20)}`;}
function median(nums){const s=nums.slice().sort((a,b)=>a-b);return s[Math.floor(s.length/2)] ?? 1;}

// Valid LZ4 block containing a single literals-only sequence. No external
// LZ4 package is necessary. Size increase is acceptable for handwriting data.
export function lz4LiteralBlock(input) {
  const n=input.length, arr=[Math.min(n,15)<<4];
  if(n>=15){let rem=n-15;while(rem>=255){arr.push(255);rem-=255;}arr.push(rem);}
  return cat(Uint8Array.from(arr),input);
}
export function encodeStroke(stroke,id,counter){
  const pts=stroke.points;
  if(!pts?.length) throw new Error('Empty stroke');
  const coords=pts.map(p=>[p.x,p.y]);
  if(coords.length===1) coords.push([coords[0][0]+.001,coords[0][1]]);
  const count=coords.length;
  const width=median(pts.map(p=>p.width));
  const payload=new Uint8Array(2+4+4+2*count+4+8+4+16*(count-1)+2+4);
  const view=new DataView(payload.buffer);let o=0;
  view.setUint16(o,2,true);o+=2;view.setFloat32(o,width,true);o+=4;view.setUint32(o,count,true);o+=4;
  for(let i=0;i<count;i++){view.setUint16(o,i?1:0,true);o+=2;}
  view.setUint32(o,1,true);o+=4;
  view.setFloat32(o,coords[0][0],true);o+=4;view.setFloat32(o,coords[0][1],true);o+=4;
  view.setUint32(o,count-1,true);o+=4;
  for(let i=1;i<count;i++){
    for(const q of [coords[i-1][0],coords[i-1][1],coords[i][0],coords[i][1]]){
      view.setFloat32(o,q,true);o+=4;
    }
  }
  view.setUint16(o,1,true);o+=2;view.setUint32(o,0,true);o+=4;
  if(o!==payload.length)throw new Error('Ink stroke serialization mismatch');
  const template=cat(te.encode('tpl\0'),u32(8+DESCRIPTOR.length+payload.length),DESCRIPTOR,payload);
  const packedBytes=lz4LiteralBlock(template);
  const packed=cat(te.encode('bv41'),u32(template.length),u32(packedBytes.length),packedBytes,te.encode('bv4$'));
  const rgba=cat(f32(1,.067),f32(2,.067),f32(3,.067),f32(4,1));
  const event=cat(pb(1,id),pb(2,clock(counter)),pb(8,1),pb(9,counter),pb(14,1),pb(16,SCHEMA));
  const mark=cat(pb(1,id),pb(2,packed),pb(4,rgba),pb(6,new Uint8Array()),
    pb(7,pb(1,clock(counter))),pb(9,new Uint8Array()),pb(15,clock(counter)),
    pb(20,new Uint8Array()),pb(21,SCHEMA));
  return cat(record(event),record(pb(7,mark)));
}

// Very small, valid ASCII PDF with blank white background.
// Goodnotes imports this as the notebook background attachment.
export function makeBlankPDF(width,height){
  const content=`q\n1 1 1 rg\n0 0 ${width.toFixed(2)} ${height.toFixed(2)} re f\nQ\n`;
  const objects=[
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width.toFixed(2)} ${height.toFixed(2)}] /Resources << >> /Contents 4 0 R >>`,
    `<< /Length ${te.encode(content).length} >>\nstream\n${content}endstream`
  ];
  let pdf='%PDF-1.4\n%DAISO\n';const offsets=[0];
  for(let i=0;i<objects.length;i++){offsets.push(te.encode(pdf).length);pdf+=`${i+1} 0 obj\n${objects[i]}\nendobj\n`;}
  const xref=te.encode(pdf).length;
  pdf+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`;
  for(let i=1;i<offsets.length;i++)pdf+=`${String(offsets[i]).padStart(10,'0')} 00000 n \n`;
  pdf+=`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return te.encode(pdf);
}
function toDocument(strokeData,{widthPt=540,widthGain=.24,title='DAISO 手書きメモ'}={}){
  const scale=widthPt/strokeData.page.width;
  const strokes=[];
  for(const s of strokeData.strokes){
    if(!s.points.length)continue;
    const pts=s.points.map(p=>({x:p.x*scale,y:p.y*scale,
      width:Math.min(6,Math.max(.35,(p.w??s.mean_width??3)*scale*widthGain))}));
    strokes.push({points:pts});
  }
  if(!strokes.length)throw new Error('筆跡が見つかりません。');
  return {title,width:widthPt,height:strokeData.page.height*scale,strokes};
}

/**
 * Encode multiple DAISO photos as pages of ONE editable Goodnotes notebook.
 * Page order is input order. A single page follows exactly the same schema.
 */
export async function exportGoodnotesPages(strokePages, thumbnailBlob,
    {widthPt=540,widthGain=.24,title='DAISO 手書きメモ'}={}){
  if(typeof JSZip==='undefined')throw new Error('ZIPライブラリが読み込まれていません');
  if(!Array.isArray(strokePages)||strokePages.length===0)throw new Error('変換するページがありません');
  const pages=strokePages.map((data,i)=>{
    try{return toDocument(data,{widthPt,widthGain,title});}
    catch(err){throw new Error(`${i+1}ページ目：${err.message}`);}
  });
  const docId=uuid();
  const files={
    'schema.pb':pb(1,SCHEMA),
    'document.info.pb':new Uint8Array(),
    'index.search.pb':new Uint8Array(),
    'thumbnail.jpg':new Uint8Array(await thumbnailBlob.arrayBuffer())
  };
  const meta=cat(pb(1,docId),pb(2,wrapped(title)),pb(6,wrapped('P')),
    pb(9,'auto'),pb(11,uuid()),pb(13,1),pb(14,1),pb(20,SCHEMA));
  let events=record(cat(pb(1,docId),pb(30,meta)));
  const notes=[];
  const attachments=[];
  for(let pageNumber=0;pageNumber<pages.length;pageNumber++){
    const doc=pages[pageNumber];
    const bgId=uuid(),templateId=uuid(),[pageId,noteId]=pairedUUIDs();
    const background=makeBlankPDF(doc.width,doc.height);
    files[`attachments/${bgId}`]=background;
    attachments.push(record(cat(pb(1,bgId),pb(2,`attachments/${bgId}`))));
    notes.push(record(cat(pb(1,noteId),pb(2,`notes/${noteId}`))));

    const attached=cat(pb(1,bgId),pb(2,bgId),pb(5,background.length),pb(6,docId),
      pb(11,uuid()),pb(12,clock()),pb(14,1),pb(15,1),pb(16,SCHEMA));
    const template=cat(pb(1,docId),pb(2,templateId),pb(4,bgId),pb(5,1),pb(6,1),
      pb(8,cat(f32(1,doc.width),f32(2,doc.height))),pb(9,'DAISO digitized paper'),
      pb(11,uuid()),pb(15,1),pb(16,1),pb(21,SCHEMA));
    const pageEvent=cat(pb(1,docId),pb(2,pageId),pb(3,wrapped(templateId)),
      pb(4,wrapped(`A${String(pageNumber).padStart(6,'0')}`)),
      pb(11,uuid()),pb(13,1),pb(14,1),pb(15,SCHEMA));
    for(const [id,tag,item] of [[bgId,6,attached],[templateId,2,template],[pageId,54,pageEvent]]){
      events=cat(events,record(cat(pb(1,id),pb(tag,item))));
    }
    files[`notes/${noteId}`]=cat(...doc.strokes.map((s,i)=>encodeStroke(s,uuid(),i+1)));
  }
  files['index.notes.pb']=cat(...notes);
  files['index.attachments.pb']=cat(...attachments);
  files['index.events.pb']=events;
  const zip=new JSZip();
  for(const [name,bytes]of Object.entries(files))zip.file(name,bytes,{binary:true,createFolders:false});
  const blob=await zip.generateAsync({type:'blob',compression:'DEFLATE',compressionOptions:{level:5}});
  return {blob,pages:pages.length,strokes:pages.reduce((n,p)=>n+p.strokes.length,0),title};
}

// Keep the original one-photo API working for previously saved integrations.
export async function exportGoodnotes(strokeData,thumbnailBlob,options={}){
  return exportGoodnotesPages([strokeData],thumbnailBlob,options);
}
