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
export const pantryGroup=item=>rules.find(([,pattern])=>pattern.test(item.name))?.[0]??'Andre varer';
