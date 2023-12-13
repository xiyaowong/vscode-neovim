import { Disposable, QuickPick, QuickPickItem, commands, window } from "vscode";
import { debounce } from "lodash-es";

import { CommandLineController } from "./command_line";
import { config } from "./config";
import { EventBusData, eventBus } from "./eventBus";
import { MainController } from "./main_controller";
import { disposeAll, normalizeInputString } from "./utils";
import { GlyphChars } from "./constants";
import { createLogger } from "./logger";

const logger = createLogger("CmdLine");

function getTitle(modeOrPrompt: string): string {
    switch (modeOrPrompt) {
        case "/":
            return `${GlyphChars.SEARCH_FORWARD} Forward Search:`;
        case "?":
            return `${GlyphChars.SEARCH_BACKWARD} Backward Search:`;
        case ":":
            return `${GlyphChars.COMMAND} VIM Command Line:`;
        default:
            return modeOrPrompt;
    }
}

export class CmdlineManager implements Disposable {
    private disposables: Disposable[] = [];
    /**
     * Commandline timeout
     */
    private cmdlineTimer?: NodeJS.Timeout;

    private input: QuickPick<QuickPickItem>;

    private get client() {
        return this.main.client;
    }

    private items: QuickPickItem[] = [];
    private _prompt = "";
    private _firstc = "";
    private _cmdline = "";

    public constructor(private main: MainController) {
        this.disposables.push((this.input = window.createQuickPick()));
        this.input = window.createQuickPick();
        this.input.ignoreFocusOut = false;
        this.disposables.push(
            this.input,
            this.input.onDidAccept(this.onAccept),
            this.input.onDidChangeValue(this.onChange),
            this.input.onDidHide(this.onHide),
            commands.registerCommand("vscode-neovim.commit-cmdline", this.onAccept),
            commands.registerCommand("vscode-neovim.complete-selection-cmdline", this.acceptSelection),
            commands.registerCommand("vscode-neovim.send-cmdline", this.sendRedraw),
            // commands.registerCommand("vscode-neovim.test-cmdline", this.testCmdline),
            eventBus.on(
                "redraw",
                (data: EventBusData<"redraw">) => {
                    for (const { name, args } of data) {
                        if (name === "cmdline_show") {
                            const [, , firstc, prompt] = args[0];
                            this.input.title = prompt || getTitle(firstc);
                        }
                    }
                },
                this,
            ),
            eventBus.on("cmdline_items", ([items]) => {
                logger.debug("cmdline_items", items);
                this.input.items = items.slice(0, 20).map((str) => ({ label: str, alwaysShow: true }));
            }),
            eventBus.on("cmdline_show", ([cmdline]) => {
                logger.debug("cmdline_show");
                if (this.input.value !== cmdline) this.input.value = cmdline;
                this.input.show();
            }),
            eventBus.on("cmdline_hide", () => {
                logger.debug("cmdline_hide");
                this.input.hide();
                this.input.value = "";
                this.input.items = [];
            }),
            eventBus.on("cmdline_changed", ([cmdline]) => {
                logger.debug("cmdline_changed", cmdline);
                if (this.input.value !== cmdline) this.input.value = cmdline;
                if (this.input.value === "") this.input.items = [];
            }),
        );
    }
    private acceptSelection = (): void => {
        /*
        if (!this.isDisplayed) {
            return;
        }
        const sel = this.input.activeItems[0];
        if (!sel) {
            return;
        }
        const selected = sel.label;
        let lastInputEl = this.input.value;
        // if there is more than one command, get the last one (command, path or space delimited)
        const symbolCheck = /[\s/\\!@#$:<'>%]/g;
        if (symbolCheck.test(lastInputEl)) {
            lastInputEl = lastInputEl.split(symbolCheck).pop()!;
        }
        const isSubstring = selected.search(lastInputEl);
        if ((lastInputEl && isSubstring !== -1) || lastInputEl === "~") {
            this.input.value = this.input.value.replace(lastInputEl, selected);
        } else {
            this.input.value += selected;
        }
        this.onChange(this.input.value);
        */
    };
    private onAccept = () => {
        this.client.lua("require'vscode-neovim.cmdline'.confirm()");
    };

    private onChange = debounce(() => {
        this.client.lua("require'vscode-neovim.cmdline'.change(...)", [this.input.value]);
    }, 30);

    private sendRedraw = (keys: string) => {
        this.client.input(keys);
    };

    private onHide = () => {
        this.client.lua("require'vscode-neovim.cmdline'.cancel()").finally(() => (this.input.value = ""));
    };

    public dispose() {
        disposeAll(this.disposables);
    }
}
