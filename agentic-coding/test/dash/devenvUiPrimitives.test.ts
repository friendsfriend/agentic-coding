import { expect, test } from "bun:test";
import { colors as devenvColors } from "../../packages/devenv/ui/src/colors";
import {
	AnimatedStatusText as DevenvAnimatedStatusText,
	statusAnimationModel as devenvStatusAnimationModel,
} from "../../packages/devenv/ui/src/components/AnimatedStatusText";
import {
	auroraColor as devenvAuroraColor,
	createAuroraPalette as devenvCreateAuroraPalette,
	createTonePalette as devenvCreateTonePalette,
	DEFAULT_ANIMATION_HIGHLIGHTS as devenvDefaultAnimationHighlights,
} from "../../packages/devenv/ui/src/components/animationColors";
import { Badge as DevenvBadge } from "../../packages/devenv/ui/src/components/Badge";
import { CenteredState as DevenvCenteredState } from "../../packages/devenv/ui/src/components/CenteredState";
import {
	ContentPanel as DevenvContentPanel,
	GridLayout as DevenvGridLayout,
} from "../../packages/devenv/ui/src/components/ContentStack";
import { FilterStatusBar as DevenvFilterStatusBar } from "../../packages/devenv/ui/src/components/FilterStatusBar";
import { HelpText as DevenvHelpText } from "../../packages/devenv/ui/src/components/HelpText";
import { HighlightedText as DevenvHighlightedText } from "../../packages/devenv/ui/src/components/Highlight";
import {
	InlineProgressAnimation as DevenvInlineProgressAnimation,
	DEFAULT_INLINE_PROGRESS_HIGHLIGHTS as devenvDefaultInlineProgressHighlights,
} from "../../packages/devenv/ui/src/components/InlineProgressAnimation";
import { LogView as DevenvLogView } from "../../packages/devenv/ui/src/components/LogView";
import { MatchedText as DevenvMatchedText } from "../../packages/devenv/ui/src/components/MatchedText";
import { ScrollableContent as DevenvScrollableContent } from "../../packages/devenv/ui/src/components/ScrollableContent";
import { ScrollableList as DevenvScrollableList } from "../../packages/devenv/ui/src/components/ScrollableList";
import { SearchHeader as DevenvSearchHeader } from "../../packages/devenv/ui/src/components/SearchHeader";
import { getMarkdownSyntaxStyle as devenvGetMarkdownSyntaxStyle } from "../../packages/devenv/ui/src/markdownSyntax";
import {
	invokeGlobalSelectionMouseUpHandler as devenvInvokeSelectionMouseUpHandler,
	setGlobalSelectionMouseUpHandler as devenvSetSelectionMouseUpHandler,
} from "../../packages/devenv/ui/src/selectionCopy";
import {
	getActiveThemeName as devenvGetActiveThemeName,
	setActiveThemeName as devenvSetActiveThemeName,
	themeColor as devenvThemeColor,
} from "../../packages/devenv/ui/src/theme";
import { focusSoon as devenvFocusSoon } from "../../packages/devenv/ui/src/utils/focusSoon";
import { calculateVisibleItems as devenvCalculateVisibleItems } from "../../packages/devenv/ui/src/utils/virtualScroll";
import { parseMarkdownBlocks as dashParseMarkdownBlocks } from "../../src/tui/dash/devenv-ui/markdownBlocks";
import {
	AnimatedStatusText as SharedAnimatedStatusText,
	statusAnimationModel as sharedStatusAnimationModel,
} from "../../src/tui/shared/AnimatedStatusText";
import {
	auroraColor as sharedAuroraColor,
	createAuroraPalette as sharedCreateAuroraPalette,
	createTonePalette as sharedCreateTonePalette,
	DEFAULT_ANIMATION_HIGHLIGHTS as sharedDefaultAnimationHighlights,
} from "../../src/tui/shared/animationColors";
import { Badge as SharedBadge } from "../../src/tui/shared/Badge";
import { CenteredState as SharedCenteredState } from "../../src/tui/shared/CenteredState";
import {
	ContentPanel as SharedContentPanel,
	GridLayout as SharedGridLayout,
} from "../../src/tui/shared/ContentStack";
import { colors as sharedColors } from "../../src/tui/shared/colors";
import { FilterStatusBar as SharedFilterStatusBar } from "../../src/tui/shared/FilterStatusBar";
import { HelpText as SharedHelpText } from "../../src/tui/shared/HelpText";
import { HighlightedText as SharedHighlightedText } from "../../src/tui/shared/Highlight";
import {
	InlineProgressAnimation as SharedInlineProgressAnimation,
	DEFAULT_INLINE_PROGRESS_HIGHLIGHTS as sharedDefaultInlineProgressHighlights,
} from "../../src/tui/shared/InlineProgressAnimation";
import { LogView as SharedLogView } from "../../src/tui/shared/LogView";
import { MatchedText as SharedMatchedText } from "../../src/tui/shared/MatchedText";
import { parseMarkdownBlocks as sharedParseMarkdownBlocks } from "../../src/tui/shared/markdownBlocks";
import { getMarkdownSyntaxStyle as sharedGetMarkdownSyntaxStyle } from "../../src/tui/shared/markdownSyntax";
import { ScrollableContent as SharedScrollableContent } from "../../src/tui/shared/ScrollableContent";
import { ScrollableList as SharedScrollableList } from "../../src/tui/shared/ScrollableList";
import { SearchHeader as SharedSearchHeader } from "../../src/tui/shared/SearchHeader";
import {
	invokeGlobalSelectionMouseUpHandler as sharedInvokeSelectionMouseUpHandler,
	setGlobalSelectionMouseUpHandler as sharedSetSelectionMouseUpHandler,
} from "../../src/tui/shared/selectionCopy";
import {
	getActiveThemeName as sharedGetActiveThemeName,
	setActiveThemeName as sharedSetActiveThemeName,
	themeColor as sharedThemeColor,
} from "../../src/tui/shared/theme";
import { focusSoon as sharedFocusSoon } from "../../src/tui/shared/utils/focusSoon";
import { calculateVisibleItems as sharedCalculateVisibleItems } from "../../src/tui/shared/utils/virtualScroll";

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
