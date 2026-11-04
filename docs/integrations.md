# Valgfrie integrasjoner

| Integrasjon | Konfigurasjon | Egen tilgang/oppsett |
|---|---|---|
| Vigilo/Spond | collector.json + profile.json | Egen innlogget Chrome-profil og utvidelse; uoffisielle API-adaptere |
| Facebook | sources.json + activity-sources.json | Bare grupper/sider familien har lovlig tilgang til; faktisk besøk og dekning |
| Calendar/Drive | sources.json + /google-setup | Egen OAuth-klient eller agentverktøy; privat mappe/kalender |
| Aktiviteter | activity-sources.json, activity-feeds.json | Velg lokale kilder og interesser selv; forslag legges ikke automatisk i kalender |
| Home Assistant | home-assistant.json | Egen URL, eksplisitt entity-allowlist og egen tilgangsnøkkel via lokal tilkobling |
| Vær | weather.json | Aktiver selv, sett koordinater og gyldig User-Agent/kontakt for MET |
| Renovasjon | sources.json.waste | Støttet kommunal adresse/leverandør og egen autorisert appKey; ingen API-nøkkel følger med |
| Ringeklokke | doorbell.json + docs/ringeklokke.md | Egen kompatibel kamera-/Neolink-bro og evt SMTP; kamera/HA er ikke inkludert |

De stedsspesifikke aktivitetsadapterne omfatter blant annet Hva skjer i Asker, kulturprogram og bibliotek. Eksempelkonfigurasjonen har ingen private grupper, bostedsfiltre eller personlige rangeringer. Kilde-ID-er som activity-11/22/24 brukes også til adaptervalg i koden; se createFeedRunner før du velger nye ID-er. Bygg en ny adapter for andre formater i stedet for å påstå universell dekning.

Google, Vigilo, Spond, Facebook, Home Assistant og eksterne bildebiblioteker/kamerabroer er separate prosjekter/tjenester. Dette repoet er ikke en offisiell integrasjon eller samarbeidspartner. Avklar egne tillatelser og vilkår, og ikke del andres rådata i feilrapporter.
