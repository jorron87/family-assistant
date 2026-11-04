export function memberColor(members,id){
 const member=members.find(m=>m.id===id);if(member?.color)return member.color;
 if(!member)return '#808789';
 const children=members.filter(m=>m.role==='child'),parents=members.filter(m=>m.role!=='child');
 const palette=member.role==='child'?['#c57b84','#668db5','#749a7b','#d5a557']:['#808789','#987b9a'];
 const index=(member.role==='child'?children:parents).findIndex(m=>m.id===id);
 return palette[Math.max(0,index)%palette.length];
}
