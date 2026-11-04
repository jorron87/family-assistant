# Når kildeelementer leses på nytt

Målet er å kontrollere **nye listekort** ved hver kjøring uten å åpne de samme detaljene og vedleggene igjen. Et element med stabil kilde-ID kvitteres etter første fullstendige lesing. Hvis synlig tittel, kildeutdrag, dato, vedleggshint, URL eller versjon faktisk endres, blir det `changed` og leses på nytt uansett policy. Manglende kildeinnlogging eller sider i listen er fortsatt et dekningshull.

`observe-list.items[].reviewPolicy` er den særskilte merkingen for elementer som kan endres etter publisering:

| Policy | Når detaljene åpnes igjen | Bruk |
| --- | --- | --- |
| `once` (standard) | Ved ny eller synlig endret kildeoppføring | Publiserte beskjeder, vanlige innlegg, enkeltmeldinger, ukeplaner og vedlegg |
| `before-start` | Én gang innen 72 timer før en kommende avtale eller oppgavefrist, i tillegg til synlig endring | Spond-arrangementer og andre oppføringer der tidspunkt/sted/deltakelse kan endres |
| `watch` | Omtrent ukentlig mens elementet er aktuelt, samt én gang innen 72 timer før frist | Åpne avstemninger/betalinger, aktive dialoger og spesifikke tråder der nye kommentarer kan endre familiens handling |

Spond `events` får `before-start` automatisk; `polls` og `payments` får `watch` automatisk, også for tidligere lagrede elementer. Agenten kan merke andre konkrete elementer `before-start` eller `watch` i `observe-list`. En avsluttet avstemning eller avgjort dialog kan eksplisitt settes til `once`; merkingen bevares når senere listeobservasjoner utelater feltet. Irrelevante elementer får ingen tidsbasert detaljkontroll. `changeTracking:"reliable"` med en dokumentert endringstoken kan erstatte tidsbasert kontroll også for disse typene; ikke kall et vanlig oppdateringstidspunkt en slik token.

## Kildetyper

| Kilde | Normal behandling | Når strengere kontroll trengs |
| --- | --- | --- |
| Vigilo Siste nytt | Les post, lenker og vedlegg én gang per stabil ID. Kontroller lister per barn og 72 timers overlapp, men åpne ikke uendrede detaljer. | Merk konkret pågående sak `watch` hvis kommentarer eller rettelser forventes i samme post. Rettelser som vises i listekort eller som nytt innlegg behandles straks. |
| Vigilo Meldinger | Les hver melding og relevante trådsvar én gang. | En aktiv frem-og-tilbake-dialog om dato, frist eller beslutning får `watch` til den er avklart. Nye meldinger/svar som vises i listen leses straks. |
| Vigilo ukeplaner/PDF | Hent, les alle sider og dokumentkvitter én gang. Samme vedleggs-ID uten tegn til endring hentes ikke på nytt. | Ny fil, synlig filversjon, endret vedleggs-ID, rettet plan eller kildebeskjed som sier at innholdet er erstattet: hent aktuell fil, sammenlign SHA-256 med kvitteringen og les bare hvis bytes er nye. |
| Spond innlegg og filer | Les publisert tekst/fil én gang; kontroller listekort for nytt/endrete poster. | Aktive kommentartråder som kan endre en relevant handling får `watch`. |
| Spond arrangementer | `before-start` automatisk; les nye/endrede arrangementer og én gang nær start. | Betaling/avstemning eller løpende beslutning får `watch`. Deltakelse er aldri sikker bare fordi appen viser en automatisk status. |
| Facebook-gruppeinnlegg | Les én gang per permalink; kontroller nye innlegg og synlige endringer i gruppelisten. | Relevante, pågående tråder med dato-/påmeldingsavklaringer får `watch`. Katalogforslag og Facebook-events følger også aktivitetskildenes egen liste-/detaljkontroll. |
| Telefoninnsending | Behandle hver ferdig innsending én gang, inkludert original og publisering. | En ny innsending/rettelse er en ny kildeopplysning; den gamle filen lastes ikke ned på nytt. |
| Aktivitetsoversikter | Kontroller nye listekort i gjeldende vindu. Gjenbruk detaljer for uendrede, dokumenterte arrangementer. | Kontroller lagrede forslag nær start for avlysning, kapasitet og pris; bruk samme canonicalKey ved treff i flere kilder. |
| Renovasjon | Daglig API-kontroll med cache; bare faktisk endret hentedato gir ny publisering. | Kilde-API-feil eller uventet endring i henteliste rapporteres. |

SHA-256 er fortsatt en **lesekvittering for en fil som faktisk er hentet**, ikke en grunn til å laste ned alle gamle vedlegg for å beregne hash på nytt. Nye/endrede filer kan gjenbruke eksisterende kvittering ved identiske bytes. Kildeliste, innlogging, barnedekning, råkort/Drive/Calendar-restanser og åpne oppgaver kontrolleres som før; `once` gjelder detaljlesing av uendrede kildeelementer.
