# Releasing DSCode

DSCode uses two long-lived branches:

- `dev`: default branch for daily development
- `main`: release-ready history only

## Normal release flow

1. Develop and validate on `dev`.
2. Update the version in `package.json` on `dev`:

   ```bash
   npm version patch --no-git-tag-version
   pnpm install --lockfile-only
   pnpm check
   ```

3. Open a pull request from `dev` to `main` and merge it after CI passes.
4. Create a GitHub Release from `main` using a tag that exactly matches the package version:

   ```bash
   gh release create v0.3.1 --target main --generate-notes
   ```

Publishing the release triggers `.github/workflows/publish.yml`. The workflow verifies that the tagged
commit belongs to `main`, checks that `vX.Y.Z` matches `package.json`, runs the complete test suite,
creates the npm tarball, uploads it as a workflow artifact, and publishes that exact tarball to npm.

## npm authentication

Use npm Trusted Publishing instead of keeping a long-lived write token:

1. Publish the package once manually, or temporarily add a granular npm publishing token as the GitHub
   Actions secret `NPM_TOKEN` for the first release.
2. In the package settings on npmjs.com, add a GitHub Actions trusted publisher:
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
