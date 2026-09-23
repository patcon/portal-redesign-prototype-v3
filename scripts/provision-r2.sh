#!/usr/bin/env bash
#
# The bucket call recordings go into, and how long they stay.
#
# Local development needs none of this: `vite dev` simulates the R2 binding
# against `.wrangler/state`. This is for the first deploy to a real account.
#
# Lifecycle rules are *bucket* configuration rather than Worker configuration,
# so they cannot live in `wrangler.jsonc` and there is nothing in the repo that
# would recreate them. That is the whole reason this file exists: the retention
# policy is a decision, and a decision that lives only in a dashboard is one
# nobody can review. Expiry is not immediate — R2 applies it within about a day
# of an object qualifying.
#
# Needs an API token with Workers R2 Storage Write.
#
# Usage: ./scripts/provision-r2.sh

set -euo pipefail

BUCKET="portal-prototype-recordings"
PREFIX="recordings/"
KEEP_DAYS=90

# Creating a bucket that already exists is an error rather than a no-op, so
# this is safe to re-run.
if pnpm wrangler r2 bucket info "$BUCKET" >/dev/null 2>&1; then
  echo "bucket $BUCKET already exists"
else
  pnpm wrangler r2 bucket create "$BUCKET"
fi

pnpm wrangler r2 bucket lifecycle add "$BUCKET" \
  --name "expire-recordings" \
  --prefix "$PREFIX" \
  --expire-days "$KEEP_DAYS"

pnpm wrangler r2 bucket lifecycle list "$BUCKET"
