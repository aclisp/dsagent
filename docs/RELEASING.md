# Releasing DSCode

DSCode is released as a public Docker Hub image from the public GitHub
repository. The repository's npm packages remain private and are not published.

## Branches and versioning

- `dev`: daily development branch
- `main`: protected release branch and GitHub default branch

The root package and `packages/core/package.json` must keep the same version.
The current baseline is `0.9.4`; existing release tags, including `v0.9.2` and
`v0.9.4`, are immutable. The next normal release is `0.9.5` unless the changes
require another semver level.

## Normal release flow

1. Develop and validate on `dev`.
2. Update the matching versions on `dev`:

   ```bash
   npm version patch --no-git-tag-version
   npm version patch --no-git-tag-version --prefix packages/core
   pnpm install --lockfile-only
   pnpm check
   ```

3. Open a pull request from `dev` to `main`. CI requires a version change for
   source changes and verifies that the root and Core packages remain private
   and in lockstep.
4. Merge after CI passes. A versioned `main` commit triggers
   `.github/workflows/release.yml`, which creates the matching immutable
   `vX.Y.Z` Git tag and GitHub Release.
5. The release workflow calls `.github/workflows/publish-image.yml`. It builds
   and smoke-tests both AMD64 variants before publishing them to Docker Hub:

   ```text
   docker.io/aclisp/dsagent:X.Y.Z
   docker.io/aclisp/dsagent:latest
   docker.io/aclisp/dsagent:X.Y.Z-lean
   docker.io/aclisp/dsagent:lean
   ```

The unqualified `latest` and `lean` tags are convenience aliases. Production
deployments should pin a version tag or image digest. Each published image
also receives SBOM and provenance attestations.

## Retry and historical backfill

`publish-image.yml` supports `workflow_dispatch`. Use it to retry a failed
publication or backfill an existing release such as `v0.9.4`; provide the
immutable Git tag and, when useful, its commit SHA. The workflow verifies that
the tag points to a commit reachable from `main` and that its package version
matches the tag. It never moves or recreates an existing Git tag.

The initial Docker Hub backfill for the registry migration is:

```text
v0.9.4 -> docker.io/aclisp/dsagent:0.9.4 and :0.9.4-lean
aliases -> :latest and :lean
```

Existing GHCR images are retained temporarily for rollback and are not the
default distribution.

## Docker images

The default product image is the full tools image built from
`deploy/tools.Dockerfile`. The lean image is published separately with the
`-lean` suffix. Both currently target `linux/amd64`; add another architecture
only after it has passed an explicit deployment validation.

The Docker smoke gate starts each image, checks its entrypoint and required
runtime files, then checks the `/health` endpoint and published port. It does
not call an LLM, provider, or WeCom service. Run the same check locally after
building images when needed:

```bash
node scripts/docker-smoke.mjs dscode-server dscode-server:lean
```

## Image registry permissions

The Docker Hub repository `aclisp/dsagent` must be **Public** so end users can
pull the image without credentials. The publish workflow logs in with a Docker
Hub Access Token stored in the GitHub repository secrets
`DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN`; neither value belongs in the
repository files. The token should have push access without delete access.

## Recommended GitHub settings

Protect `main` with these repository rules:

- set `main` as the default branch
- require a pull request before merging
- require the `CI / check` status check
- block force pushes and branch deletion
- allow release automation to create tags and GitHub Releases

Keep `dev` as the normal development branch. Changes from the original
`thinkany-ai/dscode` repository are reviewed and integrated selectively under
the policy in [UPSTREAM.md](UPSTREAM.md).
