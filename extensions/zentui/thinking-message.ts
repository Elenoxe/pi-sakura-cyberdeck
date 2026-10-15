import { stripVTControlCharacters } from "node:util";
import { AssistantMessageComponent, keyHint, keyText } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type MarkdownTheme,
	Markdown,
	MouseRegion,
	Text,
	type TuiMouseEvent,
	sliceByColumn,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { getColorMode } from "../shared/color";
import type { PolishedTuiConfig } from "./config";
import { renderSakuraGradient } from "./gradient";
import { installPrototypePatch } from "./prototype-patch-registry";

export const SAKURA_HIDDEN_THINKING_LABEL = "✦ Thought trail";
const PREFIX_WIDTH = 7;
const MIN_WIDTH = PREFIX_WIDTH + 3;
const PREVIEW_LINES = 8;
const MAX_BODY_WIDTH = 100;
const MAX_PREVIEW_NODE_WIDTH = 100;
const wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });

type ThinkingRow = { line: string; index: number };

function thinkingWordPrefix(line: string, columns: number): string {
	const text = stripVTControlCharacters(line);
	let width = 0;
	let end = 0;
	for (const word of wordSegmenter.segment(text)) {
		width += visibleWidth(word.segment);
		if (width > columns) break;
		end = word.index + word.segment.length;
	}
	return sliceByColumn(line, 0, visibleWidth(text.slice(0, end).trimEnd()), true);
}

function truncateThinkingNode(rows: ThinkingRow[], rowWidth: number): ThinkingRow[] {
	const nodeWidth = rows.reduce((total, { line }) => total + visibleWidth(line), 0);
	if (nodeWidth <= MAX_PREVIEW_NODE_WIDTH) return rows;
	const preview: ThinkingRow[] = [];
	const ellipsis = "...";
	let remaining = MAX_PREVIEW_NODE_WIDTH - ellipsis.length;
	for (const row of rows) {
		const lineWidth = visibleWidth(row.line);
		if (lineWidth > remaining) {
			let ending = row;
			let columns = Math.min(remaining, rowWidth - ellipsis.length);
			let prefix = thinkingWordPrefix(ending.line, columns);
			// Keep tiny truncation tails on the preceding row.
			if (visibleWidth(stripVTControlCharacters(prefix).trim()) <= ellipsis.length && preview.length > 0) {
				ending = preview.pop()!;
				columns = Math.min(visibleWidth(ending.line) + remaining, rowWidth - ellipsis.length);
				prefix = thinkingWordPrefix(ending.line, columns);
			}
			// An unbroken token may itself exceed the available width.
			if (!stripVTControlCharacters(prefix).trim()) prefix = sliceByColumn(ending.line, 0, columns, true);
			preview.push({ ...ending, line: `${prefix}${ellipsis}` });
			break;
		}
		preview.push(row);
		remaining -= lineWidth;
	}
	return preview;
}

type HiddenThinkingLabelUi = { setHiddenThinkingLabel?: (label?: string) => void };

export function thinkingRailEnabled(config: PolishedTuiConfig): boolean {
	return config.features.messageStyle && config.features.thinkingRail && !config.features.copyFriendly;
}

export function sakuraThinkingLabel(): string {
	return getColorMode() === "none"
		? SAKURA_HIDDEN_THINKING_LABEL
		: renderSakuraGradient(SAKURA_HIDDEN_THINKING_LABEL.slice(0, 1)) +
			renderSakuraGradient(SAKURA_HIDDEN_THINKING_LABEL.slice(1));
}

/** Restore Pi's default label when rail decorations are disabled. */
export function applyThinkingLabel(ctx: { ui?: unknown }, enabled = true): void {
	const ui = ctx.ui as HiddenThinkingLabelUi | undefined;
	if (typeof ui?.setHiddenThinkingLabel !== "function") return;
	try {
		ui.setHiddenThinkingLabel(enabled ? sakuraThinkingLabel() : undefined);
	} catch {
		// Older/alternate hosts: keep Pi's default label.
	}
}

/** Decorate rendered paragraphs only; Markdown retains its text, styles and transforms. */
export class ThinkingRailComponent implements Component {
	private decorated = false;
	private bodyHeight = 0;
	private bodyRows: number[] = [];
	private bodyInset = 0;
	private bodyWidth = 0;

	constructor(
		readonly inner: Markdown | Text,
		readonly enabled: () => boolean,
		readonly preview?: Markdown,
	) {}

	invalidate(): void {
		this.inner.invalidate();
		this.preview?.invalidate();
	}

	render(width: number): string[] {
		this.decorated = this.enabled() && width >= MIN_WIDTH;
		const source = this.decorated ? this.preview ?? this.inner : this.inner;
		// Remove one native margin column, leaving authored Markdown indentation intact.
		this.bodyInset = this.decorated && ((source as unknown as { paddingX?: number }).paddingX ?? 0) > 0 ? 1 : 0;
		this.bodyWidth = this.decorated ? Math.min(width - PREFIX_WIDTH + this.bodyInset, MAX_BODY_WIDTH) : width;
		let lines = source.render(this.bodyWidth);
		// Native Markdown needs room for its own padding and wide glyphs; do not clip individual rows.
		if (this.decorated && lines.some((line) => visibleWidth(line) - this.bodyInset > width - PREFIX_WIDTH)) {
			this.decorated = false;
			lines = this.inner.render(width);
		}
		this.bodyHeight = lines.length;
		if (!this.decorated || lines.length === 0) {
			this.decorated = false;
			return lines;
		}
		const blankLines = lines.map((line) => stripVTControlCharacters(line).trim().length === 0);
		const paragraphStarts = blankLines.map((blank, index) => !blank && (index === 0 || blankLines[index - 1]));
		const lastParagraphStart = paragraphStarts.lastIndexOf(true);
		// Blank rows identify paragraph starts, but neither view adds spacing between nodes.
		let rows = lines.map((line, index) => {
			if (this.bodyInset) line = sliceByColumn(line, this.bodyInset, visibleWidth(line) - this.bodyInset);
			return { line, index };
		}).filter(({ index }) => !blankLines[index]);
		let remaining = 0;
		if (this.preview) {
			const nodes: ThinkingRow[][] = [];
			for (const row of rows) {
				// Right-padding is layout, not part of a node’s text budget.
				const columns = visibleWidth(stripVTControlCharacters(row.line).trimEnd());
				row.line = sliceByColumn(row.line, 0, columns);
				if (paragraphStarts[row.index]) nodes.push([]);
				nodes[nodes.length - 1]!.push(row);
			}
			rows = nodes.flatMap((node) => truncateThinkingNode(node, width - PREFIX_WIDTH));
			remaining = Math.max(0, rows.length - PREVIEW_LINES);
			rows = rows.slice(0, PREVIEW_LINES);
		}
		this.bodyRows = rows.map(({ index }) => index);
		const header = truncateToWidth(`  ${sakuraThinkingLabel()}`, width, "");
		const body = rows.map(({ line, index }) => {
			let branch = "   ";
			let marker = "  ";
			if (paragraphStarts[index]) {
				branch = index === lastParagraphStart ? "╰─ " : "├─ ";
				marker = `${renderSakuraGradient("◇")} `;
			} else if (index < lastParagraphStart) {
				branch = "│  ";
			}
			return `  ${renderSakuraGradient(branch)}${marker}${line}`;
		});
		if (remaining > 0) {
			let hint = `… +${remaining} more`;
			if (keyText("app.thinking.toggle")) hint += ` · ${keyHint("app.thinking.toggle", "to expand")}`;
			body.push(truncateToWidth(`  ${renderSakuraGradient("╰─ ")}${hint}`, width, ""));
		}
		return [header, ...body];
	}

	handleMouse(event: TuiMouseEvent) {
		const inner: Component = this.inner;
		if (!this.decorated) return inner.handleMouse?.(event);
		// Chrome falls through to the enclosing native MouseRegion's thinking toggle.
		if (event.y < 1 || event.x < PREFIX_WIDTH) return undefined;
		const row = this.bodyRows[event.y - 1];
		if (row === undefined) return undefined;
		return inner.handleMouse?.({
			...event, x: event.x - PREFIX_WIDTH + this.bodyInset, y: row,
			width: this.bodyWidth, height: this.bodyHeight,
		});
	}
}

// Pi internals are confined here. Its content container's MouseRegions are thinking
// runs; require the expected run count and native children before changing anything.
type NativeRegion = Component & { child: Component };
type AssistantMessageRuntime = {
	contentContainer?: { children?: Component[] };
	lastMessage?: Parameters<AssistantMessageComponent["updateContent"]>[0];
	markdownTheme?: MarkdownTheme;
	outputPad?: number;
	markdownTransformers?: ConstructorParameters<typeof AssistantMessageComponent>[5];
	isStreaming?: boolean;
};

function thinkingRegions(receiver: unknown): NativeRegion[] {
	const runtime = receiver as AssistantMessageRuntime;
	const children = runtime.contentContainer?.children;
	const content = runtime.lastMessage?.content;
	if (!Array.isArray(children) || !Array.isArray(content)) return [];
	let thinkingRunCount = 0;
	let hasVisibleThinkingRun = false;
	for (const block of content) {
		if (block.type !== "thinking") hasVisibleThinkingRun = false;
		else if (block.thinking?.trim() && !hasVisibleThinkingRun) {
			thinkingRunCount++;
			hasVisibleThinkingRun = true;
		}
	}
	const regions = children.filter((child) => child instanceof MouseRegion) as unknown as NativeRegion[];
	if (regions.length !== thinkingRunCount) return [];
	for (const { child } of regions) {
		if (child instanceof ThinkingRailComponent || child instanceof Text) continue;
		if (!(child instanceof Markdown)) return [];
		const style = (child as unknown as {
			defaultTextStyle?: { italic?: boolean; color?: unknown };
		}).defaultTextStyle;
		if (style?.italic !== true || typeof style.color !== "function") return [];
	}
	return regions;
}

// Pi creates only a label when collapsed. Ask a separate native component for its
// expanded Markdown without changing the live message or its visibility overrides.
function expandedThinkingRegions(receiver: unknown): NativeRegion[] {
	const runtime = receiver as AssistantMessageRuntime;
	if (!runtime.lastMessage) return [];
	const expanded = new AssistantMessageComponent(
		undefined, false, runtime.markdownTheme, undefined, runtime.outputPad, runtime.markdownTransformers,
	);
	expanded.updateContent(runtime.lastMessage, runtime.isStreaming);
	return thinkingRegions(expanded);
}

export function installThinkingRail(getConfig: () => PolishedTuiConfig): () => void {
	let active = true;
	const enabled = () => active && thinkingRailEnabled(getConfig());
	const observedHosts = new WeakSet<object>();
	const hostRefs = new Set<WeakRef<object>>();
	const cleanupPatch = installPrototypePatch(
		AssistantMessageComponent.prototype, "render", "assistant-thinking-rail",
		({ predecessor, receiver, args }) => {
			const host = receiver as object;
			const regions = thinkingRegions(receiver);
			let previews: NativeRegion[] | undefined;
			for (const [index, region] of regions.entries()) {
				if (region.child instanceof ThinkingRailComponent) {
					if (region.child.enabled === enabled) continue;
					region.child = region.child.inner;
				}
				if (!enabled()) continue;
				if (region.child instanceof Markdown) {
					region.child = new ThinkingRailComponent(region.child, enabled);
				} else if (region.child instanceof Text) {
					previews ??= expandedThinkingRegions(receiver);
					const preview = previews[index]?.child;
					if (!(preview instanceof Markdown)) continue;
					region.child = new ThinkingRailComponent(region.child, enabled, preview);
				} else {
					continue;
				}
				if (!observedHosts.has(host)) {
					observedHosts.add(host);
					hostRefs.add(new WeakRef(host));
				}
			}
			return Reflect.apply(predecessor, receiver, args);
		},
	);
	return () => {
		active = false;
		cleanupPatch();
		for (const reference of hostRefs) {
			const host = reference.deref() as AssistantMessageRuntime | undefined;
			for (const child of host?.contentContainer?.children ?? []) {
				if (!(child instanceof MouseRegion)) continue;
				const region = child as unknown as NativeRegion;
				if (region.child instanceof ThinkingRailComponent && region.child.enabled === enabled) {
					region.child = region.child.inner;
				}
			}
		}
		hostRefs.clear();
	};
}
