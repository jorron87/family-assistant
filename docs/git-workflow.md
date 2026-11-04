# Én kodebase, lokal instans

En kjørende installasjon kan være et vanlig checkout av dette repoet. Windows-oppgaver, Chrome-utvidelsen og agentoppgaver peker da til samme mappe. Kildeendringer gjøres der og kan publiseres uten et separat eksportsteg. Oppdateringer må testes og gjennomgås før push.

Følgende holdes lokalt og utenfor Git:

- `config/*.json` er instanskonfigurasjon. Bare `.example.json` er offentlige. `config/profile.json` er en startprofil; løpende profil lagres i arkivet.
- `.local/AGENTS.md` inneholder familiens egne beslutninger/instrukser. `.local/docs/` kan inneholde detaljert instansdokumentasjon. Public AGENTS.md ber agenten lese den lokale filen.
- `.local/privacy.json` har `privateTerms` (strenger) og `privatePatterns` (Unicode-regex) som identifiserer lokale navn, adresser, kontoer og kilde-ID-er. Verdiene skrives aldri i kontrollens feilmeldinger.
- `.local/development.json` autoriserer publisering, for eksempel `{"publishAuthorized":true,"expectedRepository":"OWNER/REPOSITORY"}`. Opprett den bare etter uttrykkelig godkjenning fra eieren.
- Arkiv, nøkler, originaler, driftsnotater, midlertidige filer og produksjonslogger er private. Arkivet kan ligge utenfor checkout som før.

## Utviklingsflyt

```powershell
npm run hooks
# Gjør og kontroller kodeendringen. Stage eventuelle nye, offentlige filer eksplisitt.
git add src/new-feature.mjs test/new-feature.test.mjs
npm run ship -- --message "Describe the reusable improvement"
```

Ship legger til endringer i allerede sporede filer, kontrollerer faktisk staging-innhold, kjører testene, committer og pusher til forventet origin. Nye filer tas ikke automatisk med. Ikke sett opp en filovervåker som pusher vilkårlige arbeidsfiler. Pre-commit og commit-msg kontrollerer staging og committekst; pre-push kontrollerer alle nye committrær, slik at et privat dokument som senere ble slettet fortsatt oppdages. Kontrollene er tillegg til menneskelig/agentisk gjennomgang, ikke en garanti mot alle personopplysninger.

En lokal konfigurasjonsendring skal ikke gi Git-endring. Dersom noe privat likevel blir staged: unstage filen og flytt valget til lokal konfigurasjon. Har det blitt commitet, må historikken repareres **før** push. Ikke omgå hookene med `--no-verify`.

Tester bruker en egen midlertidig datamappe, syntetisk konfigurasjon og deaktivert bakgrunnsdispatch. Ikke pek tester på produksjonsdata. På Windows kan en pakket skrivebordsapp og en planlagt tjeneste se ulike virtuelle AppData-mapper selv når stien ser lik ut. Kontroller faktisk tjenestetilstand og ta sikkerhetskopi i tjenestens Windows-kontekst; anta ikke at et vilkårlig direkte filoppslag er produksjonsarkivet.

## Flytting fra eldre installasjon

Ta privat sikkerhetskopi av kode, lokale instrukser og konfigurasjon. Bevar dataområdet, DPAPI-bruker, canonicalKeys og familievalg. Ikke publiser den gamle arbeidsmappens historikk. Legg de offentlige sporede filene over i eksisterende tjenestemappe, mens private filer bevares ignorert. Konfigurer egen profil, agentmodell/tillatelser og eventuelle API-nøkler lokalt. Fullfør tester og en isolert oppstart med kopi av arkivet før skånsom omstart. Verifiser mobil, kiosk, samler og eksisterende data etterpå. Et uendret tjenestefilsted sparer omlegging av planlagte oppgaver og Chrome-utvidelsen.
