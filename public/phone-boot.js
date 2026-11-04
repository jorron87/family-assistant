// Hold en synlig vei tilbake dersom en modul ikke kan lastes.
const startup=document.querySelector('#startup');
document.querySelector('#startup-retry').onclick=()=>location.reload();
try {
 await import('./phone.js');
} catch(error) {
 startup.hidden=false;
 document.querySelector('#startup-message').textContent='Kunne ikke åpne familien. Prøv igjen.';
 console.error('Mobilvisningen kunne ikke startes.',error);
}
