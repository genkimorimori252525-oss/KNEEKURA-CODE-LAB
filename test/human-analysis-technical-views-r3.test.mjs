import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createHumanAnalysisTechnicalViews,
  validateHumanAnalysisTechnicalViews
} from '../src/human-analysis/technical-views.mjs';

function ref(path, start, end, char) {
  return {
    kind: 'FILE_RANGE',
    path,
    start_line: start,
    end_line: end,
    content_digest: 'sha256:' + char.repeat(64)
  };
}

function fixture() {
  const a = ref('src/a.ts', 1, 3, 'a');
  const b = ref('src/b.ts', 5, 8, 'b');
  const ir = {
    schema: 'kneekura.human-analysis-ir/v1',
    repository: { repository_id: 'repo:r3', snapshot_id: 'snapshot:r3' },
    evidence_pack: {
      pack_id: 'pack:r3',
      canonical_digest: 'sha256:' + 'c'.repeat(64),
      pack_digest: 'sha256:' + 'd'.repeat(64)
    },
    generation: {
      mode: 'PRODUCTION',
      semantic_author: {
        id: 'r3-test-author',
        provider_id: 'test',
        acceptance_fixture: false
      }
    },
    stages: [],
    items: [
      {
        id: 'item:a',
        stage: 'ARCHITECTURE',
        kind: 'ARCHITECTURE_COMPONENT',
        semantic_class: 'AI_INTERPRETATION',
        source_refs: [a],
        review_status: 'ACCEPT'
      },
      {
        id: 'item:b',
        stage: 'ARCHITECTURE',
        kind: 'ARCHITECTURE_COMPONENT',
        semantic_class: 'AI_INTERPRETATION',
        source_refs: [b],
        review_status: 'ACCEPT'
      },
      {
        id: 'item:flow',
        stage: 'FLOW',
        kind: 'FLOW',
        semantic_class: 'AI_INTERPRETATION',
        source_refs: [a, b],
        review_status: 'ACCEPT'
      }
    ],
    review: {
      accepted_item_ids: ['item:a', 'item:b', 'item:flow'],
      rejected_item_ids: []
    },
    ir_digest: 'sha256:' + 'e'.repeat(64)
  };
  const presentation = {
    schema: 'kneekura.human-analysis-presentation/v1',
    repository: structuredClone(ir.repository),
    human_analysis_ir_digest: ir.ir_digest,
    presentation_id: 'human-presentation:test',
    components: [
      {
        component_id: 'component:a',
        item_id: 'item:a',
        name: 'A',
        responsibility: 'entry',
        member_refs: [a]
      },
      {
        component_id: 'component:b',
        item_id: 'item:b',
        name: 'B',
        responsibility: 'writer',
        member_refs: [b]
      }
    ],
    flows: [
      {
        flow_id: 'flow:publish',
        item_id: 'item:flow',
        name: 'publish',
        entry_step_id: 's1',
        steps: [
          { step_id: 's1', label: 'guard', source_refs: [a] },
          { step_id: 's2', label: 'write', source_refs: [b] },
          { step_id: 's3', label: 'unknown branch', source_refs: [b] }
        ],
        transitions: [
          { from_step_id: 's1', to_step_id: 's2', kind: 'CALL', source_refs: [a, b] },
          { from_step_id: 's2', to_step_id: 's3', kind: 'UNKNOWN', source_refs: [b] }
        ]
      }
    ]
  };
  const spec = {
    architecture: {
      title: 'Architecture',
      component_ids: ['component:a', 'component:b'],
      relations: [
        {
          from_component_id: 'component:a',
          to_component_id: 'component:b',
          type: 'CALLS',
          direction: 'FORWARD',
          confirmation: 'CONFIRMED',
          source_refs: [a, b]
        }
      ]
    },
    workflow: { flow_id: 'flow:publish', title: 'Workflow' },
    sequence: {
      flow_id: 'flow:publish',
      title: 'Sequence',
      messages: [
        {
          from_step_id: 's1',
          to_step_id: 's2',
          label: 'guard then write',
          order: 1,
          confirmation: 'CONFIRMED',
          source_refs: [a, b]
        },
        {
          from_step_id: 's2',
          to_step_id: 's3',
          label: 'order not proven',
          confirmation: 'UNCONFIRMED',
          unconfirmed_reason: 'source does not establish a stable later event order',
          source_refs: []
        }
      ]
    },
    data_flow: {
      flow_id: 'flow:publish',
      title: 'Data Flow',
      transfers: [
        {
          from_step_id: 's1',
          to_step_id: 's2',
          label: 'validated input',
          direction: 'FORWARD',
          confirmation: 'CONFIRMED',
          source_refs: [a, b]
        }
      ]
    },
    lifecycle: {
      flow_id: 'flow:publish',
      title: 'Lifecycle',
      states: [
        { state_id: 'ready', label: 'Ready', source_refs: [a] },
        { state_id: 'published', label: 'Published', source_refs: [b] },
        { state_id: 'pr-created', label: 'PR Created', source_refs: [b] }
      ],
      transitions: [
        {
          from_state_id: 'ready',
          to_state_id: 'published',
          label: 'publish succeeds',
          confirmation: 'CONFIRMED',
          source_refs: [a, b]
        },
        {
          from_state_id: 'published',
          to_state_id: 'pr-created',
          label: 'automatic PR creation',
          confirmation: 'UNCONFIRMED',
          unconfirmed_reason: 'publish and PR creation are separate operations in the inspected scope',
          source_refs: []
        }
      ]
    }
  };
  return { ir, presentation, spec, a, b };
}

test('R3 creates all five evidence-backed technical views without canonical authority', () => {
  const { ir, presentation, spec } = fixture();
  const views = createHumanAnalysisTechnicalViews({ ir, presentation, spec });
  assert.equal(views.schema, 'kneekura.human-analysis-technical-views/v1');
  assert.equal(views.authority.canonical_authority, false);
  assert.equal(views.architecture.relations[0].confirmation, 'CONFIRMED');
  assert.equal(views.workflow.transitions[0].confirmation, 'CONFIRMED');
  assert.equal(views.workflow.transitions[1].confirmation, 'UNCONFIRMED');
  assert.equal(views.sequence.messages[1].order, null);
  assert.equal(views.lifecycle.transitions[1].confirmation, 'UNCONFIRMED');
  assert.equal(validateHumanAnalysisTechnicalViews(views, { ir, presentation }), true);
});

test('R3 rejects a confirmed sequence order without evidence', () => {
  const { ir, presentation, spec } = fixture();
  spec.sequence.messages[0].source_refs = [];
  assert.throws(
    () => createHumanAnalysisTechnicalViews({ ir, presentation, spec }),
    /CONFIRMED requires source_refs/
  );
});

test('R3 rejects an order number on an unconfirmed sequence message', () => {
  const { ir, presentation, spec } = fixture();
  spec.sequence.messages[1].order = 2;
  assert.throws(
    () => createHumanAnalysisTechnicalViews({ ir, presentation, spec }),
    /must not claim order/
  );
});

test('R3 rejects confirmed UNKNOWN data direction', () => {
  const { ir, presentation, spec } = fixture();
  spec.data_flow.transfers[0].direction = 'UNKNOWN';
  assert.throws(
    () => createHumanAnalysisTechnicalViews({ ir, presentation, spec }),
    /cannot use UNKNOWN direction/
  );
});

test('R3 rejects architecture evidence that is not attached to either endpoint component', () => {
  const { ir, presentation, spec } = fixture();
  spec.architecture.relations[0].source_refs = [
    ref('src/foreign.ts', 1, 1, 'f')
  ];
  assert.throws(
    () => createHumanAnalysisTechnicalViews({ ir, presentation, spec }),
    /outside its typed presentation evidence/
  );
});

test('R3 digest validation fails closed on post-construction transition tampering', () => {
  const { ir, presentation, spec } = fixture();
  const views = createHumanAnalysisTechnicalViews({ ir, presentation, spec });
  const tampered = structuredClone(views);
  tampered.lifecycle.transitions[1].confirmation = 'CONFIRMED';
  delete tampered.lifecycle.transitions[1].unconfirmed_reason;
  assert.throws(
    () => validateHumanAnalysisTechnicalViews(tampered, { ir, presentation }),
    /digest mismatch/
  );
});