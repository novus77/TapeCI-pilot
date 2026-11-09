# Object storage (local / S3 / R2 / MinIO)

Artifact tars are stored content-addressed as `sha256/<64-hex>.tar` (optionally under a
prefix). The same bytes always map to the same key, so retries and duplicate uploads are
idempotent. Both `put` and `get` verify the SHA-256 again; a corrupted or truncated object is
rejected instead of being served to the plan worker.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `TAPECI_OBJECT_STORE` | `local` | `local` or `s3` |
| `OBJECT_STORE_DIR` | `.tapeci/objects` | local root |
| `S3_BUCKET` | — | bucket name |
| `S3_REGION` | `auto` | AWS region or `auto` for R2 |
| `S3_ENDPOINT` | — | R2/MinIO endpoint; omit for AWS S3 |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | — | credentials (secret manager, never committed) |
| `S3_PREFIX` | — | key prefix, e.g. `prod` |
| `S3_FORCE_PATH_STYLE` | `true` when endpoint set | R2/MinIO need path style |

The API and worker must share the same bucket/prefix. `POST /v1/builds/artifacts` writes the
tar; the worker reads it during plan/deploy/rollback. No presigned URLs are generated and the
console never receives object keys as URLs.

### Cloudflare R2

```bash
TAPECI_OBJECT_STORE=s3
S3_BUCKET=tapeci-artifacts
S3_REGION=auto
S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_PREFIX=prod
S3_FORCE_PATH_STYLE=true
```

R2 API tokens should be scoped to **Object Read & Write** on this bucket only.

### AWS S3

Omit `S3_ENDPOINT` and leave `S3_FORCE_PATH_STYLE` unset. Use an IAM role or a dedicated user
with `s3:PutObject`, `s3:GetObject`, `s3:HeadObject`(covered by GetObject) and `s3:DeleteObject`
on `arn:aws:s3:::<bucket>/<prefix>/*`. Do not grant `ListBucket` unless operations need it.

### MinIO (local integration)

```bash
S3_ENDPOINT=http://127.0.0.1:9000
S3_FORCE_PATH_STYLE=true
```

## Bucket policy

- **Private bucket.** No public access, no static website hosting.
- Default server-side encryption on (SSE-S3/SSE-KMS or R2 default).
- Versioning recommended: an accidental delete can be recovered, but do not rely on it instead
  of the database.
- Lifecycle: keep artifacts at least as long as the releases/verification evidence that
  reference them. Deleting an object makes the corresponding deployment unverifiable and
  blocks rollback.
- Egress is server-side only; no browser CORS configuration is required.

## Migrating local → S3

The database stores only `artifact_storage_key` (`sha256/<hex>.tar`), so no schema change is
needed:

```bash
aws s3 sync .tapeci/objects/ "s3://$S3_BUCKET/$S3_PREFIX/" --exclude "*" --include "sha256/*.tar"
```

Then set `TAPECI_OBJECT_STORE=s3` for **both** API and worker and restart them. Verify by
re-running a fork pipeline or uploading a small artifact and confirming the plan worker can
read it.

## Verification

```bash
corepack pnpm test:p2 -- tests/p2/github/s3-store.test.ts
corepack pnpm test:p2 -- tests/p2/api/object-store.test.ts
```

`tests/p2/github/s3-store.test.ts` runs the real AWS SDK against a local HTTP server that
implements PUT/GET/HEAD/DELETE; it asserts round-trip, key/content mismatch rejection, prefix
handling and corrupted-object rejection. No cloud credentials are needed.

## Known limits

- Single `PutObject` only; artifacts are capped at 64 MiB, below the S3 single-PUT limit. No
  multipart/resumable upload.
- No server-side lifecycle automation in TapeCI; configure bucket lifecycle externally.
- `S3ObjectStore.destroy()` is used by tests/short-lived processes; the long-running API and
  worker keep the client pooled.
