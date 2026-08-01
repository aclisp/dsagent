# Releasing DSCode

DSCode uses two long-lived branches:

- `dev`: default branch for daily development
- `main`: release-ready history only

## Normal release flow

1. Develop and validate on `dev`.
2. Update the matching versions in `package.json` and `packages/core/package.json` on `dev`:

   ```bash
   npm version patch --no-git-tag-version
   npm version patch --no-git-tag-version --prefix packages/core
   pnpm install --lockfile-only
   pnpm check
   ```

3. Open a pull request from `dev` to `main`. CI rejects the release if its version was not changed or
   if that package version already exists on npm.
4. Merge after CI passes. The successful `main` CI run triggers `.github/workflows/release.yml`, which
   creates the matching `vX.Y.Z` tag and GitHub Release automatically. CI rejects mismatched CLI/Core
   versions.

After creating the GitHub Release, `.github/workflows/release.yml` directly calls
`.github/workflows/publish.yml`; manually published GitHub Releases and manual workflow dispatches are
also supported. The publishing workflow verifies that the tagged commit belongs to `main`, checks that
`vX.Y.Z` matches both package manifests, runs the complete test and packed-install suite, creates the
`@thinkany/dscode` and `@thinkany/dscode-core` tarballs, uploads them as workflow artifacts, and
publishes those exact tarballs to npm. The CLI tarball embeds the matching Core build, so CLI users do
not depend on a separate Core registry download. Existing npm versions are detected independently and
skipped so retries can recover if only one package was published.

## npm authentication

Use npm Trusted Publishing instead of keeping a long-lived write token:

1. Publish each package once manually, or temporarily add a granular npm publishing token as the GitHub
   Actions secret `NPM_TOKEN` for the first release of `@thinkany/dscode-core`.
2. In both package settings pages on npmjs.com, add a GitHub Actions trusted publisher:
   - Organization: `thinkany-ai`
   - Repository: `dscode`
   - Workflow filename: `publish.yml`
   - Allowed action: `npm publish`
3. Remove the `NPM_TOKEN` repository secret after OIDC publishing succeeds.

The workflow grants only `contents: read` and `id-token: write`. npm Trusted Publishing uses the OIDC
token and automatically adds provenance for a public package published from this public repository.

## Recommended GitHub settings

Protect `main` with these repository rules:

- require a pull request before merging
- require the `CI / check` status check
- block force pushes and branch deletion
- allow releases only from tags created on `main`

Keep `dev` as the repository default branch.
