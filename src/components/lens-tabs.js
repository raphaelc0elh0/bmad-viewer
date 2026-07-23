/**
 * Render the Wiki / Active Sprint / Sprints lens tabs.
 * The Active Sprint tab deep-links to the active sprint's board via a query param, so the
 * tab's target hash carries ?sprint=<id> while data-tab stays the view name for highlighting.
 *
 * @param {{activeTab: string, activeSprintId?: string|null}} props
 * @returns {string} HTML string
 */
export function LensTabs({ activeTab, activeSprintId }) {
	const cls = (view) => `lens-tabs__tab${activeTab === view ? ' lens-tabs__tab--active' : ''}`;
	const sel = (view) => String(activeTab === view);
	const activeTarget = activeSprintId
		? `#project?sprint=${encodeURIComponent(activeSprintId)}`
		: '#project';

	return `<div class="lens-tabs" role="tablist">
	<button class="${cls('wiki')}" role="tab" aria-selected="${sel('wiki')}" data-tab="wiki" data-target="#wiki">&#128218; Wiki</button>
	<button class="${cls('project')}" role="tab" aria-selected="${sel('project')}" data-tab="project" data-target="${activeTarget}">&#128203; Active Sprint</button>
	<button class="${cls('sprints')}" role="tab" aria-selected="${sel('sprints')}" data-tab="sprints" data-target="#sprints">&#128202; Sprints</button>
</div>`;
}
