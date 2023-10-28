local M = {}

local api = vim.api
local fn = vim.fn
local vscode = require("vscode-neovim.api")

local function get_viewport(win)
  return api.nvim_win_call(win, fn.winsaveview)
end

local function set_viewport(win, viewport)
  return api.nvim_win_call(win, function()
    return fn.winrestview(viewport)
  end)
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
  ---@type WindowViewport
  local curr_view = api.nvim_win_call(win, fn.winsaveview)

  -- local outside = view.line < view.topline or view.line > view.botline

  local height = math.max(
    -- In the viewport
    view.botline - view.topline,
    -- On the viewport top
    view.botline - view.line,
    -- On the viewport bottom
    view.line - view.topline
  ) + 2

  if height ~= api.nvim_win_get_height(win) then
    api.nvim_win_set_height(win, height)
  end

  if curr_view.topline ~= view.topline then
    api.nvim_win_set_var(win, '__vscode_viewport_topline', view.topline)
    set_viewport(win, view)
  end
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

      local curr_viewport = get_viewport(win)
      local ok, last_topline = pcall(api.nvim_win_get_var, win, "__vscode_viewport_topline")
      if not ok or last_topline ~= curr_viewport.topline then
        api.nvim_win_set_var(win, "__vscode_viewport_topline", curr_viewport)
        fn.VSCodeExtensionNotify("viewport-changed", win, curr_viewport)
      end
    end,
  })
end

return M
