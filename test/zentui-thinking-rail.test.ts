import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { stripVTControlCharacters as strip } from "node:util";
import { type AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantMessageComponent, getMarkdownTheme, initTheme } from "@earendil-works/pi-coding-agent";
import {
	type Component, getKeybindings, KeybindingsManager, Markdown, MouseRegion,
	setKeybindings, sliceByColumn, Text, type TuiMouseEvent, visibleWidth,
} from "@earendil-works/pi-tui";
import { defaultConfig, mergeConfig } from "../extensions/zentui/config";
import { installThinkingRail, sakuraThinkingLabel, ThinkingRailComponent } from "../extensions/zentui/thinking-message";
import { getColorMode, setColorMode } from "../extensions/shared/color";
import { renderSakuraGradient } from "../extensions/zentui/gradient";

const stockRender = AssistantMessageComponent.prototype.render;
let config = defaultConfig;
let cleanup: () => void;
before(() => {
	initTheme("dark");
	cleanup = installThinkingRail(() => config);
});
after(() => {
	cleanup();
	assert.equal(AssistantMessageComponent.prototype.render, stockRender);
});

function message(thinking: string, answer = ""): AssistantMessage {
	return {
		role: "assistant", content: [
			{ type: "thinking", thinking },
			...(answer ? [{ type: "text" as const, text: answer }] : []),
		],
		api: "anthropic-messages", provider: "anthropic", model: "claude",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop", timestamp: 0,
	};
}
function regions(component: AssistantMessageComponent) {
	const runtime = component as unknown as { contentContainer: { children: Component[] } };
	return runtime.contentContainer.children.filter((child) => child instanceof MouseRegion) as unknown as (Component & { child: Component })[];
}
function click(x: number, y: number, width: number, height: number): TuiMouseEvent {
	return { type: "click", button: "left", x, y, width, height,
		screenX: x + 20, screenY: y + 10, shift: false, alt: false, ctrl: false };
}

test("tree preserves native body styles and output markers after removing one padding column", () => {
	const component = new AssistantMessageComponent(message(
		"First **inspect** the implementation.\nContinue here.\n\n最后验证 🌸。\n\n```ts\nconst ok = true;\n```",
		"Native answer",
	), false, undefined, "✦ Thought", 2);
	const region = regions(component)[0]!;
	const native = region.child;
	assert.ok(native instanceof Markdown);
	const body = native.render(54).filter((line) => strip(line).trim())
		.map((line) => sliceByColumn(line, 1, visibleWidth(line) - 1));
	const lines = component.render(60);
	assert.equal(regions(component)[0], region, "native MouseRegion is preserved");
	assert.ok(region.child instanceof ThinkingRailComponent);
	const railLines = region.child.render(60);
	assert.equal(strip(railLines[0]!), "  ✦ Thought trail");
	assert.equal(railLines.length, body.length + 1, "blank lines identify nodes without adding vertical padding");
	assert.ok(railLines.every((line) => strip(line).trim() !== "│"), "no empty rail rows between nodes");
	for (let i = 0; i < body.length; i++) assert.ok(railLines[i + 1]!.endsWith(body[i]!));
	assert.ok(railLines.some((line) => strip(line).startsWith("  ├─ ◇ ")));
	assert.ok(railLines.some((line) => strip(line).startsWith("  │    ")));
	assert.ok(railLines.some((line) => strip(line).startsWith("  ╰─ ◇ ")));
	assert.ok(lines.some((line) => strip(line).includes("Native answer")));
	assert.ok(lines[0]!.startsWith("\x1b]133;A"));
	assert.ok(lines.at(-1)!.startsWith("\x1b]133;B"));
	assert.ok(lines.every((line) => visibleWidth(line) <= 60));
});

test("native thinking Markdown transformers still receive the reduced content width", () => {
	const calls: { kind: string; width: number }[] = [];
	const component = new AssistantMessageComponent(message("Original", "Answer"), false, undefined, "✦ Thought", 1, [
		(markdown, context) => {
			calls.push({ kind: context.messageType, width: context.availableWidth });
			return context.messageType === "assistant-thinking" ? `${markdown} transformed` : markdown;
		},
	]);
	assert.ok(component.render(60).some((line) => strip(line).includes("Original transformed")));
	assert.ok(calls.some((call) => call.kind === "assistant-thinking" && call.width === 52));
	assert.ok(calls.some((call) => call.kind === "assistant" && call.width === 58));
});

test("long thinking is not capped; Chinese, emoji, code and narrow widths fit", () => {
	const component = new AssistantMessageComponent(message(
		Array.from({ length: 120 }, (_, i) => `第 ${i} 行 🌸 **检查** abcdefghijklmnopqrstuvwxyz`).join("\n\n"),
	));
	for (const width of [10, 12, 20, 80]) {
		const lines = component.render(width);
		assert.ok(lines.length > 120);
		const rail = regions(component)[0]!.child as ThinkingRailComponent;
		const decorated = lines.some((line) => strip(line).trimStart().startsWith("✦"));
		let native = rail.inner.render(decorated ? Math.min(width - 6, 100) : width);
		if (decorated) native = native.filter((line) => strip(line).trim())
			.map((line) => sliceByColumn(line, 1, visibleWidth(line) - 1));
		assert.equal(lines.length, native.length + (decorated ? 2 : 1), "native spacer and optional header, no truncation");
		assert.ok(lines.at(-1)!.endsWith(native.at(-1)!));
		assert.ok(lines.every((line) => visibleWidth(line) <= width), `overflow at width ${width}`);
	}
	assert.deepEqual(component.render(8), Reflect.apply(stockRender, component, [8]));
});

for (const target of ["header", "rail", "body"] as const) {
	test(`native mouse toggle works on ${target} and collapsed label`, () => {
		const component = new AssistantMessageComponent(message("First paragraph.\n\nLast paragraph."));
		const lines = component.render(60).map(strip);
		const header = lines.findIndex((line) => line.includes("✦ Thought trail"));
		const y = target === "header" ? header : header + 1;
		const x = target === "body" ? 12 : 2;
		assert.equal(component.handleMouse(click(x, y, 60, lines.length))?.handled, true);
		const collapsed = component.render(60).map(strip);
		assert.ok(collapsed.some((line) => line.trim() === "✦ Thought trail"));
		assert.ok(collapsed.some((line) => line.includes("First paragraph.")));
		assert.ok((regions(component)[0]!.child as ThinkingRailComponent).preview instanceof Markdown);
		const row = collapsed.findIndex((line) => line.trim() === "✦ Thought trail");
		component.handleMouse(click(2, row, 60, collapsed.length));
		assert.ok(component.render(60).some((line) => strip(line).includes("Thought trail")));
		assert.equal((regions(component)[0]!.child as ThinkingRailComponent).preview, undefined);
	});
}

test("per-run overrides and global hide-thinking remain owned by Pi across streaming updates", () => {
	const initial = message("First run", "Answer");
	initial.content.push({ type: "thinking", thinking: "Second run" });
	const component = new AssistantMessageComponent(initial);
	let lines = component.render(60).map(strip);
	const headers = lines.flatMap((line, i) => line.includes("Thought trail") ? [i] : []);
	assert.equal(headers.length, 2);
	component.handleMouse(click(2, headers[1]!, 60, lines.length));
	const updated = structuredClone(initial);
	updated.content.push({ type: "thinking", thinking: "Streaming continuation" });
	component.updateContent(updated, true);
	lines = component.render(60).map(strip);
	assert.equal(lines.filter((line) => line.trim() === "✦ Thought trail").length, 2);
	assert.equal((regions(component)[0]!.child as ThinkingRailComponent).preview, undefined);
	assert.ok((regions(component)[1]!.child as ThinkingRailComponent).preview instanceof Markdown);
	assert.ok(lines.some((line) => line.includes("Streaming continuation")));
	component.setHideThinkingBlock(true);
	component.render(60);
	assert.ok(regions(component).every(({ child }) => (child as ThinkingRailComponent).preview instanceof Markdown));
	component.setHideThinkingBlock(false);
	assert.equal(component.render(60).filter((line) => strip(line).includes("Thought trail")).length, 2);
	assert.ok(regions(component).every(({ child }) => (child as ThinkingRailComponent).preview === undefined));
	const first = regions(component)[0]!.child;
	component.render(60);
	assert.equal(regions(component)[0]!.child, first, "render does not double-wrap");
	component.invalidate();
	assert.equal(component.render(60).filter((line) => strip(line).includes("Thought trail")).length, 2);
});

test("config toggles render existing blocks natively and reinstall cleans up wrappers", () => {
	const component = new AssistantMessageComponent(message("Body"));
	component.render(60);
	try {
		for (const features of [{ thinkingRail: false }, { messageStyle: false }, { copyFriendly: true }]) {
			config = mergeConfig({ features });
			assert.deepEqual(component.render(60), new AssistantMessageComponent(message("Body")).render(60));
			config = defaultConfig;
			assert.ok(component.render(60).some((line) => strip(line).includes("Thought trail")));
		}
		cleanup();
		assert.ok(regions(component)[0]!.child instanceof Markdown);
		assert.equal(AssistantMessageComponent.prototype.render, stockRender);
		cleanup = installThinkingRail(() => config);
		component.render(60);
		const previousCleanup = cleanup;
		cleanup = installThinkingRail(() => config);
		component.render(60);
		previousCleanup();
		assert.ok(regions(component)[0]!.child instanceof ThinkingRailComponent);
		assert.ok(component.render(60).some((line) => strip(line).includes("Thought trail")));
	} finally {
		config = defaultConfig;
	}
});

test("unrecognized thinking child is left unchanged", () => {
	const component = new AssistantMessageComponent(message("Body"));
	const region = regions(component)[0]!;
	const custom: Component = { render: () => ["custom thinking"], invalidate() {} };
	region.child = custom;
	assert.ok(component.render(60).some((line) => strip(line) === "custom thinking"));
	assert.equal(region.child, custom);
});


test("an unrelated Markdown MouseRegion is not mistaken for thinking", () => {
	const component = new AssistantMessageComponent(message("Body"));
	const region = regions(component)[0]!;
	const unrelated = new Markdown("Unrelated content", 0, 0, getMarkdownTheme());
	region.child = unrelated;
	component.render(60);
	assert.equal(region.child, unrelated);
});

test("body mouse coordinates shift but screen coordinates remain unchanged", () => {
	const native = new Markdown("First.\n\nLast.", 0, 0, getMarkdownTheme());
	const nativeLines = native.render(33);
	let forwarded: TuiMouseEvent | undefined;
	(native as Component).handleMouse = (event) => { forwarded = event; return { handled: true }; };
	const rail = new ThinkingRailComponent(native, () => true);
	const lines = rail.render(40);
	const event = click(11, 1, 40, lines.length);
	assert.equal(rail.handleMouse(event)?.handled, true);
	assert.deepEqual(forwarded, { ...event, x: 4, y: 0, width: 33, height: nativeLines.length });
	const lastRowEvent = click(11, 2, 40, lines.length);
	rail.handleMouse(lastRowEvent);
	assert.deepEqual(forwarded, {
		...lastRowEvent, x: 4, y: nativeLines.findIndex((line) => strip(line).includes("Last.")),
		width: 33, height: nativeLines.length,
	}, "mouse coordinates account for removed paragraph spacing");
	forwarded = undefined;
	assert.equal(rail.handleMouse(click(2, 0, 40, lines.length)), undefined);
	assert.equal(forwarded, undefined, "chrome is handled by native parent, not Markdown");
});


test("collapsed preview has eight nonblank body lines and a separate remaining-lines hint", () => {
	for (const count of [8, 9, 12]) {
		const component = new AssistantMessageComponent(message(
			Array.from({ length: count }, (_, i) => `row-${i}`).join("\n\n"),
		), true);
		const lines = component.render(180).map(strip);
		const body = lines.filter((line) => line.includes("row-"));
		assert.equal(body.length, 8, "blank lines and the hint do not consume body slots");
		assert.ok(body.every((line) => !line.includes("...")), "row limit does not append ellipses to body");
		const hint = lines.find((line) => line.includes(" more"));
		if (count === 8) assert.equal(hint, undefined);
		else assert.ok(hint?.includes(`╰─ … +${count - 8} more`));
		assert.ok(!lines.some((line) => line.includes("row-8")));
		component.setHideThinkingBlock(false);
		const expanded = component.render(180).map(strip);
		assert.equal(expanded.filter((line) => line.includes("row-")).length, count);
		assert.ok(!expanded.some((line) => line.includes(" more")));
	}
});

test("only long preview nodes get one ASCII ellipsis; expanding restores all content", () => {
	const component = new AssistantMessageComponent(message(`${"字🌸".repeat(35)}\n\nShort.`), true);
	for (const width of [24, 40, 60, 180]) {
		const lines = component.render(width);
		const rail = regions(component)[0]!.child as ThinkingRailComponent;
		assert.ok(rail.preview instanceof Markdown);
		const body = rail.render(width).slice(1).filter((line) => !strip(line).includes(" more"));
		assert.equal(body.filter((line) => strip(line).endsWith("...")).length, 1, `one ellipsis per node at width ${width}`);
		assert.ok(body.every((line) => visibleWidth(line) <= width));
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
	}
	const collapsed = component.render(180).map(strip);
	assert.ok(collapsed.some((line) => line.endsWith("Short.") && !line.endsWith("...")));
	component.setHideThinkingBlock(false);
	const expanded = component.render(180).map(strip);
	const completeBody = expanded.filter((line) => !line.includes("✦ Thought trail")).map((line) => line.slice(7).trim()).join("");
	assert.ok(completeBody.includes("字🌸".repeat(35)));
	assert.ok(!expanded.some((line) => line.endsWith("...")));
});

test("collapsed preview uses native theme, padding and streaming Markdown transformers", () => {
	const contexts: { width: number; streaming: boolean }[] = [];
	const content = message("Original", "Answer");
	const component = new AssistantMessageComponent(undefined, true, undefined, "Native hidden", 2, [
		(markdown, context) => {
			if (context.messageType !== "assistant-thinking") return markdown;
			contexts.push({ width: context.availableWidth, streaming: context.isStreaming });
			return `${markdown} **transformed**`;
		},
	]);
	component.updateContent(content, true);
	let lines = component.render(180);
	assert.ok(lines.some((line) => strip(line).includes("Original transformed")));
	assert.deepEqual(contexts, [{ width: 96, streaming: true }]);
	assert.ok(strip(lines[2]!).startsWith("  ╰─ ◇  Original"), "only one native padding column is removed");
	const wrapper = regions(component)[0]!.child;
	component.render(180);
	assert.equal(regions(component)[0]!.child, wrapper);
	assert.equal(contexts.length, 1, "native render cache is retained");
	component.updateContent(message("Updated", "Answer"), true);
	lines = component.render(180);
	assert.ok(lines.some((line) => strip(line).includes("Updated transformed")));
	assert.ok(!lines.some((line) => strip(line).includes("Original")));
	assert.ok(lines.some((line) => strip(line).trim() === "✦ Thought trail"));
	assert.ok((regions(component)[0]!.child as ThinkingRailComponent).preview instanceof Markdown, "streaming keeps the native collapsed state");
});

test("remaining-lines shortcut hint follows current Pi bindings, including no binding", () => {
	const originalBindings = getKeybindings();
	const bindings = new KeybindingsManager({
		"app.thinking.toggle": { defaultKeys: "ctrl+t", description: "Toggle thinking" },
	});
	setKeybindings(bindings);
	try {
		const component = new AssistantMessageComponent(message(
			Array.from({ length: 10 }, (_, i) => `row-${i}`).join("\n\n"),
		), true);
		const footer = () => strip(component.render(180).at(-1)!);
		assert.ok(footer().endsWith("ctrl+t to expand"));
		bindings.setUserBindings({ "app.thinking.toggle": ["alt+t", "ctrl+y"] });
		assert.ok(footer().endsWith("alt+t/ctrl+y to expand"));
		assert.ok(!footer().includes("ctrl+t"));
		bindings.setUserBindings({ "app.thinking.toggle": [] });
		assert.equal(footer(), "  ╰─ … +2 more");
	} finally {
		setKeybindings(originalBindings);
	}
});

test("config, reinstall and cleanup preserve the native collapsed child", () => {
	const component = new AssistantMessageComponent(message("Preview"), true);
	const region = regions(component)[0]!;
	const nativeLabel = region.child;
	assert.ok(nativeLabel instanceof Text);
	component.render(60);
	try {
		for (const features of [{ thinkingRail: false }, { messageStyle: false }, { copyFriendly: true }]) {
			config = mergeConfig({ features });
			const lines = component.render(60).map(strip);
			assert.ok(lines.some((line) => line.includes("Thinking...")));
			assert.ok(!lines.some((line) => line.includes("Preview")));
			config = defaultConfig;
			assert.ok(component.render(60).some((line) => strip(line).includes("Preview")));
		}
		const previousCleanup = cleanup;
		cleanup = installThinkingRail(() => config);
		component.render(60);
		previousCleanup();
		assert.ok(component.render(60).some((line) => strip(line).includes("Preview")));
		cleanup();
		assert.equal(region.child, nativeLabel);
		cleanup = installThinkingRail(() => config);
	} finally {
		config = defaultConfig;
	}
});


test("title, branch and diamond each use their own Sakura gradient", () => {
	const originalMode = getColorMode();
	setColorMode("truecolor");
	try {
		const title = renderSakuraGradient("✦") + renderSakuraGradient(" Thought trail");
		assert.equal(sakuraThinkingLabel(), title);
		for (const hidden of [false, true]) {
			const component = new AssistantMessageComponent(message("First.\nContinue.\n\nLast."), hidden);
			component.render(60);
			const rail = regions(component)[0]!.child as ThinkingRailComponent;
			const lines = rail.render(60);
			assert.equal(lines[0], `  ${title}`);
			assert.ok(lines[1]!.startsWith(`  ${renderSakuraGradient("├─ ")}${renderSakuraGradient("◇")} `));
			assert.ok(lines[2]!.startsWith(`  ${renderSakuraGradient("│  ")}  `));
			assert.ok(lines[3]!.startsWith(`  ${renderSakuraGradient("╰─ ")}${renderSakuraGradient("◇")} `));
		}
		setColorMode("none");
		assert.equal(sakuraThinkingLabel(), "✦ Thought trail");
	} finally {
		setColorMode(originalMode);
	}
});

test("both views remove exactly one native left-padding column", () => {
	for (const padding of [0, 1, 2]) {
		for (const hidden of [false, true]) {
			const component = new AssistantMessageComponent(message("Start."), hidden, undefined, undefined, padding);
			const lines = component.render(60).map(strip);
			const body = lines.find((line) => line.includes("Start."))!;
			assert.equal(body.indexOf("Start."), 7 + Math.max(0, padding - 1));
		}
	}
});

test("expanded thinking keeps the original 100-column render limit without losing content", () => {
	const content = "abcdefghij".repeat(30);
	const widths: number[] = [];
	const component = new AssistantMessageComponent(message(content), false, undefined, undefined, 1, [
		(markdown, context) => {
			widths.push(context.availableWidth);
			return markdown;
		},
	]);
	component.render(200);
	assert.deepEqual(widths, [98], "100 native columns minus both padding columns");
	const rail = regions(component)[0]!.child as ThinkingRailComponent;
	const lines = rail.render(200);
	assert.deepEqual(lines, rail.render(120), "wider terminals do not widen the body");
	assert.ok(lines.slice(1).every((line) => visibleWidth(line) <= 7 + 99));
	assert.equal(lines.slice(1).map((line) => strip(line).slice(7).trim()).join(""), content);
});

test("mouse forwarding includes the removed padding and native 100-column width", () => {
	const native = new Markdown("Body.", 1, 0, getMarkdownTheme());
	const nativeLines = native.render(100);
	let forwarded: TuiMouseEvent | undefined;
	(native as Component).handleMouse = (event) => { forwarded = event; return { handled: true }; };
	const rail = new ThinkingRailComponent(native, () => true);
	const lines = rail.render(200);
	const event = click(7, 1, 200, lines.length);
	rail.handleMouse(event);
	assert.deepEqual(forwarded, { ...event, x: 1, y: 0, width: 100, height: nativeLines.length });
});

test("node preview preserves its line breaks and applies one shared text budget", () => {
	const component = new AssistantMessageComponent(message(
		`${"A".repeat(40)}\n${"B".repeat(40)}\n${"C".repeat(40)}\n\n${"D".repeat(40)}\n${"E".repeat(40)}`,
	), true);
	const body = component.render(60).map(strip).slice(2).map((line) => line.slice(7));
	assert.deepEqual(body, [
		"A".repeat(40), "B".repeat(40), `${"C".repeat(17)}...`,
		"D".repeat(40), "E".repeat(40),
	]);
	assert.equal(body.filter((line) => line.endsWith("...")).length, 1);
	assert.equal(body.slice(0, 3).reduce((columns, line) => columns + visibleWidth(line), 0), 100);
});

test("100-column nodes remain complete; longer Unicode nodes get only one ellipsis", () => {
	for (const [text, truncated] of [["字".repeat(50), false], ["字".repeat(51), true]] as const) {
		const component = new AssistantMessageComponent(message(text), true);
		const body = component.render(180).map(strip).slice(2).map((line) => line.slice(7));
		assert.equal(body.filter((line) => line.endsWith("...")).length, truncated ? 1 : 0);
		assert.ok(body.reduce((columns, line) => columns + visibleWidth(line), 0) <= 100);
		assert.ok(body.every((line) => !line.includes("�")));
		if (!truncated) assert.equal(body.join(""), text);
	}
});

test("the eight-line preview limit applies after node shortening, without row ellipses", () => {
	const component = new AssistantMessageComponent(message(`${"字🌸".repeat(35)}\n\nShort.`), true);
	const lines = component.render(20).map(strip);
	const body = lines.slice(2, 10);
	assert.equal(body.length, 8);
	assert.ok(body.every((line) => !line.endsWith("...")), "the node's ellipsis is beyond the visible eight rows");
	assert.ok(lines.at(-1)!.includes("… +2 more"));
	assert.ok(lines.every((line) => visibleWidth(line) <= 20));
	assert.ok(component.render(10).every((line) => visibleWidth(line) <= 10));
});
