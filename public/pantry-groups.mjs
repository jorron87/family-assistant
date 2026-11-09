// Display groups describe use, not product equivalence. Specific compounds must
// win over substrings: Frukost is bread, coconut milk is not dairy, bread bags
// are household goods, and cornstarch belongs with baking ingredients.
export const PANTRY_GROUPS=['Grønnsaker','Frukt og bær','Kjøtt og kylling','Fisk og sjømat','Meieri og egg','Brød og bakst','Tørrvarer og baking','Olje, sauser og hermetikk','Drikke og kaffe','Hjem og hygiene','Til dyrene','Andre varer'];
const rules=[
 ['Hjem og hygiene',/såpe|spray|papir|bleie|tann|solidox|vask|rengjør|poser|sjampo|shampoo|balsam|våtserviett/i],
 ['Til dyrene',/katt|hund|litter|ever clean|dyrefôr/i],
 ['Olje, sauser og hermetikk',/olje|eddik|saus|sennep|ketchup|kokosmelk|peanøttsmør|honning/i],
 ['Tørrvarer og baking',/maisstivelse/i],
 ['Grønnsaker',/grønnsak|brokkoli|blomkål|rosenkål|spinat|avokado|tomater|maiskorn|(?:^|\s)mais(?:\s|$)|gulr(?:ot|øtt)|løk|hvitløk|ingefær|potet|oliven(?!olje)/i],
 ['Frukt og bær',/bær|jordbær|bringebær|ananas|mango|banan|eple|appelsin|frukt|rosin|syltetøy/i],
 ['Kjøtt og kylling',/kylling|kalkun|kjøtt|storfe|svin|biff|bacon|pølse|skinke|karbonade/i],
 ['Fisk og sjømat',/laks|torsk|fisk|ørret|makrell|reke|sjømat|tunfisk/i],
 ['Brød og bakst',/brød|rundstykk|knekkebrød|baguett|polarbrød|tortilla|lompe|flutes/i],
 ['Meieri og egg',/melk|fløte|rømme|yoghurt|gulost|norvegia|(?:^|[\s-])ost(?:[\s-]|$)|smør|bremykt|margarin|(?:^|\s)egg(?:\s|$)|grana|parmesan/i],
 ['Tørrvarer og baking',/mel|pasta|(?:^|\s)ris(?:\s|$)|havre|sukker|salt|gjær|kakao|sjokolade|nøtt|cashew|valnøtt|stivelse/i],
 ['Drikke og kaffe',/kaffe|(?:^|\s)te(?:\s|$)|juice|saft|brus|drikke/i]
];
// A linked library group knows the real category. Mixed ones such as meat, fish
// and eggs, or fruit and vegetables, still need the name to choose.
const LIBRARY_GROUPS={'Hygiene':'Hjem og hygiene','Hus og rengjøring':'Hjem og hygiene','Baby og barn':'Hjem og hygiene','Kjæledyr':'Til dyrene','Meieri og ost':'Meieri og egg','Drikke':'Drikke og kaffe','Brød og bakervarer':'Brød og bakst','Brød og bakst':'Brød og bakst','Mel, korn og baking':'Tørrvarer og baking','Ris og pasta':'Tørrvarer og baking','Nøtter og frø':'Tørrvarer og baking','Nøtter og tørket frukt':'Tørrvarer og baking','Oljer og eddik':'Olje, sauser og hermetikk','Hermetikk og middagsbasis':'Olje, sauser og hermetikk'};
export const pantryGroup=item=>LIBRARY_GROUPS[item.libraryCategory]??rules.find(([,pattern])=>pattern.test(item.name))?.[0]??'Andre varer';
