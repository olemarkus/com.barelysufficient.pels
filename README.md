# PELS

PELS (Pris- og Effektstyrt Energilagringssystem) is a Homey Pro app for capacity-aware energy control. It keeps large electrical loads inside your hourly power limit, resumes them automatically when there is available power again, and can shift flexible heating toward cheaper hours.

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

Keep using `homey app version <patch|minor|major> --commit` for the Homey version commit and tag.
After pushing that tag, promote docs without another source commit:

```bash
npm run docs:promote:test -- v2.7.0
npm run docs:promote:live -- v2.7.0
```

When the ref is omitted, the promotion scripts use `v<app.json version>`.

The short Homey App Store description stays in [`README.txt`](./README.txt).
