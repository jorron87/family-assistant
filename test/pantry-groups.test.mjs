import test from 'node:test';
import assert from 'node:assert/strict';
import {PANTRY_GROUPS,pantryGroup} from '../public/pantry-groups.mjs';

test('inventory groups distinguish ingredient compounds from misleading name fragments',()=>{
 const cases={
  'Knekkebrød Frukost fullkorn':'Brød og bakst','Miniflutes fullkorn':'Brød og bakst',
  'Brødposer 6 l':'Hjem og hygiene','Våtservietter baby':'Hjem og hygiene','Sjampo og balsam':'Hjem og hygiene',
  'Kokosmelk':'Olje, sauser og hermetikk','Peanøttsmør':'Olje, sauser og hermetikk','Tomatbasert pastasaus':'Olje, sauser og hermetikk','Olivenolje':'Olje, sauser og hermetikk',
  'Maisstivelse':'Tørrvarer og baking','Maiskorn på boks':'Grønnsaker','Gulrøtter 2. sortering':'Grønnsaker','Grønne oliven uten sten':'Grønnsaker','Tomater på boks':'Grønnsaker',
  'Norvegia skivet':'Meieri og egg','Egg fra frittgående høner':'Meieri og egg','Gulost i blokk':'Meieri og egg',
  'Kyllingfilet naturell':'Kjøtt og kylling','Laksefilet':'Fisk og sjømat','Frosne bringebær':'Frukt og bær','Kaffe hele bønner':'Drikke og kaffe','Ever Clean kattesand':'Til dyrene','Ukjent':'Andre varer'
 };
 for(const [name,expected] of Object.entries(cases)){assert.equal(pantryGroup({name}),expected,name);assert.ok(PANTRY_GROUPS.includes(expected));}
});
