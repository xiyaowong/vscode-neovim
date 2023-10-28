local M = {}

local api = vim.api
local fn = vim.fn

local vscode = require("vscode-neovim.api")
local util = require("vscode-neovim.util")

function M.get_all_viewports()
  local wins = api.nvim_list_wins()
  local views = {}
  for _, win in ipairs(wins) do
    table.insert(views, { win, api.nvim_win_call(win, fn.winsaveview) })
  end
  return views
end

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
  local is_outside = false
  local topline, botline
  if view.line <= view.topline then
    topline = view.line
    botline = view.botline
    is_outside = true
  elseif view.line >= view.botline then
    topline = view.topline
    botline = view.line
    is_outside = true
  else
    topline = view.topline
    botline = view.botline
  end

  if is_outside then
    return
  end

  topline = topline + 1
  botline = botline + 1

  local height = botline - topline + 1

  if height ~= api.nvim_win_get_height(win) then
    api.nvim_win_set_height(win, height)
  end

  api.nvim_win_call(win, function()
    if topline ~= fn.line("w0") then
      vim.w.__vscode_viewport_topline = topline
      if api.nvim_get_mode().mode == "n" then
        fn.winrestview({ topline = topline, lnum = view.line + 1, col = view.col })
      else
        fn.winrestview({ topline = topline })
      end
    end
  end)
end

function M.setup()
  vscode.on("editor_viewport_changed", on_editor_viewport_changed)
  api.nvim_create_autocmd({ "WinScrolled", "CursorMoved" }, {
    callback = function(ev)
      local buf = ev.buf
      local curr_buf = api.nvim_get_current_buf()
      local curr_win = api.nvim_get_current_win()

      local win = curr_win
      if buf ~= curr_buf then
        for _, w in ipairs(api.nvim_list_wins()) do
          local b = api.nvim_win_get_buf(w)
          if b == curr_buf then
            win = w
            break
          end
        end
      end

      api.nvim_win_call(win, function()
        local last_topline = vim.w.__vscode_viewport_topline
        local view = fn.winsaveview()
        if last_topline ~= view.topline then
          vim.w.__vscode_viewport_topline = view.topline
          fn.VSCodeExtensionNotify("viewport-changed", win, view)
        end
      end)
    end,
  })

  local scroll_to_bottom = function(key)
    util.feedkeys(key)
    local arg = { lineNumber = fn.line(".") - 1, at = "bottom" }
    vscode.action("revealLine", { args = { arg } })
  end
  vim.keymap.set({ "n" }, "zb", function()
    scroll_to_bottom("zb")
  end)
  vim.keymap.set({ "n" }, "z-", function()
    scroll_to_bottom("z-")
  end)
end

return M
