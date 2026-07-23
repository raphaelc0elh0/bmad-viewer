import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildDataModel } from '../../src/data/data-model.js';

describe('project.sprints (unified initiatives)', () => {
	let root;

	before(() => {
		root = mkdtempSync(join(tmpdir(), 'bmad-viewer-sprints-'));
		mkdirSync(join(root, '_bmad', 'bmm'), { recursive: true });
		// Config points the active initiative at the spec-driven one.
		writeFileSync(join(root, '_bmad', 'bmm', 'config.yaml'),
			'implementation_artifacts: "{project-root}/_bmad-output/implementation-artifacts/redesign"\n');

		const impl = join(root, '_bmad-output', 'implementation-artifacts');

		// Sprint-status-backed initiative.
		mkdirSync(join(impl, 'board-feat'), { recursive: true });
		writeFileSync(join(impl, 'board-feat', 'sprint-status.yaml'), `development_status:
  epic-1: done
  1-1-thing: done
`);

		// Spec-driven initiative: three specs, distinct statuses; one non-numeric (Extras).
		mkdirSync(join(impl, 'redesign'), { recursive: true });
		writeFileSync(join(impl, 'redesign', 'spec-0-1-foo.md'), "---\ntitle: 'Onda 0.1 — Foo'\nstatus: 'done'\n---\n\n# Foo\n\nBody.\n");
		writeFileSync(join(impl, 'redesign', 'spec-1-1-bar.md'), "---\ntitle: 'Onda 1.1 — Bar'\nstatus: 'in-review'\n---\n\n# Bar\n");
		writeFileSync(join(impl, 'redesign', 'spec-misc-note.md'), "---\ntitle: 'A loose note'\nstatus: 'todo'\n---\n\n# Note\n");
	});

	after(() => rmSync(root, { recursive: true, force: true }));

	it('lists every initiative, active one first and flagged', () => {
		const { project } = buildDataModel(root);
		assert.equal(project.activeSprintId, 'redesign');
		assert.deepEqual(project.sprints.map((s) => s.id), ['redesign', 'board-feat']);
		assert.equal(project.sprints[0].active, true);
		assert.equal(project.sprints[1].active, false);
	});

	it('tags board source (sprint-status vs specs)', () => {
		const { project } = buildDataModel(root);
		const byId = Object.fromEntries(project.sprints.map((s) => [s.id, s]));
		assert.equal(byId['board-feat'].source, 'sprint-status');
		assert.equal(byId.redesign.source, 'specs');
	});

	it('derives a spec-driven board from frontmatter status, grouped by wave', () => {
		const { project } = buildDataModel(root);
		const redesign = project.sprints.find((s) => s.id === 'redesign');
		// done→done, in-review→review (Active bucket), todo→backlog (pending).
		assert.deepEqual(redesign.stories, { total: 3, pending: 1, inProgress: 1, done: 1 });
		// Waves 0 and 1, plus the non-numeric "Extras" group last.
		assert.deepEqual(redesign.epics.map((e) => e.name), ['Onda 0', 'Onda 1', 'Extras']);
	});

	it('keeps each spec\'s rendered body for its story card', () => {
		const { project } = buildDataModel(root);
		const redesign = project.sprints.find((s) => s.id === 'redesign');
		const foo = redesign.storyList.find((s) => s.id.endsWith('spec-0-1-foo'));
		assert.match(foo.html, /Body\./);
		assert.equal(foo.status, 'done');
	});
});
