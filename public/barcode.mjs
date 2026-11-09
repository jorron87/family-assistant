// EAN-13 and EAN-8 from one row of pixels. Used where the browser lacks
// BarcodeDetector. The check digit rejects misreads; a miss just tries the next row.
const L=['3211','2221','2122','1411','1132','1231','1114','1312','1213','3112'];
const G=L.map(code=>[...code].reverse().join(''));
const FIRST=['LLLLLL','LLGLGG','LLGGLG','LLGGGL','LGLLGG','LGGLLG','LGGGLL','LGLGLG','LGLGGL','LGGLGL'];
const validEan=digits=>{const n=digits.map(Number),last=n.pop();const sum=n.reverse().reduce((s,d,i)=>s+d*(i%2?1:3),0);return (10-sum%10)%10===last;};

function runsOf(row) {
 let min=Infinity,max=-Infinity;for(const v of row){if(v<min)min=v;if(v>max)max=v;}
 if(max-min<40)return null;
 const mid=(min+max)/2,runs=[];let dark=row[0]<mid,length=0;
 for(const v of row){const next=v<mid;if(next===dark)length++;else{runs.push({dark,length});dark=next;length=1;}}
 runs.push({dark,length});return runs;
}
// The closest digit pattern for four bar widths, or null when nothing is close.
function digitOf(widths,tables) {
 const total=widths.reduce((a,b)=>a+b,0),unit=total/7;let best=null,second=Infinity;
 for(const [kind,codes] of tables)codes.forEach((code,digit)=>{let error=0;for(let i=0;i<4;i++)error+=Math.abs(widths[i]/unit-Number(code[i]));if(!best||error<best.error){if(best)second=Math.min(second,best.error);best={digit,kind,error};}else second=Math.min(second,error);});
 return best&&best.error<1.5&&best.error<second?best:null;
}
const guard=(runs,at,count,unit)=>{for(let i=0;i<count;i++){const r=runs[at+i];if(!r||r.length<unit*.4||r.length>unit*1.8)return false;}return true;};

function decodeAt(runs,at) {
 const span=(from,n)=>{let sum=0;for(let i=0;i<n;i++)sum+=runs[from+i].length;return sum;};
 const left=[],read=(from,tables)=>digitOf([0,1,2,3].map(i=>runs[from+i].length),tables);
 if(at+59<=runs.length){
  const unit=span(at,59)/95;
  if(guard(runs,at,3,unit)&&guard(runs,at+27,5,unit)&&guard(runs,at+56,3,unit)){
   let parity='';let ok=true;
   for(let d=0;d<6&&ok;d++){const hit=read(at+3+d*4,[['L',L],['G',G]]);if(!hit)ok=false;else{left.push(hit.digit);parity+=hit.kind;}}
   const first=FIRST.indexOf(parity);
   if(ok&&first>=0){
    const digits=[first,...left];
    for(let d=0;d<6&&ok;d++){const hit=read(at+32+d*4,[['R',L]]);if(!hit)ok=false;else digits.push(hit.digit);}
    if(ok&&validEan([...digits]))return digits.join('');
   }
  }
 }
 if(at+43<=runs.length){
  const unit=span(at,43)/67;
  if(guard(runs,at,3,unit)&&guard(runs,at+19,5,unit)&&guard(runs,at+40,3,unit)){
   const digits=[];let ok=true;
   for(let d=0;d<4&&ok;d++){const hit=read(at+3+d*4,[['L',L]]);if(!hit)ok=false;else digits.push(hit.digit);}
   for(let d=0;d<4&&ok;d++){const hit=read(at+24+d*4,[['R',L]]);if(!hit)ok=false;else digits.push(hit.digit);}
   if(ok&&validEan([...digits]))return digits.join('');
  }
 }
 return null;
}
export function decodeRow(row) {
 const runs=runsOf(row);if(!runs)return null;
 for(let at=0;at<runs.length-40;at++){if(!runs[at].dark)continue;const code=decodeAt(runs,at);if(code)return code;}
 return null;
}
/** Tries rows and columns (phones are often held across the barcode). */
export function decodeLuma(luma,width,height) {
 for(let i=1;i<16;i++){
  const y=Math.floor(height*i/16),row=luma.subarray(y*width,(y+1)*width),code=decodeRow(row)??decodeRow(Uint8Array.from(row).reverse());
  if(code)return code;
 }
 for(let i=1;i<16;i++){
  const x=Math.floor(width*i/16),column=new Uint8Array(height);for(let y=0;y<height;y++)column[y]=luma[y*width+x];
  const code=decodeRow(column)??decodeRow(Uint8Array.from(column).reverse());
  if(code)return code;
 }
 return null;
}

/** Runs until a code is seen twice in a row, or stop() is called. */
export async function scanCamera(video,onCode) {
 const stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:'environment',width:{ideal:1280}},audio:false});
 video.srcObject=stream;video.setAttribute('playsinline','');await video.play();
 const native='BarcodeDetector' in window?new window.BarcodeDetector({formats:['ean_13','ean_8']}):null;
 const canvas=document.createElement('canvas'),context=canvas.getContext('2d',{willReadFrequently:true});
 let stopped=false,last=null,timer=null;
 async function read() {
  if(native){const [hit]=await native.detect(video);return hit?.rawValue??null;}
  const width=Math.min(960,video.videoWidth),height=Math.round(video.videoHeight*width/video.videoWidth);if(!width||!height)return null;
  canvas.width=width;canvas.height=height;context.drawImage(video,0,0,width,height);
  const {data}=context.getImageData(0,0,width,height),luma=new Uint8Array(width*height);
  for(let i=0;i<luma.length;i++)luma[i]=(data[i*4]*.299+data[i*4+1]*.587+data[i*4+2]*.114)|0;
  return decodeLuma(luma,width,height);
 }
 async function tick() {
  if(stopped)return;
  let code=null;try{code=await read();}catch{}
  if(stopped)return;
  if(code&&code===last){stop();onCode(code);return;}
  last=code;timer=setTimeout(tick,180);
 }
 function stop(){stopped=true;clearTimeout(timer);for(const track of stream.getTracks())track.stop();video.srcObject=null;}
 tick();
 return stop;
}
