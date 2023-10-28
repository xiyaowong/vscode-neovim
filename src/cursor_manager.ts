import { debounce, DebouncedFunc } from "lodash-es";
import {
    commands,
    Disposable,
    Position,
    Selection,
    TextEditor,
    TextEditorCursorStyle,
    TextEditorRevealType,
    TextEditorSelectionChangeEvent,
    TextEditorSelectionChangeKind,
    window,
    workspace,
} from "vscode";

import { config } from "./config";
import { eventBus, EventBusData } from "./eventBus";
import { createLogger } from "./logger";
import { MainController } from "./main_controller";
import { Mode } from "./mode_manager";
import {
    convertEditorPositionToVimPosition,
    convertVimPositionToEditorPosition,
    disposeAll,
    ManualPromise,
} from "./utils";

const logger = createLogger("CursorManager");

interface CursorInfo {
    cursorShape: "block" | "horizontal" | "vertical";
}

export class CursorManager implements Disposable {
    private disposables: Disposable[] = [];
    /**
     * Vim cursor mode mappings
     */
    private cursorModes: Map<string, CursorInfo> = new Map();
    /**
     * Cursor positions per editor in neovim
     * ! Note: we should track this because setting cursor as consequence of neovim event will trigger onDidChangeTextEditorSelection with Command kind
     * ! And we should skip it and don't try to send cursor update into neovim again, otherwise few things may break, especially jumplist
     */
    private neovimCursorPosition: WeakMap<TextEditor, Selection> = new WeakMap();
    /**
     * Pending cursor update promise.
     * This promise is used by typing_manager to know when to unbind type handler.
     */
    private cursorUpdatePromise: Map<TextEditor, ManualPromise> = new Map();
    /**
     * Pending apply selection changed promise.
     * This promise is used by typing_manager to know when to unbind type handler.
     */
    private applySelectionChangedPromise: Map<TextEditor, ManualPromise> = new Map();
    /**
     * In insert mode, cursor updates can be sent due to document changes. We should ignore them to
     * avoid interfering with vscode typing. However, they are important for various actions, such as
     * cursor updates while entering insert mode and insert mode commands. Thus, when those events occur,
     * this flag is used to disable ignoring the update. This is set to true when entering insert
     * mode or running insert mode command, and set to false before document updates in insert mode.
     */
    public wantInsertCursorUpdate = true;
    /**
     * Set of grid that needs to undergo cursor update
     */
    private gridCursorUpdates: Set<number> = new Set();

    private debouncedCursorUpdates: WeakMap<TextEditor, DebouncedFunc<CursorManager["updateCursorPosInEditor"]>> =
        new WeakMap();

    // Different change kinds use different debounce times
    private debouncedApplySelectionChanged: Map<number, DebouncedFunc<CursorManager["applySelectionChanged"]>> =
        new Map();
    // A flag indicates that func still pending.
    private previousApplyDebounceTime: number | undefined;

    private get client() {
        return this.main.client;
    }

    public constructor(private main: MainController) {
        const updateCursorStyle = () => {
            this.updateCursorStyle();
            // Sometimes the cursor is reset to the default style.
            // Currently, can reproduce this issue when jumping between cells in Notebook.
            setTimeout(() => this.updateCursorStyle(), 100);
        };
        this.disposables.push(
            window.onDidChangeTextEditorSelection(this.onSelectionChanged),
            window.onDidChangeVisibleTextEditors(updateCursorStyle),
            window.onDidChangeActiveTextEditor(updateCursorStyle),
            eventBus.on("redraw", this.handleRedraw, this),
            eventBus.on(["window-scrolled", "visual-changed"], ([winId]) => {
                const gridId = this.main.bufferManager.getGridIdForWinId(winId);
                if (gridId) this.gridCursorUpdates.add(gridId);
            }),
            eventBus.on("range-command", this.handleRangeCommand, this),
            {
                dispose() {
                    // reset cursor style
                    const styleName = workspace
                        .getConfiguration("editor")
                        .get("cursorStyle", "line")
                        .split("-")
                        .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
                        .join("");
                    const style = TextEditorCursorStyle[styleName as any] as any as TextEditorCursorStyle;
                    window.visibleTextEditors.forEach((e) => (e.options.cursorStyle = style));
                },
            },
        );
    }

    private handleRedraw(data: EventBusData<"redraw">): void {
        for (const { name, args } of data) {
            switch (name) {
                case "grid_cursor_goto": {
                    args.forEach((arg) => this.gridCursorUpdates.add(arg[0]));
                    break;
                }
                // nvim may not send grid_cursor_goto and instead uses grid_scroll along with grid_line
                // If we received it we must shift current cursor position by given rows
                case "grid_scroll": {
                    args.forEach((arg) => this.gridCursorUpdates.add(arg[0]));
                    break;
                }
                case "mode_info_set": {
                    args.forEach((arg) =>
                        arg[1].forEach((mode) => {
                            if (mode.name && mode.cursor_shape) {
                                this.cursorModes.set(mode.name, { cursorShape: mode.cursor_shape });
                            }
                        }),
                    );
                    break;
                }
                case "mode_change": {
                    if (this.main.modeManager.isInsertMode) this.wantInsertCursorUpdate = true;
                    args.forEach((arg) => this.updateCursorStyle(arg[0]));
                    break;
                }
            }
        }
        this.processCursorMoved();
    }

    public async waitForCursorUpdate(editor: TextEditor): Promise<unknown> {
        return Promise.all([
            Promise.resolve(this.cursorUpdatePromise.get(editor)?.promise),
            Promise.resolve(this.applySelectionChangedPromise.get(editor)?.promise),
        ]);
    }

    private updateCursorStyle(modeName: string = this.main.modeManager.currentMode.name): void {
        const modeConf = this.cursorModes.get(modeName);
        if (!modeConf) {
            return;
        }
        let style: TextEditorCursorStyle;
        if (modeName == "visual") {
            // in visual mode, we try to hide the cursor because we only use it for selections
            style = TextEditorCursorStyle.LineThin;
        } else if (modeConf.cursorShape === "block") {
            style = TextEditorCursorStyle.Block;
        } else if (modeConf.cursorShape === "horizontal") {
            style = TextEditorCursorStyle.Underline;
        } else {
            style = TextEditorCursorStyle.Line;
        }
        for (const editor of window.visibleTextEditors) {
            editor.options.cursorStyle = style;
        }
    }

    /**
     * Called when cursor update received. Waits for document changes to complete and then updates cursor position in editor.
     */
    private processCursorMoved(): void {
        for (const gridId of this.gridCursorUpdates) {
            logger.debug(`Received cursor update from neovim, gridId: ${gridId}`);
            const editor = this.main.bufferManager.getEditorFromGridId(gridId);
            if (!editor) {
                logger.warn(`No editor for gridId: ${gridId}`);
                continue;
            }
            // lock typing in editor until cursor update is complete
            if (!this.cursorUpdatePromise.has(editor)) this.cursorUpdatePromise.set(editor, new ManualPromise());
            this.getDebouncedUpdateCursorPos(editor)(editor, gridId);
        }
        this.gridCursorUpdates.clear();
    }

    // !Often, especially with complex multi-command operations, neovim sends multiple cursor updates in multiple batches
    // !To not mess the cursor, try to debounce the update
    private getDebouncedUpdateCursorPos = (
        editor: TextEditor,
    ): DebouncedFunc<CursorManager["updateCursorPosInEditor"]> => {
        const existing = this.debouncedCursorUpdates.get(editor);
        if (existing) return existing;
        const func = debounce(this.updateCursorPosInEditor, 5, { leading: false, trailing: true, maxWait: 10 });
        this.debouncedCursorUpdates.set(editor, func);
        return func;
    };

    /**
     * Update cursor in active editor. Creates visual selections if appropriate.
     */
    public updateCursorPosInEditor = async (editor: TextEditor, gridId: number): Promise<void> => {
        // !For text changes neovim sends first buf_lines_event followed by redraw event
        // !But since changes are asynchronous and will happen after redraw event we need to wait for them first
        logger.debug(`Waiting for document change completion before setting the editor cursor`);
        await this.main.changeManager.getDocumentChangeCompletionLock(editor.document);

        if (
            this.main.modeManager.isInsertMode &&
            !this.wantInsertCursorUpdate &&
            !this.main.modeManager.isRecordingInInsertMode
        ) {
            logger.debug(`Skipping insert cursor update in editor`);
            this.cursorUpdatePromise.get(editor)?.resolve();
            this.cursorUpdatePromise.delete(editor);
            return;
        }

        const bytePos = this.main.viewportManager.getCursorFromViewport(gridId);
        if (!bytePos) {
            logger.warn(`No cursor for gridId from viewport: ${gridId}`);
            return;
        }
        const active = convertVimPositionToEditorPosition(editor, bytePos);

        let selections: Selection[];
        const mode = this.main.modeManager.currentMode;
        if (mode.isVisual) {
            selections = await this.createVisualSelection(editor, mode, active, undefined);
        } else {
            logger.debug(`Updating cursor in editor pos: [${active.line}, ${active.character}]`);
            selections = [new Selection(active, active)];
        }
        const { selections: prevSelections } = editor;
        if (
            // Avoid unnecessary selections updates, or it will disrupt cursor movement related features in vscode
            selections.length !== prevSelections.length ||
            selections.some(
                (s, idx) =>
                    !(s.active.isEqual(prevSelections[idx].active) && s.anchor.isEqual(prevSelections[idx].anchor)),
            )
        ) {
            editor.selections = selections;
        }
        this.neovimCursorPosition.set(editor, selections[0]);
        if (!selections[0].isEqual(prevSelections[0])) {
            commands.executeCommand("editor.action.wordHighlight.trigger");
        }

        this.cursorUpdatePromise.get(editor)?.resolve();
        this.cursorUpdatePromise.delete(editor);
    };

    private onSelectionChanged = (e: TextEditorSelectionChangeEvent): void => {
        if (this.main.modeManager.isInsertMode) return;

        const { textEditor, kind } = e;
        // ! Note: Unfortunately navigating from outline is Command kind, so we can't skip it :(
        logger.debug(
            `onSelectionChanged, kind: ${kind}, editor: ${textEditor.document.uri.fsPath}, active: [${textEditor.selection.active.line}, ${textEditor.selection.active.character}]`,
        );

        // when dragging mouse, pre-emptively hide cursor to not clash with fake cursor
        if (kind === TextEditorSelectionChangeKind.Mouse && !textEditor.selection.isEmpty) {
            this.updateCursorStyle("visual");
        }

        // Why no wait when selection is empty?
        // 1. Waiting during cursor movement causes lag, especially in nvim with "cursorMove" command.
        // 2. Issues may arise only when selected region changes, needing visual selection sync in nvim.
        //    e.g. confusion from simultaneous insert mode entry and visual region sync due to simulated input.
        // Waiting theoretically necessary but can lead to other problems.
        // However, most things work fine without waiting before adding the mechanism.
        // Thus, no wait when selection is empty.
        if (!textEditor.selection.isEmpty && !this.applySelectionChangedPromise.has(textEditor))
            this.applySelectionChangedPromise.set(textEditor, new ManualPromise());
        this.getDebouncedApplySelectionChanged(kind)(textEditor, kind);
    };

    // ! Need to debounce requests because setting cursor by consequence of neovim event will trigger this method
    // ! and cursor may go out-of-sync and produce a jitter
    private getDebouncedApplySelectionChanged = (
        kind: TextEditorSelectionChangeKind | undefined,
    ): DebouncedFunc<CursorManager["applySelectionChanged"]> => {
        let debounceTime: number;
        // Should use same debounce time if previous debounced func still in progress
        // This avoid multiple cursor updates with different positions at the same time
        if (this.previousApplyDebounceTime !== undefined) {
            debounceTime = this.previousApplyDebounceTime;
        } else if (kind === TextEditorSelectionChangeKind.Mouse) {
            debounceTime = config.mouseSelectionDebounceTime;
        } else {
            debounceTime = config.normalSelectionDebounceTime;
        }
        this.previousApplyDebounceTime = debounceTime;

        let func = this.debouncedApplySelectionChanged.get(debounceTime);
        if (func) return func;
        func = debounce(this.applySelectionChanged, debounceTime, { leading: false, trailing: true });
        this.debouncedApplySelectionChanged.set(debounceTime, func);
        return func;
    };

    private applySelectionChanged = async (
        editor: TextEditor,
        kind: TextEditorSelectionChangeKind | undefined,
    ): Promise<void> => {
        // reset cursor style if needed
        this.updateCursorStyle(this.main.modeManager.currentMode.name);

        // wait for possible layout updates first
        logger.debug(`Waiting for possible layout completion operation`);
        await this.main.bufferManager.waitForLayoutSync();
        // wait for possible change document events
        logger.debug(`Waiting for possible document change completion operation`);
        await this.main.changeManager.getDocumentChangeCompletionLock(editor.document);
        logger.debug(`Waiting done`);

        // ignore selection change caused by buffer edit
        const selection = editor.selection;
        const documentChange = this.main.changeManager.eatDocumentCursorAfterChange(editor.document);
        if (documentChange && documentChange.isEqual(selection.active)) {
            logger.debug(`Skipping onSelectionChanged event since it was selection produced by doc change`);
        } else {
            logger.debug(
                `Applying changed selection, kind: ${kind},  cursor: [${selection.active.line}, ${
                    selection.active.character
                }], isMultiSelection: ${editor.selections.length > 1}`,
            );

            if (selection.isEmpty) {
                // exit visual mode when clicking elsewhere
                if (this.main.modeManager.isVisualMode && kind == TextEditorSelectionChangeKind.Mouse)
                    await this.client.input("<Esc>");
                await this.updateNeovimCursorPosition(editor, selection.active);
            } else {
                if (kind != TextEditorSelectionChangeKind.Mouse || !config.disableMouseSelection)
                    await this.updateNeovimVisualSelection(editor, selection);
            }
        }

        this.previousApplyDebounceTime = undefined;
        this.applySelectionChangedPromise.get(editor)?.resolve();
        this.applySelectionChangedPromise.delete(editor);
    };

    /**
     * Set cursor position in neovim. Coords are [0, 0] based.
     **/
    public async updateNeovimCursorPosition(
        editor: TextEditor,
        active: Position,
        skipSameCursorUpdate = true,
    ): Promise<void> {
        const winId = this.main.bufferManager.getWinIdForTextEditor(editor);
        if (!winId) return;
        const neovimCursorPos = this.neovimCursorPosition.get(editor);
        if (skipSameCursorUpdate && neovimCursorPos && neovimCursorPos.active.isEqual(active)) {
            logger.debug(`Skipping event since neovim has same cursor pos`);
            return;
        }
        const pos = convertEditorPositionToVimPosition(editor, active);
        logger.debug(`Updating cursor pos in neovim, winId: ${winId}, pos: [${pos.line}, ${pos.character}]`);
        const vimPos = [pos.line + 1, pos.character]; // nvim_win_set_cursor is [1, 0] based
        try {
            await this.client.request("nvim_win_set_cursor", [winId, vimPos]); // a little faster
        } catch (e) {
            // 1. The output content may be out of sync due to the rapid changes in content.
            //    When initializing the buffer, the output may be constantly updating.
            // 2. The output is a textEditor, but it cannot accept input, it's meaningless to use the extension.
            // In the output, going out-of-sync and cursor position errors are not significant.
            if (editor.document.uri.scheme !== "output") {
                logger.error(`${(e as Error).message}`);
            }
        }
    }

    private async updateNeovimVisualSelection(editor: TextEditor, selection: Selection): Promise<void> {
        const winId = this.main.bufferManager.getWinIdForTextEditor(editor);
        if (!winId) return;
        const bufId = this.main.bufferManager.getBufferIdForTextDocument(editor.document);
        if (!bufId) return;
        const neovimCursorPos = this.neovimCursorPosition.get(editor);
        if (neovimCursorPos && neovimCursorPos.isEqual(selection)) {
            logger.debug(`Skipping event since neovim has same visual pos`);
            return;
        }
        let anchor = selection.anchor;
        let active = selection.active;
        // compensate for vscode selection containing last character
        if (anchor.isBeforeOrEqual(active)) {
            active = new Position(active.line, Math.max(active.character - 1, 0));
        } else {
            anchor = new Position(anchor.line, Math.max(anchor.character - 1, 0));
        }
        if (this.main.modeManager.isInsertMode) return;
        logger.debug(
            `Starting visual mode from: [${anchor.line}, ${anchor.character}] to [${active.line}, ${active.character}]`,
        );
        const visualmode = await this.client.call("visualmode", [1]);
        await this.client.call("nvim_buf_set_mark", [bufId, "<", anchor.line + 1, anchor.character, {}]);
        await this.client.call("nvim_buf_set_mark", [bufId, ">", active.line + 1, active.character, {}]);
        await this.client.input(visualmode === "V" || visualmode === "\x16" ? "gvv" : "gv");
        await this.client.call("winrestview", [{ curswant: active.character }]);
    }

    // given a neovim visual selection range (and the current mode), create a vscode selection
    private createVisualSelection = async (
        editor: TextEditor,
        mode: Mode,
        active: Position,
        anchor: Position | undefined,
    ): Promise<Selection[]> => {
        const doc = editor.document;

        if (!anchor) {
            const anchorNvim = await this.client.callFunction("getpos", ["v"]);
            anchor = convertVimPositionToEditorPosition(editor, new Position(anchorNvim[1] - 1, anchorNvim[2] - 1));
        }

        logger.debug(
            `Creating visual selection, mode: ${mode.visual}, anchor: [${anchor.line}, ${anchor.character}], active: [${active.line}, ${active.character}]`,
        );

        const activeLineLength = doc.lineAt(active.line).range.end.character;
        const anchorLineLength = doc.lineAt(anchor.line).range.end.character;

        // to make a full selection, the end of the selection needs to be moved forward by one character
        // we hide the real cursor and use a highlight decorator for the fake cursor
        switch (mode.visual) {
            case "char":
                if (anchor.isBeforeOrEqual(active))
                    return [
                        new Selection(
                            anchor,
                            new Position(active.line, Math.min(active.character + 1, activeLineLength)),
                        ),
                    ];
                else
                    return [
                        new Selection(
                            new Position(anchor.line, Math.min(anchor.character + 1, anchorLineLength)),
                            active,
                        ),
                    ];
            case "line":
                if (anchor.line <= active.line) return [new Selection(anchor.line, 0, active.line, activeLineLength)];
                else return [new Selection(anchor.line, anchorLineLength, active.line, 0)];
            case "block": {
                const selections: Selection[] = [];
                // we want the first selection to be on the cursor line, so that a single-line selection will properly trigger word highlight
                const before = anchor.line < active.line;
                for (
                    let line = active.line;
                    before ? line >= anchor.line : line <= anchor.line;
                    before ? line-- : line++
                ) {
                    // skip lines that don't contain the block selection, except if it contains the cursor
                    const docLine = doc.lineAt(line);
                    if (
                        docLine.range.end.character > Math.min(anchor.character, active.character) ||
                        line === active.line
                    ) {
                        // selections go left to right for simplicity, and don't go past the end of the line
                        selections.push(
                            new Selection(
                                line,
                                Math.min(anchor.character, active.character),
                                line,
                                Math.min(Math.max(anchor.character, active.character) + 1, docLine.range.end.character),
                            ),
                        );
                    }
                }
                return selections;
            }
        }
    };

    private async handleRangeCommand(data: EventBusData<"range-command">): Promise<unknown> {
        const [command, mode, startLine, endLine, startPos, endPos, leaveSelection, inargs] = data;
        const args = Array.isArray(inargs) ? inargs : [inargs];
        try {
            const e = window.activeTextEditor;
            if (!e) return;
            logger.debug(
                `Range command: ${command}, range: [${startLine}, ${startPos}] - [${endLine}, ${endPos}], leaveSelection: ${leaveSelection}`,
            );
            const prevSelections = e.selections;
            const selection = await this.createVisualSelection(
                e,
                new Mode(mode),
                new Position(endLine - 1, endPos - 1),
                new Position(startLine - 1, startPos - 1),
            );
            this.neovimCursorPosition.set(e, selection[0]);
            e.selections = selection;
            const res = await commands.executeCommand(command, ...args);
            if (!leaveSelection) {
                this.neovimCursorPosition.set(e, prevSelections[0]);
                e.selections = prevSelections;
            }
            return res;
        } catch (e) {
            logger.error(
                `${command} failed, range: [${startLine}, ${endLine}, ${startPos}, ${endPos}] args: ${JSON.stringify(
                    inargs,
                )} error: ${(e as Error).message}`,
            );
        }
    }

    public dispose(): void {
        disposeAll(this.disposables);
    }
}
