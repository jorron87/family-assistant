import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeRow,decodeLuma} from '../public/barcode.mjs';

const L=['0001101','0011001','0010011','0111101','0100011','0110001','0101111','0111011','0110111','0001011'];
const G=L.map(code=>[...code].map(b=>b==='0'?'1':'0').reverse().join(''));
const R=L.map(code=>[...code].map(b=>b==='0'?'1':'0').join(''));
const FIRST=['LLLLLL','LLGLGG','LLGGLG','LLGGGL','LGLLGG','LGGLLG','LGGGLL','LGLGLG','LGLGGL','LGGLGL'];
function ean13(code) {
 const d=[...code].map(Number);
 return '101'+d.slice(1,7).map((n,i)=>FIRST[d[0]][i]==='L'?L[n]:G[n]).join('')+'01010'+d.slice(7).map(n=>R[n]).join('')+'101';
}
const ean8=code=>{const d=[...code].map(Number);return '101'+d.slice(0,4).map(n=>L[n]).join('')+'01010'+d.slice(4).map(n=>R[n]).join('')+'101';};
function render(bits,{module=3,light=210,dark=35,noise=0,blur=false}={}) {
 const out=[];for(let i=0;i<40;i++)out.push(light);
 for(const bit of bits)for(let i=0;i<module;i++)out.push(bit==='1'?dark:light);
 for(let i=0;i<40;i++)out.push(light);
 let seed=1;const wiggle=()=>{seed=seed*16807%2147483647;return (seed/2147483647-.5)*noise;};
 const row=out.map(v=>Math.max(0,Math.min(255,v+wiggle())));
 return Uint8Array.from(blur?row.map((v,i)=>((row[i-1]??v)+v+(row[i+1]??v))/3):row);
}

test('EAN-13 and EAN-8 are read, also with noise, blur and small modules',()=>{
 for(const code of ['5901234123457','4006381333931','4002293401102'])for(const options of [{},{module:2},{noise:30},{blur:true,module:3},{module:5,noise:40}])assert.equal(decodeRow(render(ean13(code),options)),code,JSON.stringify(options));
 assert.equal(decodeRow(render(ean8('96385074'))),'96385074');
});
test('a wrong check digit and a flat image give nothing',()=>{
 assert.equal(decodeRow(render(ean13('5901234123450'))),null);
 assert.equal(decodeRow(new Uint8Array(400).fill(120)),null);
});
test('a code held upside down or across the frame is still found',()=>{
 const row=render(ean13('5901234123457')),width=row.length,height=30,flipped=new Uint8Array(width*height);
 for(let y=0;y<height;y++)flipped.set(Uint8Array.from(row).reverse(),y*width);
 assert.equal(decodeLuma(flipped,width,height),'5901234123457');
 const across=new Uint8Array(width*height);for(let y=0;y<width;y++)for(let x=0;x<height;x++)across[y*height+x]=row[y];
 assert.equal(decodeLuma(across,height,width),'5901234123457');
});
