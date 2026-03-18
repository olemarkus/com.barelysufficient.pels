---
title: Contributor Setup
description: Clone the repository, validate the Homey app, run the docs locally, and install PELS from source when you are contributing or testing development builds.
---

# Contributor Setup

This page is for contributors, developers, and advanced testers working from the repository.

If you are trying to use PELS in your home after installing it on Homey Pro, go to [Getting Started](/getting-started) instead.

## What this page is for

Use this page when you need to:

- clone the repository
- run the docs site locally
- validate the Homey app bundle
- install a development build on Homey Pro

## What you need

- Node.js 22 or later
- npm 10.x
- Homey CLI installed globally:

```bash
npm install -g homey
```

- A Homey Pro if you want to install and test the app itself

## Clone and install dependencies

```bash
git clone https://github.com/olemarkus/com.barelysufficient.pels.git
cd com.barelysufficient.pels
npm install
```

## Run the docs site locally

```bash
npm run docs:dev
```

This starts the docs site locally so you can review content and styling changes while editing the docs.

## Validate the app bundle

```bash
npm run validate
```

This runs Homey validation and the packaging check.

## Install a development build on Homey

```bash
homey login
npm run install-app
```

Only use this path when you are intentionally testing from source.

## Other useful commands

```bash
npm run docs:build
npm run lint
npm run ci:checks
```

## Audience split

- [Getting Started](/getting-started) is for end users working with an already installed app.
- This page is for people working with the repository and development workflows.
