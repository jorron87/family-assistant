# Drift

Bruk `node src/cli.mjs next`, `completion`, `change-completion`, `dispatch-status`, `collector-status`, `phone-inbox`, `calendar-actions`, `activity-queue` og `usage` til avgrenset diagnostikk. Ikke dump hele arkivet i hver agentrunde. CLI-kontrakter står i runbook.

Ved partial: finn den konkrete flaten/feilen. Skill ekte utlogging, midlertidig API-feil, uleste elementer og gammel status. En403 på ett vedlegg beviser ikke global utlogging. Gjenopprett køer og prøv et rimelig alternativ én gang, men bevar reelle hull. Midlertidig Facebook-loading krever en etterobservasjon før stopp. Ikke start full ny innhenting bare for driftssjekk.

Gi kjente feil et kort lokalt kontrollpunkt under `docs/drift` (ikke commit). Registrer relevante ID-er, faktisk feil, forsøkte metoder og neste kontrollbetingelse. Ingen hemmeligheter eller privat råtekst i slike notater. Varsle bare nye/forverrede feil eller nødvendig familiehandling; en kjent uendret blokkering skal fortsatt stå synlig i systemet.

`scripts/restart-web-when-idle.ps1` bruker skånsom omstart. Ikke slipp en annen agents lease eller stopp en tjenestestartet agent midt i skriving. Bruk egne testporter/dataområder. Vanlig familiebruk skal fungere mens ingest kjører.

Sikkerhetskopier hele dataområdet med nøkkelen og dokumenter DPAPI-bruker/maskin. Test gjenoppretting under riktige Windows-tilganger før nødsituasjonen. Krypterte arkiv og nøkler hører aldri hjemme i GitHub. Se SECURITY.md.
