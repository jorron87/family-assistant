# Oppsett for din familie

1. Installer Node.js 24+ og Chrome på Windows. Klon repoet til en egen mappe. Kjør `npm ci`, `npm run setup`, `npm run doctor`.
2. Rediger `config/profile.json`. Velg stabile, unike medlems-ID-er, navn, `role:parent|child` og eventuelle aliaser som matcher portalens fornavn. Ikke bruk «jeg» som et globalt person-alias; mobilinnboksen kjenner avsenderen. Sett `vigilo:false` på barn som ikke skal dekkes i Vigilo. Profilfilen er startprofil for **nye** arkiver; eksisterende profiler redigeres via GUI/CLI og overskrives ikke ved oppstart.
3. Sett `backfillFrom`, kalender-ID og privat Drive-mappe i `config/sources.json`. Velg en passende historisk start; importer ikke et annet prosjekts historie. Legg bare til Facebook-grupper husholdningen allerede har tilgang til. Alle profiler/ID-er i eksemplene er oppdiktet.
4. Start `npm start`. Lokal agentport4318, kiosk4319 og mobil4320 bruker loopback. Bruk en separat `FAMILIEN_DATA_DIR` ved utvikling. Ikke pek en testinstallasjon på produksjonsarkivet.
5. Åpne `chrome://extensions` i den Chrome-profilen familien skal bruke, aktiver utviklermodus, velg «Last inn upakket» og mappen `config/vigilo-keepalive`. Les manifestets tillatelser. Logg inn i Vigilo/Spond på vanlig måte. Behold én kildefane per tjeneste; ikke kopier cookies eller tokens. Sett `config/collector.json.enabled:true` når innhentingen er ønsket. Vent på ferske faktiske samlerkvitteringer per barn/flate. Facebook kan kreve besøk/scrolling for at innholdet lastes.
6. Koble til Google på `/google-setup` med egen OAuth-klient og de nødvendige tillatelsene, eller bruk agentens egne autoriserte Drive-/Calendar-verktøy. Følg `google-status`/`publish` i runbook. Opprett gjerne en separat testkalender først. Drive og kalender må være tilgjengelige for de valgte familiemedlemmene på telefon.
7. Konfigurer `config/agent.json`: full sti til egen agent-CLI, en modell kontoen faktisk støtter, reasoningEffort og eksplisitte valg av sandbox/approvalPolicy. Standardmodellen er tom og automatikk avslått. Start med én manuell gjennomgang og kontroller kilder, kalender, oppgaver og deling. Ved unattended drift kan en interaktiv approval-policy stoppe på verktøykall; velg dette bevisst sammen med systemeieren, og gi bare den tilgangen oppgaven trenger.
8. Etter bestått manuell test: aktiver agenten og ønsket `collector.dispatch`. Mobilbehandling starter når egen global lease er ledig. `dailyFullFallback:true` kan starte daglig reservekontroll etter07:15 norsk tid. Avtal eventuell planlagt fullkontroll og daglig drift i agent-appen. Repoet oppretter ingen abonnementer eller app-automasjoner automatisk.

## Mobil utenfor hjemmenettet

Sett en HTTPS-tunnel/reverse proxy til **bare port4320** og `/send/`; bruk egen adresse i `config/phone-access.json`. En tunnel på samme PC kan nå loopback direkte. Ved LAN-bruk må `FAMILIEN_PHONE_HOST` settes uttrykkelig og brannmur begrenses passende. Åpne `/phone-setup` lokalt på4318 for å lage en tidsbegrenset invitasjon/QR. Velg riktig avsender per telefon og legg siden på hjemskjermen. Invitasjoner og enhetstilgang er hemmeligheter. Test utlogging/tilbakekalling og ekte bilde/tekstinnsending før familiens daglige bruk. Bare den valgte agenten behandler data; ingen eksterne AI-kall gjøres av prosjektet uten agentoppsettet.

## Windows og Raspberry Pi

Familievisningen er laget for en permanent **24-tommers touchskjerm i 16:9, 1920 × 1080**, sentralt i huset: et vakkert og nyttig møbel familien bruker sammen. Monter i en høyde barna kan nå. Store trykkflater, touchrulling og tilbakeføring til oversikten etter inaktivitet er tilpasset denne bruken. En separat laptop/mini-PC driver løsningen; skjermen eller Pi-en viser den. Mobilvisningen fungerer i tillegg.

`scripts/install-web.ps1` installerer en lokal Windows-oppgave under den nåværende brukeren. Kjør bare fra den nye installasjonen. Oppgavene må ha tilgang til samme DPAPI-bruker. Pi-en kan kjøre `scripts/dashboard-kiosk.sh` som bruker-tjeneste fra `scripts/dashboard-kiosk.service`. Kopier skriptet til `~/.local/bin/familien-kiosk` og gjør det kjørbart. Tilpass display/Wayland/X11 til Pi-OS. Installer et SSH-alias `dashboard` med verifisert vertsnøkkel; `install-dashboard-tunnel.ps1` videresender kiosk/gateway til loopback på Pi. Ikke eksponer agentporten som kiosk. Oppsettet er et utgangspunkt; display- og tunneloppsett må testes på den faktiske maskinen.

## Akseptanse før automatikk

- En ny ukeplan er fullstendig lest, gir riktig dato og pakkeliste, og originalen kan åpnes fra telefon.
- Ny gjennomgang av uendret plan lager ingen nye nedlastinger eller kalenderdubletter.
- Søsken har individuelle avkryssinger. Skjul/gjenåpne synkroniserer med testkalenderen.
- En utløpt økt gir synlig dekningshull og et forståelig varsel.
- Mobil tekst/bilde behandles straks lease er ledig; lokal visning og kalender samsvarer.
- Gjenstart av web/PC bevarer data, låseregler og familiens valg.
