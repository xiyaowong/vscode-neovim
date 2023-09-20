import {
    Disposable,
    TextEditor,
    DecorationOptions,
    window,
    TextEditorDecorationType,
    DecorationRenderOptions,
    Uri,
    Range,
} from "vscode";
//@ts-expect-error no types
import { createSVGWindow } from "svgdom";
import { SVG, registerWindow } from "@svgdotjs/svg.js";

import { NeovimExtensionRequestProcessable } from "./neovim_events_processable";
import { MainController } from "./main_controller";

type Span = { color: string; text: string };

export class StatusColumn implements Disposable, NeovimExtensionRequestProcessable {
    private editorGutters = new WeakMap<TextEditor, Map<number, string>>();
    private decorationTypes: TextEditorDecorationType[] = [];
    private disposables: Disposable[] = [];
    private canvas: any;

    constructor(private main: MainController) {
        const _window = createSVGWindow();
        const _document = _window.document;
        registerWindow(_window, _document);
        this.canvas = SVG(_document.documentElement);
        this.disposables.push(window.onDidChangeTextEditorVisibleRanges((e) => this.refreshGutters(e.textEditor)));
    }

    async handleExtensionRequest(name: string, args: unknown[]): Promise<void> {
        if (name !== "refresh-statuscolumn") return;
        args = args[0] as unknown[];
        const winId = args[0] as number;
        const editor = this.main.bufferManager.getEditorFromWinId(winId) ?? window.activeTextEditor;
        if (!editor) return;
        if (!this.editorGutters.has(editor)) {
            this.editorGutters.set(editor, new Map());
        }
        const gutters = this.editorGutters.get(editor)!;
        (args[1] as [number, Span[]][]).forEach(([lnum, spans]) => {
            if (spans.length) {
                gutters.set(lnum, this.getSVG(spans));
            } else {
                gutters.delete(lnum);
            }
        });

        this.refreshGutters(editor);
    }

    refreshGutters(editor: TextEditor) {
        const currDecorationTypes: TextEditorDecorationType[] = [];
        if (!this.editorGutters.has(editor)) {
            this.editorGutters.set(editor, new Map());
        }
        const gutters = this.editorGutters.get(editor)!;
        if (gutters) {
            gutters.forEach((gutter, lnum) => {
                const decoType = window.createTextEditorDecorationType({
                    gutterIconPath: Uri.parse(`data:image/svg+xml,${encodeURIComponent(gutter)}`),
                    isWholeLine: false,
                });
                currDecorationTypes.push(decoType);
                editor.setDecorations(decoType, [new Range(lnum - 1, 0, lnum - 1, 0)]);
            });
        }
        this.decorationTypes.forEach((t) => t.dispose());
        this.decorationTypes = currDecorationTypes;
    }

    private getSVG(spans: Span[]): string {
        return `<svg  xmlns="http://www.w3.org/2000/svg"><text text-anchor="middle" dominant-baseline="middle" alignment-baseline="middle" x="50%" y="50%"><tspan fill="red">H</tspan><tspan fill="green">e</tspan></text></svg>`;
    }
    dispose() {
        this.disposables.forEach((d) => d.dispose());
        this.decorationTypes.forEach((d) => d.dispose());
    }
}
