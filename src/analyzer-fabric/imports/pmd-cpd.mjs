import {
  boundedArray,
  safePath,
  requireText,
  createImportResult,
  LIMITS,
  freeze,
  validateImportResult,
} from "../../analysis-workbench/contracts.mjs";

function decode(text) {
  if (/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[\da-fA-F]+;)/.test(text))
    throw new Error("Invalid XML entity");
  return text.replace(
    /&(amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);/g,
    (_, name) => {
      const predefined = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
      if (predefined[name]) return predefined[name];
      const n = name.startsWith("#x")
        ? parseInt(name.slice(2), 16)
        : Number(name.slice(1));
      if (
        !Number.isInteger(n) ||
        (n < 32 && ![9, 10, 13].includes(n)) ||
        n === 0xfffe ||
        n === 0xffff ||
        n > 0x10ffff ||
        (n >= 0xd800 && n <= 0xdfff)
      )
        throw new Error("Invalid XML character entity");
      return String.fromCodePoint(n);
    },
  );
}
// Deliberately small, strict, non-resolving XML parser. Never resolves DTDs or URLs.
function parseXml(xml) {
  if (typeof xml !== "string" || Buffer.byteLength(xml) > LIMITS.maxBytes)
    throw new Error("CPD XML artifact exceeds byte limit or is not text");
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/u.test(xml))
    throw new Error("Forbidden XML character");
  if (/<!DOCTYPE|<!ENTITY/i.test(xml))
    throw new Error("DTD and entity declarations are forbidden");
  const document = { name: "#document", children: [], text: "" },
    stack = [document];
  let pos = 0,
    count = 0;
  function append(text) {
    const node = stack.at(-1);
    node.text += text;
    if (node.text.length > LIMITS.maxString)
      throw new Error("XML text exceeds string limit");
  }
  while (pos < xml.length) {
    if (xml.startsWith("<!--", pos)) {
      const end = xml.indexOf("-->", pos + 4);
      if (end < 0 || xml.slice(pos + 4, end).includes("--"))
        throw new Error("Malformed XML comment");
      pos = end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", pos)) {
      const end = xml.indexOf("]]>", pos + 9);
      if (end < 0 || stack.length < 2) throw new Error("Malformed CDATA");
      append(xml.slice(pos + 9, end));
      pos = end + 3;
      continue;
    }
    if (xml.startsWith("<?xml", pos)) {
      const end = xml.indexOf("?>", pos + 5);
      if (pos !== 0 || end < 0) throw new Error("Invalid XML declaration");
      pos = end + 2;
      continue;
    }
    if (xml[pos] !== "<") {
      const next = xml.indexOf("<", pos);
      const end = next < 0 ? xml.length : next;
      append(decode(xml.slice(pos, end)));
      pos = end;
      continue;
    }
    const match = /^<((?:[^"'<>]|"[^"<]*"|'[^'<]*')*)>/.exec(xml.slice(pos));
    if (!match) throw new Error("Malformed XML tag");
    pos += match[0].length;
    const body = match[1];
    if (body.startsWith("/")) {
      if (stack.length < 2 || body.slice(1).trim() !== stack.at(-1).name)
        throw new Error("Mismatched XML closing tag");
      stack.pop();
      continue;
    }
    const tag = /^([A-Za-z_][\w:.-]*)([\s\S]*?)(\/?)$/.exec(body);
    if (!tag) throw new Error("Unsupported XML construct");
    const attrs = {};
    let rest = tag[2];
    while (rest.length) {
      if (!rest.trim()) break;
      const attr = /^\s+([A-Za-z_][\w:.-]*)\s*=\s*("[^"<]*"|'[^'<]*')/.exec(
        rest,
      );
      if (!attr || Object.hasOwn(attrs, attr[1]))
        throw new Error("Malformed or duplicate XML attribute");
      const value = decode(attr[2].slice(1, -1));
      if (value.length > LIMITS.maxString)
        throw new Error("XML attribute exceeds string limit");
      attrs[attr[1]] = value;
      rest = rest.slice(attr[0].length);
    }
    if (++count > LIMITS.maxRecords || stack.length > LIMITS.maxDepth)
      throw new Error("XML structural limit exceeded");
    const node = { name: tag[1], attrs, children: [], text: "" };
    stack.at(-1).children.push(node);
    if (!tag[3]) stack.push(node);
  }
  if (
    stack.length !== 1 ||
    document.children.length !== 1 ||
    document.text.trim()
  )
    throw new Error("Malformed XML document");
  return document.children[0];
}
function positive(value, label) {
  if (
    !/^\d+$/.test(value ?? "") ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) < 1
  )
    throw new Error(`Invalid ${label}`);
  return Number(value);
}
export function importCpd(artifact, context, options = {}) {
  const root = parseXml(artifact);
  if (root.name !== "pmd-cpd" || root.text.trim())
    throw new Error("Expected pmd-cpd XML root");
  const findings = [],
    warnings = [
      "Token similarity does not establish semantic equivalence or authorize deletion.",
    ];
  for (const node of root.children) {
    if (node.name === "file") {
      safePath(node.attrs.path);
      if (node.children.length) throw new Error("Invalid CPD inventory file");
      continue;
    }
    if (
      ["error", "processingError", "configurationError"].includes(node.name)
    ) {
      warnings.push(
        `CPD reported ${node.name}: ${node.text || node.attrs.msg || "coverage incomplete"}`,
      );
      continue;
    }
    if (node.name !== "duplication" || node.text.trim())
      throw new Error("Unsupported CPD report element");
    const lines = positive(node.attrs.lines, "duplication lines"),
      tokens = positive(node.attrs.tokens, "duplication tokens");
    const sources = [];
    let code_fragment = null;
    for (const child of node.children) {
      if (child.name === "file") {
        if (child.children.length || child.text.trim())
          throw new Error("Invalid CPD occurrence");
        const start_line = positive(child.attrs.line, "occurrence line");
        const end_line =
          child.attrs.endline === undefined
            ? start_line + lines - 1
            : positive(child.attrs.endline, "occurrence endline");
        if (!Number.isSafeInteger(end_line) || end_line < start_line)
          throw new Error("Invalid CPD line range");
        sources.push({
          path: safePath(child.attrs.path),
          start_line,
          end_line,
          snapshot_id: context.snapshot_id,
        });
      } else if (
        child.name === "codefragment" &&
        code_fragment === null &&
        !child.children.length
      )
        code_fragment = child.text;
      else throw new Error("Invalid CPD duplication child");
    }
    if (sources.length < 2)
      throw new Error("CPD duplication requires two occurrences");
    findings.push({
      kind: "clone-group",
      title: `${tokens} duplicated tokens across ${sources.length} occurrences`,
      sources,
      capability: "SYNTAX",
      strength: "STRUCTURAL",
      details: {
        lines,
        tokens,
        code_fragment,
        semantic_equivalence: "UNKNOWN",
      },
    });
  }
  return createImportResult("pmd-cpd", artifact, context, findings, {
    format: "pmd-cpd-xml",
    warnings,
  });
}
export function annotateCloneGroups(result, annotations) {
  validateImportResult(result);
  if (result.adapter_id !== "pmd-cpd")
    throw new Error("Expected CPD import result");
  const ids = new Set(result.findings.map((f) => f.finding_id ?? f.id));
  const normalized = boundedArray(annotations, "clone annotations").map(
    (annotation) => {
      const id = requireText(annotation.finding_id, "finding_id");
      if (!ids.has(id)) throw new Error("Unknown clone group");
      return {
        finding_id: id,
        label: requireText(annotation.label, "label"),
        note: requireText(annotation.note, "note"),
        authority: "HUMAN_ANNOTATION",
      };
    },
  );
  return freeze({
    schema: "kneekura.clone-annotations/v1",
    import_id: result.import_id,
    annotations: normalized,
  });
}
