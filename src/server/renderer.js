import { BaseLayout } from '../templates/base-layout.js';
import { SidebarNav } from '../components/sidebar-nav.js';
import { StatsBox } from '../components/stats-box.js';
import { KanbanColumn } from '../components/kanban-column.js';
import { ProgressBar } from '../components/progress-bar.js';
import { escapeHtml } from '../utils/html-escape.js';

/**
 * Render the complete dashboard HTML.
 * @param {{wiki: object, project: object, config: object, aggregator: object}} dataModel
 * @returns {string} Complete HTML
 */
export function renderDashboard(dataModel) {
	const { wiki, project, config, aggregator } = dataModel;

	// Build sidebar with proper module/group/item structure
	const sidebar = SidebarNav({
		modules: wiki.modules,
		artifacts: project.artifacts,
		epics: project.epics,
		sprints: project.sprints,
		activeSprintId: project.activeSprintId,
		artifactGroups: project.artifactGroups,
	});

	// Build content data JSON for client-side rendering
	const contentMap = buildContentMap(wiki, project);

	// Build wiki view (initially shows welcome)
	const wikiContent = `<div id="wiki-view">
	<main class="content-area" id="content-area">
		<div class="content-area__breadcrumb" id="wiki-breadcrumb"></div>
		<div class="content-area__body" id="wiki-content-body">
			<h1>${escapeHtml(config.project_name || 'BMAD')} ${config.project_name ? '- bmad-viewer' : 'Viewer'}</h1>
			${config.projectContextHtml
				? `<div class="project-intro">${config.projectContextHtml}</div>`
				: ''}
			<p>Select an item from the sidebar to view its content, or use <kbd>Ctrl+K</kbd> to search.</p>
		</div>
	</main>
</div>`;

	// Build project view. Each initiative is a "sprint" (sprint-status-backed or spec-driven);
	// the client shows the one named by #project?sprint=<id> (default: the active sprint).
	const sprints = (project.sprints && project.sprints.length > 0)
		? project.sprints
		: [{ id: 'sprint', label: 'Sprint', source: 'sprint-status', active: true, stories: project.stories, storyList: project.storyList || [], epics: project.epics, board: project.board }];
	const activeSprintId = project.activeSprintId || sprints[0]?.id || null;
	const singleSprint = sprints.length === 1;

	const noData = project.epics.length === 0 && project.stories.total === 0;
	const configPanel = `<div class="path-config-panel${noData ? '' : ' path-config-panel--collapsed'}" id="path-config-panel">
	<div class="path-config-panel__toggle" id="path-config-toggle">
		<h3>${noData ? 'No project data found' : 'Custom paths'}</h3>
		<span class="path-config-panel__arrow" id="path-config-arrow">${noData ? '' : '&#9654;'}</span>
	</div>
	${noData ? '<p class="path-config-panel__hint" style="margin-bottom:12px">Could not auto-detect epics or sprint status. Specify custom paths below.</p>' : ''}
	<div class="path-config-panel__fields" id="path-config-fields">
		<label class="path-config-panel__label">
			<span>Output folder</span>
			<input type="text" id="custom-output-path" class="path-config-panel__input" placeholder="e.g. /project/_bmad-output" />
			<span class="path-config-panel__hint">Folder containing planning-artifacts, implementation-artifacts, etc.</span>
		</label>
		<label class="path-config-panel__label">
			<span>Epics file</span>
			<input type="text" id="custom-epics-path" class="path-config-panel__input" placeholder="e.g. /project/docs/epics.md" />
			<span class="path-config-panel__hint">Markdown file with epic/story definitions (## Epic N: / ### Story N.M:)</span>
		</label>
		<label class="path-config-panel__label">
			<span>Sprint status file</span>
			<input type="text" id="custom-sprint-status-path" class="path-config-panel__input" placeholder="e.g. /project/sprint-status.yaml" />
			<span class="path-config-panel__hint">YAML file (.yaml or .md) with development_status section</span>
		</label>
		<button class="path-config-panel__btn" id="apply-paths-btn">Apply</button>
		<span class="path-config-panel__status" id="path-config-status"></span>
	</div>
</div>`;

	// Global bugs and pending items aren't tied to a feature — attach them to the first board only.
	const globals = {
		pendingBacklog: (project.pendingItems || []).filter(i => !i.done).map(i => ({
			id: `global-${i.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
			title: i.title, status: 'backlog', epic: 'Global', detail: i.detail, cardType: 'global',
		})),
		pendingDone: (project.pendingItems || []).filter(i => i.done).map(i => ({
			id: `global-${i.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
			title: i.title, status: 'done', epic: 'Global', cardType: 'global',
		})),
		bugs: (project.bugs || []).map(b => ({
			id: b.id.toLowerCase(), title: b.description, status: b.status, epic: b.id, cardType: 'bug',
		})),
	};

	const boardSections = sprints
		.map((sprint) => renderSprintBoardSection(sprint, {
			// Global bugs/pending items ride along on the active sprint's board only.
			globals: sprint.id === activeSprintId ? globals : null,
			// Drag-and-drop persists to a single sprint-status file, so only a lone
			// sprint-status board is editable; multi-sprint and spec boards are read-only.
			editable: singleSprint && sprint.source === 'sprint-status' && !!sprint.board?.editable,
			visible: sprint.id === activeSprintId,
			singleSprint,
		}))
		.join('\n');

	const projectContent = `<div id="project-view" hidden>
	<div id="project-dashboard" data-active-sprint="${escapeHtml(activeSprintId || '')}">
		${configPanel}
		${renderIntegrationsLauncher()}
		${boardSections}
	</div>
	${renderIntegrationsModal()}
	<main class="content-area" id="project-content-area" hidden>
		<div class="content-area__breadcrumb" id="project-breadcrumb"></div>
		<div class="content-area__body" id="project-content-body"></div>
	</main>
</div>`;

	// Sprints gallery — one card per initiative, linking into its board.
	const sprintsContent = `<div id="sprints-view" hidden>
	<div class="sprints-gallery__header">
		<h1>Sprints</h1>
		<p class="sprints-gallery__subtitle">Every initiative tracked in <code>implementation-artifacts/</code>. Open one to see its board.</p>
	</div>
	${renderSprintsGallery(sprints, activeSprintId)}
</div>`;

	const content = wikiContent + projectContent + sprintsContent;

	// Gather warnings
	const summary = aggregator.getSummary();
	const warnings = [...summary.errors, ...summary.warnings];

	return BaseLayout({
		title: `${config.project_name || 'BMAD'} - bmad-viewer`,
		sidebar,
		content,
		activeTab: 'wiki',
		activeSprintId,
		warnings,
		contentMapJson: JSON.stringify(contentMap),
		projectName: config.project_name,
	});
}

// Terminal statuses shown in the Done column (superseded/cancelled work is closed, not backlog).
const DONE_STATES = new Set(['done', 'superseded', 'cancelled', 'descoped']);

/**
 * Render one sprint's dashboard section: header, stats, progress, and a kanban board.
 * All sections are rendered; the client reveals the one named by #project?sprint=<id>.
 * Global bug/pending cards ride along on the active sprint's section only (via `globals`).
 *
 * @param {object} sprint - { id, label, source, active, stories, storyList, epics, board }
 * @param {{globals: object|null, editable: boolean, visible: boolean, singleSprint: boolean}} opts
 */
function renderSprintBoardSection(sprint, { globals, editable, visible, singleSprint }) {
	const storyList = sprint.storyList || [];
	const inState = (state) => storyList.filter((s) => s.status === state);
	const bugs = globals?.bugs || [];
	const columns = [
		{ key: 'backlog', title: 'Backlog', stories: [...inState('backlog'), ...(globals?.pendingBacklog || []), ...bugs.filter((c) => c.status === 'backlog')] },
		{ key: 'ready-for-dev', title: 'Ready for Dev', stories: [...inState('ready-for-dev'), ...bugs.filter((c) => c.status === 'ready-for-dev')] },
		{ key: 'in-progress', title: 'In Progress', stories: [...inState('in-progress'), ...bugs.filter((c) => c.status === 'in-progress')] },
		{ key: 'review', title: 'Review', stories: [...inState('review'), ...bugs.filter((c) => c.status === 'review')] },
		{ key: 'done', title: 'Done', stories: [...storyList.filter((s) => DONE_STATES.has(s.status)), ...bugs.filter((c) => DONE_STATES.has(c.status)), ...(globals?.pendingDone || [])] },
	];

	const readOnlyHint = sprint.source === 'specs'
		? ' Spec-driven sprint — status comes from each <code>spec-*.md</code> frontmatter.'
		: (singleSprint ? ' Add a writable <code>sprint-status</code> file to enable drag and drop updates.' : ' Drag-and-drop is disabled while several sprints are tracked.');
	const message = editable
		? '<div class="kanban-toolbar"><p class="kanban-toolbar__hint">Drag story cards between BMAD states. The viewer saves <code>sprint-status</code> locally and syncs connected platforms when available.</p><span class="kanban-toolbar__status" id="board-save-status" aria-live="polite"></span></div>'
		: `<div class="kanban-toolbar"><p class="kanban-toolbar__hint">Read-only board.${readOnlyHint}</p></div>`;

	return `<section class="sprint-board" data-sprint="${escapeHtml(sprint.id)}"${visible ? '' : ' hidden'}>
		${renderSprintHeader(sprint)}
		${StatsBox({ total: sprint.stories.total, pending: sprint.stories.pending, inProgress: sprint.stories.inProgress, done: sprint.stories.done, inProgressLabel: 'Active' })}
		${ProgressBar({ completed: sprint.stories.done, total: sprint.stories.total })}
		${message}
		<div class="kanban" data-board-editable="${editable ? 'true' : 'false'}">
			${columns.map((column) => KanbanColumn({ title: column.title, stories: column.stories, columnId: column.key, editable })).join('\n')}
		</div>
	</section>`;
}

/**
 * Header shown atop a sprint board: name, active/source badges.
 */
function renderSprintHeader(sprint) {
	const badges = [];
	if (sprint.active) badges.push('<span class="sprint-badge sprint-badge--active">Active sprint</span>');
	badges.push(`<span class="sprint-badge sprint-badge--source">${sprint.source === 'specs' ? 'spec-driven' : 'sprint-status'}</span>`);
	return `<div class="sprint-board__header">
		<h2 class="sprint-board__title">${escapeHtml(sprint.label)}</h2>
		<div class="sprint-board__badges">${badges.join('')}</div>
	</div>`;
}

/**
 * Render the sprints gallery — one card per initiative linking into its board.
 */
function renderSprintsGallery(sprints, activeSprintId) {
	if (sprints.length === 0) {
		return '<p class="sprints-gallery__empty">No sprints found under implementation-artifacts/.</p>';
	}
	const cards = sprints.map((sprint) => {
		const pct = sprint.stories.total > 0 ? Math.round((sprint.stories.done / sprint.stories.total) * 100) : 0;
		const isActive = sprint.id === activeSprintId;
		return `<a class="sprint-card${isActive ? ' sprint-card--active' : ''}" href="#project?sprint=${encodeURIComponent(sprint.id)}">
		<div class="sprint-card__head">
			<h3 class="sprint-card__title">${escapeHtml(sprint.label)}</h3>
			${isActive ? '<span class="sprint-badge sprint-badge--active">Active</span>' : ''}
		</div>
		<div class="sprint-card__meta">
			<span class="sprint-badge sprint-badge--source">${sprint.source === 'specs' ? 'spec-driven' : 'sprint-status'}</span>
			<span class="sprint-card__count">${sprint.stories.done}/${sprint.stories.total} done</span>
		</div>
		${ProgressBar({ completed: sprint.stories.done, total: sprint.stories.total })}
		<div class="sprint-card__pills">
			<span class="sprint-card__pill sprint-card__pill--done">${sprint.stories.done} done</span>
			<span class="sprint-card__pill sprint-card__pill--active">${sprint.stories.inProgress} active</span>
			<span class="sprint-card__pill sprint-card__pill--pending">${sprint.stories.pending} pending</span>
			<span class="sprint-card__pct">${pct}%</span>
		</div>
	</a>`;
	}).join('\n');
	return `<div class="sprints-gallery">${cards}</div>`;
}

function renderIntegrationsLauncher() {
	return `<section class="platform-launcher">
	<div class="platform-launcher__header">
		<div class="platform-launcher__copy">
			<h3 class="platform-launcher__title">Boards</h3>
			<p class="platform-launcher__subtitle">Connect BMAD with delivery platforms and sync when you want.</p>
		</div>
		<div class="platform-launcher__actions">
			<button class="platform-chip platform-chip--github" type="button" data-open-integration="github">
				<span class="platform-chip__logo">${platformLogo('github')}</span>
				<span class="platform-chip__text">
					<strong>GitHub</strong>
					<span id="github-launcher-status" class="platform-chip__status">Not connected</span>
				</span>
			</button>
			<button class="platform-chip platform-chip--jira" type="button" data-open-integration="jira">
				<span class="platform-chip__logo">${platformLogo('jira')}</span>
				<span class="platform-chip__text">
					<strong>Jira</strong>
					<span class="platform-chip__status">Coming next</span>
				</span>
			</button>
			<button class="platform-chip platform-chip--azure" type="button" data-open-integration="azure">
				<span class="platform-chip__logo">${platformLogo('azure')}</span>
				<span class="platform-chip__text">
					<strong>Azure DevOps</strong>
					<span class="platform-chip__status">Coming next</span>
				</span>
			</button>
		</div>
	</div>
	<div class="platform-launcher__summary" id="github-project-summary" hidden>
		<span class="platform-launcher__summary-label">GitHub Project</span>
		<div class="platform-launcher__summary-copy">
			<strong id="github-project-title">No GitHub project connected</strong>
			<span id="github-project-subtitle">Create or sync a project board to reflect BMAD work in GitHub.</span>
		</div>
		<a class="platform-launcher__summary-link" id="github-project-link" href="#" target="_blank" rel="noreferrer" hidden>Open project</a>
	</div>
</section>`;
}

function renderIntegrationsModal() {
	return `<div class="integration-modal" id="integration-modal" role="dialog" aria-modal="true" aria-label="Board integrations" hidden>
	<div class="integration-modal__backdrop" id="integration-modal-backdrop"></div>
	<div class="integration-modal__content">
		<div class="integration-modal__header">
			<div>
				<h3 class="integration-modal__title">Board Integrations</h3>
				<p class="integration-modal__subtitle">Choose a platform, connect the target project and sync when you want.</p>
			</div>
			<button class="integration-modal__close" id="integration-modal-close" aria-label="Close integrations">&times;</button>
		</div>
		<div class="integration-modal__tabs">
			<button class="integration-modal__tab integration-modal__tab--active" type="button" data-provider-tab="github">
				${platformLogo('github')} GitHub
			</button>
			<button class="integration-modal__tab" type="button" data-provider-tab="jira">
				${platformLogo('jira')} Jira
			</button>
			<button class="integration-modal__tab" type="button" data-provider-tab="azure">
				${platformLogo('azure')} Azure DevOps
			</button>
		</div>
		<div class="integration-modal__body">
			<section class="integration-pane integration-pane--active" id="integration-pane-github" data-provider-pane="github">
				<div class="integration-pane__intro">
					<div>
						<h4>GitHub Issues Sync</h4>
						<p>Map BMAD epics and stories to GitHub Issues and sync them on demand.</p>
					</div>
					<span class="integration-panel__badge" id="github-connection-badge">Not connected</span>
				</div>
				<div class="integration-panel__grid">
					<label class="integration-panel__field">
						<span>Owner or org</span>
						<input type="text" id="github-owner-input" class="integration-panel__input" placeholder="e.g. octo-org" />
					</label>
					<label class="integration-panel__field">
						<span>Repository</span>
						<input type="text" id="github-repo-input" class="integration-panel__input" placeholder="e.g. my-bmad-project" />
					</label>
					<label class="integration-panel__field">
						<span>Personal access token</span>
						<input type="password" id="github-token-input" class="integration-panel__input" placeholder="Paste your GitHub token" />
					</label>
				</div>
				<div class="integration-panel__actions">
					<button class="integration-panel__btn" id="github-connect-btn">Connect GitHub</button>
					<button class="integration-panel__btn integration-panel__btn--secondary" id="github-project-btn">Sync Project Board</button>
					<button class="integration-panel__btn integration-panel__btn--secondary" id="github-preview-btn">Preview Sync</button>
					<button class="integration-panel__btn integration-panel__btn--secondary" id="github-sync-btn">Sync Now</button>
				</div>
		<p class="integration-panel__note">This token is stored only in the current project under <code>.bmad-viewer</code>. Sync Project Board creates or reuses a GitHub Project and maps BMAD work into it.</p>
		<p class="integration-panel__status" id="github-integration-status" aria-live="polite"></p>
		<div class="integration-panel__preview" id="github-sync-preview" hidden></div>
	</section>
			<section class="integration-pane" id="integration-pane-jira" data-provider-pane="jira" hidden>
				<div class="integration-pane__placeholder">
					<div class="integration-pane__placeholder-logo">${platformLogo('jira')}</div>
					<h4>Jira is next</h4>
					<p>The next phase will add project detection, workflow transition mapping and manual sync preview for Jira.</p>
				</div>
			</section>
			<section class="integration-pane" id="integration-pane-azure" data-provider-pane="azure" hidden>
				<div class="integration-pane__placeholder">
					<div class="integration-pane__placeholder-logo">${platformLogo('azure')}</div>
					<h4>Azure DevOps is next</h4>
					<p>The next phase will add process-template detection, work item mapping and manual sync preview for Azure DevOps.</p>
				</div>
			</section>
		</div>
	</div>
</div>`;
}

function platformLogo(provider) {
	if (provider === 'github') {
		return `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 .5a12 12 0 0 0-3.79 23.39c.6.11.82-.26.82-.58v-2.04c-3.34.73-4.04-1.41-4.04-1.41-.55-1.36-1.33-1.72-1.33-1.72-1.09-.73.08-.72.08-.72 1.2.08 1.84 1.2 1.84 1.2 1.08 1.8 2.82 1.28 3.51.98.11-.76.42-1.28.76-1.57-2.67-.3-5.47-1.31-5.47-5.86 0-1.3.47-2.36 1.23-3.19-.12-.3-.53-1.52.12-3.16 0 0 1.01-.32 3.3 1.22a11.7 11.7 0 0 1 6 0c2.28-1.54 3.29-1.22 3.29-1.22.66 1.64.25 2.86.12 3.16.77.83 1.23 1.89 1.23 3.19 0 4.56-2.8 5.55-5.48 5.85.43.37.82 1.1.82 2.22v3.29c0 .32.21.69.83.57A12 12 0 0 0 12 .5Z"/></svg>`;
	}
	if (provider === 'jira') {
		return `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M21.9 11.1 12.9 2.1a3 3 0 0 0-4.2 0l-1.9 1.9 2.4 2.4 1.4-1.4a1 1 0 0 1 1.4 0l2 2-5.6 5.6a3 3 0 0 0 0 4.2l3.8 3.8 2.4-2.4-3.8-3.8a1 1 0 0 1 0-1.4l5.6-5.6 2 2a1 1 0 0 1 0 1.4l-1.4 1.4 2.4 2.4 1.9-1.9a3 3 0 0 0 0-4.2Z"/></svg>`;
	}
	return `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M2 3.2 11 2v9H2V3.2Zm10 0 10-1.2V11H12V3.2ZM2 12h9v10L2 20.8V12Zm10 0h10v10l-10-1.2V12Z"/></svg>`;
}

/**
 * Build a content map keyed by item id for client-side lookup.
 */
function buildContentMap(wiki, project) {
	const map = {};

	// Wiki items
	for (const mod of wiki.modules) {
		for (const group of mod.groups) {
			for (const item of group.items) {
				map[item.id] = {
					html: item.html || '',
					name: item.name,
					type: item.type,
					module: mod.name,
					group: group.name,
				};
			}
		}
	}

	// Project artifacts
	for (const artifact of project.artifacts) {
		map[artifact.id] = {
			html: artifact.html || '',
			name: artifact.name,
			type: artifact.type || 'artifact',
		};
	}

	// Stories across every sprint (sprint-status boards and spec-driven boards).
	const storyContents = project.storyContents || {};
	const sprintsForContent = (project.sprints && project.sprints.length > 0)
		? project.sprints
		: [{ epics: project.epics }];
	for (const sprint of sprintsForContent) {
		for (const epic of sprint.epics || []) {
			for (const story of epic.stories) {
				const key = `story/${story.id}`;
				if (map[key]) continue;
				const statusLabel = (story.status || 'backlog').replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
				const statusBadge = `<p><strong>${escapeHtml(String(epic.name))}:</strong> &nbsp; <span class="badge badge--${escapeHtml(story.status)}">${escapeHtml(statusLabel)}</span></p>`;

				// Spec-driven stories carry their own rendered markdown body.
				if (story.html) {
					map[key] = { html: statusBadge + story.html, name: story.title, type: 'story' };
					continue;
				}
				// Otherwise fall back to epics.md content keyed by "epicNum-storyNum".
				const parts = String(story.id).split('-');
				const epicContent = storyContents[`${parts[0]}-${parts[1]}`];
				map[key] = {
					html: epicContent
						? statusBadge + epicContent.html
						: `<h1>${escapeHtml(story.title)}</h1>${statusBadge}<p style="color:var(--text-muted);margin-top:24px">No detailed content found for this story.</p>`,
					name: epicContent ? epicContent.title : story.title,
					type: 'story',
				};
			}
		}
	}

	return map;
}
