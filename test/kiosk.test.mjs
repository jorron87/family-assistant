import test from "node:test";
import assert from "node:assert/strict";
import { idleReturn } from "../public/kiosk.mjs";

test("kiosk returns after two minutes, extends for real activity and cleans up",()=>{
  const target=new EventTarget();
  let clock=0, sequence=0, homes=0;
  const jobs=new Map();
  const advance=ms=>{clock+=ms; for (const [id,job] of [...jobs]) if (job.at<=clock) {jobs.delete(id);job.fn();}};
  const stop=idleReturn(()=>homes++,{target,schedule:(fn,ms)=>{const id=++sequence;jobs.set(id,{fn,at:clock+ms});return id;},cancel:id=>jobs.delete(id)});
  advance(119_000); assert.equal(homes,0);
  target.dispatchEvent(new Event("pointerdown"));
  advance(119_000); assert.equal(homes,0);
  advance(1_000); assert.equal(homes,1);
  target.dispatchEvent(new Event("wheel"));
  advance(120_000); assert.equal(homes,2);
  advance(59_000); target.dispatchEvent(new Event("scroll"));
  advance(61_000); assert.equal(homes,3,"programmatic scrolling during refresh must not extend the timeout");
  stop(); target.dispatchEvent(new Event("keydown"));
  assert.equal(jobs.size,0);
});
