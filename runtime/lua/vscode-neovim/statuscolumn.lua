vim.o.numberwidth = 1
local user_statuscolumn = "%{%v:lua.a.test()%}"
local statuscolumn = "%{%v:lua.a.test()%}"
local statuscolumns = {}
_G.a = {}
a.test = function()
  local s = user_statuscolumn
  if s == statuscolumn then
    s = ""
    if vim.o.number or vim.o.relativenumber then
      s = s .. "%s"
    end
  end
  local line = vim.api.nvim_eval_statusline(s, {
    winid = vim.api.nvim_get_current_win(),
    use_statuscol_lnum = vim.v.lnum,
  })
  statuscolumns[vim.v.lnum] = { { text = "A", color = "#ff0000" } }
  return "%#NonText#" .. ("-"):rep(20)
end
vim.o.statuscolumn = statuscolumn
vim.api.nvim_create_autocmd({ "CursorMoved", "OptionSet", "CmdlineLeave", "BufWinEnter", "WinEnter" }, {
  callback = function()
    vim.defer_fn(function()
      if vim.o.statuscolumn ~= statuscolumn then
        user_statuscolumn = vim.o.statuscolumn
        vim.o.statuscolumn = statuscolumn
      end
    end, 0)
  end,
})

vim.api.nvim_create_user_command("Test", function()
  local args = {}
  for lnum, spans in pairs(statuscolumns or {}) do
    table.insert(args, { lnum, spans })
  end

  require("vscode-neovim.api").notify_extension("refresh-statuscolumn", {
    vim.api.nvim_get_current_win(),
    args,
  })
end, {})
