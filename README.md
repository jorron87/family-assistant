# Family Assistant · Familien

En lokal familieplanlegger med agentisk gjennomgang av Vigilo, Spond, relevante Facebook-grupper og familiens egne mobilinnsendinger. Kalender, personlige oppgaver og originaldokumenter samles i et touchvennlig dashboard og en mobilvisning.

Dette er en generalisert utgave av et system brukt i en husstand. Ingen familiearkiv, innlogginger, private dokumenter eller produksjonskonfigurasjon følger med. Integrasjonene er uoffisielle og kan kreve tilpasning når portalene endres.

## Kom i gang

Krever **Windows, Node.js 24+ og Chrome** på maskinen som samler data. Raspberry Pi kan brukes som separat kioskskjerm. Agentkjøring krever en egen installert og innlogget agent med tilgjengelig modell og nødvendige verktøy; dette prosjektet inkluderer ingen abonnementer eller modelltilgang.

```powershell
git clone https://github.com/jorron87/family-assistant.git
cd family-assistant
npm ci
npm run setup
# Rediger config/profile.json og config/sources.json
npm run doctor
npm start
```

Åpne [lokal familievisning](http://127.0.0.1:4318), [kioskvisning](http://127.0.0.1:4319/?kiosk=1) eller [mobilvisning](http://127.0.0.1:4320/send/). Oppsett kopierer bare manglende eksempelfiler og overskriver aldri eksisterende konfigurasjon. Agent, kildeinnhenting, aktivitetsinnhenting og vær er avslått i eksemplene.

Be din agent lese [AGENTS.md](AGENTS.md), [oppsettet](docs/setup.md) og [kjøringsboken](docs/runbook.md), og hjelpe familien gjennom tilkobling og én manuell gjennomgang før automatikk aktiveres.

## Hva følger med?

- Chrome-utvidelse for innlogget Vigilo og Spond, samt passiv lesing av besøkte Facebook-sider.
- Originalcache, tekstuttrekk fra PDF/DOCX, kryptert arkiv, dokumentkvitteringer og stabil deduplisering.
- Google Calendar/Drive-publisering, kildebelegg og vedvarende skjuling/avkryssing.
- Personlige lekseoppgaver, uke-/månedsvisning og snarvei til hvert barns gjeldende ukebrev.
- Mobilinnboks for bilder, dokumenter og korte tekstbeskjeder, med lagret avsender.
- Aktivitetsforslag, redigerbare profiler, Home Assistant, vær og renovasjon som valgfrie tillegg.
- Kiosk-, SSH-, Windows- og ringeklokkekomponenter, samt regresjonstester.

## Drift og grenser

Arkivet bruker AES-256-GCM; nøkkelen beskyttes med Windows DPAPI for den aktuelle Windows-brukeren. Kryptering erstatter ikke tilgangskontroll eller sikkerhetskopi. Ikke slett nøkkelen eller flytt bare arkivfilene til en annen bruker. Standard dataområde er `%LOCALAPPDATA%\Familien\data`; sett `FAMILIEN_DATA_DIR` til en egen mappe hvis flere installasjoner deler PC.

Agentporten og kiosken er beregnet for et betrodd hjemmemiljø. **Eksponer aldri 4318/4319 direkte på internett.** Mobilporten har egen innlogging og kan publiseres via HTTPS-tunnel; se oppsettet. Ingen offentlige dokumentlenker opprettes som standard. Les [personvern og sikkerhet](SECURITY.md).

Ingen utvidelse kan garantere permanent Vigilo-/Spond-innlogging. Systemet må oppdage utløpt økt og vise reelle dekningshull. Et grønt nettleservindu er heller ikke bevis på at alle barn, vedlegg og kildeflater er kontrollert.

Grensesnitt og datotolkning er foreløpig primært norske, med `Europe/Oslo` i flere moduler. Aktivitetssamlere inkluderer stedsspesifikke adaptere som må velges eller utvides for ditt område. Mobil- og Windows-flytene er hovedplattformen; dette er ikke en ferdig flerbruker-SaaS.

## Utvikling

```powershell
npm test
npm run privacy-check
```

Se [arkitektur](docs/architecture.md), [integrasjoner](docs/integrations.md), [drift](docs/operations.md) og [CONTRIBUTING.md](CONTRIBUTING.md). Del bare syntetiske feiltilfeller. MIT-lisens gjelder prosjektets kode; eksterne tjenester, modeller, biblioteker og kamerabroer har egne vilkår/lisenser.
