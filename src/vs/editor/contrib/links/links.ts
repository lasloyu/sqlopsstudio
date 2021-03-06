/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the Source EULA. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import 'vs/css!./links';
import * as nls from 'vs/nls';
import { onUnexpectedError } from 'vs/base/common/errors';
import * as platform from 'vs/base/common/platform';
import { TPromise } from 'vs/base/common/winjs.base';
import { IOpenerService } from 'vs/platform/opener/common/opener';
import * as editorCommon from 'vs/editor/common/editorCommon';
import { registerEditorAction, registerEditorContribution, ServicesAccessor, EditorAction } from 'vs/editor/browser/editorExtensions';
import { LinkProviderRegistry } from 'vs/editor/common/modes';
import { ICodeEditor, MouseTargetType } from 'vs/editor/browser/editorBrowser';
import { getLinks, Link } from 'vs/editor/contrib/links/getLinks';
import { IDisposable, dispose } from 'vs/base/common/lifecycle';
import { registerThemingParticipant } from 'vs/platform/theme/common/themeService';
import { editorActiveLinkForeground } from 'vs/platform/theme/common/colorRegistry';
import { Position } from 'vs/editor/common/core/position';
import { ModelDecorationOptions } from 'vs/editor/common/model/textModel';
import { ClickLinkGesture, ClickLinkMouseEvent, ClickLinkKeyboardEvent } from 'vs/editor/contrib/goToDeclaration/clickLinkGesture';
import { MarkdownString } from 'vs/base/common/htmlContent';
import { TrackedRangeStickiness, IModelDeltaDecoration, IModelDecorationsChangeAccessor } from 'vs/editor/common/model';
import { INotificationService } from 'vs/platform/notification/common/notification';

const HOVER_MESSAGE_GENERAL_META = new MarkdownString().appendText(
	platform.isMacintosh
		? nls.localize('links.navigate.mac', "Cmd + click to follow link")
		: nls.localize('links.navigate', "Ctrl + click to follow link")
);

const HOVER_MESSAGE_COMMAND_META = new MarkdownString().appendText(
	platform.isMacintosh
		? nls.localize('links.command.mac', "Cmd + click to execute command")
		: nls.localize('links.command', "Ctrl + click to execute command")
);

const HOVER_MESSAGE_GENERAL_ALT = new MarkdownString().appendText(
	platform.isMacintosh
		? nls.localize('links.navigate.al.mac', "Option + click to follow link")
		: nls.localize('links.navigate.al', "Alt + click to follow link")
);

const HOVER_MESSAGE_COMMAND_ALT = new MarkdownString().appendText(
	platform.isMacintosh
		? nls.localize('links.command.al.mac', "Option + click to execute command")
		: nls.localize('links.command.al', "Alt + click to execute command")
);

const decoration = {
	meta: ModelDecorationOptions.register({
		stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
		inlineClassName: 'detected-link',
		hoverMessage: HOVER_MESSAGE_GENERAL_META
	}),
	metaActive: ModelDecorationOptions.register({
		stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
		inlineClassName: 'detected-link-active',
		hoverMessage: HOVER_MESSAGE_GENERAL_META
	}),
	alt: ModelDecorationOptions.register({
		stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
		inlineClassName: 'detected-link',
		hoverMessage: HOVER_MESSAGE_GENERAL_ALT
	}),
	altActive: ModelDecorationOptions.register({
		stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
		inlineClassName: 'detected-link-active',
		hoverMessage: HOVER_MESSAGE_GENERAL_ALT
	}),
	altCommand: ModelDecorationOptions.register({
		stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
		inlineClassName: 'detected-link',
		hoverMessage: HOVER_MESSAGE_COMMAND_ALT
	}),
	altCommandActive: ModelDecorationOptions.register({
		stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
		inlineClassName: 'detected-link-active',
		hoverMessage: HOVER_MESSAGE_COMMAND_ALT
	}),
	metaCommand: ModelDecorationOptions.register({
		stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
		inlineClassName: 'detected-link',
		hoverMessage: HOVER_MESSAGE_COMMAND_META
	}),
	metaCommandActive: ModelDecorationOptions.register({
		stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
		inlineClassName: 'detected-link-active',
		hoverMessage: HOVER_MESSAGE_COMMAND_META
	}),
};


class LinkOccurrence {

	public static decoration(link: Link, useMetaKey: boolean): IModelDeltaDecoration {
		return {
			range: link.range,
			options: LinkOccurrence._getOptions(link, useMetaKey, false)
		};
	}

	private static _getOptions(link: Link, useMetaKey: boolean, isActive: boolean): ModelDecorationOptions {
		if (/^command:/i.test(link.url)) {
			if (useMetaKey) {
				return (isActive ? decoration.metaCommandActive : decoration.metaCommand);
			} else {
				return (isActive ? decoration.altCommandActive : decoration.altCommand);
			}
		} else {
			if (useMetaKey) {
				return (isActive ? decoration.metaActive : decoration.meta);
			} else {
				return (isActive ? decoration.altActive : decoration.alt);
			}
		}
	}

	public decorationId: string;
	public link: Link;

	constructor(link: Link, decorationId: string) {
		this.link = link;
		this.decorationId = decorationId;
	}

	public activate(changeAccessor: IModelDecorationsChangeAccessor, useMetaKey: boolean): void {
		changeAccessor.changeDecorationOptions(this.decorationId, LinkOccurrence._getOptions(this.link, useMetaKey, true));
	}

	public deactivate(changeAccessor: IModelDecorationsChangeAccessor, useMetaKey: boolean): void {
		changeAccessor.changeDecorationOptions(this.decorationId, LinkOccurrence._getOptions(this.link, useMetaKey, false));
	}
}

class LinkDetector implements editorCommon.IEditorContribution {

	private static readonly ID: string = 'editor.linkDetector';

	public static get(editor: ICodeEditor): LinkDetector {
		return editor.getContribution<LinkDetector>(LinkDetector.ID);
	}

	static RECOMPUTE_TIME = 1000; // ms

	private editor: ICodeEditor;
	private enabled: boolean;
	private listenersToRemove: IDisposable[];
	private timeoutPromise: TPromise<void>;
	private computePromise: TPromise<void>;
	private activeLinkDecorationId: string;
	private openerService: IOpenerService;
	private notificationService: INotificationService;
	private currentOccurrences: { [decorationId: string]: LinkOccurrence; };

	constructor(
		editor: ICodeEditor,
		@IOpenerService openerService: IOpenerService,
		@INotificationService notificationService: INotificationService
	) {
		this.editor = editor;
		this.openerService = openerService;
		this.notificationService = notificationService;
		this.listenersToRemove = [];

		let clickLinkGesture = new ClickLinkGesture(editor);
		this.listenersToRemove.push(clickLinkGesture);
		this.listenersToRemove.push(clickLinkGesture.onMouseMoveOrRelevantKeyDown(([mouseEvent, keyboardEvent]) => {
			this._onEditorMouseMove(mouseEvent, keyboardEvent);
		}));
		this.listenersToRemove.push(clickLinkGesture.onExecute((e) => {
			this.onEditorMouseUp(e);
		}));
		this.listenersToRemove.push(clickLinkGesture.onCancel((e) => {
			this.cleanUpActiveLinkDecoration();
		}));

		this.enabled = editor.getConfiguration().contribInfo.links;
		this.listenersToRemove.push(editor.onDidChangeConfiguration((e) => {
			let enabled = editor.getConfiguration().contribInfo.links;
			if (this.enabled === enabled) {
				// No change in our configuration option
				return;
			}
			this.enabled = enabled;

			// Remove any links (for the getting disabled case)
			this.updateDecorations([]);

			// Stop any computation (for the getting disabled case)
			this.stop();

			// Start computing (for the getting enabled case)
			this.beginCompute();
		}));
		this.listenersToRemove.push(editor.onDidChangeModelContent((e) => this.onChange()));
		this.listenersToRemove.push(editor.onDidChangeModel((e) => this.onModelChanged()));
		this.listenersToRemove.push(editor.onDidChangeModelLanguage((e) => this.onModelModeChanged()));
		this.listenersToRemove.push(LinkProviderRegistry.onDidChange((e) => this.onModelModeChanged()));

		this.timeoutPromise = null;
		this.computePromise = null;
		this.currentOccurrences = {};
		this.activeLinkDecorationId = null;
		this.beginCompute();
	}

	public getId(): string {
		return LinkDetector.ID;
	}

	private onModelChanged(): void {
		this.currentOccurrences = {};
		this.activeLinkDecorationId = null;
		this.stop();
		this.beginCompute();
	}

	private onModelModeChanged(): void {
		this.stop();
		this.beginCompute();
	}

	private onChange(): void {
		if (!this.timeoutPromise) {
			this.timeoutPromise = TPromise.timeout(LinkDetector.RECOMPUTE_TIME);
			this.timeoutPromise.then(() => {
				this.timeoutPromise = null;
				this.beginCompute();
			});
		}
	}

	private beginCompute(): void {
		if (!this.editor.getModel() || !this.enabled) {
			return;
		}

		if (!LinkProviderRegistry.has(this.editor.getModel())) {
			return;
		}

		this.computePromise = getLinks(this.editor.getModel()).then(links => {
			this.updateDecorations(links);
			this.computePromise = null;
		});
	}

	private updateDecorations(links: Link[]): void {
		const useMetaKey = (this.editor.getConfiguration().multiCursorModifier === 'altKey');
		let oldDecorations: string[] = [];
		let keys = Object.keys(this.currentOccurrences);
		for (let i = 0, len = keys.length; i < len; i++) {
			let decorationId = keys[i];
			let occurance = this.currentOccurrences[decorationId];
			oldDecorations.push(occurance.decorationId);
		}

		let newDecorations: IModelDeltaDecoration[] = [];
		if (links) {
			// Not sure why this is sometimes null
			for (let i = 0; i < links.length; i++) {
				newDecorations.push(LinkOccurrence.decoration(links[i], useMetaKey));
			}
		}

		let decorations = this.editor.deltaDecorations(oldDecorations, newDecorations);

		this.currentOccurrences = {};
		this.activeLinkDecorationId = null;
		for (let i = 0, len = decorations.length; i < len; i++) {
			let occurance = new LinkOccurrence(links[i], decorations[i]);
			this.currentOccurrences[occurance.decorationId] = occurance;
		}
	}

	private _onEditorMouseMove(mouseEvent: ClickLinkMouseEvent, withKey?: ClickLinkKeyboardEvent): void {
		const useMetaKey = (this.editor.getConfiguration().multiCursorModifier === 'altKey');
		if (this.isEnabled(mouseEvent, withKey)) {
			this.cleanUpActiveLinkDecoration(); // always remove previous link decoration as their can only be one
			var occurrence = this.getLinkOccurrence(mouseEvent.target.position);
			if (occurrence) {
				this.editor.changeDecorations((changeAccessor) => {
					occurrence.activate(changeAccessor, useMetaKey);
					this.activeLinkDecorationId = occurrence.decorationId;
				});
			}
		} else {
			this.cleanUpActiveLinkDecoration();
		}
	}

	private cleanUpActiveLinkDecoration(): void {
		const useMetaKey = (this.editor.getConfiguration().multiCursorModifier === 'altKey');
		if (this.activeLinkDecorationId) {
			var occurrence = this.currentOccurrences[this.activeLinkDecorationId];
			if (occurrence) {
				this.editor.changeDecorations((changeAccessor) => {
					occurrence.deactivate(changeAccessor, useMetaKey);
				});
			}

			this.activeLinkDecorationId = null;
		}
	}

	private onEditorMouseUp(mouseEvent: ClickLinkMouseEvent): void {
		if (!this.isEnabled(mouseEvent)) {
			return;
		}
		var occurrence = this.getLinkOccurrence(mouseEvent.target.position);
		if (!occurrence) {
			return;
		}
		this.openLinkOccurrence(occurrence, mouseEvent.hasSideBySideModifier);
	}

	public openLinkOccurrence(occurrence: LinkOccurrence, openToSide: boolean): void {

		if (!this.openerService) {
			return;
		}

		const { link } = occurrence;

		link.resolve().then(uri => {
			// open the uri
			return this.openerService.open(uri, { openToSide });

		}, err => {
			// different error cases
			if (err === 'invalid') {
				this.notificationService.warn(nls.localize('invalid.url', 'Failed to open this link because it is not well-formed: {0}', link.url));
			} else if (err === 'missing') {
				this.notificationService.warn(nls.localize('missing.url', 'Failed to open this link because its target is missing.'));
			} else {
				onUnexpectedError(err);
			}
		}).done(null, onUnexpectedError);
	}

	public getLinkOccurrence(position: Position): LinkOccurrence {
		var decorations = this.editor.getModel().getDecorationsInRange({
			startLineNumber: position.lineNumber,
			startColumn: position.column,
			endLineNumber: position.lineNumber,
			endColumn: position.column
		}, 0, true);

		for (var i = 0; i < decorations.length; i++) {
			var decoration = decorations[i];
			var currentOccurrence = this.currentOccurrences[decoration.id];
			if (currentOccurrence) {
				return currentOccurrence;
			}
		}

		return null;
	}

	private isEnabled(mouseEvent: ClickLinkMouseEvent, withKey?: ClickLinkKeyboardEvent): boolean {
		return (
			mouseEvent.target.type === MouseTargetType.CONTENT_TEXT
			&& (mouseEvent.hasTriggerModifier || (withKey && withKey.keyCodeIsTriggerKey))
		);
	}

	private stop(): void {
		if (this.timeoutPromise) {
			this.timeoutPromise.cancel();
			this.timeoutPromise = null;
		}
		if (this.computePromise) {
			this.computePromise.cancel();
			this.computePromise = null;
		}
	}

	public dispose(): void {
		this.listenersToRemove = dispose(this.listenersToRemove);
		this.stop();
	}
}

class OpenLinkAction extends EditorAction {

	constructor() {
		super({
			id: 'editor.action.openLink',
			label: nls.localize('label', "Open Link"),
			alias: 'Open Link',
			precondition: null
		});
	}

	public run(accessor: ServicesAccessor, editor: ICodeEditor): void {
		let linkDetector = LinkDetector.get(editor);
		if (!linkDetector) {
			return;
		}

		let selections = editor.getSelections();

		for (let sel of selections) {
			let link = linkDetector.getLinkOccurrence(sel.getEndPosition());

			if (link) {
				linkDetector.openLinkOccurrence(link, false);
			}
		}
	}
}

registerEditorContribution(LinkDetector);
registerEditorAction(OpenLinkAction);

registerThemingParticipant((theme, collector) => {
	let activeLinkForeground = theme.getColor(editorActiveLinkForeground);
	if (activeLinkForeground) {
		collector.addRule(`.monaco-editor .detected-link-active { color: ${activeLinkForeground} !important; }`);
	}
});
