import diff, { Diff } from "fast-diff";
import { NeovimClient } from "neovim";
import wcwidth from "ts-wcwidth";
import {
    Disposable,
    EndOfLine,
    Position,
    Range,
    TextDocument,
    TextDocumentContentChangeEvent,
    TextEditor,
    TextEditorEdit,
    commands,
} from "vscode";

import { ILogger } from "./logger";

export interface EditRange {
    start: number;
    end: number;
    newStart: number;
    newEnd: number;
    type: "changed" | "removed" | "added";
}

/**
 * Stores last changes information for dot repeat
 */
export interface DotRepeatChange {
    /**
     * Num of deleted characters, 0 when only added
     */
    rangeLength: number;
    /**
     * Range offset
     */
    rangeOffset: number;
    /**
     * Change text
     */
    text: string;
    /**
     * Text eol
     */
    eol: string;
}

// Copied from https://github.com/google/diff-match-patch/blob/master/javascript/diff_match_patch_uncompressed.js
export function diffLineToChars(text1: string, text2: string): { chars1: string; chars2: string; lineArray: string[] } {
    const lineArray: string[] = []; // e.g. lineArray[4] == 'Hello\n'
    const lineHash: { [key: string]: number } = {}; // e.g. lineHash['Hello\n'] == 4

    // '\x00' is a valid character, but various debuggers don't like it.
    // So we'll insert a junk entry to avoid generating a null character.
    lineArray[0] = "";

    /**
     * Split a text into an array of strings.  Reduce the texts to a string of
     * hashes where each Unicode character represents one line.
     * Modifies linearray and linehash through being a closure.
     * @param {string} text String to encode.
     * @return {string} Encoded string.
     * @private
     */
    const linesToCharsMunge = (text: string, maxLines: number): string => {
        let chars = "";
        // Walk the text, pulling out a substring for each line.
        // text.split('\n') would would temporarily double our memory footprint.
        // Modifying text would create many large strings to garbage collect.
        let lineStart = 0;
        let lineEnd = -1;
        // Keeping our own length variable is faster than looking it up.
        let lineArrayLength = lineArray.length;
        while (lineEnd < text.length - 1) {
            lineEnd = text.indexOf("\n", lineStart);
            if (lineEnd == -1) {
                lineEnd = text.length - 1;
            }
            let line = text.substring(lineStart, lineEnd + 1);

            // eslint-disable-next-line no-prototype-builtins
            if (lineHash.hasOwnProperty ? lineHash.hasOwnProperty(line) : lineHash[line] !== undefined) {
                chars += String.fromCharCode(lineHash[line]);
            } else {
                if (lineArrayLength == maxLines) {
                    // Bail out at 65535 because
                    // String.fromCharCode(65536) == String.fromCharCode(0)
                    line = text.substring(lineStart);
                    lineEnd = text.length;
                }
                chars += String.fromCharCode(lineArrayLength);
                lineHash[line] = lineArrayLength;
                lineArray[lineArrayLength++] = line;
            }
            lineStart = lineEnd + 1;
        }
        return chars;
    };
    // Allocate 2/3rds of the space for text1, the rest for text2.
    const chars1 = linesToCharsMunge(text1, 40000);
    const chars2 = linesToCharsMunge(text2, 65535);
    return { chars1: chars1, chars2: chars2, lineArray: lineArray };
}

export function prepareEditRangesFromDiff(diffs: Diff[]): EditRange[] {
    const ranges: EditRange[] = [];
    // 0 - not changed, diff.length is length of non changed lines
    // 1 - added, length is added lines
    // -1 removed, length is removed lines
    let oldIdx = 0;
    let newIdx = 0;
    let currRange: EditRange | undefined;
    let currRangeDiff = 0;
    for (let i = 0; i < diffs.length; i++) {
        const [diffRes, diffStr] = diffs[i];
        if (diffRes === 0) {
            if (currRange) {
                // const diff = currRange.newEnd - currRange.newStart - (currRange.end - currRange.start);
                if (currRange.type === "changed") {
                    // changed range is inclusive
                    oldIdx += 1 + (currRange.end - currRange.start);
                    newIdx += 1 + (currRange.newEnd - currRange.newStart);
                } else if (currRange.type === "added") {
                    // added range is non inclusive
                    newIdx += Math.abs(currRangeDiff);
                } else if (currRange.type === "removed") {
                    // removed range is non inclusive
                    oldIdx += Math.abs(currRangeDiff);
                }
                ranges.push(currRange);
                currRange = undefined;
                currRangeDiff = 0;
            }
            oldIdx += diffStr.length;
            newIdx += diffStr.length;
            // if first change is single newline, then it's being eaten into the equal diff. probably comes from optimization by trimming common prefix?
            // if (
            //     ranges.length === 0 &&
            //     diffStr.length !== 1 &&
            //     diffs[i + 1] &&
            //     diffs[i + 1][0] === 1 &&
            //     diffs[i + 1][1].length === 1 &&
            //     diffs[i + 1][1].charCodeAt(0) === 3
            // ) {
            //     oldIdx--;
            //     newIdx--;
            // }
        } else {
            if (!currRange) {
                currRange = {
                    start: oldIdx,
                    end: oldIdx,
                    newStart: newIdx,
                    newEnd: newIdx,
                    type: "changed",
                };
                currRangeDiff = 0;
            }
            if (diffRes === -1) {
                // handle single string change, the diff will be -1,1 in this case
                if (diffStr.length === 1 && diffs[i + 1] && diffs[i + 1][0] === 1 && diffs[i + 1][1].length === 1) {
                    i++;
                    continue;
                }
                currRange.type = "removed";
                currRange.end += diffStr.length - 1;
                currRangeDiff = -diffStr.length;
            } else {
                if (currRange.type === "removed") {
                    currRange.type = "changed";
                } else {
                    currRange.type = "added";
                }
                currRange.newEnd += diffStr.length - 1;
                currRangeDiff += diffStr.length;
            }
        }
    }
    if (currRange) {
        ranges.push(currRange);
    }
    return ranges;
}

export function convertCharNumToByteNum(line: string, col: number): number {
    if (col === 0 || !line) {
        return 0;
    }

    let currCharNum = 0;
    let totalBytes = 0;
    while (currCharNum < col) {
        // VIM treats 2 bytes as 1 char pos for grid_cursor_goto/grid_lines (https://github.com/asvetliakov/vscode-neovim/issues/127)
        // but for setting cursor we must use original byte length
        const bytes = getBytesFromCodePoint(line.codePointAt(currCharNum));
        totalBytes += bytes;
        currCharNum += bytes === 4 ? 2 : 1;
        if (currCharNum >= line.length) {
            return totalBytes;
        }
    }
    return totalBytes;
}

export function convertByteNumToCharNum(line: string, col: number): number {
    let totalBytes = 0;
    let currCharNum = 0;
    while (totalBytes < col) {
        if (currCharNum >= line.length) {
            return currCharNum + (col - totalBytes);
        }
        const bytes = getBytesFromCodePoint(line.codePointAt(currCharNum));
        totalBytes += bytes;
        currCharNum += bytes === 4 ? 2 : 1;
    }
    return currCharNum;
}

export function convertVimPositionToEditorPosition(editor: TextEditor, vimPos: Position): Position {
    const line = editor.document.lineAt(vimPos.line).text;
    const character = convertByteNumToCharNum(line, vimPos.character);
    return new Position(vimPos.line, character);
}
export function convertEditorPositionToVimPosition(editor: TextEditor, editorPos: Position): Position {
    const line = editor.document.lineAt(editorPos.line).text;
    const byte = convertCharNumToByteNum(line, editorPos.character);
    return new Position(editorPos.line, byte);
}

function getBytesFromCodePoint(point?: number): number {
    if (point == null) {
        return 0;
    }
    if (point <= 0x7f) {
        return 1;
    }
    if (point <= 0x7ff) {
        return 2;
    }
    if (point >= 0xd800 && point <= 0xdfff) {
        // Surrogate pair: These take 4 bytes in UTF-8/UTF-16 and 2 chars in UTF-16 (JS strings)
        return 4;
    }
    if (point < 0xffff) {
        return 3;
    }
    return 4;
}

export function calculateEditorColFromVimScreenCol(line: string, screenCol: number, tabSize: number): number {
    if (screenCol === 0 || !line) {
        return 0;
    }
    let currentCharIdx = 0;
    let currentVimCol = 0;
    while (currentVimCol < screenCol) {
        if (line[currentCharIdx] === "\t") {
            currentVimCol += tabSize - (currentVimCol % tabSize);
            currentCharIdx++;
        } else {
            currentVimCol += wcwidth(line[currentCharIdx]);
            currentCharIdx++;
        }

        if (currentCharIdx >= line.length) {
            return currentCharIdx;
        }
    }
    return currentCharIdx;
}

export function isChangeSubsequentToChange(
    change: TextDocumentContentChangeEvent,
    lastChange: DotRepeatChange,
): boolean {
    const lastChangeTextLength = lastChange.text.length;
    const lastChangeOffsetStart = lastChange.rangeOffset;
    const lastChangeOffsetEnd = lastChange.rangeOffset + lastChangeTextLength;

    if (change.rangeOffset >= lastChangeOffsetStart && change.rangeOffset <= lastChangeOffsetEnd) {
        return true;
    }

    if (
        change.rangeOffset < lastChangeOffsetStart &&
        change.rangeOffset + change.rangeLength >= lastChangeOffsetStart
    ) {
        return true;
    }

    return false;
}

export function isCursorChange(change: TextDocumentContentChangeEvent, cursor: Position, eol: string): boolean {
    if (change.range.contains(cursor)) {
        return true;
    }
    if (change.range.isSingleLine && change.text) {
        const lines = change.text.split(eol);
        const lineLength = lines.length;
        const newEndLineRange = change.range.start.line + lineLength - 1;
        const newEndLastLineCharRange = change.range.end.character + lines.slice(-1)[0].length;
        if (newEndLineRange >= cursor.line && newEndLastLineCharRange >= cursor.character) {
            return true;
        }
    }
    return false;
}

export function normalizeDotRepeatChange(change: TextDocumentContentChangeEvent, eol: string): DotRepeatChange {
    return {
        rangeLength: change.rangeLength,
        rangeOffset: change.rangeOffset,
        text: change.text,
        eol,
    };
}

export function accumulateDotRepeatChange(
    change: TextDocumentContentChangeEvent,
    lastChange: DotRepeatChange,
): DotRepeatChange {
    const newLastChange: DotRepeatChange = {
        ...lastChange,
    };

    const removedLength =
        change.rangeOffset <= lastChange.rangeOffset
            ? change.rangeOffset - lastChange.rangeOffset + change.rangeLength
            : change.rangeLength;

    const sliceBeforeStart = 0;
    const sliceBeforeEnd =
        change.rangeOffset <= lastChange.rangeOffset
            ? // ? sliceBeforeStart + removedLength
              0
            : change.rangeOffset - lastChange.rangeOffset;

    const sliceAfterStart = change.rangeOffset - lastChange.rangeOffset + removedLength;

    // adjust text
    newLastChange.text =
        lastChange.text.slice(sliceBeforeStart, sliceBeforeEnd) + change.text + lastChange.text.slice(sliceAfterStart);

    // adjust offset & range length
    // we need to account the case only when text was deleted before the original change
    if (change.rangeOffset < lastChange.rangeOffset) {
        newLastChange.rangeOffset = change.rangeOffset;
        newLastChange.rangeLength += change.rangeLength;
    }
    return newLastChange;
}

export function getDocumentLineArray(doc: TextDocument): string[] {
    const eol = doc.eol === EndOfLine.CRLF ? "\r\n" : "\n";
    return doc.getText().split(eol);
}

export function normalizeInputString(str: string, wrapEnter = true): string {
    let finalStr = str.replace(/</g, "<LT>");
    if (wrapEnter) {
        finalStr = finalStr.replace(/\n/g, "<CR>");
    }
    return finalStr;
}

export function findLastEvent(name: string, batch: [string, ...unknown[]][]): [string, ...unknown[]] | undefined {
    for (let i = batch.length - 1; i >= 0; i--) {
        const [event] = batch[i];
        if (event === name) {
            return batch[i];
        }
    }
}

/**
 * Wrap nvim callAtomic and check for any errors in result
 * @param client
 * @param requests
 * @param logger
 * @param prefix
 */
export async function callAtomic(
    client: NeovimClient,
    requests: [string, unknown[]][],
    logger: ILogger,
): Promise<void> {
    const res = await client.callAtomic(requests);
    const errors: string[] = [];
    if (res && Array.isArray(res) && Array.isArray(res[0])) {
        res[0].forEach((res, idx) => {
            if (res) {
                const call = requests[idx];
                const requestName = call?.[0];
                if (requestName !== "nvim_input") {
                    errors.push(`${call?.[0] || "Unknown"}: ${res}`);
                }
            }
        });
    }
    if (errors.length) {
        logger.error(`\n${errors.join("\n")}`);
    }
}

type EditorDiffOperation = { op: -1 | 0 | 1; range: [number, number]; chars: string | null };

export function computeEditorOperationsFromDiff(diffs: diff.Diff[]): EditorDiffOperation[] {
    let curCol = 0;
    return diffs
        .map(([op, chars]: diff.Diff) => {
            let editorOp: EditorDiffOperation | null = null;

            switch (op) {
                // -1
                case diff.DELETE:
                    editorOp = {
                        op,
                        range: [curCol, curCol + chars.length],
                        chars: null,
                    };
                    curCol += chars.length;
                    break;

                // 0
                case diff.EQUAL:
                    curCol += chars.length;
                    break;

                // +1
                case diff.INSERT:
                    editorOp = {
                        op,
                        range: [curCol, curCol],
                        chars,
                    };
                    curCol += 0; // NOP
                    break;

                default:
                    throw new Error("Operation not supported");
            }

            return editorOp;
        })
        .filter(isNotNull);

    // User-Defined Type Guard
    // https://stackoverflow.com/a/54318054
    function isNotNull<T>(argument: T | null): argument is T {
        return argument !== null;
    }
}

export function applyEditorDiffOperations(
    builder: TextEditorEdit,
    { editorOps, line }: { editorOps: EditorDiffOperation[]; line: number },
): void {
    editorOps.forEach((editorOp) => {
        const {
            op,
            range: [from, to],
            chars,
        } = editorOp;

        switch (op) {
            case diff.DELETE:
                builder.delete(new Range(new Position(line, from), new Position(line, to)));
                break;

            case diff.INSERT:
                if (chars) {
                    builder.insert(new Position(line, from), chars);
                }
                break;

            default:
                break;
        }
    });
}

/**
 * Manual promise that can be resolved/rejected from outside. Used in document and cursor managers to indicate pending update.
 */
export class ManualPromise {
    public promise: Promise<void>;
    public resolve: () => void = () => {
        // noop
    };
    public reject: () => void = () => {
        // noop
    };

    constructor() {
        this.promise = new Promise((resolve, reject) => {
            this.resolve = resolve;
            this.reject = reject;
        });
        this.promise.catch((_err) => {
            // noop
        });
    }
}

/**
 * Wait for a given number of milliseconds
 * @param ms Number of milliseconds
 */
export async function wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Credit: https://github.com/VSCodeVim/Vim/blob/5dc9fbf9e7c31a523a348066e61605ed6caf62da/src/util/vscodeContext.ts
type VSCodeContextValue = boolean | string | string[];
/**
 * Wrapper around VS Code's `setContext`.
 * The API call takes several milliseconds to seconds to complete,
 * so let's cache the values and only call the API when necessary.
 */
export abstract class VSCodeContext {
    private static readonly cache: Map<string, VSCodeContextValue> = new Map();

    public static async set(key: string, value?: VSCodeContextValue): Promise<void> {
        const prev = this.get(key);
        if (prev !== value) {
            if (value === undefined) {
                this.cache.delete(key);
            } else {
                this.cache.set(key, value);
            }
            await commands.executeCommand("setContext", key, value);
        }
    }

    public static get(key: string): VSCodeContextValue | undefined {
        return this.cache.get(key);
    }
}

export function disposeAll(disposables: Disposable[]): void {
    while (disposables.length) {
        try {
            disposables.pop()?.dispose();
        } catch (e) {
            console.warn(e);
        }
    }
}
