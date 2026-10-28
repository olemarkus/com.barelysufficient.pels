# PELS

PELS (Pris- og Effektstyrt Energilagringssystem) is a Homey Pro app for capacity-aware energy control. It keeps large electrical loads inside your hourly or 15-minute capacity limit, resumes them automatically when there is available power again, and can shift flexible heating toward cheaper hours.

The public documentation lives at [pels.barelysufficient.org](https://pels.barelysufficient.org/).

## Documentation

- User docs and setup guide: <https://pels.barelysufficient.org/>
- Technical reference: <https://pels.barelysufficient.org/technical.html>
- Contributor setup: <https://pels.barelysufficient.org/contributor-setup.html>

## Local development

```bash
npm install
npm run docs:dev
```

## Documentation channels

The public docs site publishes three static channels on one GitHub Pages domain:

- Live: <https://pels.barelysufficient.org/>
- Test: <https://pels.barelysufficient.org/test/>
- Dev: <https://pels.barelysufficient.org/dev/>

Cut a release with `npm run release -- start <patch|minor|major> <changelog-file>`, then `npm run release -- finish` (pushes the tag) and `npm run release -- publish`.
After `finish` pushes the tag, promote docs without another source commit:

```bash
npm run docs:promote:test -- v2.7.0
npm run docs:promote:live -- v2.7.0
```

When the ref is omitted, the promotion scripts use `v<app.json version>`.

Homey App Store readmes live in [`README.txt`](./README.txt) (English) and one `README.<lang>.txt` per store language: [Danish](./README.da.txt), [Dutch](./README.nl.txt), [Finnish](./README.fi.txt), [French](./README.fr.txt), [German](./README.de.txt), [Italian](./README.it.txt), [Norwegian](./README.no.txt), [Polish](./README.pl.txt), and [Swedish](./README.sv.txt); one-line descriptions and tags live in [`.homeycompose/app.json`](./.homeycompose/app.json).
