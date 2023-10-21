import { DebouncedFunc, debounce } from "lodash-es";
import { Disposable, Position, TextEditor, TextEditorVisibleRangesChangeEvent, window, workspace } from "vscode";

import { config } from "./config";
import { EventBusData, eventBus } from "./eventBus";
import { createLogger } from "./logger";
import { MainController } from "./main_controller";
import { disposeAll, convertEditorPositionToVimPosition } from "./utils";
import actions from "./actions";

const logger = createLogger("ViewportManager");

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
    const { selection, visibleRanges } = editor;
    const pos = convertEditorPositionToVimPosition(editor, selection.active);
    const view: EditorViewport = {
        line: pos.line,
        col: pos.character,
        topline: visibleRanges[0].start.line,
        botline: visibleRanges[visibleRanges.length - 1].end.line,
    };
    console.log(JSON.stringify(view));
    return view;
}

export class ViewportManager implements Disposable {
    private disposables: Disposable[] = [];

    /**
     * Current grid viewport, indexed by grid
     */
    private gridViewport: Map<number, GridViewport> = new Map();

    private get client() {
        return this.main.client;
    }

    public constructor(private main: MainController) {
        const fireViewportChanged = (editor: TextEditor) => {
            if (this.main.modeManager.isInsertMode) return;
            const winId = this.main.bufferManager.getWinIdForTextEditor(editor);
            if (!winId) return;
            actions.fireNvimEvent("editor-viewport-changed", winId, getViewportFromEditor(editor));
        };
        const debouncedMap = {
            20: debounce(fireViewportChanged, 20),
            60: debounce(fireViewportChanged, 60),
        };

        window.onDidChangeTextEditorSelection((e) => debouncedMap[config.useSmoothScrolling ? 60 : 20](e.textEditor));
        window.onDidChangeTextEditorVisibleRanges((e) =>
            debouncedMap[config.useSmoothScrolling ? 60 : 20](e.textEditor),
        );

        this.disposables.push(
            // window.onDidChangeTextEditorVisibleRanges(this.onDidChangeVisibleRange),
            eventBus.on("redraw", this.handleRedraw, this),
            eventBus.on("window-scroll", ([winId, saveView]) => {
                const gridId = this.main.bufferManager.getGridIdForWinId(winId);
                if (gridId) {
                    const view = this.getViewport(gridId);
                    view.leftcol = saveView.leftcol;
                    view.skipcol = saveView.skipcol;
                }
            }),
        );
    }

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
