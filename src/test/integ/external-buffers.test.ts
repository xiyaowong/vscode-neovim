import { strict as assert } from "assert";

import { NeovimClient } from "neovim";
import vscode from "vscode";

import {
    attachTestNvimClient,
    closeActiveEditor,
    closeAllActiveEditors,
    closeNvimClient,
    getNeovimCursor,
    getVScodeCursor,
    openTextDocument,
    sendVSCodeCommand,
    sendVSCodeKeys,
    sendVSCodeKeysAtomic,
} from "./integrationUtils";

describe("Neovim external buffers", () => {
    let client: NeovimClient;
    before(async () => {
        client = await attachTestNvimClient();
    });
    after(async () => {
        await closeNvimClient(client);
        await closeAllActiveEditors();
    });

    beforeEach(async () => {
        await closeAllActiveEditors();
    });

    it("Opens VIM help", async () => {
        await openTextDocument({ content: "blah" });

        await sendVSCodeKeys(":");
        await sendVSCodeCommand("vscode-neovim.test-cmdline", "help");
        await sendVSCodeCommand("vscode-neovim.commit-cmdline", "");

        const text = vscode.window.activeTextEditor!.document.getText();
        assert.ok(text.indexOf("NVIM DOCUMENTATION") !== -1);

        await sendVSCodeKeys(":");
        await sendVSCodeCommand("vscode-neovim.test-cmdline", "help options");
        await sendVSCodeCommand("vscode-neovim.commit-cmdline", "");

        const text2 = vscode.window.activeTextEditor!.document.getText();
        assert.ok(text2.indexOf("VIM REFERENCE MANUAL") !== -1);

        await closeActiveEditor();
    });

    it("Cursor for external buffers is OK", async function () {
        this.retries(3);

        await openTextDocument({ content: "blah" });

        await sendVSCodeKeysAtomic(":help local-options");
        await sendVSCodeCommand("vscode-neovim.commit-cmdline", "");
        await sendVSCodeKeys("$0");

        const vscodeCursor = getVScodeCursor();
        const neovimCursor = await getNeovimCursor(client);
        const text = vscode.window.activeTextEditor!.document.getText();

        assert.ok(neovimCursor[0] !== 0);
        assert.ok(vscodeCursor[0] === neovimCursor[0]);
        assert.equal(text.split("\n")[neovimCursor[0]], "Handling of local options			*local-options*");
    });
});
