const $=selector=>document.querySelector(selector);
const access=await (await fetch('/api/phone/access')).json();
$('#access').textContent=access.internetEnabled?'Mobiladressen virker også utenfor hjemmet.':'Mobiladressen virker på hjemmenettet. Internettadressen er ikke aktivert ennå.';
$('#invite').onclick=async()=>{try{const response=await fetch('/api/phone/invite',{method:'POST'});const invite=await response.json();if(!response.ok)throw Error(invite.error);$('#url').value=invite.url;$('#qr').src=invite.qr;$('#result').hidden=false;}catch(error){$('#status').textContent=error.message;}};
$('#copy').onclick=async()=>{try{await navigator.clipboard.writeText($('#url').value);$('#status').textContent='Lenken er kopiert. Del den bare med familien.';}catch{$('#url').select();$('#status').textContent='Marker og kopier lenken over.';}};
