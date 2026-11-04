import test from "node:test";
import assert from "node:assert/strict";
import { addDays, eventLastDay, eventsOnDay, mondayOf, monthDays, osloDay, shiftMonth, weekDays } from "../public/calendar-data.mjs";

test("unfinished tasks stay visible each day of their period and overdue until checked", () => {
  const today=osloDay();
  const task={title:"Ukens lekser",start:`${addDays(today,-5)}T18:00:00Z`,task:{visibleFrom:addDays(today,-5),dueDate:addDays(today,-1),items:[{key:"read",text:"Les",doneAt:null}]}};
  assert.equal(eventsOnDay([task],addDays(today,-3)).length,1);
  assert.equal(eventsOnDay([task],today).length,1);
  assert.equal(eventsOnDay([task],addDays(today,1)).length,0);
  task.task.items[0].doneAt=new Date().toISOString();
  assert.equal(eventsOnDay([task],today).length,0);
});

test("Norwegian day and week navigation stays correct across daylight saving time", () => {
  assert.equal(osloDay("2026-03-28T23:30:00Z"), "2026-03-29");
  assert.equal(addDays("2026-03-29", 1), "2026-03-30");
  assert.equal(mondayOf("2026-09-27"), "2026-09-21");
  assert.deepEqual(weekDays("2026-09-27"), ["2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27"]);
});

test("all-day end dates are exclusive and timed events can span midnight", () => {
  const allDay = { title:"Tur", allDay:true, start:"2026-09-24", end:"2026-09-25" };
  const overnight = { title:"Overnatting", allDay:false, start:"2026-09-24T23:00:00+02:00", end:"2026-09-25T01:00:00+02:00" };
  assert.equal(eventLastDay(allDay), "2026-09-24");
  assert.deepEqual(eventsOnDay([allDay, overnight], "2026-09-24").map((event) => event.title), ["Tur", "Overnatting"]);
  assert.deepEqual(eventsOnDay([allDay, overnight], "2026-09-25").map((event) => event.title), ["Overnatting"]);
});

test("month grid starts on Monday and includes its last day", () => {
  const days = monthDays("2026-09-24");
  assert.equal(days[0], "2026-08-31");
  assert.equal(days.at(-1), "2026-10-04");
  assert.equal(shiftMonth("2026-12-24", 1), "2027-01-01");
});
