# Matrix Chat Prototype (React)

Schneller React-Prototyp fuer einen Matrix-Client mit:
- Passwort-Login gegen einen Matrix Homeserver
- Raumliste
- Nachrichtenanzeige pro Raum
- Senden von Textnachrichten
- Join per Raum-ID oder Alias

## Start

```bash
npm install
npm run dev
```

Dann im Browser die angezeigte lokale URL oeffnen.

## Deploy auf Vercel

1. Repository nach GitHub pushen.
2. Auf https://vercel.com einloggen und `Add New -> Project` waehlen.
3. GitHub-Repository importieren.
4. Vercel erkennt die Einstellungen aus `vercel.json` automatisch.
5. Deploy starten.

Nach dem Deploy bekommst du eine oeffentliche URL wie `https://dein-projekt.vercel.app`.

Hinweis fuer Matrix/Homeserver:
- Falls Requests oder Bilder im Web nicht laden, liegt es meist an CORS oder Media-Auth auf dem Homeserver.
- Dann die Vercel-Domain in der Homeserver/CORS-Konfiguration erlauben.

## Hinweis

- Der Prototyp nutzt `matrix-js-sdk` ohne End-to-End-Verschluesselung.
- Fuer Demo-Zwecke gedacht, nicht produktionsreif.
