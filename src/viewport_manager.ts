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
import { disposeAll, convertEditorPositionToVimPosition } from "./utils";
import actions from "./actions";

const logger = createLogger("ViewportManager");

export interface WinViewport {
    lnum: number; // 1
    col: number;
    coladd: number;
    curswant: number;
    topline: number; // 1
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
    console.log(JSON.stringify(view));
    return view;
}

export class ViewportManager implements Disposable {
    private disposables: Disposable[] = [];

    private editorRevealLine: WeakMap<TextEditor, number> = new WeakMap();

    /**
     * Current grid viewport, indexed by grid
     */
    private gridViewport: Map<number, GridViewport> = new Map();

    private get client() {
        return this.main.client;
    }

    public constructor(private main: MainController) {
        this.disposables.push(
            window.onDidChangeTextEditorSelection(this.alignVisibleTopLine),
            window.onDidChangeTextEditorVisibleRanges(this.alignVisibleTopLine),
            window.onDidChangeTextEditorSelection(this.sendEditorViewport),
            window.onDidChangeTextEditorVisibleRanges(this.sendEditorViewport),

            eventBus.on("redraw", this.handleRedraw, this),
            eventBus.on("viewport-changed", this.handleWinViewportChanged),
        );
    }

    private handleWinViewportChanged = ([winId, saveView]: [number, WinViewport]) => {
        const gridId = this.main.bufferManager.getGridIdForWinId(winId);
        if (gridId) {
            console.log(`viewport changed: ${winId} => ${JSON.stringify(saveView)}`);
            const view = this.getViewport(gridId);
            view.line = saveView.lnum - 1;
            view.col = saveView.col;
            view.topline = saveView.topline - 1;
            view.leftcol = saveView.leftcol;
            view.skipcol = saveView.skipcol;
        }
    };

    private _sendEditorViewPort = (e: TextEditorVisibleRangesChangeEvent | TextEditorSelectionChangeEvent) => {
        if (this.main.modeManager.isInsertMode) return;
        const editor = e.textEditor;
        const winId = this.main.bufferManager.getWinIdForTextEditor(editor);
        if (!winId) return;
        actions.fireNvimEvent("editor_viewport_changed", winId, getViewportFromEditor(editor));
    };
    private sendEditorViewport = debounce(this._sendEditorViewPort, 100);

    // Scrolling using the mouse or dragging the scrollbar scrolls by pixels
    private _alignVisibleTopLine = (e: TextEditorVisibleRangesChangeEvent | TextEditorSelectionChangeEvent) => {
        const editor = e.textEditor;
        const { visibleRanges } = editor;
        const topline = visibleRanges[0].start.line;
        const lastRevealLine = this.editorRevealLine.get(editor) ?? -1;
        if (lastRevealLine !== topline && topline > 1) {
            console.log(`Reveal line: ${topline}`);
            this.editorRevealLine.set(editor, topline);
            if (window.activeTextEditor === editor)
                commands.executeCommand("revealLine", { lineNumber: topline, at: "top" });
            else editor.revealRange(new Range(topline, 0, topline, 0), TextEditorRevealType.AtTop);
        }
    };
    private alignVisibleTopLine = debounce(this._alignVisibleTopLine, 50);

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

    private handleRedraw(data: EventBusData<"redraw">) {
        for (const { name, args } of data) {
            switch (name) {
                case "win_viewport": {
                    for (const [grid, , topline, botline, curline, curcol] of args) {
                        const view = this.getViewport(grid);
                        view.topline = topline;
                        view.botline = botline;
                        view.line = curline;
                        view.col = curcol;
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
    }

    dispose() {
        disposeAll(this.disposables);
    }
}
