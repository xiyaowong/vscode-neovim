import { Disposable, TextEditor, DecorationOptions } from "vscode";

class StatusColumn implements Disposable {
    private editorGutters = new WeakMap<TextEditor, Map<number, string>>();
    private disposables: Disposable[] = [];

    dispose() {
        this.disposables.forEach((d) => d.dispose());
    }

    constructor() {
        const a: DecorationOptions = {};
        //
    }
}
