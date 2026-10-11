import { UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { getColorMode } from "../shared/color";
import type { PolishedTuiConfig } from "./config";
import { renderSakuraFrameGradient, SAKURA_MACARON_GRADIENT } from "./gradient";
import {
	EDITOR_ACCENT_FALLBACK,
	EDITOR_BORDER_FALLBACK,
	renderStyleForSourceOrFallback,
	type ThemeLike,
} from "./style";
import { installPrototypePatch } from "./prototype-patch-registry";

/**
 * User prompt chrome: editor-configured borders/rail, using the user-message color source.
 *
 * The message body is Pi's own UserMessageComponent render (markdown options, extension
 * markdown transformers, outputPad, OSC 133 prompt markers) at the reduced width, passed through
 * byte-for-byte. Copy-friendly mode drops the rail so copied text has no extra glyphs.
 */

type Cleanup = () => void;

type UserMessageCard = {
	width: number;
	chromeKey: string;
	inner: readonly string[];
	lines: string[];
};

const MIN_WIDTH = 8;

function sameLines(a: readonly string[], b: readonly string[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

function railFor(config: PolishedTuiConfig): { text: string; columns: number } {
	if (config.features.copyFriendly) return { text: "", columns: 0 };
	const glyph = typeof config.icons?.rail === "string" ? config.icons.rail : "▐";
	// Control characters would corrupt the row; fall back to the default glyph.
	const safe = /[\u0000-\u001f\u007f-\u009f]/.test(glyph) || visibleWidth(glyph) > 2 ? "▐" : glyph;
	const text = `${safe} `;
	return { text, columns: visibleWidth(text) };
}

export function renderUserMessageCard(inner: readonly string[], rail: string, border: string): string[] {
	const lines: string[] = [border];
	for (const line of inner) {
		// Pi's fullscreen filtering and prompt navigation require OSC 133 at the row start.
		const markers = line.match(/^(?:\x1b\]133;[ABC](?:\x07|\x1b\\))+/)?.[0] ?? "";
		lines.push(`${markers}${rail}${line.slice(markers.length)}`);
	}
	lines.push(border);
	return lines;
}

export function installUserMessageStyle(
	getTheme: () => ThemeLike,
	getConfig: () => PolishedTuiConfig,
): Cleanup {
	const cards = new WeakMap<object, UserMessageCard>();
	return installPrototypePatch(
		UserMessageComponent.prototype,
		"render",
		"user-message-render",
		({ predecessor, receiver, args }) => {
			const width = args[0];
			if (typeof width !== "number" || width < MIN_WIDTH) {
				return Reflect.apply(predecessor, receiver, args);
			}
			const config = getConfig();
			const rail = railFor(config);
			const inner = Reflect.apply(predecessor, receiver, [width - rail.columns, ...args.slice(1)]);
			if (!Array.isArray(inner) || inner.length === 0) return inner;

			const lines = inner as string[];
			const colorMode = getColorMode();
			const theme = getTheme();
			const source = config.colorSources.userMessages;
			const styledRail = !rail.text || colorMode === "none" ? rail.text : renderStyleForSourceOrFallback(
				theme, source, config.colors.editorAccent, EDITOR_ACCENT_FALLBACK, rail.text,
			);
			const borderText = "─".repeat(width);
			const border = colorMode === "none" ? borderText
				: config.colors.editorBorder === SAKURA_MACARON_GRADIENT
					? renderSakuraFrameGradient(borderText)
					: renderStyleForSourceOrFallback(
							theme, source, config.colors.editorBorder, EDITOR_BORDER_FALLBACK, borderText,
						);
			const chromeKey = `${styledRail}\0${border}`;
			const cached = cards.get(receiver as object);
			if (
				cached &&
				cached.width === width &&
				cached.chromeKey === chromeKey &&
				sameLines(cached.inner, lines)
			) {
				return cached.lines;
			}
			const card = renderUserMessageCard(lines, styledRail, border);
			cards.set(receiver as object, { width, chromeKey, inner: lines, lines: card });
			return card;
		},
	);
}
