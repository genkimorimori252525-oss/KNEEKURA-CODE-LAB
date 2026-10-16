import { attachWorkbenchToExplorerProjection } from "../presentation/explorer/workbench.mjs";
import fs from "node:fs/promises";
import path from "node:path";
import { runEvidenceWorkbench, describeEvidenceWorkbench } from "./index.mjs";
import { compileWorkbenchArtifact } from "./render.mjs";
import { LIMITS } from "./contracts.mjs";
export async function runWorkbenchCli(args) {
  if (args.includes("--help")) {
    console.log(JSON.stringify(describeEvidenceWorkbench(), null, 2));
    return;
  }
  const get = (k) => {
    const i = args.indexOf(k);
    return i < 0 ? null : args[i + 1];
  };
  const input = get("--request"),
    output = get("--out");
  if (!input || !output)
    throw new TypeError(
      "workbench requires --request request.json --out NEW-directory",
    );
  const st = await fs.stat(input);
  if (!st.isFile() || st.size > LIMITS.maxBytes)
    throw new RangeError("request must be a bounded regular JSON file");
  const request = JSON.parse(await fs.readFile(input, "utf8"));
  const report = runEvidenceWorkbench(request);
  const explorerProjection =
    report.operation === "import" && request.projection
      ? attachWorkbenchToExplorerProjection(report.result, request.projection, {
          reportId: report.report_id,
        })
      : null;
  const bundle = compileWorkbenchArtifact(report, { explorerProjection });
  const out = path.resolve(output);
  await fs.mkdir(out); // Intentionally fail if output exists: never overwrite sources/artifacts.
  for (const file of bundle.files)
    await fs.writeFile(path.join(out, file.path), file.content, { flag: "wx" });
  await fs.writeFile(path.join(out, "bundle.zip"), bundle.zip_bytes, {
    flag: "wx",
  });
  console.log(`Evidence workbench: ${report.report_id} -> ${out}`);
}
