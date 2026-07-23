import { readdirSync, existsSync, statSync, readFileSync } from 'node:fs';
import { join, extname, basename, relative, dirname } from 'node:path';
import { parseYaml } from '../parsers/parse-yaml.js';
import { parseMarkdownContent } from '../parsers/parse-markdown.js';
import { ErrorAggregator } from '../utils/error-aggregator.js';

/**
 * Build the complete in-memory data model from a BMAD project.
 *
 * @param {string} bmadDir - Project root containing _bmad/
 * @param {{customEpicsPath?: string, customOutputPath?: string, customSprintStatusPath?: string}} [options] - Optional overrides
 * @returns {{wiki: object, project: object, config: object, aggregator: ErrorAggregator}}
 */
export function buildDataModel(bmadDir, options) {
	const aggregator = new ErrorAggregator();
	const bmadPath = join(bmadDir, '_bmad');
	const outputPath = options?.customOutputPath || join(bmadDir, '_bmad-output');

	const wiki = buildWikiData(bmadPath, aggregator);
	const project = buildProjectData(outputPath, aggregator, options);
	const config = loadConfig(bmadPath, aggregator);

	return { wiki, project, config, aggregator };
}

/**
 * Build wiki catalog data by scanning _bmad directory structure.
 * Dynamically discovers modules and supports both:
 *   - New structure: SKILL.md as entry point in skill directories
 *   - Old structure: agents/ and workflows/ subdirectories with direct .md files
 */
function buildWikiData(bmadPath, aggregator) {
	const modules = [];
	const allItems = [];

	// Dynamically discover module directories (skip underscore-prefixed like _config)
	let moduleDirs = [];
	try {
		const entries = readdirSync(bmadPath, { withFileTypes: true });
		moduleDirs = entries
			.filter(e => e.isDirectory() && !e.name.startsWith('_'))
			.map(e => e.name)
			.sort();
	} catch {
		return { modules, allItems };
	}

	for (const modName of moduleDirs) {
		const modPath = join(bmadPath, modName);
		const moduleData = { id: modName, name: modName.toUpperCase(), groups: [] };
		const groupMap = {};

		// --- New structure: find SKILL.md files recursively ---
		const skillFiles = findNamedFilesRecursive(modPath, 'SKILL.md');
		const skillDirs = new Set(skillFiles.map(f => dirname(f)));

		for (const filePath of skillFiles) {
			const rel = relative(modPath, filePath).replace(/\\/g, '/');
			const parts = rel.split('/'); // e.g. ["skill-name","SKILL.md"] or ["category","skill-name","SKILL.md"]
			const skillDirName = parts[parts.length - 2];
			const groupName = parts.length > 2 ? parts[0] : null;
			const groupKey = groupName ?? '__root__';
			const displayGroup = groupName ? formatName(groupName) : 'Skills';

			const id = `${modName}/${rel.replace('/SKILL.md', '')}`;
			const content = readMarkdownSafe(filePath, aggregator);
			const type = inferSkillType(groupName, skillDirName);
			const item = { id, name: formatName(skillDirName), type, path: filePath, ...content };

			if (!groupMap[groupKey]) {
				groupMap[groupKey] = { name: displayGroup, type: groupKey === '__root__' ? 'skill' : groupKey, items: [], _sortKey: groupName ?? '' };
			}
			groupMap[groupKey].items.push(item);
			allItems.push(item);
		}

		// --- New structure: workflow.md files in dirs without SKILL.md ---
		const workflowFiles = findNamedFilesRecursive(modPath, 'workflow.md')
			.filter(f => !skillDirs.has(dirname(f)));

		for (const filePath of workflowFiles) {
			const rel = relative(modPath, filePath).replace(/\\/g, '/');
			const parts = rel.split('/');
			const skillDirName = parts[parts.length - 2];
			const groupName = parts.length > 2 ? parts[0] : null;
			// Use same groupKey as SKILL.md items so they merge into the same group
			const groupKey = groupName ?? '__root__';
			const displayGroup = groupName ? formatName(groupName) : 'Workflows';

			const id = `${modName}/${rel.replace('/workflow.md', '')}`;
			const content = readMarkdownSafe(filePath, aggregator);
			const item = { id, name: formatName(skillDirName), type: 'workflow', path: filePath, ...content };

			if (!groupMap[groupKey]) {
				groupMap[groupKey] = { name: displayGroup, type: 'workflows', items: [], _sortKey: groupName ?? '' };
			}
			groupMap[groupKey].items.push(item);
			allItems.push(item);
		}

		// --- Old structure (backward compat): only used if new-style SKILL.md scan found nothing ---
		const newStyleFound = skillFiles.length > 0 || workflowFiles.length > 0;
		if (!newStyleFound) {
			// agents/ with direct .md files
			const agentsPath = join(modPath, 'agents');
			if (existsSync(agentsPath) && statSync(agentsPath).isDirectory()) {
				const agentFiles = scanDirectMarkdownFiles(agentsPath);
				if (agentFiles.length > 0) {
					const groupKey = '__legacy_agents__';
					if (!groupMap[groupKey]) {
						groupMap[groupKey] = { name: 'Agents', type: 'agents', items: [], _sortKey: 'agents' };
					}
					for (const filePath of agentFiles) {
						const name = basename(filePath, '.md');
						const id = `${modName}/agents/${name}`;
						const content = readMarkdownSafe(filePath, aggregator);
						const item = { id, name: formatName(name), type: 'agent', path: filePath, ...content };
						groupMap[groupKey].items.push(item);
						allItems.push(item);
					}
				}
			}

			// workflows/ directory
			const workflowsPath = join(modPath, 'workflows');
			if (existsSync(workflowsPath) && statSync(workflowsPath).isDirectory()) {
				const workflowItems = scanWorkflows(workflowsPath, modName, aggregator);
				if (workflowItems.length > 0) {
					const groupKey = '__legacy_workflows__';
					if (!groupMap[groupKey]) {
						groupMap[groupKey] = { name: 'Workflows', type: 'workflows', items: [], _sortKey: 'workflows' };
					}
					groupMap[groupKey].items.push(...workflowItems);
					allItems.push(...workflowItems);
				}
			}

			// other resource dirs
			const otherDirs = ['tasks', 'resources', 'data', 'teams', 'testarch'];
			for (const dirName of otherDirs) {
				const dirPath = join(modPath, dirName);
				if (existsSync(dirPath) && statSync(dirPath).isDirectory()) {
					const files = scanDirectMarkdownFiles(dirPath);
					if (files.length > 0) {
						const groupKey = `__legacy_${dirName}__`;
						if (!groupMap[groupKey]) {
							groupMap[groupKey] = { name: formatName(dirName), type: dirName, items: [], _sortKey: dirName };
						}
						for (const filePath of files) {
							const name = basename(filePath, '.md');
							const id = `${modName}/${dirName}/${name}`;
							const content = readMarkdownSafe(filePath, aggregator);
							const item = { id, name: formatName(name), type: dirName, path: filePath, ...content };
							groupMap[groupKey].items.push(item);
							allItems.push(item);
						}
					}
				}
			}
		}

		// Sort groups alphabetically and attach to module
		moduleData.groups = Object.values(groupMap)
			.filter(g => g.items.length > 0)
			.sort((a, b) => a._sortKey.localeCompare(b._sortKey))
			.map(({ _sortKey, ...g }) => g);

		if (moduleData.groups.length > 0) {
			modules.push(moduleData);
		}
	}

	return { modules, allItems };
}

/**
 * Infer the type of a skill based on its group/category name and skill name.
 */
function inferSkillType(groupName, skillName) {
	const g = (groupName ?? '').toLowerCase();
	const s = skillName.toLowerCase();
	if (g.includes('agent') || s.includes('agent')) return 'agent';
	if (g.includes('workflow') || g.includes('workflows')) return 'workflow';
	if (g.includes('skill') || g.includes('skills')) return 'skill';
	return 'skill';
}

/**
 * Scan workflows directory. Workflows can be:
 * - Direct .md files
 * - Directories containing a workflow.md
 * - Category directories with sub-workflow directories
 */
function scanWorkflows(workflowsPath, modName, aggregator) {
	const items = [];

	try {
		const entries = readdirSync(workflowsPath, { withFileTypes: true });

		for (const entry of entries) {
			const fullPath = join(workflowsPath, entry.name);

			if (entry.isFile() && extname(entry.name) === '.md' && entry.name !== 'README.md') {
				const name = basename(entry.name, '.md');
				const id = `${modName}/workflows/${name}`;
				const content = readMarkdownSafe(fullPath, aggregator);
				items.push({ id, name: formatName(name), type: 'workflow', path: fullPath, ...content });
			} else if (entry.isDirectory()) {
				const workflowMd = join(fullPath, 'workflow.md');

				if (existsSync(workflowMd)) {
					const name = entry.name;
					const id = `${modName}/workflows/${name}`;
					const content = readMarkdownSafe(workflowMd, aggregator);
					items.push({ id, name: formatName(name), type: 'workflow', path: workflowMd, ...content });
				} else {
					// Check for sub-workflow directories
					const subItems = scanWorkflowSubdir(fullPath, modName, entry.name, aggregator);
					items.push(...subItems);
				}
			}
		}
	} catch {
		// Ignore access errors
	}

	return items;
}

/**
 * Scan a workflow subdirectory for nested workflow directories.
 */
function scanWorkflowSubdir(dirPath, modName, categoryName, aggregator) {
	const items = [];

	try {
		const entries = readdirSync(dirPath, { withFileTypes: true });

		for (const entry of entries) {
			const fullPath = join(dirPath, entry.name);

			if (entry.isDirectory()) {
				const workflowMd = join(fullPath, 'workflow.md');
				if (existsSync(workflowMd)) {
					const name = entry.name;
					const id = `${modName}/workflows/${categoryName}/${name}`;
					const content = readMarkdownSafe(workflowMd, aggregator);
					items.push({ id, name: formatName(name), type: 'workflow', path: workflowMd, ...content });
				}
			} else if (extname(entry.name) === '.md' && entry.name !== 'README.md') {
				const name = basename(entry.name, '.md');
				const id = `${modName}/workflows/${categoryName}/${name}`;
				const content = readMarkdownSafe(fullPath, aggregator);
				items.push({ id, name: formatName(name), type: 'workflow', path: fullPath, ...content });
			}
		}
	} catch {
		// Ignore access errors
	}

	return items;
}

/**
 * Read a markdown file safely and return html + frontmatter.
 */
function readMarkdownSafe(filePath, aggregator) {
	try {
		const raw = readFileSync(filePath, 'utf8');
		const result = parseMarkdownContent(raw, filePath);
		if (result.errors.length > 0) {
			aggregator.addResult(filePath, result);
		}
		return { html: result.data?.html || '', frontmatter: result.data?.frontmatter || null, raw };
	} catch {
		return { html: '', frontmatter: null, raw: '' };
	}
}

/**
 * Build project data from _bmad-output directory.
 * @param {string} outputPath
 * @param {ErrorAggregator} aggregator
 * @param {{customEpicsPath?: string, customSprintStatusPath?: string}} [options]
 */
function buildProjectData(outputPath, aggregator, options) {
	const customEpicsPath = options?.customEpicsPath;
	const project = {
		sprintStatus: null,
		board: { editable: false, sprintStatusPath: null, sprintStatusFormat: null },
		stories: { total: 0, pending: 0, inProgress: 0, done: 0 },
		storyList: [],
		epics: [],
		// One board per tracked feature (implementation-artifacts/<feature>/sprint-status.*),
		// or a single unnamed board for the classic flat layout. See discoverSprintStatusFiles.
		featureBoards: [],
		// One entry per initiative/sprint: sprint-status-backed boards AND spec-driven ones
		// (implementation-artifacts/<init>/spec-*.md). See buildSprints. activeSprintId is the
		// initiative the BMAD config currently points its workflows at.
		sprints: [],
		activeSprintId: null,
		artifacts: [],
		bugs: [],
		pendingItems: [],
	};

	// Discover sprint-status boards. A BMAD project can track several features in
	// parallel — each implementation-artifacts/<feature>/sprint-status.yaml is its own
	// board — alongside (or instead of) a single top-level board. Surface each as a
	// feature board; the first becomes the primary for backward-compatible fields.
	for (const { path: statusPath, feature } of discoverSprintStatusFiles(outputPath, options)) {
		const board = buildBoardData(statusPath, feature, aggregator);
		if (board) project.featureBoards.push(board);
	}
	if (project.featureBoards.length > 0) {
		applyPrimaryBoard(project, project.featureBoards[0]);
	}

	// Scan planning artifacts (recursive to catch research/ subdir, and include .html files)
	const planningDir = join(outputPath, 'planning-artifacts');
	if (existsSync(planningDir)) {
		const files = scanFilesRecursive(planningDir, ['.md', '.html']);
		for (const file of files) {
			const ext = extname(file).toLowerCase();
			const name = basename(file, ext);

			// Skip sprint-status files (already parsed above)
			if (name === 'sprint-status') continue;

			const content = ext === '.html'
				? readHtmlSafe(file)
				: readMarkdownSafe(file, aggregator);
			const type = categorizeArtifact(file, outputPath);
			project.artifacts.push({
				id: `artifact/${name}`,
				name: formatName(name),
				path: file,
				type,
				...content,
			});

			// Parse stories and epics from epics.md or epics-and-stories.md
			if (name.startsWith('epics') && ext === '.md' && content.raw) {
				const storyContents = parseStoriesFromEpics(content.raw, aggregator);
				project.storyContents = storyContents;

				if (project.featureBoards.length > 0) {
					// Per-feature sprint-status already owns the epic/story truth for this
					// project; don't rebuild or merge from epics.md (it would double-count
					// and blend one feature's epics into another's board).
				} else if (project.epics.length === 0) {
					// No sprint-status found — build epics entirely from markdown
					project.epics = parseEpicsFromMarkdown(content.raw, storyContents);
					for (const epic of project.epics) {
						project.stories.total += epic.stories.length;
						project.stories.pending += epic.stories.length;
						project.storyList.push(...epic.stories);
					}
				} else {
					// Merge: add stories from epics.md that are missing in sprint-status
					const mdEpics = parseEpicsFromMarkdown(content.raw, storyContents);
					const existingIds = new Set(project.storyList.map(s => `${s.epic}-${s.id.split('-')[1]}`));
					for (const mdEpic of mdEpics) {
						let sprintEpic = project.epics.find(e => e.num === mdEpic.num);
						if (!sprintEpic) {
							// Entire epic missing from sprint-status — add with all stories as backlog
							sprintEpic = { ...mdEpic, stories: [], status: 'backlog' };
							for (const story of mdEpic.stories) {
								story.status = 'backlog';
								sprintEpic.stories.push(story);
								project.storyList.push(story);
								project.stories.total++;
								project.stories.pending++;
							}
							project.epics.push(sprintEpic);
							project.epics.sort((a, b) => Number(a.num) - Number(b.num));
						} else {
							if (!sprintEpic.name || sprintEpic.name === `Epic ${sprintEpic.num}`) {
								sprintEpic.name = mdEpic.name;
							}
							// Add only stories missing from sprint-status
							for (const story of mdEpic.stories) {
								const storyKey = `${mdEpic.num}-${story.id.split('-')[1]}`;
								if (!existingIds.has(storyKey)) {
									story.status = 'backlog';
									sprintEpic.stories.push(story);
									project.storyList.push(story);
									project.stories.total++;
									project.stories.pending++;
								}
							}
						}
					}
				}
			}
		}
	}

	// Load custom epics file if provided and no epics were found from normal scan
	if (project.epics.length === 0) {
		loadCustomEpicsFile(customEpicsPath, project, aggregator);
	}

	// Classic flat layout (or epics.md-only projects): expose the single set of
	// epics/stories as one unnamed board so the renderer always works off featureBoards.
	if (project.featureBoards.length === 0 && (project.epics.length > 0 || project.stories.total > 0)) {
		project.featureBoards.push({
			key: 'sprint',
			label: 'Sprint',
			feature: null,
			stories: project.stories,
			storyList: project.storyList,
			epics: project.epics,
			board: project.board,
		});
	}

	// Scan implementation artifact story files (direct .md files in impl dir + stories/ subdir)
	const implDir = join(outputPath, 'implementation-artifacts');
	if (existsSync(implDir)) {
		const implFiles = scanDirectMarkdownFiles(implDir);
		for (const file of implFiles) {
			const name = basename(file, '.md');
			const content = readMarkdownSafe(file, aggregator);
			project.artifacts.push({
				id: `story/${name}`,
				name: formatName(name),
				path: file,
				type: 'story',
				...content,
			});
		}

		const storyDir = join(implDir, 'stories');
		if (existsSync(storyDir)) {
			const files = scanDirectMarkdownFiles(storyDir);
			for (const file of files) {
				const name = basename(file, '.md');
				const content = readMarkdownSafe(file, aggregator);
				project.artifacts.push({
					id: `story/${name}`,
					name: formatName(name),
					path: file,
					type: 'story',
					...content,
				});
			}
		}
	}

	// Scan analysis/ directory
	const analysisDir = join(outputPath, 'analysis');
	if (existsSync(analysisDir)) {
		const files = scanDirectFiles(analysisDir, ['.md']);
		for (const file of files) {
			const name = basename(file, '.md');
			const content = readMarkdownSafe(file, aggregator);
			project.artifacts.push({
				id: `artifact/${name}`,
				name: formatName(name),
				path: file,
				type: 'analysis',
				...content,
			});
		}
	}

	// Scan excalidraw-diagrams/ directory
	const excalidrawDir = join(outputPath, 'excalidraw-diagrams');
	if (existsSync(excalidrawDir)) {
		const files = scanDirectFiles(excalidrawDir, ['.excalidraw']);
		for (const file of files) {
			const name = basename(file, '.excalidraw');
			const content = readExcalidrawSafe(file);
			project.artifacts.push({
				id: `artifact/${name}`,
				name: formatName(name),
				path: file,
				type: 'diagram',
				...content,
			});
		}
	}

	// Scan bmb-creations/ directory (recursive, .md + .yaml)
	const bmbDir = join(outputPath, 'bmb-creations');
	if (existsSync(bmbDir)) {
		const files = scanFilesRecursive(bmbDir, ['.md', '.yaml']);
		for (const file of files) {
			const ext = extname(file).toLowerCase();
			const name = basename(file, ext);
			const content = ext === '.yaml'
				? readYamlSafe(file)
				: readMarkdownSafe(file, aggregator);
			project.artifacts.push({
				id: `artifact/${name}`,
				name: formatName(name),
				path: file,
				type: 'bmb-creation',
				...content,
			});
		}
	}

	// Scan root-level files in _bmad-output/ (CIS sessions, test-arch outputs, etc.)
	const rootFiles = scanDirectFiles(outputPath, ['.md']);
	for (const file of rootFiles) {
		const name = basename(file, '.md');
		const content = readMarkdownSafe(file, aggregator);
		const type = categorizeArtifact(file, outputPath);
		project.artifacts.push({
			id: `artifact/${name}`,
			name: formatName(name),
			path: file,
			type,
			...content,
		});
	}

	// Build artifactGroups by category (excluding stories which are shown under epics)
	project.artifactGroups = {};
	for (const art of project.artifacts) {
		if (art.type === 'story') continue;
		const cat = art.type || 'other';
		if (!project.artifactGroups[cat]) project.artifactGroups[cat] = [];
		project.artifactGroups[cat].push(art);
	}

	// Unify every initiative into a single sprints list: sprint-status-backed boards plus
	// spec-driven initiatives (implementation-artifacts/<init>/spec-*.md). The active one is
	// whatever the BMAD config currently points its workflows at.
	buildSprints(project, outputPath, aggregator);

	return project;
}

/**
 * Populate project.sprints (and project.activeSprintId) from both board sources.
 * A "sprint" is one initiative folder under implementation-artifacts/.
 */
function buildSprints(project, outputPath, aggregator) {
	const activeId = readActiveSprintId(outputPath);

	// Sprint-status-backed initiatives come straight from featureBoards.
	const sprints = project.featureBoards.map((fb) => ({
		id: fb.feature || fb.key,
		label: fb.label,
		source: 'sprint-status',
		stories: fb.stories,
		storyList: fb.storyList,
		epics: fb.epics,
		board: fb.board,
	}));
	const covered = new Set(sprints.map((s) => s.id));

	// Spec-driven initiatives (no sprint-status.yaml, tracked by spec-*.md frontmatter).
	for (const sprint of buildSpecDrivenSprints(outputPath, covered, aggregator)) {
		sprints.push(sprint);
	}

	// Active first, then alphabetical — keeps the initiative in progress at the front.
	sprints.sort((a, b) => {
		if (a.id === activeId) return -1;
		if (b.id === activeId) return 1;
		return a.label.localeCompare(b.label);
	});
	for (const sprint of sprints) sprint.active = sprint.id === activeId;

	project.sprints = sprints;
	project.activeSprintId = activeId && sprints.some((s) => s.id === activeId)
		? activeId
		: (sprints[0]?.id ?? null);
}

/**
 * Read the active initiative slug from the BMAD config. Workflows read
 * `implementation_artifacts`, which points at the current initiative's subfolder; its last
 * path segment is the initiative id (matching the implementation-artifacts/<id> folder).
 *
 * @param {string} outputPath
 * @returns {string|null}
 */
function readActiveSprintId(outputPath) {
	const configPath = join(outputPath, '..', '_bmad', 'bmm', 'config.yaml');
	if (!existsSync(configPath)) return null;
	const result = parseYaml(configPath);
	const implPath = result.data?.implementation_artifacts;
	if (typeof implPath !== 'string') return null;
	const slug = implPath.replace(/[/\\]+$/, '').split(/[/\\]/).pop();
	// Only treat it as an initiative when it's nested under implementation-artifacts/.
	return slug && slug !== 'implementation-artifacts' ? slug : null;
}

/**
 * Load a custom epics file and populate project data from it.
 */
function loadCustomEpicsFile(customEpicsPath, project, aggregator) {
	if (!customEpicsPath || !existsSync(customEpicsPath)) return;
	const content = readMarkdownSafe(customEpicsPath, aggregator);
	if (!content.raw) return;

	const name = basename(customEpicsPath, extname(customEpicsPath));
	project.artifacts.push({
		id: `artifact/${name}`,
		name: formatName(name),
		path: customEpicsPath,
		type: 'planning',
		...content,
	});
	const storyContents = parseStoriesFromEpics(content.raw, aggregator);
	project.storyContents = storyContents;
	project.epics = parseEpicsFromMarkdown(content.raw, storyContents);
	for (const epic of project.epics) {
		project.stories.total += epic.stories.length;
		project.stories.pending += epic.stories.length;
		project.storyList.push(...epic.stories);
	}
}

/**
 * Parse individual story sections from epics.md.
 * Stories follow the pattern: ### Story X.Y: Title
 * Returns a map of story key (e.g. "1-1") to {title, markdown}.
 */
function parseStoriesFromEpics(raw, aggregator) {
	const storyMap = {};
	// Split on story headers (supports ### or #### level)
	const storyRegex = /^#{3,4} Story (\d+)\.(\d+):\s*(.+)$/gm;
	let match;
	const positions = [];

	while ((match = storyRegex.exec(raw)) !== null) {
		positions.push({
			epicNum: match[1],
			storyNum: match[2],
			title: match[3].trim(),
			start: match.index,
			headerEnd: match.index + match[0].length,
		});
	}

	for (let i = 0; i < positions.length; i++) {
		const pos = positions[i];
		// Content goes until the next story header, next epic header (## Epic), or end of file
		let end = raw.length;
		if (i + 1 < positions.length) {
			end = positions[i + 1].start;
		}
		// Also check for epic section boundary (## Epic or ---)
		const remaining = raw.substring(pos.headerEnd, end);
		const epicBoundary = remaining.search(/^---$/m);
		if (epicBoundary !== -1) {
			end = pos.headerEnd + epicBoundary;
		}

		const storyMarkdown = raw.substring(pos.start, end).trim();
		const key = `${pos.epicNum}-${pos.storyNum}`;
		const result = parseMarkdownContent(storyMarkdown, `epics.md#story-${key}`);
		storyMap[key] = {
			title: pos.title,
			html: result.data?.html || '',
		};
	}

	return storyMap;
}

/**
 * Parse epics and their stories from epics.md markdown.
 * Epics follow the pattern: ## Epic N: Title
 * Stories follow the pattern: ### Story N.M: Title
 */
function parseEpicsFromMarkdown(raw, storyContents) {
	const epicRegex = /^#{2,3} Epic (\d+):\s*(.+)$/gm;
	const epicMap = {};
	let match;

	while ((match = epicRegex.exec(raw)) !== null) {
		const num = match[1];
		const name = match[2].trim();
		epicMap[num] = { id: `epic-${num}`, num, name, status: 'backlog', stories: [] };
	}

	// Assign stories to their epics
	for (const [key, storyData] of Object.entries(storyContents)) {
		const epicNum = key.split('-')[0];
		const story = { id: key, title: storyData.title, status: 'backlog', epic: epicNum };
		if (epicMap[epicNum]) {
			epicMap[epicNum].stories.push(story);
		} else {
			epicMap[epicNum] = { id: `epic-${epicNum}`, num: epicNum, name: `Epic ${epicNum}`, status: 'backlog', stories: [story] };
		}
	}

	return Object.values(epicMap).sort((a, b) => Number(a.num) - Number(b.num));
}

/**
 * Parse sprint-status from markdown table format.
 * Expects ### Epic N: Name headers followed by tables with | N.M | description | status |
 * @returns {boolean} true if data was found
 */
function parseSprintStatusMarkdown(raw, project) {
	const epicHeaderRegex = /^#{2,3}\s*Epic\s+(\d+):\s*(.+)$/gm;
	const storyRowRegex = /^\|\s*(\d+)\.(\d+)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|$/gm;

	// First pass: find all epic headers
	const epicMap = {};
	let match;
	while ((match = epicHeaderRegex.exec(raw)) !== null) {
		const epicNum = match[1];
		epicMap[epicNum] = {
			id: `epic-${epicNum}`,
			num: epicNum,
			name: match[2].trim(),
			status: 'in-progress',
			stories: [],
		};
	}

	if (Object.keys(epicMap).length === 0) return false;

	// Second pass: find all story rows
	while ((match = storyRowRegex.exec(raw)) !== null) {
		const epicNum = match[1];
		const storyNum = match[2];
		const title = match[3].trim();
		const rawStatus = match[4].trim();

		// Normalize status from emoji/text to our standard values
		const status = normalizeMarkdownStatus(rawStatus);

		project.stories.total++;
		if (status === 'backlog' || status === 'ready-for-dev') project.stories.pending++;
		else if (status === 'in-progress' || status === 'review') project.stories.inProgress++;
		else if (status === 'done') project.stories.done++;

		const story = {
			id: `${epicNum}-${storyNum}-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '')}`,
			title,
			status,
			epic: epicNum,
		};
		project.storyList.push(story);

		if (!epicMap[epicNum]) {
			epicMap[epicNum] = { id: `epic-${epicNum}`, num: epicNum, name: `Epic ${epicNum}`, status: 'in-progress', stories: [] };
		}
		epicMap[epicNum].stories.push(story);
	}

	// Determine epic status from stories
	for (const epic of Object.values(epicMap)) {
		if (epic.stories.length === 0) continue;
		epic.status = deriveEpicStatusFromStories(epic.stories);
	}

	project.epics = Object.values(epicMap).sort((a, b) => Number(a.num) - Number(b.num));

	// Parse bugs table: | BUG-XXX | desc | epic | status |
	const bugRowRegex = /^\|\s*(BUG-\d+)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|$/gm;
	while ((match = bugRowRegex.exec(raw)) !== null) {
		project.bugs.push({
			id: match[1],
			description: match[2].trim(),
			epic: match[3].trim(),
			status: normalizeMarkdownStatus(match[4].trim()),
		});
	}

	// Parse pendientes globales: - [ ] text or - [✅] text or - [x] text
	const pendingRegex = /^-\s*\[([^\]]*)\]\s*\*{0,2}(.+?)(?:\*{0,2}\s*[-–—]\s*(.+))?$/gm;
	while ((match = pendingRegex.exec(raw)) !== null) {
		const check = match[1].trim();
		const done = check === '✅' || check.toLowerCase() === 'x';
		project.pendingItems.push({
			title: match[2].replace(/\*{1,2}/g, '').trim(),
			detail: match[3]?.trim() || '',
			done,
		});
	}

	return project.stories.total > 0;
}

// Map spec-*.md frontmatter status values onto the kanban's standard states.
const SPEC_STATUS_MAP = {
	done: 'done',
	'in-review': 'review', review: 'review', reviewing: 'review',
	'in-progress': 'in-progress', wip: 'in-progress', doing: 'in-progress',
	approved: 'ready-for-dev', ready: 'ready-for-dev', 'ready-for-dev': 'ready-for-dev',
	todo: 'backlog', draft: 'backlog', drafting: 'backlog', planned: 'backlog', backlog: 'backlog', new: 'backlog',
};

function mapSpecStatus(rawStatus) {
	return SPEC_STATUS_MAP[String(rawStatus || '').toLowerCase().trim()] || 'backlog';
}

/**
 * Build spec-driven sprints for initiative folders that carry spec-*.md files but no
 * sprint-status.yaml (already-covered initiatives are skipped).
 *
 * @param {string} outputPath
 * @param {Set<string>} covered - initiative ids already represented by a sprint-status board
 * @param {ErrorAggregator} aggregator
 * @returns {Array<object>}
 */
function buildSpecDrivenSprints(outputPath, covered, aggregator) {
	const implDir = join(outputPath, 'implementation-artifacts');
	let entries = [];
	try { entries = readdirSync(implDir, { withFileTypes: true }); } catch { return []; }

	const sprints = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.name.startsWith('.') || covered.has(entry.name)) continue;
		const dir = join(implDir, entry.name);
		const specFiles = scanDirectMarkdownFiles(dir).filter((f) => basename(f).startsWith('spec-'));
		if (specFiles.length === 0) continue;
		sprints.push(buildSpecSprint(entry.name, specFiles, aggregator));
	}
	return sprints;
}

/**
 * Build one sprint from an initiative's spec-*.md files, grouping by wave ("Onda") and
 * mapping each spec's frontmatter status to a kanban column. Each spec keeps its rendered
 * body so its card opens the full document.
 */
function buildSpecSprint(id, specFiles, aggregator) {
	const stories = { total: 0, pending: 0, inProgress: 0, done: 0 };
	const storyList = [];
	const epicMap = {};

	for (const file of specFiles.sort()) {
		const base = basename(file, '.md');
		const content = readMarkdownSafe(file, aggregator);
		const fm = content.frontmatter || {};
		const status = mapSpecStatus(fm.status);
		const { epicNum, epicName } = parseSpecName(base, fm.title);
		const title = (fm.title ? String(fm.title) : formatName(base.replace(/^spec-/, ''))).trim();

		const story = { id: `spec/${id}/${base}`, title, status, epic: epicNum, html: content.html, path: file };
		storyList.push(story);
		stories.total++;
		if (status === 'backlog' || status === 'ready-for-dev') stories.pending++;
		else if (status === 'in-progress' || status === 'review') stories.inProgress++;
		else if (status === 'done') stories.done++;

		if (!epicMap[epicNum]) {
			epicMap[epicNum] = { id: `epic-${epicNum}`, num: epicNum, name: epicName, status: 'in-progress', stories: [] };
		}
		epicMap[epicNum].stories.push(story);
	}

	// Numeric waves ascending, non-numeric ("Extras") last.
	const epics = Object.values(epicMap).sort((a, b) => {
		const na = Number(a.num), nb = Number(b.num);
		if (Number.isNaN(na) && Number.isNaN(nb)) return String(a.num).localeCompare(String(b.num));
		if (Number.isNaN(na)) return 1;
		if (Number.isNaN(nb)) return -1;
		return na - nb;
	});
	for (const epic of epics) epic.status = deriveEpicStatusFromStories(epic.stories);

	return {
		id,
		label: formatName(id),
		source: 'specs',
		stories,
		storyList,
		epics,
		board: { editable: false, sprintStatusPath: null, sprintStatusFormat: 'specs' },
	};
}

/**
 * Derive the wave/epic grouping for a spec file.
 * `spec-1-2-employees` → wave 1 ("Onda 1"); `spec-storybook-…` (no leading number) → "Extras".
 * When the frontmatter title carries an explicit "Onda N", it names the wave.
 *
 * @param {string} base - spec file basename without extension
 * @param {string} [title]
 * @returns {{epicNum: string, epicName: string}}
 */
function parseSpecName(base, title) {
	const rest = base.replace(/^spec-/, '');
	const numeric = rest.match(/^(\d+)\b/);
	if (numeric) {
		const wave = numeric[1];
		const ondaFromTitle = title && String(title).match(/Onda\s+(\d+)/i);
		return { epicNum: wave, epicName: ondaFromTitle ? `Onda ${ondaFromTitle[1]}` : `Onda ${wave}` };
	}
	return { epicNum: 'extras', epicName: 'Extras' };
}

function deriveEpicStatusFromStories(stories) {
	if (!stories || stories.length === 0) return 'backlog';

	if (stories.every((story) => story.status === 'done')) {
		return 'done';
	}

	if (stories.every((story) => story.status === 'backlog' || story.status === 'ready-for-dev')) {
		return 'backlog';
	}

	return 'in-progress';
}

/**
 * Normalize markdown status text/emojis to standard status values.
 */
function normalizeMarkdownStatus(raw) {
	const lower = raw.toLowerCase();
	// Strip parenthetical notes for primary status detection
	const primary = lower.replace(/\(.*?\)/g, '').trim();
	if (primary.includes('done') || primary.includes('completado') || raw.includes('✅')) return 'done';
	if (primary.includes('in-progress') || primary.includes('in progress') || primary.includes('en progreso') || raw.includes('🔄')) return 'in-progress';
	if (primary.includes('review') || primary.includes('revisión') || primary.includes('revision')) return 'review';
	if (primary.includes('parcial')) return 'in-progress';
	if (primary.includes('pendiente') || primary.includes('pending') || primary.includes('backlog')) return 'backlog';
	if (raw.includes('⏳')) return 'in-progress';
	return 'backlog';
}

/**
 * Parse epic names from YAML comments like "# Epic 1: Fundación del Proyecto"
 */
function parseEpicNamesFromComments(rawYaml) {
	const names = {};
	const regex = /#\s*Epic\s+(\d+):\s*(.+)/gi;
	let match;
	while ((match = regex.exec(rawYaml)) !== null) {
		names[match[1]] = match[2].trim();
	}
	return names;
}

// Terminal statuses that mean "no longer open work" but aren't literally "done".
// Counted as done for progress and routed to the Done column so they don't inflate backlog.
const TERMINAL_DONE_STATUSES = new Set(['done', 'superseded', 'cancelled', 'descoped']);

/**
 * Discover every sprint-status file to surface as a board.
 *
 * Returns the classic single-board locations (feature = null) plus one entry per
 * implementation-artifacts/<feature>/ and planning-artifacts/<feature>/ that holds a
 * sprint-status.{yaml,md}. Unnamed boards come first so the primary stays the flat-layout
 * board when both exist; per-feature entries are sorted by name for stable output.
 *
 * @param {string} outputPath
 * @param {{customSprintStatusPath?: string}} [options]
 * @returns {Array<{path: string, feature: string|null}>}
 */
function discoverSprintStatusFiles(outputPath, options) {
	const found = [];
	const seen = new Set();
	const add = (filePath, feature) => {
		if (filePath && !seen.has(filePath) && existsSync(filePath)) {
			seen.add(filePath);
			found.push({ path: filePath, feature: feature || null });
		}
	};

	// Explicit override wins and is treated as a single unnamed board.
	if (options?.customSprintStatusPath) add(options.customSprintStatusPath, null);

	// Classic single-board locations (unnamed).
	add(join(outputPath, 'implementation-artifacts', 'sprint-status.yaml'), null);
	add(join(outputPath, 'implementation-artifacts', 'sprint-status.md'), null);
	add(join(outputPath, 'sprint-status.yaml'), null);
	add(join(outputPath, 'sprint-status.md'), null);
	add(join(outputPath, 'planning-artifacts', 'sprint-status.yaml'), null);
	add(join(outputPath, 'planning-artifacts', 'sprint-status.md'), null);

	// Per-feature nested boards: <impl|planning>/<feature>/sprint-status.{yaml,md}
	for (const parent of ['implementation-artifacts', 'planning-artifacts']) {
		const parentDir = join(outputPath, parent);
		let entries = [];
		try { entries = readdirSync(parentDir, { withFileTypes: true }); } catch { continue; }
		for (const entry of entries.filter(e => e.isDirectory() && !e.name.startsWith('.')).sort((a, b) => a.name.localeCompare(b.name))) {
			add(join(parentDir, entry.name, 'sprint-status.yaml'), entry.name);
			add(join(parentDir, entry.name, 'sprint-status.md'), entry.name);
		}
	}

	return found;
}

/**
 * Build a single board object from one sprint-status file, or null if it holds no
 * parseable development_status. Prefers strict YAML but falls back to a resilient
 * line extractor, since real sprint-status files often carry multi-line prose or
 * unquoted braces that break the YAML parser.
 *
 * @param {string} statusPath
 * @param {string|null} feature
 * @param {ErrorAggregator} aggregator
 */
function buildBoardData(statusPath, feature, aggregator) {
	let raw = '';
	try { raw = readFileSync(statusPath, 'utf8'); } catch { return null; }
	const ext = extname(statusPath).toLowerCase();

	if (ext === '.yaml' || ext === '.yml') {
		const result = parseYaml(statusPath);
		const status = result.data?.development_status;
		if (status && typeof status === 'object') {
			return boardFromStatusEntries(statusPath, feature, raw, status);
		}
		// Strict YAML failed or lacked the section — recover via the line extractor.
		const salvaged = extractDevelopmentStatus(raw);
		if (salvaged) return boardFromStatusEntries(statusPath, feature, raw, salvaged);
		aggregator.addResult(statusPath, result);
	}

	// Markdown table format (### Epic N + | N.M | desc | status |).
	if (raw) {
		const md = { stories: { total: 0, pending: 0, inProgress: 0, done: 0 }, storyList: [], epics: [] };
		if (parseSprintStatusMarkdown(raw, md)) {
			return {
				key: feature || 'sprint',
				label: feature ? formatName(feature) : 'Sprint',
				feature: feature || null,
				stories: md.stories,
				storyList: md.storyList,
				epics: md.epics,
				board: { editable: true, sprintStatusPath: statusPath, sprintStatusFormat: 'markdown' },
			};
		}
	}

	return null;
}

/**
 * Turn a development_status map ({ "epic-1": "done", "1-1-title": "done", ... }) into a
 * board object with counted stories and epics. Mirrors the classic single-board logic.
 */
function boardFromStatusEntries(statusPath, feature, raw, status) {
	const epicNames = parseEpicNamesFromComments(raw);
	const stories = { total: 0, pending: 0, inProgress: 0, done: 0 };
	const storyList = [];
	const epicMap = {};

	for (const [key, value] of Object.entries(status)) {
		if (typeof value !== 'string') continue;
		if (key.endsWith('-retrospective')) continue;

		if (/^epic-\d+$/.test(key)) {
			const epicNum = key.replace('epic-', '');
			if (!epicMap[epicNum]) {
				epicMap[epicNum] = { id: key, num: epicNum, name: epicNames[epicNum] || `Epic ${epicNum}`, status: value, stories: [] };
			} else {
				epicMap[epicNum].status = value;
				epicMap[epicNum].name = epicNames[epicNum] || epicMap[epicNum].name;
			}
			continue;
		}

		stories.total++;
		if (value === 'backlog' || value === 'ready-for-dev') stories.pending++;
		else if (value === 'in-progress' || value === 'review') stories.inProgress++;
		else if (TERMINAL_DONE_STATUSES.has(value)) stories.done++;

		const parts = key.split('-');
		const epicNum = parts[0];
		const storyTitle = parts.slice(2).join(' ').replace(/\b\w/g, (c) => c.toUpperCase());
		const story = { id: key, title: storyTitle || key, status: value, epic: epicNum };
		storyList.push(story);

		if (!epicMap[epicNum]) {
			epicMap[epicNum] = { id: `epic-${epicNum}`, num: epicNum, name: epicNames[epicNum] || `Epic ${epicNum}`, status: 'in-progress', stories: [] };
		}
		epicMap[epicNum].stories.push(story);
	}

	const epics = Object.values(epicMap).sort((a, b) => Number(a.num) - Number(b.num));
	return {
		key: feature || 'sprint',
		label: feature ? formatName(feature) : 'Sprint',
		feature: feature || null,
		sprintStatus: { development_status: status },
		stories,
		storyList,
		epics,
		board: { editable: true, sprintStatusPath: statusPath, sprintStatusFormat: 'yaml' },
	};
}

/**
 * Extract the development_status map from raw sprint-status text without a full YAML
 * parse. Real files frequently wrap prose across comment lines or use unquoted `{...}`
 * elsewhere in the doc, which breaks js-yaml — but the block itself is a flat list of
 * `  key: value  # optional comment` lines. Returns null if nothing usable is found.
 *
 * @param {string} raw
 * @returns {Record<string, string>|null}
 */
export function extractDevelopmentStatus(raw) {
	const status = {};
	let inBlock = false;
	for (const line of raw.split(/\r?\n/)) {
		if (!inBlock) {
			if (/^development_status\s*:\s*(#.*)?$/.test(line)) inBlock = true;
			continue;
		}
		// A new top-level mapping key ends the block; stray wrapped prose does not.
		if (/^[A-Za-z0-9_][\w.-]*\s*:/.test(line)) break;
		const entry = line.match(/^\s+([A-Za-z0-9._-]+)\s*:\s*([A-Za-z0-9._-]+)\s*(?:#.*)?$/);
		if (entry) status[entry[1]] = entry[2];
	}
	return Object.keys(status).length > 0 ? status : null;
}

/**
 * Copy a feature board's data onto the legacy top-level project fields so existing
 * single-board consumers (save endpoint, content map fallback) keep working.
 */
function applyPrimaryBoard(project, board) {
	project.sprintStatus = board.sprintStatus || null;
	project.board = board.board;
	project.stories = board.stories;
	project.storyList = board.storyList;
	project.epics = board.epics;
}

/**
 * Load BMAD config and project context.
 */
function loadConfig(bmadPath, aggregator) {
	const configPaths = [
		join(bmadPath, 'bmm', 'config.yaml'),
		join(bmadPath, 'config.yaml'),
	];

	let config = {};
	for (const configPath of configPaths) {
		if (existsSync(configPath)) {
			const result = parseYaml(configPath);
			aggregator.addResult(configPath, result);
			config = result.data || {};
			break;
		}
	}

	// Look for project context or product brief for intro content
	const projectRoot = join(bmadPath, '..');
	const contextPaths = [
		join(projectRoot, 'docs', 'project-context.md'),
		join(projectRoot, 'project-context.md'),
		join(projectRoot, '_bmad-output', 'planning-artifacts', 'product-brief.md'),
	];

	// Also search for any product-brief file with date suffix
	const planningDir = join(projectRoot, '_bmad-output', 'planning-artifacts');
	if (existsSync(planningDir)) {
		try {
			const entries = readdirSync(planningDir);
			for (const entry of entries) {
				if (entry.includes('product-brief') && entry.endsWith('.md')) {
					contextPaths.push(join(planningDir, entry));
				}
			}
		} catch { /* ignore */ }
	}

	for (const ctxPath of contextPaths) {
		if (existsSync(ctxPath)) {
			const content = readMarkdownSafe(ctxPath, aggregator);
			config.projectContextHtml = content.html;
			config.projectContextName = basename(ctxPath, '.md');
			break;
		}
	}

	return config;
}

/**
 * Recursively find all files with a specific filename within a directory.
 */
function findNamedFilesRecursive(dir, targetName) {
	const found = [];
	try {
		const entries = readdirSync(dir, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = join(dir, entry.name);
			if (entry.isDirectory()) {
				found.push(...findNamedFilesRecursive(fullPath, targetName));
			} else if (entry.isFile() && entry.name === targetName) {
				found.push(fullPath);
			}
		}
	} catch {
		// Ignore access errors
	}
	return found.sort();
}

/**
 * Scan a directory for direct .md files (non-recursive).
 */
function scanDirectMarkdownFiles(dir) {
	const files = [];
	try {
		const entries = readdirSync(dir, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.isFile() && extname(entry.name) === '.md') {
				files.push(join(dir, entry.name));
			}
		}
	} catch {
		// Ignore
	}
	return files.sort();
}

/**
 * Scan a directory for direct files matching given extensions (non-recursive).
 */
function scanDirectFiles(dir, extensions) {
	const files = [];
	try {
		const entries = readdirSync(dir, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.isFile() && extensions.includes(extname(entry.name).toLowerCase())) {
				files.push(join(dir, entry.name));
			}
		}
	} catch {
		// Ignore
	}
	return files.sort();
}

/**
 * Recursively scan a directory for files matching given extensions.
 */
function scanFilesRecursive(dir, extensions) {
	const files = [];
	try {
		const entries = readdirSync(dir, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = join(dir, entry.name);
			if (entry.isDirectory()) {
				files.push(...scanFilesRecursive(fullPath, extensions));
			} else if (entry.isFile() && extensions.includes(extname(entry.name).toLowerCase())) {
				files.push(fullPath);
			}
		}
	} catch {
		// Ignore
	}
	return files.sort();
}

/**
 * Read an Excalidraw file and produce an HTML viewer using the Excalidraw React component via CDN.
 */
function readExcalidrawSafe(filePath) {
	try {
		const raw = readFileSync(filePath, 'utf8');
		const sceneData = JSON.parse(raw);

		// Escape the JSON for safe embedding in HTML
		const escapedJson = JSON.stringify(sceneData)
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;');

		const html = `<div class="excalidraw-viewer" style="width:100%;height:70vh;border:1px solid var(--border-color,#ddd);border-radius:8px;overflow:hidden;">
<iframe style="width:100%;height:100%;border:none;" srcdoc="<!DOCTYPE html>
<html>
<head>
<meta charset='utf-8'>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html, body, #root { width:100%; height:100%; }
  .excalidraw .App-menu_top .buttonList { display:none; }
</style>
</head>
<body>
<div id='root'></div>
<script src='https://unpkg.com/react@18/umd/react.production.min.js'><\/script>
<script src='https://unpkg.com/react-dom@18/umd/react-dom.production.min.js'><\/script>
<script src='https://unpkg.com/@excalidraw/excalidraw/dist/excalidraw.production.min.js'><\/script>
<script>
  var scene = JSON.parse(decodeURIComponent(&quot;${encodeURIComponent(JSON.stringify(sceneData))}&quot;));
  var App = function() {
    return React.createElement(ExcalidrawLib.Excalidraw, {
      initialData: { elements: scene.elements || [], appState: { viewBackgroundColor: scene.appState?.viewBackgroundColor || '#ffffff', theme: 'light' }, files: scene.files || {} },
      viewModeEnabled: true,
      zenModeEnabled: true,
      gridModeEnabled: false,
      UIOptions: { canvasActions: { changeViewBackgroundColor: false, clearCanvas: false, export: false, loadScene: false, saveToActiveFile: false, toggleTheme: false, saveAsImage: false } }
    });
  };
  ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(App));
<\/script>
</body>
</html>"></iframe></div>`;

		return { html, frontmatter: null, raw };
	} catch {
		return { html: '<p>Error loading Excalidraw file</p>', frontmatter: null, raw: '' };
	}
}

/**
 * Read an HTML file and embed it in an isolated iframe.
 */
function readHtmlSafe(filePath) {
	try {
		const raw = readFileSync(filePath, 'utf8');
		// Escape for srcdoc attribute
		const escaped = raw
			.replace(/&/g, '&amp;')
			.replace(/"/g, '&quot;');
		const html = `<div class="html-artifact-viewer" style="width:100%;height:80vh;border:1px solid var(--border-color,#ddd);border-radius:8px;overflow:hidden;">
<iframe style="width:100%;height:100%;border:none;" srcdoc="${escaped}"></iframe></div>`;
		return { html, frontmatter: null, raw };
	} catch {
		return { html: '<p>Error loading HTML file</p>', frontmatter: null, raw: '' };
	}
}

/**
 * Read a YAML file and render it as formatted code block.
 */
function readYamlSafe(filePath) {
	try {
		const raw = readFileSync(filePath, 'utf8');
		const escaped = raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
		const html = `<pre><code class="language-yaml">${escaped}</code></pre>`;
		return { html, frontmatter: null, raw };
	} catch {
		return { html: '<p>Error loading YAML file</p>', frontmatter: null, raw: '' };
	}
}

/**
 * Categorize an artifact based on its path relative to _bmad-output.
 */
function categorizeArtifact(filePath, outputPath) {
	const rel = relative(outputPath, filePath).replace(/\\/g, '/');

	if (rel.startsWith('planning-artifacts/research/')) return 'research';
	if (rel.startsWith('planning-artifacts/')) return 'planning';
	if (rel.startsWith('implementation-artifacts/')) return 'story';
	if (rel.startsWith('analysis/')) return 'analysis';
	if (rel.startsWith('excalidraw-diagrams/')) return 'diagram';
	if (rel.startsWith('bmb-creations/')) return 'bmb-creation';

	// Root-level files — categorize by filename prefix
	const name = basename(filePath).toLowerCase();
	if (/^(test-design|test-review|atdd-|automation-|traceability-|gate-decision-|nfr-)/.test(name)) return 'test-arch';
	if (/^(design-thinking-|innovation-strategy-|problem-solution-|story-)/.test(name)) return 'cis';
	if (/^brainstorming-/.test(name)) return 'analysis';

	return 'other';
}

/**
 * Format a kebab-case name to Title Case.
 */
function formatName(name) {
	return name.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
