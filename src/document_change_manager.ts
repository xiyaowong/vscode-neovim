import { Mutex } from "async-mutex";
import {
    Disposable,
    EndOfLine,
    ProgressLocation,
    Selection,
    TextDocument,
    TextDocumentChangeEvent,
    window,
    workspace,
} from "vscode";

import actions from "./actions";
import { BufferManager } from "./buffer_manager";
import { createLogger } from "./logger";
import { MainController } from "./main_controller";
import {
    DotRepeatChange,
    ManualPromise,
    accumulateDotRepeatChange,
    calcDiffWithPosition,
    convertCharNumToByteNum,
    disposeAll,
    getDocumentLineArray,
    isChangeSubsequentToChange,
    isCursorChange,
    normalizeDotRepeatChange,
} from "./utils";

const logger = createLogger("DocumentChangeManager");

export class DocumentChangeManager implements Disposable {
    private disposables: Disposable[] = [];
    /**
     * Array of pending events to apply in batch
     * ! vscode text editor operations are async and can't be executed in parallel.
     * ! We can execute them synchronously by awaiting each change but it will be very slow
     * ! So group buffer changes within 50ms and execute them in batch
     */
    private pendingEvents: Array<Parameters<NonNullable<BufferManager["onBufferEvent"]>>> = [];
    /**
     * Buffer skipping update map
     * ! Since neovim change will trigger onDocumentChangeEvent we need to handle it and don't send a change again
     * ! For it we optimistically increase skipTicks for each change originated from vscode and check it in neovim buffer event handler
     */
    private bufferSkipTicks: Map<number, number> = new Map();
    /**
     * Document version tracking
     * ! Same as previous property, but reverse
     */
    private documentSkipVersionOnChange: WeakMap<TextDocument, number> = new WeakMap();
    /**
     * Pending document changes promise. Being set early when first change event for a document is received
     * ! Since operations are async it's possible we receive other updates (such as cursor, HL) for related editors with document before
     * ! text change will be applied. In this case we need to queue such changes (through .then()) and wait for change operation completion
     */
    private textDocumentChangePromise: Map<TextDocument, Array<ManualPromise>> = new Map();
    /**
     * Holds document content last known to neovim.
     * ! This is used to convert vscode ranges to neovim bytes.
     * ! It's possible to just fetch content from neovim and check instead of tracking here, but this will add unnecessary lag
     */
    private documentContentInNeovim: WeakMap<TextDocument, string> = new WeakMap();
    /**
     * Dot repeat workaround
     */
    private dotRepeatChange: DotRepeatChange | undefined;
    /**
     * True when we're currently applying edits, so incoming changes will go into pending events queue
     */
    private applyingEdits = false;
    /**
     * Lock edits being sent to neovim
     */
    public documentChangeLock = new Mutex();

    private get client() {
        return this.main.client;
    }

    public constructor(private main: MainController) {
        this.main.bufferManager.onBufferEvent = this.onNeovimChangeEvent;
        this.main.bufferManager.onBufferInit = this.onBufferInit;
        this.disposables.push(workspace.onDidChangeTextDocument(this.onChangeTextDocument));
    }

    public dispose(): void {
        disposeAll(this.disposables);
    }

    public async getDocumentChangeCompletionLock(doc: TextDocument): Promise<void> {
        const promises = this.textDocumentChangePromise.get(doc);
        if (!promises || !promises.length) {
            return;
        }
        await Promise.all(promises.map((p) => p.promise).filter(Boolean));
    }

    public async syncDotRepeatWithNeovim(): Promise<void> {
        // dot-repeat executes last change across all buffers.
        // So we'll create a temporary buffer & window,
        // replay last changes here to trick neovim and destroy it after
        if (!this.dotRepeatChange) return;
        const edits = this.dotRepeatChange.text.replace(/\r\n/g, "\n");
        const deletes = this.dotRepeatChange.rangeLength;
        this.dotRepeatChange = undefined;
        if (!edits.length && !deletes) return;
        try {
            await actions.lua("dotrepeat_sync", edits, deletes);
        } finally {
            await actions.lua("dotrepeat_restore", edits, deletes);
        }
    }

    private onBufferInit: BufferManager["onBufferInit"] = (id, doc) => {
        logger.debug(`Init buffer content for bufId: ${id}, uri: ${doc.uri.toString()}`);
        this.documentContentInNeovim.set(doc, doc.getText());
    };

    private onNeovimChangeEvent: BufferManager["onBufferEvent"] = (
        bufId,
        tick,
        firstLine,
        lastLine,
        linedata,
        more,
    ) => {
        logger.debug(`Received neovim buffer changed event for bufId: ${bufId}, tick: ${tick}`);
        const doc = this.main.bufferManager.getTextDocumentForBufferId(bufId);
        if (!doc) {
            logger.debug(`No text document for buffer: ${bufId}`);
            return;
        }
        const skipTick = this.bufferSkipTicks.get(bufId) || 0;
        if (skipTick >= tick) {
            logger.debug(`BufId: ${bufId} skipping tick: ${tick}`);
            return;
        }
        // happens after undo
        if (firstLine === lastLine && linedata.length === 0) {
            logger.debug(`BufId: ${bufId} empty change, skipping`);
            return;
        }
        if (!this.textDocumentChangePromise.has(doc)) {
            this.textDocumentChangePromise.set(doc, []);
        }
        this.textDocumentChangePromise.get(doc)!.push(new ManualPromise());

        this.pendingEvents.push([bufId, tick, firstLine, lastLine, linedata, more]);
        if (!this.applyingEdits) {
            this.applyEdits();
        }
    };

    private applyEdits = async (): Promise<void> => {
        this.applyingEdits = true;
        logger.debug(`Applying neovim edits`);
        // const edits = this.pendingEvents.splice(0);
        let resolveProgress: undefined | (() => void);
        const progressTimer = setTimeout(() => {
            window.withProgress<void>(
                { location: ProgressLocation.Notification, title: "Applying neovim edits" },
                () => new Promise((res) => (resolveProgress = res)),
            );
        }, 1000);

        while (this.pendingEvents.length) {
            const newTextByDoc: Map<TextDocument, string[]> = new Map();
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            let edit = this.pendingEvents.shift();
            while (edit) {
                // eslint-disable-next-line @typescript-eslint/no-unused-vars
                const [bufId, _tick, firstLine, lastLine, data, _more] = edit;
                const doc = this.main.bufferManager.getTextDocumentForBufferId(bufId);
                if (!doc) {
                    logger.warn(`No document for ${bufId}, skip`);
                    continue;
                }
                logger.debug(`Accumulating edits for ${doc.uri.toString()}, bufId: ${bufId}`);
                if (!newTextByDoc.get(doc)) {
                    newTextByDoc.set(doc, getDocumentLineArray(doc));
                }
                let lines = newTextByDoc.get(doc)!;
                // nvim sends following:
                // 1. string change - firstLine is the changed line , lastLine + 1
                // 2. cleaned line but not deleted - first line is the changed line, lastLine + 1, linedata is ""
                // 3. newline insert - firstLine = lastLine and linedata is "" or new data
                // 4. line deleted - firstLine is changed line, lastLine + 1, linedata is empty []
                // 5. multiple empty lines deleted (sometimes happens), firstLine is changedLine - shouldn't be deleted, lastLine + 1, linedata is ""
                // LAST LINE is exclusive and can be out of the last editor line
                if (firstLine !== lastLine && lastLine === firstLine + 1 && data.length === 1 && data[0] === "") {
                    // 2
                    for (let line = firstLine; line < lastLine; line++) {
                        lines[line] = "";
                    }
                } else if (firstLine !== lastLine && data.length === 1 && data[0] === "") {
                    // 5
                    for (let line = 1; line < lastLine - firstLine; line++) {
                        lines.splice(firstLine, 1);
                    }
                    lines[firstLine] = "";
                } else if (firstLine !== lastLine && !data.length) {
                    // 4
                    for (let line = 0; line < lastLine - firstLine; line++) {
                        lines.splice(firstLine, 1);
                    }
                } else if (firstLine === lastLine) {
                    // 3
                    if (firstLine > lines.length) {
                        data.unshift("");
                    }
                    if (firstLine === 0) {
                        lines.unshift(...data);
                    } else {
                        lines = [...lines.slice(0, firstLine), ...data, ...lines.slice(firstLine)];
                    }
                } else {
                    // 1 or 3
                    // handle when change is overflow through editor lines. E.g. pasting on last line.
                    // Without newline it will append to the current one
                    if (firstLine >= lines.length) {
                        data.unshift("");
                    }
                    lines = [...lines.slice(0, firstLine), ...data, ...lines.slice(lastLine)];
                }
                newTextByDoc.set(doc, lines);
                edit = this.pendingEvents.shift();
            }
            // replacing lines with WorkspaceEdit() moves cursor to the end of the line, unfortunately this won't work
            // const workspaceEdit = new vscode.WorkspaceEdit();
            for (const [doc, newLines] of newTextByDoc) {
                const lastPromiseIdx = this.textDocumentChangePromise.get(doc)?.length || 0;
                try {
                    logger.debug(`Applying edits for ${doc.uri.toString()}`);
                    if (doc.isClosed) {
                        logger.debug(`Document was closed, skippnig`);
                        continue;
                    }
                    const editor = window.visibleTextEditors.find((e) => e.document === doc);
                    if (!editor) {
                        logger.debug(`No visible text editor for document, skipping`);
                        continue;
                    }
                    const oldText = doc.getText().replace(/\r\n/g, "\n");
                    const newText = newLines.join("\n");
                    this.documentSkipVersionOnChange.set(doc, doc.version + 1);

                    const cursorBefore = editor.selection.active;
                    const success = await editor.edit(
                        (builder) => {
                            const changes = calcDiffWithPosition(oldText, newText);
                            for (const { range, text } of changes) {
                                builder.replace(range, text);
                            }
                        },
                        { undoStopAfter: false, undoStopBefore: false },
                    );
                    const docPromises = this.textDocumentChangePromise.get(doc)?.splice(0, lastPromiseIdx) || [];
                    if (success) {
                        if (!editor.selection.anchor.isEqual(editor.selection.active)) {
                            editor.selections = [new Selection(editor.selection.active, editor.selection.active)];
                        } else {
                            // Some editor operations change cursor position. This confuses cursor
                            // sync from Vim to Code (e.g. when cursor did not change in Vim but
                            // changed in Code). Fix by forcing cursor position to stay the same
                            // indepent of the diff operation in question.
                            editor.selections = [new Selection(cursorBefore, cursorBefore)];
                        }
                        docPromises.forEach((p) => p.resolve && p.resolve());
                        logger.debug(`Changes succesfully applied for ${doc.uri.toString()}`);
                        this.documentContentInNeovim.set(doc, doc.getText());
                    } else {
                        docPromises.forEach((p) => {
                            p.promise.catch(() => logger.warn(`Edit was canceled for doc: ${doc.uri.toString()}`));
                            p.reject();
                        });
                        logger.warn(`Changes were not applied for ${doc.uri.toString()}`);
                    }
                } catch (e) {
                    logger.error(`Error applying neovim edits, error: ${(e as Error).message}`);
                }
            }
        }
        const promises = [...this.textDocumentChangePromise.values()].flatMap((p) => p);
        this.textDocumentChangePromise.clear();
        promises.forEach((p) => p.resolve && p.resolve());
        // better to be safe - if event was inserted after exit the while() block but before exit the function
        if (progressTimer) {
            clearTimeout(progressTimer);
        }
        if (resolveProgress) {
            resolveProgress();
        }
        if (this.pendingEvents.length) {
            this.applyEdits();
        }
        this.applyingEdits = false;
    };

    private onChangeTextDocument = async (e: TextDocumentChangeEvent): Promise<void> => {
        const { document: doc } = e;
        const origText = this.documentContentInNeovim.get(doc);
        if (origText == null) {
            logger.warn(`Can't get last known neovim content for ${doc.uri.toString()}, skipping`);
            return;
        }
        this.documentContentInNeovim.set(doc, doc.getText());
        await this.documentChangeLock.runExclusive(async () => await this.onChangeTextDocumentLocked(e, origText));
    };

    private onChangeTextDocumentLocked = async (e: TextDocumentChangeEvent, origText: string): Promise<void> => {
        const { document: doc, contentChanges } = e;

        logger.debug(`Change text document for uri: ${doc.uri.toString()}`);
        logger.debug(`Version: ${doc.version}, skipVersion: ${this.documentSkipVersionOnChange.get(doc)}`);
        if ((this.documentSkipVersionOnChange.get(doc) ?? 0) >= doc.version) {
            logger.debug(`Skipping a change since versions equals`);
            return;
        }

        const bufId = this.main.bufferManager.getBufferIdForTextDocument(doc);
        if (!bufId) {
            logger.warn(`No neovim buffer for ${doc.uri.toString()}`);
            return;
        }

        const eol = doc.eol === EndOfLine.LF ? "\n" : "\r\n";
        const activeEditor = window.activeTextEditor;

        // Store dot repeat
        if (activeEditor && activeEditor.document === doc && this.main.modeManager.isInsertMode) {
            const cursor = activeEditor.selection.active;
            for (const change of contentChanges) {
                if (isCursorChange(change, cursor, eol)) {
                    if (this.dotRepeatChange && isChangeSubsequentToChange(change, this.dotRepeatChange)) {
                        this.dotRepeatChange = accumulateDotRepeatChange(change, this.dotRepeatChange);
                    } else {
                        this.dotRepeatChange = normalizeDotRepeatChange(change, eol);
                    }
                }
            }
        }

        const changeArgs = [];
        for (const change of contentChanges) {
            const {
                text,
                range: { start, end },
            } = change;
            const startBytes = convertCharNumToByteNum(origText.split(eol)[start.line], start.character);
            const endBytes = convertCharNumToByteNum(origText.split(eol)[end.line], end.character);
            changeArgs.push([start.line, startBytes, end.line, endBytes, text.split(eol)]);
        }

        const bufTick: number = await this.client.request("nvim_buf_get_changedtick", [bufId]);
        if (!bufTick) {
            logger.warn(`Can't get changed tick for bufId: ${bufId}, deleted?`);
            return;
        }

        this.bufferSkipTicks.set(bufId, bufTick + changeArgs.length);

        logger.debug(`Setting wantInsertCursorUpdate to false`);
        this.main.cursorManager.wantInsertCursorUpdate = false;

        await actions.lua("handle_changes", bufId, changeArgs);
        const editor = window.visibleTextEditors.find((e) => e.document === doc);
        if (editor) await this.main.cursorManager.applySelectionChanged(editor);
    };
}
