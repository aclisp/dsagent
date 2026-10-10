# Development Rules

## Releases

- When releasing, merge the `dev` → `main` PR with a **merge commit**.

## Pi upstream source

- When implementing anything that uses pi APIs, refer to the pi source at
  `../pi` (relative to this repo).

## Pi upgrades

- When upgrading pi, inspect the target release's manifests in `../pi` at the
  corresponding release tag. Align versions of dependencies and devDependencies
  explicitly declared by DSCode or its workspace packages that pi also declares
  with the versions used by that release, including packages such as `typebox`,
  `@types/node`, and `vitest`.
- Leave DSCode-only dependencies, such as `@napi-rs/keyring`, unchanged as part of
  a pi upgrade unless a separate dependency upgrade is requested.
