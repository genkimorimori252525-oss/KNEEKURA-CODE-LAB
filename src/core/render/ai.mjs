import { validateAnalysisResultV1 } from '../schema/v1.mjs';

export function renderAnalysisForAI(result, {
  profile = 'standard'
} = {}) {
  validateAnalysisResultV1(result);
  if (!['compact','standard','forensic'].includes(profile)) {
    throw new TypeError('unsupported AI render profile: ' + profile);
  }

  const lines = [];
  lines.push('# CORE AnalysisResult');
  lines.push(
    'analysis=' + result.analysis_id +
    ' session=' + result.session_id +
    ' run=' + result.status
  );
  lines.push(
    'snapshot=' + result.snapshot.snapshot_id +
    ' coverage=' + result.coverage.completeness
  );

  lines.push('');
  lines.push('## Claims');
  if (!result.claims?.length) {
    lines.push('- none');
  } else {
    for (const claim of result.claims) {
      lines.push(renderClaim(claim, profile));
    }
  }

  lines.push('');
  lines.push('## Coverage / Unknowns');
  lines.push(
    '- completeness=' + result.coverage.completeness +
    ' entries=' + result.coverage.entries.length
  );
  for (const unknown of result.unknowns ?? []) {
    lines.push(
      '- UNKNOWN ' + String(unknown.ref ?? unknown.kind ?? 'unknown') +
      ': ' + String(unknown.reason ?? unknown.reason_code ?? 'unresolved')
    );
  }
  if (!(result.unknowns ?? []).length) lines.push('- unknowns=none');

  lines.push('');
  lines.push('## Evidence refs');
  lines.push(
    '- support=' + ((result.evidence_refs ?? []).join(', ') || 'none')
  );
  lines.push(
    '- counter=' + ((result.counterevidence_refs ?? []).join(', ') || 'none')
  );

  lines.push('');
  lines.push('## Validation');
  if (!(result.recommended_validation ?? []).length) {
    lines.push('- none');
  } else {
    for (const item of result.recommended_validation) {
      lines.push(
        '- ' + String(item.code ?? 'VALIDATE') +
        ': ' + String(item.message ?? item)
      );
    }
  }

  if ((result.warnings ?? []).length) {
    lines.push('');
    lines.push('## Warnings');
    for (const warning of result.warnings) {
      lines.push(
        '- ' + String(warning.code ?? 'WARNING') +
        ': ' + String(warning.message ?? warning.reason ?? warning)
      );
    }
  }

  if ((result.failures ?? []).length) {
    lines.push('');
    lines.push('## Failures');
    for (const failure of result.failures) {
      lines.push(
        '- ' + String(failure.code ?? 'FAILURE') +
        ': ' + String(failure.message ?? failure.reason ?? failure)
      );
    }
  }

  if (profile !== 'compact') {
    lines.push('');
    lines.push('## Affected symbols');
    for (const symbol of result.affected_symbols ?? []) {
      lines.push(
        '- ' + symbol.node_id +
        ' ' + String(symbol.kind ?? '') +
        ' ' + String(symbol.key ?? symbol.label ?? '')
      );
    }

    lines.push('');
    lines.push('## Relevant graph paths');
    for (const edge of result.graph_paths ?? []) {
      lines.push(
        '- ' + edge.edge_id +
        ' ' + edge.from + ' -[' + edge.edge_type + ']-> ' + edge.to
      );
    }
  }

  if (profile === 'forensic') {
    lines.push('');
    lines.push('## Evidence provenance');
    for (const evidence of result.evidence ?? []) {
      const provenance = evidence.provenance ?? {};
      lines.push(
        '- ' + evidence.id +
        ' kind=' + evidence.kind +
        ' provider=' + evidence.provider_id + '@' + evidence.provider_version +
        ' snapshot=' + provenance.snapshot_id +
        (provenance.path ? ' path=' + provenance.path : '') +
        (provenance.artifact_id ? ' artifact=' + provenance.artifact_id : '') +
        (provenance.runtime_run_id ? ' run=' + provenance.runtime_run_id : '')
      );
    }

    lines.push('');
    lines.push('## Verifier records');
    for (const record of result.verifier_records ?? []) {
      lines.push(
        '- ' + record.id +
        ' ' + record.verifier_id + '@' + record.verifier_version +
        ' status=' + record.status +
        ' findings=' +
        (record.findings ?? [])
          .map(item => item.code ?? item.message ?? 'finding')
          .join(',')
      );
    }
  }

  return lines.join('\n') + '\n';
}

function renderClaim(claim, profile) {
  const base =
    '- [' + claim.status + '] ' +
    claim.id + ' ' +
    claim.predicate + '=' +
    JSON.stringify(claim.object_or_value);

  const qualifiers = [];
  qualifiers.push('type=' + claim.type);
  qualifiers.push('coverage=' + claim.coverage_ref);
  qualifiers.push(
    'evidence=' +
    claim.evidence_links.map(link => link.evidence_id).join(',')
  );
  if (claim.counterevidence_links.length) {
    qualifiers.push(
      'counter=' +
      claim.counterevidence_links.map(link => link.evidence_id).join(',')
    );
  }
  if (claim.status === 'UNRESOLVED' && claim.unresolved_reason) {
    qualifiers.push('reason=' + claim.unresolved_reason);
  }

  if (profile === 'compact') {
    return base + ' {' + qualifiers.join(' ') + '}';
  }

  qualifiers.push('subject=' + JSON.stringify(claim.subject));
  qualifiers.push(
    'confidence=' +
    claim.confidence.level + ':' + claim.confidence.rationale
  );
  if (claim.dependency_claim_ids.length) {
    qualifiers.push('depends=' + claim.dependency_claim_ids.join(','));
  }
  return base + ' {' + qualifiers.join(' ') + '}';
}
