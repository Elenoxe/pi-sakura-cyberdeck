import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { defaultConfig, mergeConfig } from "../extensions/zentui/config";
import { PolishedEditor, WrappedPolishedEditor } from "../extensions/zentui/ui";

function createEditor(config = defaultConfig) {
	const identity = (text: string) => text;
	const tui = { terminal: { rows: 40, columns: 80 }, requestRender() {} };
	const editorTheme = {
		borderColor: identity,
		selectList: {
			selectedPrefix: identity,
			selectedText: identity,
			description: identity,
			scrollInfo: identity,
			noMatch: identity,
		},
	};
	const uiTheme = { fg: (_c: string, t: string) => t, bold: identity } as never;
	return new PolishedEditor(
		tui as never,
		editorTheme as never,
		{ matches: () => false } as never,
		uiTheme,
		() => config,
		() => ({ modelLabel: "gpt-5", providerLabel: "OpenAI" }),
		() => "high",
	);
}

test("PolishedEditor frames Pi's real Editor without reading private fields", () => {
	const editor = createEditor();
	editor.setText("compare gpt-5 with OpenAI\n────────");
	const lines = editor.render(50).map((line) => stripVTControlCharacters(line));
	assert.ok(lines.some((line) => line.includes("compare gpt-5 with OpenAI")), lines.join("\n"));
	assert.ok(lines.some((line) => line.includes("────────") && line.includes(defaultConfig.icons.rail)), "typed dashes stay content");
	assert.ok(lines.some((line) => /gpt-5\s+OpenAI\s+high/.test(line)));
	assert.equal(lines.length, 7, lines.join("\n"));
});

function click(x: number, y: number, width = 30, height = 7) {
	return {
		type: "click" as const, button: "left" as const, x, y, screenX: x, screenY: y,
		width, height, shift: false, alt: false, ctrl: false,
	};
}

for (const copyFriendly of [false, true]) {
	for (const wrapped of [false, true, "nested"] as const) {
		test(`mouse hits real editor text, not chrome (copyFriendly=${copyFriendly}, wrapped=${wrapped})`, () => {
			const config = mergeConfig({ features: { copyFriendly } });
			const base = createEditor(config);
			let editor: PolishedEditor | WrappedPolishedEditor = base;
			const wrap = () => new WrappedPolishedEditor(
				editor, { fg: (_c: string, t: string) => t } as never, () => config,
				() => ({ modelLabel: "m", providerLabel: "p" }), () => "off",
			);
			if (wrapped) editor = wrap();
			if (wrapped === "nested") editor = wrap();
			editor.setText("abcdef\nuvwxyz");
			const lines = editor.render(30).map(stripVTControlCharacters);
			const y = lines.findIndex((line) => line.includes("abcdef"));
			const x = lines[y]!.indexOf("abcdef");
			editor.handleMouse(click(x, y));
			assert.deepEqual(base.getCursor(), { line: 0, col: 0 });
			editor.handleMouse(click(x + 3, y + 1));
			assert.deepEqual(base.getCursor(), { line: 1, col: 3 });
			const cursor = base.getCursor();
			for (const row of [0, 1, lines.length - 3, lines.length - 2, lines.length - 1]) {
				editor.handleMouse(click(x, row));
				assert.deepEqual(base.getCursor(), cursor, `chrome row ${row}`);
			}
			if (x > 0) {
				editor.handleMouse(click(x - 1, y));
				assert.deepEqual(base.getCursor(), cursor, "rail/prompt");
			}
			editor.render(2);
			editor.handleMouse(click(0, 1, 2));
			assert.deepEqual(base.getCursor(), { line: 0, col: 0 }, "narrow layout is unframed");
		});
	}
}

test("wrapped editor forwards autocomplete clicks below the frame", async () => {
	const base = createEditor();
	const editor = new WrappedPolishedEditor(
		base, { fg: (_c: string, t: string) => t } as never, () => defaultConfig,
		() => ({ modelLabel: "m", providerLabel: "p" }), () => "off",
	);
	base.setAutocompleteProvider({
		getSuggestions: () => ({ prefix: "/", items: [
			{ value: "/first", label: "/first" }, { value: "/second", label: "/second" },
		] }),
		applyCompletion: (_lines, _line, _col, item) => ({
			lines: [item.value], cursorLine: 0, cursorCol: item.value.length,
		}),
	});
	base.handleInput("/");
	await new Promise((resolve) => setImmediate(resolve));
	const lines = editor.render(30).map(stripVTControlCharacters);
	const row = lines.findIndex((line) => line.includes("/second"));
	assert.ok(row > 0, lines.join("\n"));
	editor.handleMouse(click(3, row, 30, lines.length));
	assert.equal(editor.getText(), "/second");
});
