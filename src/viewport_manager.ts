import { DebouncedFunc, debounce } from "lodash-es";
import {
    Disposable,
    Position,
    Range,
    TextEditor,
    TextEditorRevealType,
    TextEditorSelectionChangeEvent,
    TextEditorVisibleRangesChangeEvent,
    commands,
    window,
    workspace,
} from "vscode";

import { config } from "./config";
import { EventBusData, eventBus } from "./eventBus";
import { createLogger } from "./logger";
import { MainController } from "./main_controller";
import { disposeAll, convertEditorPositionToVimPosition, ManualPromise } from "./utils";
import actions from "./actions";

const logger = createLogger("ViewportManager");

export interface WinViewport {
    lnum: number; // 1-indexed
    col: number;
    coladd: number;
    curswant: number;
    topline: number; // 1-indexed
    topfill: number;
    leftcol: number;
    skipcol: number;
}

// All 0-indexed
interface EditorViewport {
    line: number;
    col: number;
    topline: number;
    botline: number;
}

// All 0-indexed
interface GridViewport {
    line: number; // current line
    col: number; // current col
    topline: number; // top viewport line
    botline: number; // bottom viewport line
    leftcol: number; // left viewport col
    skipcol: number; // skip col (maybe left col)
}

function getViewportFromEditor(editor: TextEditor): EditorViewport {
    const { selection, visibleRanges, document } = editor;
    const pos = convertEditorPositionToVimPosition(editor, selection.active);
    const { line, character: col } = pos;
    const topline = visibleRanges[0].start.line;
    const botline = Math.min(
        document.lineCount - 1,
        // Generally 1-2 lines less than the actual range
        visibleRanges[visibleRanges.length - 1].end.line,
    );
    const view = { line, col, topline, botline };
    // console.log(JSON.stringify(view));
    return view;
}

export class ViewportManager implements Disposable {
    private disposables: Disposable[] = [];

    private editorRevealLine: WeakMap<TextEditor, number> = new WeakMap();

    /**
     * Current grid viewport, indexed by grid
     */
    private gridViewport: Map<number, GridViewport> = new Map();

    private updatePromise?: ManualPromise;

    private scrolledGrids: Set<number> = new Set();

    private get client() {
        return this.main.client;
    }

    public constructor(private main: MainController) {
        this.disposables.push(
            // window.onDidChangeTextEditorSelection(this.alignVisibleTopLine),
            // window.onDidChangeTextEditorVisibleRanges(this.alignVisibleTopLine),
            window.onDidChangeTextEditorSelection(this.sendEditorViewport),
            window.onDidChangeTextEditorVisibleRanges(this.sendEditorViewport),

            eventBus.on("redraw", this.handleRedraw, this),
            eventBus.on("viewport-changed", this.handleWinViewportChanged),
        );
    }

    public get syncDone(): Promise<void> {
        return Promise.resolve(this.updatePromise?.promise);
    }

    private handleWinViewportChanged = ([winId, winView]: [number, WinViewport]) => {
        const gridId = this.main.bufferManager.getGridIdForWinId(winId);
        if (gridId) {
            const view = this.getViewport(gridId);
            const newTopline = winView.topline - 1;
            if (view.topline !== newTopline) {
                this.scrolledGrids.add(gridId);
            }
            view.line = winView.lnum - 1;
            view.col = winView.col;
            view.topline = newTopline;
            view.leftcol = winView.leftcol;
            view.skipcol = winView.skipcol;
        }
    };

    private _sendEditorViewPort = async (e: TextEditorVisibleRangesChangeEvent | TextEditorSelectionChangeEvent) => {
        if (this.main.modeManager.isInsertMode) return;
        const { textEditor } = e;
        const winId = this.main.bufferManager.getWinIdForTextEditor(textEditor);
        if (!winId) return;
        await this.main.bufferManager.waitForLayoutSync();
        await this.main.cursorManager.waitForCursorUpdate(textEditor);
        await this.main.changeManager.getDocumentChangeCompletionLock(textEditor.document);
        actions.fireNvimEvent("editor_viewport_changed", winId, getViewportFromEditor(textEditor));
    };
    private sendEditorViewport = debounce(this._sendEditorViewPort, 100);

    /**
     * Get viewport data
     * @param gridId: grid id
     * @returns viewport data
     */
    private getViewport(gridId: number): GridViewport {
        if (!this.gridViewport.has(gridId))
            this.gridViewport.set(gridId, {
                line: 0,
                col: 0,
                topline: 0,
                botline: 0,
                leftcol: 0,
                skipcol: 0,
            });
        return this.gridViewport.get(gridId)!;
    }

    /**
     * @param gridId: grid id
     * @returns (0, 0)-indexed cursor position and flag indicating byte col
     */
    public getCursorFromViewport(gridId: number): Position {
        const view = this.getViewport(gridId);
        return new Position(view.line, view.col);
    }

    /**
     * @param gridId: grid id
     * @returns (0, 0)-indexed grid offset
     */
    public getGridOffset(gridId: number): Position {
        const view = this.getViewport(gridId);
        return new Position(view.topline, view.leftcol);
    }

    private syncGridViewports = async () => {
        try {
            const res = await this.client.executeLua(`return require'vscode-neovim.viewport'.get_all_viewports()`);
            for (const [winId, winView] of res as [number, any][]) {
                const grid = this.main.bufferManager.getGridIdForWinId(winId);
                if (grid) {
                    const view = this.getViewport(grid);
                    view.topline = winView.topline - 1;
                    view.line = winView.lnum - 1;
                    view.col = winView.col;
                    view.skipcol = winView.skipcol;
                    view.leftcol = winView.leftcol;
                }
            }
        } catch {
            //
        }
    };

    private async handleRedraw(data: EventBusData<"redraw">) {
        for (const { name, args } of data) {
            switch (name) {
                case "win_viewport": {
                    for (const [grid, win, topline, botline, curline, curcol] of args) {
                        const view = this.getViewport(grid);
                        if (view.topline !== topline) {
                            this.scrolledGrids.add(grid);
                        }
                        view.topline = topline;
                        view.botline = botline;
                        view.line = curline;
                        view.col = curcol;
                    }

                    if (this.main.modeManager.isCmdlineMode && !this.updatePromise) {
                        try {
                            this.updatePromise = new ManualPromise();
                            const currWin = await this.client.window;
                            const winView = await this.client.call("winsaveview");
                            const grid = this.main.bufferManager.getGridIdForWinId(currWin.id);
                            if (grid) {
                                const view = this.getViewport(grid);
                                view.topline = winView.topline - 1;
                                view.line = winView.lnum - 1;
                                view.col = winView.col;
                                view.skipcol = winView.skipcol;
                                view.leftcol = winView.leftcol;
                            }
                        } catch {
                            //
                        }
                        this.updatePromise?.resolve();
                        this.updatePromise = undefined;
                    }
                    break;
                }
                case "grid_destroy": {
                    for (const [grid] of args) {
                        this.gridViewport.delete(grid);
                    }
                    break;
                }
            }
        }

        for (const gridId of this.scrolledGrids) {
            const editor = this.main.bufferManager.getEditorFromGridId(gridId);
            if (!editor) continue;
            const ranges = editor.visibleRanges;
            const startLine = ranges[0].start.line;
            const { topline } = this.getViewport(gridId);
            if (startLine !== topline) {
                if (window.activeTextEditor === editor) {
                    commands.executeCommand("revealLine", { lineNumber: topline, at: "top" });
                } else {
                    editor.revealRange(new Range(topline, 0, topline, 0), TextEditorRevealType.AtTop);
                }
            }
            this.scrolledGrids.delete(gridId);
        }
    }

    dispose() {
        disposeAll(this.disposables);
    }
}
