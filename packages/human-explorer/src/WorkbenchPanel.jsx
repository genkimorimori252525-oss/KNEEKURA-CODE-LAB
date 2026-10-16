import React, { useMemo, useState } from "react";

const PAGE_SIZE = 100;
const rows = (value) => (Array.isArray(value) ? value : []);
const text = (value) =>
  typeof value === "string"
    ? value.slice(0, 4000)
    : value === null || value === undefined
      ? "UNKNOWN"
      : String(value).slice(0, 4000);

/** Only exact links from the derived projection may select canonical nodes. */
export function activateWorkbenchLink(link, nodeId, onSelectNode) {
  if (
    link?.status !== "MATCH" ||
    !Array.isArray(link.node_ids) ||
    link.node_ids.length !== 1 ||
    link.node_ids[0] !== nodeId ||
    typeof nodeId !== "string" ||
    typeof onSelectNode !== "function"
  )
    return false;
  onSelectNode(nodeId);
  return true;
}

function SourceReference({ source }) {
  return (
    <span>
      {text(source?.path)}
      {source?.start_line ? `:${text(source.start_line)}` : ""}
      {" · snapshot: "}
      {text(source?.snapshot_id)}
    </span>
  );
}

function SourceList({ label, sources }) {
  const list = rows(sources);
  return (
    <section>
      <strong>{label}</strong>
      {list.length ? (
        <ul>
          {list.slice(0, PAGE_SIZE).map((source, index) => (
            <li key={index}>
              <SourceReference source={source} />
            </li>
          ))}
        </ul>
      ) : (
        <p>ソース参照なし / UNKNOWN</p>
      )}
      {list.length > PAGE_SIZE ? (
        <p>先頭100件のみ表示（全{list.length}件）</p>
      ) : null}
    </section>
  );
}

function ObservationReasons({ details }) {
  const metadata = details.observation_metadata;
  const supplied = rows(details.observation_reasons);
  if (!metadata && !supplied.length) return null;
  const reasons = [];
  if (metadata?.identity_match === false) reasons.push("IDENTITY_MISMATCH");
  if (metadata?.instrumented === false) reasons.push("NOT_INSTRUMENTED");
  if (
    metadata?.sampled_out === true ||
    (Number.isSafeInteger(metadata?.dropped_count) &&
      metadata.dropped_count > 0)
  )
    reasons.push("SAMPLED_OR_DROPPED");
  return (
    <section>
      <strong>観測メタデータ（exporter申告）</strong>
      <p>{reasons.length ? reasons.join(" · ") : "UNKNOWN"}</p>
      {supplied.slice(0, PAGE_SIZE).map((reason, index) => (
        <p key={index}>{text(reason?.reason ?? reason)}</p>
      ))}
      <p>未観測は未実行を意味しません。execution: UNKNOWN</p>
    </section>
  );
}

function Finding({ finding, links, onSelectNode }) {
  const details = finding.details ?? {};
  return (
    <article
      style={{ borderTop: "1px solid #748094", paddingTop: 8, marginTop: 12 }}
    >
      <h3>{text(finding.title)}</h3>
      <p>
        {text(finding.kind)} · {text(finding.id)}
      </p>
      {details.category ? (
        <p>
          変更カテゴリ: {text(details.category)} · 振る舞いの同等性: UNKNOWN
        </p>
      ) : null}
      {details.before ? (
        <SourceList label="Before" sources={details.before} />
      ) : null}
      {details.after ? (
        <SourceList label="After" sources={details.after} />
      ) : null}
      <SourceList label="ソース参照" sources={finding.sources} />
      <ObservationReasons details={details} />
      <section>
        <strong>canonicalへの参照</strong>
        {links.length ? (
          <ul>
            {links.slice(0, PAGE_SIZE).map((link, index) => (
              <li key={index}>
                <SourceReference source={link} />
                {" · "}
                {text(link.status)}{" "}
                {link.status === "MATCH" && rows(link.node_ids).length === 1 ? (
                  <button
                    type="button"
                    onClick={() =>
                      activateWorkbenchLink(
                        link,
                        link.node_ids[0],
                        onSelectNode,
                      )
                    }
                  >
                    要素を選択: {text(link.node_ids[0])}
                  </button>
                ) : (
                  <span>未解決（グラフへ移動できません）</span>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p>UNRESOLVED_SOURCE · 対応するグラフ参照なし</p>
        )}
        {links.length > PAGE_SIZE ? (
          <p>先頭100件のみ表示（全{links.length}件）</p>
        ) : null}
      </section>
      <details>
        <summary>インポートされた詳細</summary>
        <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
          {text(JSON.stringify(details, null, 2))}
        </pre>
        {JSON.stringify(details).length > 4000 ? (
          <p>詳細は先頭4000文字のみ表示</p>
        ) : null}
      </details>
    </article>
  );
}

export function WorkbenchPanel({ workbench, onSelectNode }) {
  // Reset paging when a different report is mounted; the parent keys by report ID.
  const [page, setPage] = useState(0);
  const findings = rows(workbench?.findings);
  const linkMap = useMemo(() => {
    const map = new Map();
    for (const link of rows(workbench?.links)) {
      if (!map.has(link.finding_id)) map.set(link.finding_id, []);
      map.get(link.finding_id).push(link);
    }
    return map;
  }, [workbench]);
  if (workbench?.schema !== "kneekura.explorer-workbench-panel/v1") return null;
  const currentPage = Math.min(
    page,
    Math.max(0, Math.ceil(findings.length / PAGE_SIZE) - 1),
  );
  const start = currentPage * PAGE_SIZE;
  return (
    <details
      className="explorer-workbench-panel"
      open
      style={{ overflowWrap: "anywhere" }}
    >
      <summary>Evidence Workbench（{findings.length}件）</summary>
      <p>
        IMPORTED / DERIVED ·
        インポート・派生根拠。canonicalの事実は変更していません。
      </p>
      <p>report: {text(workbench.report_id)}</p>
      <p>
        要素を選択後、既存の変更影響パネルから調査できます。参照の一致は意味や振る舞いの同等性を保証しません。
      </p>
      {rows(workbench.warnings)
        .slice(0, PAGE_SIZE)
        .map((warning, index) => (
          <p key={index}>警告: {text(warning?.message ?? warning)}</p>
        ))}
      {rows(workbench.warnings).length > PAGE_SIZE ? (
        <p>警告は先頭100件のみ表示</p>
      ) : null}
      {!findings.length ? <p>インポートされた所見なし</p> : null}
      <p aria-live="polite">
        {findings.length ? start + 1 : 0}–
        {Math.min(start + PAGE_SIZE, findings.length)} / {findings.length}件
      </p>
      {findings.slice(start, start + PAGE_SIZE).map((finding, index) => (
        <Finding
          key={`${finding.id}:${index}`}
          finding={finding}
          links={linkMap.get(finding.id) ?? []}
          onSelectNode={onSelectNode}
        />
      ))}
      <nav aria-label="Workbenchのページ">
        {currentPage > 0 ? (
          <button type="button" onClick={() => setPage(currentPage - 1)}>
            前の100件
          </button>
        ) : null}
        {start + PAGE_SIZE < findings.length ? (
          <button type="button" onClick={() => setPage(currentPage + 1)}>
            次の100件
          </button>
        ) : null}
      </nav>
    </details>
  );
}
