# Chrome-utvidelsen

Last inn denne mappen som upakket utvidelse i en egen Chrome-profil. Se ../../docs/setup.md for oppsett. Bruk familiens egen innlogging; ingen økt garanteres å vare permanent. Ved oppdatering: last utvidelsen på nytt og oppfrisk eksisterende kildefaner én gang.

Utvidelsen bruker portalens egne lesekall og sender avgrensede utdrag til http://127.0.0.1:4318. API-er kan endres. Den trenger alarms, scripting og storage og vertstilgang til de oppgitte kildene og den lokale tjenesten. Facebook leses passivt fra besøkte sider. Ingen cookies eller nettleserpassord eksporteres til prosjektet.

Versjon 1.6.13 bevarer gjenværende tilleggsoppgaver ved unauthorized og respekterer ti minutters auth-pause. Bekreft faktisk supplemental implementation extra-auth-queue-2026-11-04, ikke bare manifestversjon.

Versjon 1.9.4 gjenkjenner Sponds «Hjem»-lenke ved kontroll av den innloggede appen, sammen med meldingsknapp og kontomeny. Én skånsom gjenoppretting av en inaktiv app beholdes ved avvist/gammel økt; innloggingsside, aktiv fane, utkast, dialoger, auth-pause og grensen på én gang per time respekteres fortsatt. Kontroller nye faktiske liste-/probe-kvitteringer etter oppdatering; en synlig app eller ny manifestversjon beviser ikke fersk dekning.
