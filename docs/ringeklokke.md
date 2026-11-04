# Valgfri ringeklokke

Koden inkluderer lokal videovisning, alarmmottaker, SMTP-parser, Home Assistant-hendelser og en egen gateway til kiosken. En kompatibel kamerabro, for eksempel Neolink, må installeres separat under sin egen lisens. Ingen kameralegitimasjon, UID, firmwaredump eller brobinærer følger med.

Konfigurer egen URL, streamPath, eksplisitte HA-entiteter og eventuell SMTP-vert/kamera-IP i doorbell.json. Eksempeladresser er reserverte testadresser. Bruk de lokale tilkoblingsverktøyene; hemmeligheter lagres kryptert. Deploymentspesifikke kameraendringer/prober følger ikke med.

Test syntetisk alarm og deretter fysisk ringetrykk. Oppstarts-/replayhendelser skal ikke åpne gammel video. Eksponer aldri strømmen eller adminportene offentlig. Velg tilgang og eventuell lagring sammen med husholdningen.
