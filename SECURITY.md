# Security policy

## Reporting a vulnerability

Report vulnerabilities privately through GitHub: on the repository page, open **Security → Report a vulnerability**. Please don't open a public issue for security problems.

Include the version or commit, the command you ran, and what happened.

## Supported versions

Fixes go into the latest release on npm.

## Scope

- The tool runs referenda against local Chopsticks forks, using well-known development accounts such as Alice. It never needs your keys or seed phrase; if it ever asks for one, that is a bug.
- A post-test (`--post-test`) is JavaScript that runs with your user's permissions. Running a post-test from an untrusted source is the same as running untrusted code, so it is not a vulnerability in this tool.
- The bundled `apply-authorized-upgrade` post-test downloads runtime WASM files from GitHub releases and only applies one whose blake2-256 hash matches the upgrade authorized on chain.

## Release integrity

Releases are built by GitHub Actions and staged on npm using trusted publishing. A staged version only goes public after a maintainer approves it with npm two-factor authentication, so the CI pipeline alone cannot release anything. Each version on npm has a provenance attestation that links it to the commit and workflow run that built it, and ships an `npm-shrinkwrap.json` that pins every dependency to the version tested for that release.
