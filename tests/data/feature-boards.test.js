import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildDataModel, extractDevelopmentStatus } from '../../src/data/data-model.js';

describe('extractDevelopmentStatus (resilient sprint-status parsing)', () => {
	it('reads a clean development_status block with trailing comments', () => {
		const raw = `development_status:
  # Epic 1: Setup
  epic-1: done
  1-1-project-setup: done # closed 2026-01-01
  1-2-basic: in-progress
`;
		assert.deepEqual(extractDevelopmentStatus(raw), {
			'epic-1': 'done',
			'1-1-project-setup': 'done',
			'1-2-basic': 'in-progress',
		});
	});

	it('recovers the block even when other lines would break strict YAML', () => {
		// `story_location: {project-root}/...` is an unquoted flow-map that js-yaml rejects;
		// the extractor should still return the development_status entries.
		const raw = `project: fido
story_location: {project-root}/_bmad-output/implementation-artifacts/venda
development_status:
  epic-1: done
  1-1-cadastrar-produto: done
  epic-1-retrospective: done
`;
		assert.deepEqual(extractDevelopmentStatus(raw), {
			'epic-1': 'done',
			'1-1-cadastrar-produto': 'done',
			'epic-1-retrospective': 'done',
		});
	});

	it('tolerates multi-line prose wrapped under a comment before the block', () => {
		const raw = `# last_updated: 2026-07-19 (a long note that wraps
across a physical line with no leading hash and even a colon: here)
development_status:
  epic-1: done
  1-1-thing: superseded
`;
		assert.deepEqual(extractDevelopmentStatus(raw), {
			'epic-1': 'done',
			'1-1-thing': 'superseded',
		});
	});

	it('returns null when there is no development_status section', () => {
		assert.equal(extractDevelopmentStatus('project: fido\nkey: value\n'), null);
	});
});

describe('buildDataModel feature boards', () => {
	let root;

	before(() => {
		root = mkdtempSync(join(tmpdir(), 'bmad-viewer-fb-'));
		mkdirSync(join(root, '_bmad'), { recursive: true });
		const impl = join(root, '_bmad-output', 'implementation-artifacts');

		// Feature A: clean YAML, all done + one superseded (should count as done).
		mkdirSync(join(impl, 'alpha'), { recursive: true });
		writeFileSync(join(impl, 'alpha', 'sprint-status.yaml'), `development_status:
  # Epic 1: Alpha One
  epic-1: done
  1-1-first: done
  1-2-second: superseded
`);

		// Feature B: YAML-breaking top matter, one story still open.
		mkdirSync(join(impl, 'beta'), { recursive: true });
		writeFileSync(join(impl, 'beta', 'sprint-status.yaml'), `project: fido
story_location: {project-root}/_bmad-output/implementation-artifacts/beta
development_status:
  # Epic 1: Beta One
  epic-1: in-progress
  1-1-alpha: done
  1-2-beta: in-progress
`);
	});

	after(() => rmSync(root, { recursive: true, force: true }));

	it('discovers one board per feature, sorted by name', () => {
		const { project } = buildDataModel(root);
		assert.equal(project.featureBoards.length, 2);
		assert.deepEqual(project.featureBoards.map((b) => b.key), ['alpha', 'beta']);
		assert.deepEqual(project.featureBoards.map((b) => b.label), ['Alpha', 'Beta']);
	});

	it('counts superseded as done and keeps per-feature totals separate', () => {
		const { project } = buildDataModel(root);
		const [alpha, beta] = project.featureBoards;
		assert.deepEqual(alpha.stories, { total: 2, pending: 0, inProgress: 0, done: 2 });
		assert.deepEqual(beta.stories, { total: 2, pending: 0, inProgress: 1, done: 1 });
	});

	it('exposes the first feature as the primary board for legacy fields', () => {
		const { project } = buildDataModel(root);
		assert.equal(project.epics.length, 1);
		assert.match(project.board.sprintStatusPath, /alpha[/\\]sprint-status\.yaml$/);
	});
});
