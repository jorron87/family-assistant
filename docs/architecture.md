# Arkitektur

Chrome-utvidelsen leser innloggede kilde-API-er og besøkte Facebook-sider. Lokal tjeneste normaliserer native ID-er, holder originalcache og registrerer endringer. Agenten leser nye/relevante tekster og alle sider i nye dokumenter, vurderer datoer/mottakere og lagrer funn, personlige oppgaver og profilfakta. Drive-/Calendar-skriving kvitteres mot gjeldende revisjon. Dashboard og mobil viser lokal tilstand.

| Del | Filer | Ansvar |
|---|---|---|
| Arkiv | src/store.mjs, crypto.mjs | DPAPI-nøkkel, AES-GCM, historikk, lease, stabile identiteter |
| Kilder | config/vigilo-keepalive, src/collector.mjs | API-lister, passiv Facebook, pauser og køer |
| Originaler | src/resources.mjs, original-response.mjs | Bytes, uttrekk, falske feiloriginaler og lesegrunnlag |
| Agent | src/ingestion-dispatch.mjs, phone-dispatch.mjs | Prioritering, avgrenset scope og avslutningskontroll |
| Publisering | src/google-publisher.mjs | Privat Drive/Calendar og faktiske kvitteringer |
| Visning | public, src/phone-server.mjs | Touchkiosk, mobil, personfilter, oppgaver og dokumentlenker |
| Tillegg | home-assistant, doorbell, weather, waste, activity-* | Valgfrie husholdningsintegrasjoner |

Ingen skybackend følger med. Google-kopier og kalender er eksplisitt ekstern publisering; agentens modell/verktøy kan også behandle persondata i henhold til brukerens valgte tjeneste. «Lokal» beskriver prosjektets kjørende tjeneste og arkiv, ikke at en ekstern modell er offline.

Native identitet + gjennomgangskvitteringer reduserer omlesing. Kontrollerbare, sjeldne endringskilder kan ha en annen reviewPolicy enn vanlige engangsmeldinger. Hold forskjell på innhenting, faktisk lesing, publisering og full dekning. En fullført endringskø erstatter ikke en full kildekontroll.
