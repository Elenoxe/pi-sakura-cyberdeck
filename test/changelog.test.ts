import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import sakuraChangelog, {
	compareVersions,
	parseChangelog,
	renderChangelogLines,
	renderNoticeLines,
	unseenEntries,
} from "../extensions/changelog/index";

const plain = { fg: (_c: string, t: string) => t, bold: (t: string) => t } as never;

const SAMPLE = `# Changelog

## [1.2.0] - 2026-09-30

### Highlights

- **Lighter**: removed the fixed editor.
- Faster idle footer.

### Fixed

- Bug one with a very long description that has to wrap across several lines in a narrow terminal window.
  - nested detail

## [1.1.6] - 2026-09-30

- Removed quota UI.

## 1.0.0

- Initial.
`;

test("parseChangelog reads versions, dates, sections and bullets", () => {
	const entries = parseChangelog(SAMPLE);
	assert.deepEqual(entries.map((e) => e.version), ["1.2.0", "1.1.6", "1.0.0"]);
	assert.equal(entries[0]!.date, "2026-09-30");
	assert.deepEqual(entries[0]!.sections.map((s) => s.title), ["Highlights", "Fixed"]);
	assert.equal(entries[1]!.sections[0]!.lines.length, 1);
});

test("unseenEntries returns versions after lastSeen up to current, newest first", () => {
	const entries = parseChangelog(SAMPLE);
	assert.deepEqual(unseenEntries(entries, "1.1.6", "1.2.0").map((e) => e.version), ["1.2.0"]);
	assert.deepEqual(unseenEntries(entries, "1.0.0", "1.2.0").map((e) => e.version), ["1.2.0", "1.1.6"]);
	assert.deepEqual(unseenEntries(entries, undefined, "1.1.6").map((e) => e.version), ["1.1.6", "1.0.0"]);
	assert.deepEqual(unseenEntries(entries, "1.2.0", "1.2.0"), []);
	assert.equal(compareVersions("1.10.0", "1.9.9"), 1);
});

test("notice shows highlights only and never exceeds width", () => {
	const entries = unseenEntries(parseChangelog(SAMPLE), "1.1.6", "1.2.0");
	for (const width of [20, 40, 80, 200]) {
		const lines = renderNoticeLines(entries, width, plain);
		assert.ok(lines.every((l) => visibleWidth(l) <= width), `width ${width}`);
		assert.ok(lines.some((l) => l.includes("Lighter: removed the fixed editor.")) || width < 40);
		assert.ok(!lines.some((l) => l.includes("Bug one")));
	}
});

test("full changelog wraps long bullets within width", () => {
	const lines = renderChangelogLines(parseChangelog(SAMPLE), 40, plain);
	assert.ok(lines.every((l) => visibleWidth(l) <= 40));
	assert.ok(lines.filter((l) => l.trim()).length > 8);
});

test("shipped CHANGELOG.md has an entry for the package version", () => {
	const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	const entries = parseChangelog(readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8"));
	assert.equal(entries[0]?.version, pkg.version);
	assert.ok(entries[0]!.sections.some((s) => /highlight/i.test(s.title)));
});

test("changelog viewer clamps its scroll offset after width and height changes", async () => {
	let command: { handler: (args: string, ctx: never) => Promise<void> } | undefined;
	sakuraChangelog({
		on() {},
		registerCommand(_name: string, definition: typeof command) { command = definition; },
	} as never);
	assert.ok(command);
	const entries = parseChangelog(readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8"));
	const terminal = { rows: 16 };
	await command.handler("", {
		hasUI: true, mode: "tui",
		ui: {
			custom: async (factory: (...args: never[]) => {
				render: (width: number) => string[]; handleInput: (key: string) => void; invalidate: () => void;
			}) => {
				const viewer = factory({ terminal, requestRender() {} } as never, plain, {} as never, (() => {}) as never);
				viewer.render(32);
				viewer.handleInput("G");
				for (const [width, rows] of [[160, 16], [160, 48], [80, 48]]) {
					terminal.rows = rows!;
					const rendered = viewer.render(width!);
					const all = renderChangelogLines(entries, width!, plain);
					const size = Math.max(5, Math.min(40, rows! - 8));
					const range = rendered.at(-1)!.match(/(\d+)-(\d+)\/(\d+)/);
					assert.ok(range, rendered.at(-1));
					const [start, end, total] = range.slice(1).map(Number);
					assert.ok(start! <= end! && end! <= total!, rendered.at(-1));
					assert.equal(total, all.length);
					assert.deepEqual(rendered.slice(0, -2), all.slice(start! - 1, end));
					assert.equal(rendered.length - 2, Math.min(size, all.length));
				}
				viewer.invalidate();
				assert.ok(viewer.render(80).length > 2);
			},
		},
	} as never);
});
