import { createHumanAnalysisSourceBroker } from "../human-analysis/source-broker.mjs";
import { assertEvidencePackUnchanged } from "../human-analysis/evidence-pack.mjs";
import { validateWorkbenchReport } from "./render.mjs";
import { boundedArray, freeze, stableDigest, LIMITS } from "./contracts.mjs";

/** Optional host integration: all text passes the existing digest-checking Source Broker. */
export async function materializeWorkbenchSources(
  report,
  { bindings, maxSources = 100, maxLines = 100 } = {},
) {
  validateWorkbenchReport(report);
  boundedArray(bindings, "source bindings", 20);
  if (
    !Number.isInteger(maxSources) ||
    maxSources < 1 ||
    maxSources > 200 ||
    !Number.isInteger(maxLines) ||
    maxLines < 1 ||
    maxLines > 400
  )
    throw new RangeError("invalid source materialization limits");
  const brokers = new Map();
  for (const b of bindings) {
    const pack = b.evidencePack;
    assertEvidencePackUnchanged(pack, pack.canonical_digest);
    const identity = pack.repository;
    if (!identity?.repository_id || !identity?.snapshot_id)
      throw new TypeError("source pack identity required");
    const key = JSON.stringify([identity.repository_id, identity.snapshot_id]);
    if (brokers.has(key)) throw new TypeError("duplicate source binding");
    brokers.set(key, {
      broker: createHumanAnalysisSourceBroker(pack, {
        readSource: async (path) => {
          const value = await b.readSource(path);
          if (
            typeof value !== "string" ||
            Buffer.byteLength(value) > LIMITS.maxBytes
          )
            throw new RangeError("source byte limit exceeded");
          return value;
        },
      }),
      pack,
    });
  }
  const contexts =
      report.input_contexts ??
      (report.result.context ? [report.result.context] : []),
    refs = new Map();
  function visit(value, depth = 0) {
    if (depth > 64) throw new RangeError("source traversal limit exceeded");
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value.sources))
      for (const s of value.sources)
        if (s?.path && s?.snapshot_id) refs.set(stableDigest(s), s);
    for (const [k, v] of Object.entries(value))
      if (k !== "sources" && k !== "observations") visit(v, depth + 1);
  }
  visit(report.result);
  const records = [];
  let bytes = 0;
  for (const [key, ref] of refs) {
    if (records.length >= maxSources) break;
    const repos = [
      ...new Set(
        contexts
          .filter((c) => c.snapshot_id === ref.snapshot_id)
          .map((c) => c.repository_id),
      ),
    ];
    const binding =
      repos.length === 1
        ? brokers.get(JSON.stringify([repos[0], ref.snapshot_id]))
        : null;
    if (!binding || !ref.start_line) {
      records.push({
        source_ref_digest: key,
        ref,
        status: "UNRESOLVED_IDENTITY_OR_RANGE",
      });
      continue;
    }
    const end = Math.min(
      ref.end_line ?? ref.start_line,
      ref.start_line + maxLines - 1,
    );
    const value = await binding.broker.readFileRange({
      kind: "FILE_RANGE",
      path: ref.path,
      start_line: ref.start_line,
      end_line: end,
      ...(ref.content_digest ? { content_digest: ref.content_digest } : {}),
    });
    bytes += Buffer.byteLength(value.text);
    if (bytes > LIMITS.maxBytes)
      throw new RangeError("materialized source byte limit exceeded");
    records.push({
      source_ref_digest: key,
      ref,
      status: "DIGEST_VERIFIED_SOURCE",
      ...value,
      snapshot_id: ref.snapshot_id,
      repository_id: repos[0],
      truncated: end < (ref.end_line ?? ref.start_line),
    });
  }
  const body = {
    ...structuredClone(report),
    derived_from_report_id: report.report_id,
    sources: records,
    source_materialization: {
      total_refs: refs.size,
      returned_refs: records.length,
      truncated: records.length < refs.size,
    },
  };
  delete body.report_id;
  return freeze({
    ...body,
    report_id: "workbench:" + stableDigest(body).slice(7),
  });
}
