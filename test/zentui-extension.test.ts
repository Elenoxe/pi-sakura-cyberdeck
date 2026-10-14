import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "zentui-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const configFile = join(agentDir, "sakura-cyberdeck-zentui.json");

type Handler = (event: unknown, ctx: unknown) => unknown;

async function setup() {
	const { default: zentui } = await import("../extensions/zentui/index");
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerCommand(name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) {
			commands.set(name, command.handler);
		},
		getThinkingLevel: () => "off",
	};
	zentui(pi as never);
	const emit = async (event: string, payload: unknown, ctx: unknown) => {
		for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
	};
	return { emit, command: (args: string, ctx: unknown) => commands.get("zentui")!(args, ctx) };
}

function makeCtx() {
	const notices: string[] = [];
	const labels: (string | undefined)[] = [];
	let footerFactory: ((...args: unknown[]) => { render(width: number): string[]; dispose?(): void }) | undefined;
	let footer: { render(width: number): string[]; dispose?(): void } | undefined;
	let editorFactory: unknown;
	const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t, getColorMode: () => "256color" };
	const ctx = {
		mode: "tui",
		hasUI: true,
		cwd: mkdtempSync(join(tmpdir(), "zentui-cwd-")),
		model: { provider: "openai", id: "gpt-5", contextWindow: 1000 },
		isProjectTrusted: () => false,
		getContextUsage: () => ({ tokens: 100, contextWindow: 1000, percent: 10 }),
		sessionManager: {
			getEntries: () => [],
			getLeafId: () => "leaf",
			getSessionId: () => "s",
		},
		ui: {
			theme,
			notify: (message: string) => notices.push(message),
			setHiddenThinkingLabel: (label?: string) => labels.push(label),
			setFooter(factory: typeof footerFactory) {
				footer?.dispose?.();
				footerFactory = factory;
				footer = factory?.(
					{ requestRender() {} },
					theme,
					{
						getGitBranch: () => "main\x1b]0;x\x07",
						getExtensionStatuses: () => new Map([["constructor", "status!"]]),
						onBranchChange: () => () => {},
					},
				);
			},
			setEditorComponent(factory: unknown) {
				editorFactory = factory;
			},
			getEditorComponent: () => editorFactory,
		},
	};
	return { ctx, notices, labels, footer: () => footer, footerFactory: () => footerFactory, editor: () => editorFactory };
}

test("session lifecycle: config diagnostics, footer render, idempotent shutdown", async () => {
	writeFileSync(configFile, "{ broken");
	const { emit } = await setup();
	const first = makeCtx();
	await emit("session_start", {}, first.ctx);
	assert.equal(first.notices.length, 1);
	assert.match(first.notices[0] ?? "", /config is invalid/);
	assert.ok(first.notices[0]?.includes(configFile));
	const line = first.footer()?.render(120)[0] ?? "";
	assert.match(line, /main/);
	assert.doesNotMatch(line, /\x07|\]0;/, "branch from Pi is sanitized");
	assert.match(line, /status!/, "status key `constructor` renders instead of crashing");
	assert.ok(first.editor(), "editor installed");

	await emit("session_shutdown", {}, first.ctx);
	assert.equal(first.footerFactory(), undefined);
	await emit("session_shutdown", {}, first.ctx);

	// Legacy fixed-editor config: one notice, then the dead key is migrated away.
	writeFileSync(configFile, JSON.stringify({ fixedEditor: { enabled: true }, separator: "dot" }));
	const second = makeCtx();
	await emit("session_start", {}, second.ctx);
	assert.equal(second.notices.length, 1);
	assert.match(second.notices[0] ?? "", /tuiMode/);
	assert.deepEqual(JSON.parse(readFileSync(configFile, "utf8")), { separator: "dot" });
	await emit("session_shutdown", {}, second.ctx);

	const third = makeCtx();
	await emit("session_start", {}, third.ctx);
	assert.deepEqual(third.notices, []);
	await emit("session_shutdown", {}, third.ctx);
});

test("non-TUI modes install nothing", async () => {
	const { emit } = await setup();
	const rpc = makeCtx();
	(rpc.ctx as { mode: string }).mode = "rpc";
	await emit("session_start", {}, rpc.ctx);
	assert.equal(rpc.footerFactory(), undefined);
	assert.equal(rpc.editor(), undefined);
	await emit("session_shutdown", {}, rpc.ctx);
});

test("thinking rail settings and hidden label follow config, session switches and reload", async () => {
	const { AssistantMessageComponent } = await import("@earendil-works/pi-coding-agent");
	const originalRender = AssistantMessageComponent.prototype.render;
	writeFileSync(configFile, JSON.stringify({ features: { editor: false, statusLine: false, messageStyle: true } }));
	let runtime = await setup();
	let view = makeCtx();
	await runtime.emit("session_start", {}, view.ctx);
	try {
		assert.notEqual(AssistantMessageComponent.prototype.render, originalRender);
		assert.ok(view.labels.at(-1)?.includes("✦"));
		for (const [args, decorated] of [
			["thinking-rail disable", false], ["thinking-rail enable", true],
			["copy-friendly enable", false], ["copy-friendly disable", true],
			["messages disable", false], ["messages enable", true],
			["thinking-rail toggle", false],
		] as const) {
			await runtime.command(args, view.ctx);
			assert.equal(view.labels.at(-1) !== undefined, decorated, args);
		}
		assert.equal(JSON.parse(readFileSync(configFile, "utf8")).features.thinkingRail, false);
		await runtime.emit("session_start", {}, view.ctx);
		assert.equal(view.labels.at(-1), undefined, "session switch loads the saved setting");
		await runtime.emit("session_shutdown", {}, view.ctx);
		assert.equal(AssistantMessageComponent.prototype.render, originalRender);
		runtime = await setup();
		view = makeCtx();
		await runtime.emit("session_start", {}, view.ctx);
		assert.equal(view.labels.at(-1), undefined, "reload keeps the saved setting");
		await runtime.command("thinking-rail enable", view.ctx);
		assert.ok(view.labels.at(-1)?.includes("✦"));
	} finally {
		await runtime.emit("session_shutdown", {}, view.ctx);
	}
	assert.equal(AssistantMessageComponent.prototype.render, originalRender);
	assert.equal(view.labels.at(-1), undefined);
});
