local M = {}

local api = vim.api
local fn = vim.fn
local vscode = require("vscode-neovim.api")

---@class EditorViewport
---@field line number 0-indexed
---@field col number 0-indexed
---@field topline number 0-indexed
---@field botline number 0-indexed

---@class WindowViewport
---@field lnum number 1-indexed
---@field col number 0-indexed
---@field topline number 1-indexed

---@param win number
---@param view EditorViewport
local function on_editor_viewport_changed(win, view)
  ---@type WindowViewport
  local winview = api.nvim_win_call(win, fn.winsaveview)

  if view.line < view.topline - 1 or view.line > view.botline + 1 then
    return
  end

  local editor_height = view.botline - view.topline + 2 + 2
  local window_height = api.nvim_win_get_height(win)
  if window_height ~= editor_height then
    api.nvim_win_set_height(win, editor_height)
  end

  if winview.topline ~= view.topline then
    api.nvim_win_call(win, function()
      fn.winrestview({ topline = view.topline })
    end)
  end
end

function M.setup()
  vscode.on("editor-viewport-changed", on_editor_viewport_changed)
end

return M
