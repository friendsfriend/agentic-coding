import { expect, test } from "bun:test";
import {
	AnimatedStatusText as SharedAnimatedStatusText,
	Badge as SharedBadge,
	CenteredState as SharedCenteredState,
	ContentPanel as SharedContentPanel,
	FilterStatusBar as SharedFilterStatusBar,
	GridLayout as SharedGridLayout,
	HelpText as SharedHelpText,
	HighlightedText as SharedHighlightedText,
	InlineProgressAnimation as SharedInlineProgressAnimation,
	LogView as SharedLogView,
	MatchedText as SharedMatchedText,
	ScrollableContent as SharedScrollableContent,
	ScrollableList as SharedScrollableList,
	SearchHeader as SharedSearchHeader,
	auroraColor as sharedAuroraColor,
	backdropDismiss as sharedBackdropDismiss,
	calculateVisibleItems as sharedCalculateVisibleItems,
	classifyPointerGesture as sharedClassifyPointerGesture,
	colors as sharedColors,
	createAuroraPalette as sharedCreateAuroraPalette,
	createTonePalette as sharedCreateTonePalette,
	DEFAULT_ANIMATION_HIGHLIGHTS as sharedDefaultAnimationHighlights,
	DEFAULT_INLINE_PROGRESS_HIGHLIGHTS as sharedDefaultInlineProgressHighlights,
	focusSoon as sharedFocusSoon,
	getActiveThemeName as sharedGetActiveThemeName,
	getMarkdownSyntaxStyle as sharedGetMarkdownSyntaxStyle,
	invokeGlobalSelectionMouseUpHandler as sharedInvokeSelectionMouseUpHandler,
	isPrimaryPointerButton as sharedIsPrimaryPointerButton,
	keybindChipRunnable as sharedKeybindChipRunnable,
	moveRowIndex as sharedMoveRowIndex,
	parseChipKey as sharedParseChipKey,
	parseMarkdownBlocks as sharedParseMarkdownBlocks,
	resolveRowInteraction as sharedResolveRowInteraction,
	setActiveThemeName as sharedSetActiveThemeName,
	setGlobalSelectionMouseUpHandler as sharedSetSelectionMouseUpHandler,
	statusAnimationModel as sharedStatusAnimationModel,
	themeColor as sharedThemeColor,
	useRowMouse as sharedUseRowMouse,
	useTap as sharedUseTap,
	useWheelScroll as sharedUseWheelScroll,
} from "@agentic-coding/ui";
import {
	backdropDismiss,
	classifyPointerGesture,
	AnimatedStatusText as DevenvAnimatedStatusText,
	Badge as DevenvBadge,
	CenteredState as DevenvCenteredState,
	ContentPanel as DevenvContentPanel,
	FilterStatusBar as DevenvFilterStatusBar,
	GridLayout as DevenvGridLayout,
	HelpText as DevenvHelpText,
	HighlightedText as DevenvHighlightedText,
	InlineProgressAnimation as DevenvInlineProgressAnimation,
	LogView as DevenvLogView,
	MatchedText as DevenvMatchedText,
	ScrollableContent as DevenvScrollableContent,
	ScrollableList as DevenvScrollableList,
	SearchHeader as DevenvSearchHeader,
	parseMarkdownBlocks as dashParseMarkdownBlocks,
	auroraColor as devenvAuroraColor,
	calculateVisibleItems as devenvCalculateVisibleItems,
	colors as devenvColors,
	createAuroraPalette as devenvCreateAuroraPalette,
	createTonePalette as devenvCreateTonePalette,
	DEFAULT_ANIMATION_HIGHLIGHTS as devenvDefaultAnimationHighlights,
	DEFAULT_INLINE_PROGRESS_HIGHLIGHTS as devenvDefaultInlineProgressHighlights,
	focusSoon as devenvFocusSoon,
	getActiveThemeName as devenvGetActiveThemeName,
	getMarkdownSyntaxStyle as devenvGetMarkdownSyntaxStyle,
	invokeGlobalSelectionMouseUpHandler as devenvInvokeSelectionMouseUpHandler,
	setActiveThemeName as devenvSetActiveThemeName,
	setGlobalSelectionMouseUpHandler as devenvSetSelectionMouseUpHandler,
	statusAnimationModel as devenvStatusAnimationModel,
	themeColor as devenvThemeColor,
	isPrimaryPointerButton,
	keybindChipRunnable,
	moveRowIndex,
	parseChipKey,
	resolveRowInteraction,
	useRowMouse,
	useTap,
	useWheelScroll,
} from "../../packages/devenv/cli/src/tui/ui";

// Each environment (devenv) primitive entry point must be the same function
// object as the shared implementation — a re-export, not a second copy. This
// is the module-identity half of the consolidation parity; the renderer
// behavior is exercised by sharedPrimitives.test.tsx and the package tests.
// Every re-exported function/const the environment package claims to share is
// listed so reintroducing a duplicate in the package fails here.
test("environment primitive entry points are the shared implementations", () => {
	const identities: Array<[unknown, unknown]> = [
		[DevenvHighlightedText, SharedHighlightedText],
		[DevenvMatchedText, SharedMatchedText],
		[DevenvCenteredState, SharedCenteredState],
		[DevenvScrollableContent, SharedScrollableContent],
		[DevenvScrollableList, SharedScrollableList],
		[DevenvSearchHeader, SharedSearchHeader],
		[DevenvFilterStatusBar, SharedFilterStatusBar],
		[DevenvHelpText, SharedHelpText],
		[DevenvBadge, SharedBadge],
		[DevenvContentPanel, SharedContentPanel],
		[DevenvGridLayout, SharedGridLayout],
		[DevenvAnimatedStatusText, SharedAnimatedStatusText],
		[devenvStatusAnimationModel, sharedStatusAnimationModel],
		[DevenvInlineProgressAnimation, SharedInlineProgressAnimation],
		[
			devenvDefaultInlineProgressHighlights,
			sharedDefaultInlineProgressHighlights,
		],
		[devenvCreateAuroraPalette, sharedCreateAuroraPalette],
		[devenvCreateTonePalette, sharedCreateTonePalette],
		[devenvAuroraColor, sharedAuroraColor],
		[devenvDefaultAnimationHighlights, sharedDefaultAnimationHighlights],
		[devenvCalculateVisibleItems, sharedCalculateVisibleItems],
		[devenvFocusSoon, sharedFocusSoon],
		[devenvSetSelectionMouseUpHandler, sharedSetSelectionMouseUpHandler],
		[devenvInvokeSelectionMouseUpHandler, sharedInvokeSelectionMouseUpHandler],
		[devenvColors, sharedColors],
		[devenvThemeColor, sharedThemeColor],
		[DevenvLogView, SharedLogView],
		[devenvGetMarkdownSyntaxStyle, sharedGetMarkdownSyntaxStyle],
		[dashParseMarkdownBlocks, sharedParseMarkdownBlocks],
		// The shared mouse layer is one implementation for every family: the same
		// function objects, never a per-surface copy of the tap or wheel rule.
		[classifyPointerGesture, sharedClassifyPointerGesture],
		[resolveRowInteraction, sharedResolveRowInteraction],
		[isPrimaryPointerButton, sharedIsPrimaryPointerButton],
		[moveRowIndex, sharedMoveRowIndex],
		[backdropDismiss, sharedBackdropDismiss],
		[keybindChipRunnable, sharedKeybindChipRunnable],
		[parseChipKey, sharedParseChipKey],
		[useRowMouse, sharedUseRowMouse],
		[useTap, sharedUseTap],
		[useWheelScroll, sharedUseWheelScroll],
	];
	for (const [environment, shared] of identities)
		expect(environment).toBe(shared);
});

test("one theme store is shared across workflow and environment surfaces", () => {
	expect(devenvSetActiveThemeName).toBe(sharedSetActiveThemeName);
	expect(devenvGetActiveThemeName).toBe(sharedGetActiveThemeName);
	expect(devenvSetActiveThemeName("nord")).toBe(true);
	expect(sharedGetActiveThemeName()).toBe("nord");
	expect(devenvGetActiveThemeName()).toBe("nord");
	sharedSetActiveThemeName("catppuccin");
	expect(devenvGetActiveThemeName()).toBe("catppuccin");
});
