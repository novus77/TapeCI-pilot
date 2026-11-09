/**
 * Redirect evidence writes away from the tracked tree (P7-11).
 *
 * `docs/evidence/**` is a record of what a run observed at a pin. A test that rewrites
 * those files turns the record into a mutable output of the next run, and a later reader
 * cannot tell the two apart. Importing this module (done by the fork suites that write
 * evidence) points them at a temp directory instead.
 *
 * Set `TAPECI_EVIDENCE_DIR` explicitly to keep the old behaviour, e.g. when deliberately
 * refreshing an artefact for review.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (process.env["TAPECI_EVIDENCE_DIR"] === undefined) {
  process.env["TAPECI_EVIDENCE_DIR"] = mkdtempSync(join(tmpdir(), "tapeci-evidence-"));
}
