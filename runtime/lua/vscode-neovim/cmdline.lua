local api, fn = vim.api, vim.fn

local code = require("vscode-neovim.api")
local util = require("vscode-neovim.util")

local M = {}

local function is_c()
  return fn.mode() == "c"
end

local refresh_completions = util.debounce(function()
  local cmdtype = fn.getcmdtype()
  local cmdline = fn.getcmdline()
  local use_completion = cmdtype == ":"
    and cmdline ~= ""
    and not vim.startswith(cmdline, "?")
    and not vim.startswith(cmdline, "/")
    and not cmdline:find("s/")
    and not cmdline:find("substitute/")
    and not cmdline:find("g/")
    and not cmdline:find("global/")
    and not cmdline:find("v/")
    and not cmdline:find("vglobal/")
  local items = {}
  if use_completion then
    items = fn.getcompletion(cmdline, "cmdline")
  end
  fn.VSCodeExtensionNotify("cmdline_items", vim.list_slice(items, 1, 20))
end, 100)

local cmdline_changed = util.debounce(function()
  if not is_c() then
    return
  end
  fn.VSCodeExtensionNotify("cmdline_changed", fn.getcmdline())
  refresh_completions()
end, 100)

local cmdline_enter = util.debounce(function()
  if not is_c() then
    return
  end
  fn.VSCodeExtensionNotify("cmdline_show", fn.getcmdline())
  refresh_completions()
end, 50)

local function cmdline_leave()
  fn.VSCodeExtensionNotify("cmdline_hide")
end

function M.confirm()
  if not is_c() then
    return
  end
  api.nvim_input("<CR>")
end

M.cancel = function()
  if not is_c() then
    return
  end
  api.nvim_input("<ESC>")
end

M.change = function(s)
  if not is_c() then
    return
  end
  local curr = fn.getcmdline()
  if curr ~= s then
    fn.setcmdline("")
    api.nvim_input(s)
  end
end

function M.setup()
  local group = api.nvim_create_augroup("VSCodeCmdline", {})
  local au = api.nvim_create_autocmd
  au({ "CmdlineEnter" }, { group = group, callback = cmdline_enter })
  au({ "CmdlineChanged" }, { group = group, callback = cmdline_changed })
  au({ "CmdlineLeave" }, { group = group, callback = cmdline_leave })
end

return M
