import { cloneDeep } from "lodash";
import { DecorationOptions, Range, TextEditor, TextEditorDecorationType, ThemeColor } from "vscode";

import { BufferManager } from "../buffer_manager";
import { ViewportManager } from "../viewport_manager";

import { HighlightGroupStore } from "./highlight_group_store";
import { CellIter, getWidth, isDouble, splitGraphemes } from "./util";

export type VimCell = [string, number?, number?];
export interface LineCell {
    text: string;
    hlId: number;
}
export interface Highlight {
    text: string;
    hlId: number;
    virtText?: string;
}
export interface NormalHighlightRange {
    textType: "normal";
    hlId: number;
    line: number;
    startCol: number;
    endCol: number;
}
export interface VirtualHighlightRange {
    textType: "virtual";
    highlights: Highlight[];
    line: number;
    col: number;
}
export type HighlightRange = NormalHighlightRange | VirtualHighlightRange;

export class HighlightGrid {
    // line number -> line cells
    private lineCells: LineCell[][] = [];
    // The way to clear decorations is to set them to an empty array, so it is
    // necessary to record the decorators used in the last refresh.
    // In the next refresh, if a decorator is no longer used, it should be cleared.
    private prevDecorators: Set<TextEditorDecorationType> = new Set();

    private isDirty = false;

    private readonly gridId: number;
    private readonly groupStore: HighlightGroupStore;
    private readonly bufferManager?: BufferManager;
    private readonly viewportManager?: ViewportManager;

    constructor(
        gridId: number,
        groupStore: HighlightGroupStore,
        bufferManger?: BufferManager,
        viewportManager?: ViewportManager,
    ) {
        this.gridId = gridId;
        this.groupStore = groupStore;
        this.bufferManager = bufferManger;
        this.viewportManager = viewportManager;
        // setInterval(() => {
        //     const line = window.activeTextEditor?.selection.active.line;
        //     if (line == null) return;
        //     const cells = this.lineCells[line] ?? [];
        //     if (cells.length) {
        //         const text = cells.map((cell) => cell.text).join("");
        //         if (text !== last) {
        //             console.log(text);
        //             last = text;
        //         }
        //     }
        // }, 100);
    }

    // #region Handle Redraw Events

    handleGridLine(line: number, vimCol: number, cells: VimCell[]) {
        // console.log(line, vimCol);
        // console.log(JSON.stringify(cells));
        const prevCells = this.lineCells[line] ?? [];
        // Fill in the missing cells
        if (prevCells.length < vimCol) {
            const missingCells = vimCol - prevCells.length;
            for (let i = 0; i < missingCells; i++) {
                prevCells.push({ text: " ", hlId: 0 });
            }
        }

        const redrawCells: LineCell[] = [];
        {
            let currHlId = 0;
            for (const [text, hlId, repeat] of cells) {
                if (hlId != null) currHlId = this.groupStore.normalizeHighlightId(hlId) ?? hlId;
                for (let i = 0; i < (repeat ?? 1); i++) {
                    redrawCells.push({ text, hlId: currHlId });
                }
            }
        }
        const leftCells = prevCells.slice(0, vimCol);
        const rightCells = prevCells.slice(vimCol + redrawCells.length);

        this.lineCells[line] = [...leftCells, ...redrawCells, ...rightCells];
    }

    handleGridScroll(top: number, bottom: number, rows: number) {
        console.log("Scroll: top", top, "bottom", bottom, "rows", rows);
        const lines: number[] = [];
        this.lineCells.forEach((_, i) => lines.push(i));

        if (rows > 0) {
            for (const line of lines) {
                this.lineCells[line - rows] = this.lineCells[line];
            }
        } else if (rows < 0) {
            const scrollBy = Math.abs(rows);
            for (const line of lines.reverse()) {
                this.lineCells[line + scrollBy] = this.lineCells[line];
            }
        }
    }

    handleRedrawFlush() {
        if (this.isDirty) {
            this.refreshDecorations();
            this.isDirty = false;
        }
    }

    // #endregion

    // #region Render Decorations

    refreshDecorations(): void {
        const editor = this.bufferManager?.getEditorFromGridId(this.gridId);
        if (!editor) return;

        const viewport = this.viewportManager?.getViewport(this.gridId);
        if (!viewport) return;

        const decorations = new Map<TextEditorDecorationType, DecorationOptions[]>();

        const startLine = Math.max(0, viewport.topline);
        const endLine = Math.min(editor.document.lineCount - 1, viewport.botline);

        this.getDecorations(editor, startLine, endLine).forEach((opts, decorator) => {
            if (!decorations.has(decorator)) decorations.set(decorator, []);
            decorations.get(decorator)!.push(...opts);
        });

        // const { visibleRanges } = editor;
        // for (const [idx, visibleRange] of visibleRanges.entries()) {
        //     let startLine = visibleRange.start.line;
        //     let endLine = visibleRange.end.line;
        //     // There maybe one line padding at the top and bottom
        //     if (idx === 0) startLine = Math.max(0, startLine - 1);
        //     if (idx === visibleRanges.length - 1) endLine = Math.min(editor.document.lineCount - 1, endLine + 1);

        //     this.getDecorations(editor, startLine, endLine).forEach((opts, decorator) => {
        //         if (!decorations.has(decorator)) decorations.set(decorator, []);
        //         decorations.get(decorator)!.push(...opts);
        //     });
        // }

        const currDecorators = new Set(decorations.keys());
        this.prevDecorators.forEach((decorator) => {
            if (!currDecorators.has(decorator)) {
                decorations.set(decorator, []);
            }
        });
        this.prevDecorators = currDecorators;

        for (const [decorator, ranges] of decorations) {
            editor.setDecorations(decorator, ranges);
        }

        // console.log("Refresh decorations:", Date.now() - start, "ms");
    }

    // #endregion

    // #region Calculate Decorations

    // decoration type -> decoration options
    private getDecorations(
        editor: TextEditor,
        startLine: number,
        endLine: number,
    ): Map<TextEditorDecorationType, DecorationOptions[]> {
        const results = new Map<TextEditorDecorationType, DecorationOptions[]>();

        for (let line = startLine; line <= endLine; line++) {
            const lineDecorations = this.getDecorationsForLine(editor, line);
            lineDecorations.forEach((options, hlId) => {
                const { decorator } = this.groupStore.getDecorator(hlId);
                if (!decorator) return;
                if (!results.has(decorator)) results.set(decorator, []);
                results.get(decorator)!.push(...options);
            });
        }

        return results;
    }

    // hlId -> decoration options
    private getDecorationsForLine(editor: TextEditor, line: number): Map<number, DecorationOptions[]> {
        const lineText = editor.document.lineAt(line).text;
        const tabSize = editor.options.tabSize as number;
        const highlights = this.computeLineHighlights(line, lineText, tabSize);
        const ranges = this.lineHighlightsToRanges(line, highlights);
        return this.highlightRangesToOptions(editor, ranges);
    }

    // hlId -> decoration options
    private highlightRangesToOptions(editor: TextEditor, ranges: HighlightRange[]): Map<number, DecorationOptions[]> {
        const hlId_options = new Map<number, DecorationOptions[]>();
        const pushOptions = (hlId: number, ...options: DecorationOptions[]) => {
            if (!hlId_options.has(hlId)) {
                hlId_options.set(hlId, []);
            }
            hlId_options.get(hlId)!.push(...options);
        };

        ranges.forEach((range) => {
            if (
                (range.textType === "normal" && range.hlId === 0) ||
                (range.textType === "virtual" && !range.highlights.some((hl) => hl.hlId !== 0))
            )
                return;

            if (range.textType === "virtual") {
                const lineText = editor.document.lineAt(range.line).text;
                const virtOptions = this.createColVirtTextOptions(range.line, lineText, range.col, range.highlights);
                virtOptions.forEach((options, hlId) => pushOptions(hlId, ...options));
            } else if (range.hlId !== 0) {
                pushOptions(range.hlId, {
                    range: new Range(range.line, range.startCol, range.line, range.endCol),
                });
            }
        });

        return hlId_options;
    }

    private lineHighlightsToRanges(line: number, highlights: Map<number, Highlight[]>): HighlightRange[] {
        const normalHighlights: Map<number, NormalHighlightRange[]> = new Map();
        const virtualHighlights: VirtualHighlightRange[] = [];
        highlights.forEach((hls, col) => {
            if (hls.length === 0) {
                // Should never happen, but defensive
                return;
            }

            if (hls.length > 1 || hls[0].virtText) {
                virtualHighlights.push({
                    textType: "virtual",
                    highlights: hls,
                    line,
                    col,
                });
                return;
            }

            const colHighlight = hls[0];
            const existingHighlights = normalHighlights.get(colHighlight.hlId) ?? [];
            const matchingHighlight = findLast(existingHighlights, (hl) => hl.endCol === col);

            if (matchingHighlight) {
                // Extend our existing highlight if we already have it
                matchingHighlight.endCol = col + 1;
            } else {
                const highlight = {
                    textType: "normal" as const,
                    hlId: colHighlight.hlId,
                    line,
                    startCol: col,
                    endCol: col + 1,
                };
                existingHighlights.push(highlight);
            }

            normalHighlights.set(colHighlight.hlId, existingHighlights);
        });

        const ranges: HighlightRange[] = Array.from(normalHighlights.values()).flat();
        ranges.push(...virtualHighlights);

        return ranges;
    }

    // Actually we should only accept the line number and the editor instance
    // But it's not easy to test

    // char col -> highlights
    private computeLineHighlights(line: number, lineText: string, tabSize: number): Map<number, Highlight[]> {
        const lineCells = cloneDeep(this.lineCells[line] ?? []);
        if (!lineCells.length) return new Map();

        const highlights: Map<number, Highlight[]> = new Map();

        const cells: LineCell[] = [];
        // EOL highlights are all virtual text highlights
        // For performance, we need to combine EOL cells that have the same hlId
        {
            const idealMaxCells = getWidth(lineText, tabSize);
            cells.push(...lineCells.slice(0, idealMaxCells));

            const eolCells: LineCell[] = [];
            let hlId = 0;
            for (const cell of lineCells.slice(idealMaxCells)) {
                if (cell.hlId === hlId && eolCells.length) {
                    eolCells[eolCells.length - 1].text += cell.text;
                } else {
                    eolCells.push(cell);
                }
                hlId = cell.hlId;
            }

            cells.push(...eolCells);
        }
        const cellIter = new CellIter(cells);
        const lineChars = splitGraphemes(lineText);
        // Insert additional columns for characters with length greater than 1.
        const filledLineText = splitGraphemes(lineText).reduce((p, c) => p + c + " ".repeat(c.length - 1), "");
        const filledLineChars = splitGraphemes(filledLineText);
        // Calculates the number of spaces occupied by the tab
        const calcTabCells = (tabCol: number) => {
            let nearestTabIdx = lineChars.slice(0, tabCol).lastIndexOf("\t");
            nearestTabIdx = nearestTabIdx === -1 ? 0 : nearestTabIdx + 1;
            const center = lineChars.slice(nearestTabIdx, tabCol).join("");
            return tabSize - (getWidth(center, tabSize) % tabSize);
        };

        // Always redraw the entire line :)
        let currCharCol = 0;
        let cell = cellIter.takeNext();
        while (cell) {
            const hls: Highlight[] = [];
            const add = (cell: LineCell, virtText?: string) => hls.push({ ...cell, virtText });
            const currChar = filledLineChars[currCharCol];
            const extraCols = currChar ? currChar.length - 1 : 0;
            currCharCol += extraCols;
            // ... some emojis have text versions e.g. [..."❤️"] == ['❤', '️']
            const hlCol = currCharCol - (currChar ? [...currChar].length - 1 : 0);

            do {
                if (currChar === "\t") {
                    add(cell, cell.text);
                    for (let i = 0; i < calcTabCells(currCharCol) - 1; i++) {
                        cell = cellIter.takeNext();
                        cell && add(cell, cell.text);
                    }

                    break;
                }

                if (currChar && isDouble(currChar)) {
                    if (currChar === cell.text) {
                        add(cell);
                        cellIter.discardNext();
                        break;
                    }

                    add(cell, cell.text);
                    if (!isDouble(cell.text)) {
                        const nextCell = cellIter.takeNext();
                        nextCell && add(nextCell, nextCell.text);
                        extraCols && add(nextCell ?? cell, " ".repeat(extraCols));
                    }

                    break;
                }

                if (currChar === cell.text) {
                    add(cell);
                } else {
                    add(cell, cell.text);
                    if (isDouble(cell.text)) {
                        currCharCol++;
                    }
                }

                // eslint-disable-next-line no-constant-condition
            } while (false);

            highlights.set(hlCol, hls);

            /////////////////////////////////////////////
            currCharCol++;
            cell = cellIter.takeNext();
        }

        return highlights;
    }

    private createColVirtTextOptions(
        line: number,
        lineText: string,
        col: number,
        colHighlights: Highlight[],
    ): Map<number, DecorationOptions[]> {
        const hlId_options = new Map<number, DecorationOptions[]>();

        colHighlights = cloneDeep(colHighlights);

        // #region
        // When on a multi-width character,
        // there may be a cell with a highlight ID of 0 and its content is a space used to hide the cell.
        // However, in vscode, we will ignore the highlighting ID of 0.
        // So, we add the character to the preceding virtual text.
        const processedColHighlights: { hlId: number; virtText: string }[] = [];
        colHighlights.forEach(({ virtText, hlId, text }) => {
            // In certain edge cases, the right-side highlight may be appended later,
            // resulting in the column being converted to virt text type.
            // So, the left-side highlight may not include virtText.
            virtText ??= text;
            if (hlId === 0 && processedColHighlights.length > 0) {
                processedColHighlights[processedColHighlights.length - 1].virtText += virtText;
            } else {
                processedColHighlights.push({ hlId, virtText });
            }
        });
        // #endregion

        const virtTextCol = Math.min(lineText.length, col);
        const range = new Range(line, virtTextCol, line, virtTextCol);
        const backgroundColor = new ThemeColor("editor.background");

        processedColHighlights.forEach(({ virtText, hlId }, offset) => {
            const { decorator, options } = this.groupStore.getDecorator(hlId);
            if (!decorator) return;
            if (!hlId_options.has(hlId)) hlId_options.set(hlId, []);
            const width = virtText.length;
            if (col > lineText.length) {
                offset += col - lineText.length; // for 'eol' virtual text
            }
            hlId_options.get(hlId)!.push({
                range,
                renderOptions: {
                    before: {
                        backgroundColor,
                        ...options,
                        contentText: virtText,
                        margin: `0 0 0 ${offset}ch`,
                        width: `${width}ch; position:absolute; z-index:${99 - offset}; white-space: pre; --hlId: ${hlId};`,
                    },
                },
            });
        });
        return hlId_options;
    }

    // #endregion
}

function findLast<T>(arr: T[], finder: (item: T) => boolean): T | undefined {
    for (let i = arr.length - 1; i >= 0; i--) {
        if (finder(arr[i])) {
            return arr[i];
        }
    }
}
